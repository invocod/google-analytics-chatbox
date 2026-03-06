/**
 * google-analytics-chatbox - npm package entry point
 *
 * Usage in Laravel (via Node sidecar / child_process / API):
 *
 *   const { createServer, queryGA4, processQuery } = require('@invocod/google-analytics-chatbox');
 *
 *   // Option 1: Start the full Express server
 *   createServer({ port: 3001 });
 *
 *   // Option 2: Use individual functions programmatically
 *   const data = await queryGA4({ metrics: ['totalUsers'], startDate: '7daysAgo', endDate: 'yesterday' });
 *   const answer = await processQuery('How many users visited last week?');
 */

const path = require("path");

// Ensure dotenv loads from consuming project's root (if present)
require("dotenv").config();

const { queryGA4 } = require("../server/ga4");
const { processQuery } = require("../server/ai");

/**
 * Start the full Express server programmatically.
 * @param {Object} options
 * @param {number} [options.port=3000] - Port to listen on
 * @param {string} [options.host='0.0.0.0'] - Host to bind to
 * @param {boolean} [options.serveFrontend=true] - Whether to serve the built-in chat UI
 * @returns {Promise<{app: import('express').Express, server: import('http').Server}>}
 */
function createServer(options = {}) {
  const {
    port = process.env.PORT || 3000,
    host = "0.0.0.0",
    serveFrontend = true,
  } = options;

  // We require the server module which sets up express
  // but we need to extract the app before it starts listening
  const express = require("express");
  const cors = require("cors");
  const helmet = require("helmet");
  const rateLimit = require("express-rate-limit");

  const app = express();

  // Security
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

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: "Too many requests. Please wait a moment." },
  });
  app.use("/api/", apiLimiter);

  // Auth middleware
  function authMiddleware(req, res, next) {
    const token = process.env.TEAM_ACCESS_TOKEN;
    if (!token) return next();
    const provided =
      req.headers.authorization?.replace("Bearer ", "") || req.query.token;
    if (provided !== token) {
      return res
        .status(401)
        .json({ error: "Unauthorized. Invalid access token." });
    }
    next();
  }

  // Optionally serve the built-in frontend
  if (serveFrontend) {
    app.use(
      express.static(path.join(__dirname, "..", "public"))
    );
  }

  // API routes
  app.get("/api/health", authMiddleware, (req, res) => {
    res.json({
      status: "ok",
      property: process.env.GA4_PROPERTY_ID || "not set",
      timestamp: new Date().toISOString(),
    });
  });

  app.post("/api/chat", authMiddleware, async (req, res) => {
    try {
      const { message, history = [] } = req.body;
      if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "Message is required" });
      }
      if (message.length > 2000) {
        return res
          .status(400)
          .json({ error: "Message too long (max 2000 chars)" });
      }

      const ga4Params = await processQuery(message, history);

      if (ga4Params.error) {
        return res.json({ type: "text", content: ga4Params.error });
      }
      if (ga4Params.type === "text") {
        return res.json({ type: "text", content: ga4Params.content });
      }

      const ga4Data = await queryGA4(ga4Params);

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
      res.status(500).json({
        error: "Failed to process your query. Please try again.",
        details:
          process.env.NODE_ENV === "development" ? err.message : undefined,
      });
    }
  });

  app.post("/api/query", authMiddleware, async (req, res) => {
    try {
      const {
        dimensions,
        metrics,
        startDate,
        endDate,
        limit,
        dimensionFilter,
      } = req.body;
      if (!metrics || !Array.isArray(metrics) || metrics.length === 0) {
        return res
          .status(400)
          .json({ error: "At least one metric is required" });
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

  app.get("/api/schema", authMiddleware, (req, res) => {
    res.json({
      commonMetrics: [
        "totalUsers", "newUsers", "activeUsers", "sessions",
        "screenPageViews", "bounceRate", "averageSessionDuration",
        "engagedSessions", "engagementRate", "eventCount", "conversions",
      ],
      commonDimensions: [
        "date", "country", "city", "deviceCategory", "browser",
        "operatingSystem", "pagePath", "pageTitle", "source", "medium",
        "sessionDefaultChannelGroup", "landingPage",
      ],
    });
  });

  if (serveFrontend) {
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "..", "public", "index.html"));
    });
  }

  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      console.log(`GA4 Chatbox server running on http://${host}:${port}`);
      resolve({ app, server });
    });
  });
}

module.exports = {
  createServer,
  queryGA4,
  processQuery,
};
