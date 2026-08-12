import type pg from "pg";
import {
  loadTripSchedule,
  resolveRoute,
  tripsExpectedNow,
} from "../poller/schedule.js";

const GHOST_DEFINITION =
  "Ghost bus: a trip on today's timetable that should already be in service (started at least 8 minutes ago, not yet finished) but has never appeared in GPS.";

export async function routeDbIds(route: string): Promise<string[]> {
  const q = String(route || "").trim();
  if (!q) return [];
  try {
    const sched = await loadTripSchedule();
    return resolveRoute(sched, q).db_ids;
  } catch {
    return [q];
  }
}

export async function getRouteReliability(
  pool: pg.Pool,
  route: string,
  hours: number
) {
  const h = Math.min(Math.max(Number(hours) || 4, 1), 48);
  const ids = await routeDbIds(route);
  if (ids.length === 0) {
    return { route, hours: h, points: [] };
  }
  const result = await pool.query(
    `
    SELECT
      bucket,
      route_id,
      ROUND(avg_delay_sec::numeric, 1) AS avg_delay_sec,
      ROUND(on_time_pct::numeric, 1) AS on_time_pct,
      sample_count
    FROM route_reliability_15m
    WHERE route_id = ANY($1::text[])
      AND bucket >= NOW() - ($2 || ' hours')::interval
    ORDER BY bucket ASC
    `,
    [ids, String(h)]
  );
  return {
    route,
    hours: h,
    points: result.rows,
  };
}

/** Ghost buses: scheduled trips that never showed up on GPS. */
export async function getGhostBuses(pool: pg.Pool, route?: string) {
  const sched = await loadTripSchedule();
  const routeQ = String(route || "").trim() || undefined;
  const expected = tripsExpectedNow(sched, { route: routeQ });
  const resolved = routeQ ? resolveRoute(sched, routeQ) : null;

  const gps = await pool.query(
    `SELECT COUNT(*)::int AS n FROM vehicle_positions WHERE time >= NOW() - INTERVAL '15 minutes'`
  );
  if (Number(gps.rows[0]?.n ?? 0) === 0) {
    return {
      definition: GHOST_DEFINITION,
      count: 0,
      expected_trips: expected.length,
      showed_trips: 0,
      show_rate_pct: null as number | null,
      buses: [] as GhostBusRow[],
      interpretation:
        "No GPS in the last 15 minutes — poller may be down; cannot call no-shows.",
      route: resolved?.short_name ?? routeQ ?? null,
    };
  }

  if (expected.length === 0) {
    return {
      definition: GHOST_DEFINITION,
      count: 0,
      expected_trips: 0,
      showed_trips: 0,
      show_rate_pct: null as number | null,
      buses: [] as GhostBusRow[],
      interpretation: routeQ
        ? `No trips currently scheduled on route ${resolved?.short_name ?? routeQ} (started ≥8 min ago and still in their window).`
        : "No trips currently in their scheduled service window.",
      route: resolved?.short_name ?? routeQ ?? null,
    };
  }

  const tripIds = expected.map((t) => t.trip_id);
  const since = new Date(
    Math.min(...expected.map((t) => t.start_unix * 1000)) - 120_000
  );
  const seen = await pool.query(
    `SELECT DISTINCT trip_id
     FROM vehicle_positions
     WHERE time >= $1
       AND trip_id = ANY($2::text[])`,
    [since, tripIds]
  );
  const seenSet = new Set(seen.rows.map((r) => String(r.trip_id)));
  const ghosts = expected.filter((t) => !seenSet.has(t.trip_id));
  const showed = expected.length - ghosts.length;
  const showRate =
    expected.length > 0
      ? Math.round((1000 * showed) / expected.length) / 10
      : null;

  return {
    definition: GHOST_DEFINITION,
    count: ghosts.length,
    expected_trips: expected.length,
    showed_trips: showed,
    show_rate_pct: showRate,
    buses: ghosts.slice(0, 50).map(
      (t): GhostBusRow => ({
        trip_id: t.trip_id,
        route_id: t.route_short_name,
        gtfs_route_id: t.route_id,
        route_short_name: t.route_short_name,
        scheduled_start: new Date(t.start_unix * 1000).toISOString(),
        scheduled_end: new Date(t.end_unix * 1000).toISOString(),
        minutes_since_start: t.minutes_since_start,
      })
    ),
    interpretation:
      ghosts.length === 0
        ? `All ${expected.length} scheduled in-service trips have GPS.`
        : `${ghosts.length} of ${expected.length} scheduled trips never showed on GPS.`,
    route: resolved?.short_name ?? routeQ ?? null,
  };
}

type GhostBusRow = {
  trip_id: string;
  route_id: string;
  gtfs_route_id: string;
  route_short_name: string;
  scheduled_start: string;
  scheduled_end: string;
  minutes_since_start: number;
};

export async function getWorstRoutesToday(pool: pg.Pool) {
  const result = await pool.query(
    `
    SELECT
      route_id,
      ROUND(AVG(avg_delay_sec)::numeric, 1) AS avg_delay_sec,
      ROUND(AVG(on_time_pct)::numeric, 1) AS on_time_pct,
      SUM(sample_count)::bigint AS sample_count
    FROM route_reliability_15m
    WHERE bucket >= date_trunc('day', NOW())
    GROUP BY route_id
    HAVING SUM(sample_count) >= 5
    ORDER BY AVG(on_time_pct) ASC NULLS LAST
    LIMIT 10
    `
  );
  return {
    day: new Date().toISOString().slice(0, 10),
    worst: result.rows,
  };
}

export async function getReliabilityChart(pool: pg.Pool, hours = 4) {
  const result = await pool.query(
    `
    SELECT
      bucket,
      route_id,
      ROUND(on_time_pct::numeric, 1) AS on_time_pct,
      ROUND(avg_delay_sec::numeric, 1) AS avg_delay_sec,
      sample_count
    FROM route_reliability_15m
    WHERE bucket >= NOW() - ($1 || ' hours')::interval
    ORDER BY bucket ASC, route_id ASC
    `,
    [String(hours)]
  );
  return result.rows;
}

/**
 * Gaps between consecutive sighting timestamps on a route (last 2 hours).
 * Any gap > 15 minutes is flagged as a service gap.
 */
export async function getHeadwayGaps(pool: pg.Pool, routeId: string) {
  const route = String(routeId || "").trim();
  if (!route) {
    return { route: "", hours: 2, threshold_min: 15, gaps: [], error: "route_id required" };
  }

  const ids = await routeDbIds(route);
  const stats = await pool.query(
    `
    SELECT
      count(*)::int AS row_count,
      count(DISTINCT time)::int AS sighting_count,
      count(DISTINCT vehicle_id)::int AS vehicle_count,
      min(time) AS first_seen,
      max(time) AS last_seen
    FROM vehicle_positions
    WHERE route_id = ANY($1::text[])
      AND time >= NOW() - INTERVAL '2 hours'
    `,
    [ids]
  );
  const s = stats.rows[0] ?? {};

  const result = await pool.query(
    `
    WITH sightings AS (
      SELECT DISTINCT time
      FROM vehicle_positions
      WHERE route_id = ANY($1::text[])
        AND time >= NOW() - INTERVAL '2 hours'
    ),
    gaps AS (
      SELECT
        lag(time) OVER (ORDER BY time) AS gap_start,
        time AS gap_end,
        EXTRACT(EPOCH FROM (time - lag(time) OVER (ORDER BY time))) / 60.0 AS duration_min
      FROM sightings
    )
    SELECT
      gap_start,
      gap_end,
      ROUND(duration_min::numeric, 1) AS duration_min
    FROM gaps
    WHERE gap_start IS NOT NULL
    ORDER BY duration_min DESC
    `,
    [ids]
  );

  const allGaps = result.rows.map((r) => ({
    start: r.gap_start,
    end: r.gap_end,
    duration_min: Number(r.duration_min),
  }));
  const maxGapMin = allGaps.length ? allGaps[0].duration_min : null;
  const serviceGaps = allGaps
    .filter((g) => g.duration_min > 15)
    .slice(0, 50)
    .map((g) => ({ ...g, service_gap: true as const }));

  const sightingCount = Number(s.sighting_count ?? 0);

  return {
    route,
    hours: 2,
    threshold_min: 15,
    sighting_count: sightingCount,
    vehicle_count: Number(s.vehicle_count ?? 0),
    first_seen: s.first_seen ?? null,
    last_seen: s.last_seen ?? null,
    max_gap_min: maxGapMin,
    gap_count: serviceGaps.length,
    gaps: serviceGaps,
    // Explicit so models don't narrate "no data" as "no gaps"
    interpretation:
      sightingCount === 0
        ? "No vehicle sightings for this route in the last 2 hours — cannot assess headway gaps."
        : serviceGaps.length === 0
          ? `Sightings present (${sightingCount}); no gap exceeded ${15} minutes (largest was ${maxGapMin ?? "n/a"} min).`
          : `Found ${serviceGaps.length} service gap(s) over 15 minutes (largest ${maxGapMin} min).`,
  };
}
