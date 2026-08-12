-- Commute briefings written by the Render Workflow (Gemini over Tiger data).

CREATE TABLE IF NOT EXISTS briefings (
  id           BIGSERIAL PRIMARY KEY,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  audience     TEXT NOT NULL DEFAULT 'georgia-tech',
  body_md      TEXT NOT NULL,
  stats        JSONB
);

CREATE INDEX IF NOT EXISTS idx_briefings_latest
  ON briefings (audience, generated_at DESC);
