import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askMartaChat, generateReportCard } from "./chat.js";
import { getCommuteVerdict } from "./commute.js";
import { createPool } from "./db.js";
import { getLatestVehicles } from "./mapVehicles.js";
import { streamReportPdf } from "./reportPdf.js";
import { getGhostBuses, getReliabilityChart } from "./tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const pool = createPool();
const port = Number(process.env.PORT || 3000);

app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/reliability", async (req, res) => {
  try {
    const hours = Math.min(Number(req.query.hours) || 4, 24);
    const rows = await getReliabilityChart(pool, hours);
    res.json({ hours, rows });
  } catch (err) {
    console.error("/api/reliability", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "query failed",
    });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const question = String(req.body?.question ?? "").trim();
    if (!question) {
      res.status(400).json({ error: "question is required" });
      return;
    }
    const answer = await askMartaChat(pool, question);
    res.json({ answer });
  } catch (err) {
    console.error("/api/chat", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "chat failed",
    });
  }
});

app.get("/api/report", async (_req, res) => {
  try {
    const result = await generateReportCard(pool);
    res.json(result);
  } catch (err) {
    console.error("/api/report", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "report failed",
    });
  }
});

app.get("/api/report/pdf", async (req, res) => {
  try {
    const inline = String(req.query.inline || "") === "1";
    await streamReportPdf(pool, res, { inline });
  } catch (err) {
    console.error("/api/report/pdf", err);
    if (!res.headersSent) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "pdf failed",
      });
    } else {
      res.end();
    }
  }
});

app.get("/api/commute", async (req, res) => {
  try {
    const route = String(req.query.route ?? "").trim();
    const arriveBy = String(req.query.arrive_by ?? "").trim() || undefined;
    if (!route) {
      res.status(400).json({ error: "route is required" });
      return;
    }
    const result = await getCommuteVerdict(pool, route, arriveBy);
    res.json(result);
  } catch (err) {
    console.error("/api/commute", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "commute query failed",
    });
  }
});

app.get("/api/ghosts", async (req, res) => {
  try {
    const route = String(req.query.route ?? "").trim() || undefined;
    const result = await getGhostBuses(pool, route);
    res.json(result);
  } catch (err) {
    console.error("/api/ghosts", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "ghosts query failed",
    });
  }
});

app.get("/api/vehicles/latest", async (_req, res) => {
  try {
    const result = await getLatestVehicles(pool);
    res.json(result);
  } catch (err) {
    console.error("/api/vehicles/latest", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "vehicles query failed",
    });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`[web] Transit Ledger ATL listening on http://localhost:${port}`);
});
