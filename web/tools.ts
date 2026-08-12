import type pg from "pg";

export async function getRouteReliability(
  pool: pg.Pool,
  route: string,
  hours: number
) {
  const h = Math.min(Math.max(Number(hours) || 4, 1), 48);
  const result = await pool.query(
    `
    SELECT
      bucket,
      route_id,
      ROUND(avg_delay_sec::numeric, 1) AS avg_delay_sec,
      ROUND(on_time_pct::numeric, 1) AS on_time_pct,
      sample_count
    FROM route_reliability_15m
    WHERE route_id = $1
      AND bucket >= NOW() - ($2 || ' hours')::interval
    ORDER BY bucket ASC
    `,
    [route, String(h)]
  );
  return {
    route,
    hours: h,
    points: result.rows,
  };
}

/** Ghost buses: recent vehicles whose trip has no stop-delay updates. */
export async function getGhostBuses(pool: pg.Pool) {
  const result = await pool.query(
    `
    WITH recent_vehicles AS (
      SELECT DISTINCT ON (vehicle_id)
        time,
        vehicle_id,
        route_id,
        trip_id,
        lat,
        lon,
        speed
      FROM vehicle_positions
      WHERE time >= NOW() - INTERVAL '15 minutes'
      ORDER BY vehicle_id, time DESC
    )
    SELECT
      rv.vehicle_id,
      rv.route_id,
      rv.trip_id,
      rv.lat,
      rv.lon,
      rv.speed,
      rv.time AS last_seen
    FROM recent_vehicles rv
    WHERE rv.trip_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM trip_delays td
        WHERE td.trip_id = rv.trip_id
          AND td.time >= NOW() - INTERVAL '15 minutes'
      )
    ORDER BY rv.route_id, rv.vehicle_id
    LIMIT 50
    `
  );
  return {
    definition:
      "Vehicles reporting a position in the last 15 minutes whose trip has no stop-time delay updates (possible ghost / stuck feed).",
    count: result.rows.length,
    buses: result.rows,
  };
}

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

  const result = await pool.query(
    `
    WITH sightings AS (
      SELECT DISTINCT time
      FROM vehicle_positions
      WHERE route_id = $1
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
      AND duration_min > 15
    ORDER BY duration_min DESC
    LIMIT 50
    `,
    [route]
  );

  return {
    route,
    hours: 2,
    threshold_min: 15,
    gap_count: result.rows.length,
    gaps: result.rows.map((r) => ({
      start: r.gap_start,
      end: r.gap_end,
      duration_min: Number(r.duration_min),
      service_gap: true,
    })),
  };
}

/** Aggregated reliability for report card (last 24h). */
export async function getReliabilitySummary24h(pool: pg.Pool) {
  const result = await pool.query(
    `
    SELECT
      route_id,
      ROUND(AVG(avg_delay_sec)::numeric, 1) AS avg_delay_sec,
      ROUND(AVG(on_time_pct)::numeric, 1) AS on_time_pct,
      SUM(sample_count)::bigint AS sample_count,
      MIN(bucket) AS first_bucket,
      MAX(bucket) AS last_bucket
    FROM route_reliability_15m
    WHERE bucket >= NOW() - INTERVAL '24 hours'
    GROUP BY route_id
    HAVING SUM(sample_count) >= 3
    ORDER BY AVG(on_time_pct) ASC NULLS LAST
    `
  );
  return result.rows;
}
