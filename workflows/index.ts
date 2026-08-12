/**
 * Render Workflows service entrypoint.
 *
 * Deployed from the Render dashboard (New > Workflow — Blueprints don't
 * support workflows yet). Start command: `npm run workflows`.
 * The task server auto-starts on Render via RENDER_SDK_SOCKET_PATH.
 *
 * Task graph:
 *   campusBriefing
 *     ├─ gatherStatsTask   (Tiger: caggs, ghosts, campus routes)
 *     ├─ writeBriefingTask (Gemini, retried — free-tier flakiness)
 *     └─ storeBriefingTask (Tiger: briefings table → dashboard reads it)
 */
import "dotenv/config";
import { task } from "@renderinc/sdk/workflows";
import { createPool } from "../web/db.js";
import {
  gatherStats,
  storeBriefing,
  writeBriefing,
  type BriefingStats,
} from "./briefing.js";

const gatherStatsTask = task(
  { name: "gatherStats", retry: { maxRetries: 2, waitDurationMs: 2000 } },
  async function gatherStatsTask(destination: string): Promise<BriefingStats> {
    const pool = createPool();
    try {
      return await gatherStats(pool, destination);
    } finally {
      await pool.end();
    }
  }
);

const writeBriefingTask = task(
  {
    name: "writeBriefing",
    retry: { maxRetries: 3, waitDurationMs: 3000, backoffScaling: 2 },
  },
  async function writeBriefingTask(stats: BriefingStats): Promise<string> {
    return writeBriefing(stats);
  }
);

const storeBriefingTask = task(
  { name: "storeBriefing", retry: { maxRetries: 2, waitDurationMs: 2000 } },
  async function storeBriefingTask(bodyMd: string, stats: BriefingStats) {
    const pool = createPool();
    try {
      return await storeBriefing(pool, bodyMd, stats);
    } finally {
      await pool.end();
    }
  }
);

export const campusBriefing = task(
  { name: "campusBriefing", timeoutSeconds: 300 },
  async function campusBriefing(destination = "Georgia Tech") {
    const stats = await gatherStatsTask(destination);
    const body = await writeBriefingTask(stats);
    const saved = await storeBriefingTask(body, stats);
    return { ...saved, body_md: body };
  }
);
