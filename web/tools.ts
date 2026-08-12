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
