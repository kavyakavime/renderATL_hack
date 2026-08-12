import type pg from "pg";

/**
 * Latest vehicle positions (last 5 minutes) with route on-time coloring
 * from the newest route_reliability_15m bucket.
 */
export async function getLatestVehicles(pool: pg.Pool) {
  const result = await pool.query(
    `
    WITH latest_vehicles AS (
      SELECT DISTINCT ON (vehicle_id)
        vehicle_id,
        route_id,
        trip_id,
        lat,
        lon,
        speed,
        time AS last_seen
      FROM vehicle_positions
      WHERE time >= NOW() - INTERVAL '5 minutes'
        AND lat IS NOT NULL
        AND lon IS NOT NULL
      ORDER BY vehicle_id, time DESC
    ),
    latest_bucket AS (
      SELECT MAX(bucket) AS bucket
      FROM route_reliability_15m
    ),
    route_ontime AS (
      SELECT r.route_id, r.on_time_pct, r.bucket
      FROM route_reliability_15m r
      JOIN latest_bucket b ON r.bucket = b.bucket
    )
    SELECT
      v.vehicle_id,
      v.route_id,
      v.trip_id,
      v.lat,
      v.lon,
      v.speed,
      v.last_seen,
      ROUND(o.on_time_pct::numeric, 1) AS on_time_pct
    FROM latest_vehicles v
    LEFT JOIN route_ontime o ON o.route_id = v.route_id
    ORDER BY v.route_id, v.vehicle_id
    `
  );

  return {
    generated_at: new Date().toISOString(),
    count: result.rows.length,
    vehicles: result.rows.map((r) => {
      const onTime =
        r.on_time_pct == null ? null : Number(r.on_time_pct);
      let color: "green" | "yellow" | "red" | "gray" = "gray";
      if (onTime != null) {
        if (onTime > 80) color = "green";
        else if (onTime >= 50) color = "yellow";
        else color = "red";
      }
      return {
        vehicle_id: r.vehicle_id,
        route_id: r.route_id,
        trip_id: r.trip_id,
        lat: Number(r.lat),
        lon: Number(r.lon),
        speed: r.speed == null ? null : Number(r.speed),
        last_seen: r.last_seen,
        on_time_pct: onTime,
        color,
      };
    }),
  };
}
