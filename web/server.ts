import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askMartaChat } from "./chat.js";
import { getCommuteVerdict } from "./commute.js";
import { createPool } from "./db.js";
import { loadDestinationIndex, searchStops } from "./destinations.js";
import { getLatestVehicles } from "./mapVehicles.js";
import { getGhostBuses, getReliabilityChart } from "./tools.js";
import { generateBriefing } from "../workflows/briefing.js";
import { triggerBriefingWorkflow } from "../workflows/trigger.js";

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

app.get("/api/stops", async (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) {
      res.json({ stops: [] });
      return;
    }
    const index = await loadDestinationIndex();
    res.json({ stops: searchStops(index, q, 12) });
  } catch (err) {
    console.error("/api/stops", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "stop search failed",
    });
  }
});

app.get("/api/commute", async (req, res) => {
  try {
    const route = String(req.query.route ?? "").trim() || undefined;
    const destination = String(req.query.destination ?? "").trim() || undefined;
    const stopId = String(req.query.stop_id ?? "").trim() || undefined;
    const arriveBy = String(req.query.arrive_by ?? "").trim() || undefined;
    const lat = req.query.lat != null ? Number(req.query.lat) : undefined;
    const lon = req.query.lon != null ? Number(req.query.lon) : undefined;
    if (!route && !destination && !stopId && (lat == null || lon == null)) {
      res.status(400).json({ error: "destination or route is required" });
      return;
    }
    const result = await getCommuteVerdict(pool, {
      route,
      destination,
      stop_id: stopId,
      lat: Number.isFinite(lat) ? lat : undefined,
      lon: Number.isFinite(lon) ? lon : undefined,
      arrive_by: arriveBy,
    });
    if (result && "error" in result && result.error) {
      res.status(400).json(result);
      return;
    }
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

app.get("/api/briefing/latest", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, generated_at, body_md, stats
       FROM briefings
       WHERE audience = 'georgia-tech'
       ORDER BY generated_at DESC
       LIMIT 1`
    );
    if (!result.rows.length) {
      res.json({ briefing: null });
      return;
    }
    const row = result.rows[0];
    res.json({
      briefing: {
        id: Number(row.id),
        generated_at: new Date(row.generated_at).toISOString(),
        body_md: String(row.body_md),
      },
    });
  } catch (err) {
    console.error("/api/briefing/latest", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "briefing query failed",
    });
  }
});

// Kicks the Render Workflow (durable, retried tasks); falls back to inline
// generation when no workflow deploy is configured (local dev).
app.post("/api/briefing/run", async (_req, res) => {
  try {
    const triggered = await triggerBriefingWorkflow();
    if (triggered) {
      res.json({ status: "workflow_started", ...triggered });
      return;
    }
    const briefing = await generateBriefing(pool);
    res.json({ status: "generated_inline", briefing });
  } catch (err) {
    console.error("/api/briefing/run", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "briefing run failed",
    });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`[web] Transit Ledger ATL listening on http://localhost:${port}`);
});
