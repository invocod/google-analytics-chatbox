#!/usr/bin/env node
require("dotenv").config();

// ─── Environment Validation ─────────────────────────────
const requiredEnv = ["GA4_PROPERTY_ID", "ANTHROPIC_API_KEY"];

const missing = requiredEnv.filter((key) => !process.env[key]);
if (!process.env.GA_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  missing.push("GOOGLE_APPLICATION_CREDENTIALS or GA_CREDENTIALS_JSON");
}
if (missing.length > 0) {
  console.error(`\nMissing required environment variables:\n  ${missing.join("\n  ")}\n`);
  console.error("Copy .env.example to .env and fill in all required values.\n");
  process.exit(1);
}

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const { queryGA4 } = require("./ga4");
const { processQuery } = require("./ai");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security ─────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "'unsafe-eval'",
          "https://unpkg.com",
          "https://cdn.jsdelivr.net",
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://fonts.googleapis.com",
          "https://cdn.jsdelivr.net",
        ],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
      },
    },
  })
);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Rate limiting — 30 queries per minute per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many requests. Please wait a moment." },
});
app.use("/api/", apiLimiter);

// ─── Simple Token Auth ────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = process.env.TEAM_ACCESS_TOKEN;
  if (!token) return next(); // No token configured = open access

  const provided =
    req.headers.authorization?.replace("Bearer ", "") ||
    req.query.token;

  if (provided !== token) {
    return res.status(401).json({ error: "Unauthorized. Invalid access token." });
  }
  next();
}

// ─── Serve Frontend ───────────────────────────────────────
app.use(express.static(path.join(__dirname, "..", "public")));

// ─── API Routes ───────────────────────────────────────────

// Health check (with auth if token is configured)
app.get("/api/health", authMiddleware, (req, res) => {
  res.json({
    status: "ok",
    property: process.env.GA4_PROPERTY_ID || "not set",
    timestamp: new Date().toISOString(),
  });
});

// Chat endpoint — the core magic
app.post("/api/chat", authMiddleware, async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required" });
    }

    if (message.length > 2000) {
      return res.status(400).json({ error: "Message too long (max 2000 chars)" });
    }

    console.log(`[${new Date().toISOString()}] Query: ${message}`);

    // Step 1: Claude interprets the query and generates GA4 API params
    const ga4Params = await processQuery(message, history);

    if (ga4Params.error) {
      return res.json({
        type: "text",
        content: ga4Params.error,
      });
    }

    if (ga4Params.type === "text") {
      return res.json({
        type: "text",
        content: ga4Params.content,
      });
    }

    // Step 2: Execute GA4 query
    const ga4Data = await queryGA4(ga4Params);

    // Step 3: Claude formats the response
    const response = await processQuery(
      `Here is the raw GA4 data for the user's question "${message}". 
       Format this data as a clear, insightful answer. Use markdown tables where appropriate.
       Include key insights and trends. Keep it concise but informative.
       If relevant, suggest follow-up questions.
       
       GA4 Query params: ${JSON.stringify(ga4Params)}
       GA4 Data: ${JSON.stringify(ga4Data)}`,
      [],
      true
    );

    res.json({
      type: "analytics",
      content: response.content || response,
      rawData: ga4Data,
      query: ga4Params,
    });
  } catch (err) {
    console.error("[Chat Error]", err.message);
    console.error("Full error:", err);
    console.error("Stack trace:", err.stack);
    res.status(500).json({
      error: "Failed to process your query. Please try again.",
      details: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

// Direct GA4 query (for advanced users)
app.post("/api/query", authMiddleware, async (req, res) => {
  try {
    const { dimensions, metrics, startDate, endDate, limit, dimensionFilter } =
      req.body;

    if (!metrics || !Array.isArray(metrics) || metrics.length === 0) {
      return res.status(400).json({ error: "At least one metric is required" });
    }

    const data = await queryGA4({
      dimensions: dimensions || ["date"],
      metrics,
      startDate: startDate || "7daysAgo",
      endDate: endDate || "yesterday",
      limit: Math.min(limit || 100, 1000),
      dimensionFilter,
    });

    res.json(data);
  } catch (err) {
    console.error("[Query Error]", err.message);
    res.status(500).json({ error: "Failed to query GA4" });
  }
});

// ─── Available metrics/dimensions info ────────────────────
app.get("/api/schema", authMiddleware, (req, res) => {
  res.json({
    commonMetrics: [
      "totalUsers",
      "newUsers",
      "activeUsers",
      "sessions",
      "screenPageViews",
      "bounceRate",
      "averageSessionDuration",
      "engagedSessions",
      "engagementRate",
      "eventCount",
      "conversions",
    ],
    commonDimensions: [
      "date",
      "country",
      "city",
      "deviceCategory",
      "browser",
      "operatingSystem",
      "pagePath",
      "pageTitle",
      "source",
      "medium",
      "sessionDefaultChannelGroup",
      "landingPage",
    ],
    exampleQueries: [
      "Show me active users for the last 7 days",
      "What are the top 10 pages by views this month?",
      "Compare traffic this week vs last week",
      "Show me users by country for the last 30 days",
      "What's the bounce rate by device category?",
      "What are the top traffic sources?",
      "Show me daily sessions trend for the past month",
      "Which pages have the highest engagement rate?",
    ],
  });
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// ─── Start Server ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║          GA4 Team Chat — Ready!                       ║
║                                                       ║
║  🌐  http://localhost:${PORT}                          ║
║  📊  Property: ${(process.env.GA4_PROPERTY_ID || "NOT SET").padEnd(38)}║
║  🔐  Auth: ${(process.env.TEAM_ACCESS_TOKEN ? "Enabled" : "Disabled (open access)").padEnd(42)}║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
  `);
});
