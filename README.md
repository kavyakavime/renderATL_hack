# Transit Ledger ATL

Hackathon build: poll **MARTA GTFS-RT** feeds into TimescaleDB, chart route reliability, and ask Gemini about the data.

## What you get

| Piece | Role |
| --- | --- |
| `poller/` | HTTPS `.pb` feeds → delay vs static GTFS → `vehicle_positions` / `trip_delays` |
| `migrations/001_init.sql` | Hypertables, `routes`, continuous aggregate `route_reliability_15m`, compression |
| `web/` | Express dashboard (Chart.js + Leaflet) + `/api/chat` with Gemini function calling |

## Prerequisites

- Node.js 20+
- TimescaleDB / Tiger Cloud Postgres (`DATABASE_URL`)
- Gemini API key (`GEMINI_API_KEY`) from [Google AI Studio](https://aistudio.google.com/apikey)
- `unzip` (for static GTFS on first poll)

## Setup (once)

```bash
cp .env.example .env
# edit .env — DATABASE_URL + GEMINI_API_KEY

npm install
npm run migrate
```

## Run locally — **2 terminals**

**Terminal 1 — poller (every 30s):**
```bash
npm run poll:loop
```

**Terminal 2 — dashboard:**
```bash
npm run web
```

Open [http://localhost:3000](http://localhost:3000).

First poll downloads MARTA static GTFS and builds `data/schedule-index.json` (~55MB, gitignored) so delays are real (MARTA RT only sends absolute times, not `delay`).

## Deploy on Render

`render.yaml` defines:

1. **Web** `marta-receipts-web` → `npm run web`
2. **Cron** `marta-receipts-poller` → `npm run poll` every minute

Steps:

1. Push this repo to GitHub
2. Render Dashboard → **New** → **Blueprint** → select the repo
3. Set env vars (both services need `DATABASE_URL`; web also needs `GEMINI_API_KEY`)
4. Deploy

## Env vars

| Var | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Timescale/Tiger connection string |
| `GEMINI_API_KEY` | yes (chat) | Google AI Studio key |
| `GEMINI_MODEL` | no | Defaults to `gemini-3.1-flash-lite` |
| `PORT` | no | Default `3000` |

## Notes

- Product name: **Transit Ledger ATL** (data source: MARTA GTFS-RT)
- On-time = `|delay_sec| <= 300`
- Ghost buses = scheduled trips that should already be in service but never appeared in GPS
- Default feeds: `…/vehiclepositions.pb` and `…/tripupdates.pb` (HTTPS; short paths 301 to blocked `:80`)
