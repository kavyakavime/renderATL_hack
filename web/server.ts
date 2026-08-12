import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askMartaChat } from "./chat.js";
import { createPool } from "./db.js";
import { getReliabilityChart } from "./tools.js";

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

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`[web] MARTA Receipts listening on http://localhost:${port}`);
});
