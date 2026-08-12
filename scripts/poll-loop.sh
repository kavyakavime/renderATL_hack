#!/usr/bin/env bash
# Fat-dev loop: poll MARTA every N seconds (default 30).
set -euo pipefail
INTERVAL="${1:-30}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
echo "[poll-loop] every ${INTERVAL}s — Ctrl+C to stop"
while true; do
  npm run poll || echo "[poll-loop] poll failed, retrying next cycle"
  sleep "$INTERVAL"
done
