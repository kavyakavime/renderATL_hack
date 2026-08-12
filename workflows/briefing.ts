import { GoogleGenAI } from "@google/genai";
import type pg from "pg";
import {
  loadDestinationIndex,
  resolveDestination,
} from "../web/destinations.js";
import {
  getGhostBuses,
  getRouteReliability,
  getWorstRoutesToday,
} from "../web/tools.js";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";

export type BriefingStats = {
  worst: unknown[];
  ghosts: {
    count: number;
    expected_trips: number;
    show_rate_pct: number | null;
  };
  campus_routes: Array<{
    route: string;
    on_time_pct: number | null;
    avg_delay_min: number | null;
    samples: number;
  }>;
  destination: string;
};

function avgOf(nums: number[]): number | null {
  const vals = nums.filter((n) => Number.isFinite(n));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Task 1 — pull live reliability stats out of Tiger (worst routes, ghosts, campus routes). */
export async function gatherStats(
  pool: pg.Pool,
  destination = "Georgia Tech"
): Promise<BriefingStats> {
  const [worstToday, ghosts, index] = await Promise.all([
    getWorstRoutesToday(pool),
    getGhostBuses(pool),
    loadDestinationIndex(),
  ]);

  const dest = resolveDestination(index, { destination });
  const candidates =
    "error" in dest ? [] : dest.candidate_routes.slice(0, 6);

  const campusRoutes = await Promise.all(
    candidates.map(async (route) => {
      const rel = await getRouteReliability(pool, route, 2);
      const onTime = avgOf(rel.points.map((p) => Number(p.on_time_pct)));
      const delay = avgOf(rel.points.map((p) => Number(p.avg_delay_sec)));
      return {
        route,
        on_time_pct: onTime == null ? null : Math.round(onTime * 10) / 10,
        avg_delay_min:
          delay == null ? null : Math.round((delay / 60) * 10) / 10,
        samples: rel.points.reduce((n, p) => n + Number(p.sample_count || 0), 0),
      };
    })
  );

  return {
    worst: worstToday.worst,
    ghosts: {
      count: ghosts.count,
      expected_trips: ghosts.expected_trips,
      show_rate_pct: ghosts.show_rate_pct,
    },
    campus_routes: campusRoutes.filter((r) => r.samples > 0),
    destination,
  };
}

/** Task 2 — Gemini turns the stats into a rider-facing briefing. */
export async function writeBriefing(stats: BriefingStats): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is required");
  const ai = new GoogleGenAI({ apiKey });

  const prompt = [
    `You write a punchy commute briefing for Georgia Tech students riding MARTA to campus (${stats.destination}).`,
    "Live stats from the last 2 hours (TimescaleDB continuous aggregates over MARTA GTFS-RT):",
    JSON.stringify(stats),
    "Write <=120 words of markdown:",
    "- One-line verdict headline (bold) — is transit to campus trustworthy right now?",
    "- 2-3 bullets: best/worst campus routes with on-time %, any ghost-bus risk, one concrete tip (e.g. 'leave 10 min early on Route X').",
    "No preamble, no sign-off. Cite route numbers and percentages from the stats only.",
  ].join("\n");

  const res = await ai.models.generateContent({ model: MODEL, contents: prompt });
  const text = (res.text ?? "").trim();
  if (!text) throw new Error("Gemini returned an empty briefing");
  return text;
}

/** Task 3 — persist so the dashboard (and history) can read it. */
export async function storeBriefing(
  pool: pg.Pool,
  bodyMd: string,
  stats: BriefingStats
): Promise<{ id: number; generated_at: string }> {
  const result = await pool.query(
    `INSERT INTO briefings (audience, body_md, stats)
     VALUES ('georgia-tech', $1, $2)
     RETURNING id, generated_at`,
    [bodyMd, JSON.stringify(stats)]
  );
  return {
    id: Number(result.rows[0].id),
    generated_at: new Date(result.rows[0].generated_at).toISOString(),
  };
}

/** Full pipeline (used by the Render Workflow tasks and the local fallback). */
export async function generateBriefing(pool: pg.Pool) {
  const stats = await gatherStats(pool);
  const body = await writeBriefing(stats);
  const saved = await storeBriefing(pool, body, stats);
  return { ...saved, body_md: body, stats };
}
