#!/usr/bin/env node
/**
 * Google Analytics AI Insights — MCP Server
 *
 * Exposes GA4 analytics as tools for Claude Desktop / Claude Code.
 * This is additive — the existing REST API (server/index.js) is untouched.
 *
 * Usage:
 *   node mcp-server.js
 *
 * Claude Desktop config (~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "google-analytics": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/mcp-server.js"],
 *         "env": {
 *           "GA4_PROPERTY_ID": "your_property_id",
 *           "ANTHROPIC_API_KEY": "sk-ant-...",
 *           "GA_CREDENTIALS_JSON": "{...service account json...}"
 *         }
 *       }
 *     }
 *   }
 *
 * Claude Code config (.claude/settings.json in project root):
 *   {
 *     "mcpServers": {
 *       "google-analytics": {
 *         "command": "node",
 *         "args": ["mcp-server.js"]
 *       }
 *     }
 *   }
 */

require("dotenv").config();

const { McpServer }            = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z }                    = require("zod");
const { queryGA4 }             = require("./server/ga4");
const { processQuery }         = require("./server/ai");

// ─── Validate required env vars ──────────────────────────────
const missing = [];
if (!process.env.GA4_PROPERTY_ID)  missing.push("GA4_PROPERTY_ID");
if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
if (!process.env.GA_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  missing.push("GA_CREDENTIALS_JSON or GOOGLE_APPLICATION_CREDENTIALS");
}
if (missing.length > 0) {
  console.error(`\n[GA4 MCP] Missing required environment variables:\n  ${missing.join("\n  ")}\n`);
  process.exit(1);
}

// ─── Create MCP Server ────────────────────────────────────────
const server = new McpServer({
  name:    "google-analytics-insights",
  version: "1.0.3",
});

// ─── Tool 1: ask_analytics ────────────────────────────────────
// Natural language question → GA4 data → formatted markdown answer
server.tool(
  "ask_analytics",
  "Ask a natural language question about your Google Analytics data and get an AI-formatted answer with insights",
  {
    message: z.string().describe(
      'Your analytics question in plain English. Examples: "How many users last week?", "Top 10 pages by views this month", "Compare mobile vs desktop sessions"'
    ),
  },
  async ({ message }) => {
    try {
      // Step 1: Claude interprets question → GA4 params
      const params = await processQuery(message, []);

      // Non-GA4 question — return Claude's text response directly
      if (params.type === "text") {
        return { content: [{ type: "text", text: params.content }] };
      }

      if (params.error) {
        return { content: [{ type: "text", text: `Error: ${params.error}` }] };
      }

      // Step 2: Execute GA4 query
      const data = await queryGA4(params);

      // Step 3: Claude formats the response as markdown
      const formatted = await processQuery(
        `Here is the raw GA4 data for the user's question: "${message}".
         Format this data as a clear, insightful answer. Use markdown tables where appropriate.
         Include key insights and trends. Keep it concise but informative.
         Suggest 2-3 follow-up questions at the end.

         GA4 Query params: ${JSON.stringify(params)}
         GA4 Data: ${JSON.stringify(data)}`,
        [],
        true
      );

      return {
        content: [{ type: "text", text: formatted.content || formatted }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to fetch analytics: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool 2: query_ga4 ───────────────────────────────────────
// Direct GA4 query with explicit metrics/dimensions — raw data returned
server.tool(
  "query_ga4",
  "Run a direct Google Analytics 4 query with specific metrics and dimensions. Returns raw structured data.",
  {
    metrics: z.array(z.string()).describe(
      "GA4 metrics to retrieve. Examples: totalUsers, sessions, screenPageViews, bounceRate, averageSessionDuration, eventCount, conversions"
    ),
    dimensions: z.array(z.string()).optional().describe(
      "GA4 dimensions to group by. Examples: date, country, city, deviceCategory, pagePath, source, medium, browser"
    ),
    startDate: z.string().optional().describe(
      'Start date. Use YYYY-MM-DD or relative values: "today", "yesterday", "7daysAgo", "30daysAgo", "90daysAgo"'
    ),
    endDate: z.string().optional().describe(
      'End date. Use YYYY-MM-DD or relative values: "today", "yesterday"'
    ),
    limit: z.number().optional().describe(
      "Maximum number of rows to return. Default: 20, Max: 1000"
    ),
  },
  async ({ metrics, dimensions, startDate, endDate, limit }) => {
    try {
      const data = await queryGA4({
        metrics,
        dimensions: dimensions ?? ["date"],
        startDate:  startDate  ?? "7daysAgo",
        endDate:    endDate    ?? "yesterday",
        limit:      Math.min(limit ?? 20, 1000),
      });

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `GA4 query failed: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool 3: get_analytics_schema ────────────────────────────
// Returns available metrics and dimensions — useful for discovery
server.tool(
  "get_analytics_schema",
  "Get the list of all available Google Analytics 4 metrics and dimensions you can query",
  {},
  async () => {
    const schema = {
      dimensions: {
        time:     ["date", "dateHour", "dateHourMinute"],
        location: ["country", "city", "region", "continent"],
        device:   ["deviceCategory", "browser", "operatingSystem", "platform"],
        content:  ["pagePath", "pageTitle", "landingPage", "landingPagePlusQueryString"],
        traffic:  ["source", "medium", "sessionDefaultChannelGroup", "campaignName"],
        user:     ["newVsReturning", "userAgeBracket", "userGender", "eventName"],
      },
      metrics: {
        users:    ["totalUsers", "newUsers", "activeUsers", "active1DayUsers", "active7DayUsers", "active28DayUsers"],
        sessions: ["sessions", "sessionsPerUser", "engagedSessions", "engagementRate", "bounceRate", "averageSessionDuration"],
        content:  ["screenPageViews", "screenPageViewsPerSession", "screenPageViewsPerUser"],
        events:   ["eventCount", "eventsPerSession", "conversions"],
        revenue:  ["totalRevenue", "transactions"],
      },
      dateFormats: {
        relative: ["today", "yesterday", "7daysAgo", "30daysAgo", "90daysAgo", "365daysAgo"],
        absolute: "YYYY-MM-DD (e.g. 2026-01-15)",
      },
      exampleQuestions: [
        "How many users visited last week?",
        "What are the top 10 pages by views this month?",
        "Show sessions by country for the last 30 days",
        "Compare mobile vs desktop traffic",
        "What is the bounce rate by device category?",
        "Which traffic sources bring the most users?",
      ],
    };

    return {
      content: [{ type: "text", text: JSON.stringify(schema, null, 2) }],
    };
  }
);

// ─── Start MCP Server ─────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[GA4 MCP] Server running — waiting for Claude to connect...");
}

main().catch((err) => {
  console.error("[GA4 MCP] Fatal error:", err);
  process.exit(1);
});
