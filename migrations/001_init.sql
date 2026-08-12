-- MARTA Receipts — TimescaleDB schema
-- Run against a Timescale/Tiger Postgres instance (timescaledb extension enabled).

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------------------------------------------------------------------------
-- Raw feeds
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vehicle_positions (
  time        TIMESTAMPTZ NOT NULL,
  vehicle_id  TEXT NOT NULL,
  route_id    TEXT,
  trip_id     TEXT,
  lat         DOUBLE PRECISION,
  lon         DOUBLE PRECISION,
  speed       DOUBLE PRECISION
);

SELECT create_hypertable('vehicle_positions', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_vp_vehicle_time
  ON vehicle_positions (vehicle_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_vp_route_time
  ON vehicle_positions (route_id, time DESC);

CREATE TABLE IF NOT EXISTS trip_delays (
  time        TIMESTAMPTZ NOT NULL,
  trip_id     TEXT,
  route_id    TEXT,
  stop_id     TEXT,
  delay_sec   INTEGER
);

SELECT create_hypertable('trip_delays', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_td_route_time
  ON trip_delays (route_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_td_trip_time
  ON trip_delays (trip_id, time DESC);

-- ---------------------------------------------------------------------------
-- Route metadata (upserted by poller when seen in feeds)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS routes (
  route_id         TEXT PRIMARY KEY,
  route_short_name TEXT,
  route_long_name  TEXT,
  first_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Continuous aggregate: 15-min route reliability
-- on-time = |delay_sec| <= 300 (5 minutes)
-- ---------------------------------------------------------------------------

CREATE MATERIALIZED VIEW IF NOT EXISTS route_reliability_15m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('15 minutes', time) AS bucket,
  route_id,
  AVG(delay_sec)::DOUBLE PRECISION AS avg_delay_sec,
  (
    100.0 * COUNT(*) FILTER (WHERE ABS(delay_sec) <= 300)
    / NULLIF(COUNT(*), 0)
  )::DOUBLE PRECISION AS on_time_pct,
  COUNT(*)::BIGINT AS sample_count
FROM trip_delays
WHERE route_id IS NOT NULL
  AND delay_sec IS NOT NULL
GROUP BY 1, 2
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'route_reliability_15m',
  start_offset      => INTERVAL '3 hours',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists     => TRUE
);

-- ---------------------------------------------------------------------------
-- Compression on vehicle_positions after 2 hours
-- ---------------------------------------------------------------------------

ALTER TABLE vehicle_positions SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'route_id,vehicle_id',
  timescaledb.compress_orderby = 'time DESC'
);

SELECT add_compression_policy(
  'vehicle_positions',
  compress_after => INTERVAL '2 hours',
  if_not_exists  => TRUE
);
