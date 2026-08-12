import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const GTFS_URL = "https://itsmarta.com/google_transit_feed/google_transit.zip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const STOP_TIMES_PATH = path.join(DATA_DIR, "stop_times.txt");
const CACHE_PATH = path.join(DATA_DIR, "schedule-index.json");

/** trip_id|stop_id -> arrival seconds since service-day midnight (can be > 86400) */
export type ScheduleIndex = Map<string, number>;

let cached: ScheduleIndex | null = null;

export function scheduleKey(tripId: string, stopId: string): string {
  return `${tripId}|${stopId}`;
}

export function parseGtfsTimeToSeconds(timeStr: string): number {
  const [hh, mm, ss] = timeStr.trim().split(":").map(Number);
  return hh * 3600 + mm * 60 + (ss || 0);
}

/** MARTA August = EDT (UTC-4). Good enough for this hackathon. */
export function scheduledUnix(startDate: string, gtfsSeconds: number): number {
  const y = Number(startDate.slice(0, 4));
  const mo = Number(startDate.slice(4, 6)) - 1;
  const d = Number(startDate.slice(6, 8));
  const extraDays = Math.floor(gtfsSeconds / 86400);
  const secInDay = gtfsSeconds % 86400;
  const h = Math.floor(secInDay / 3600);
  const mi = Math.floor((secInDay % 3600) / 60);
  const s = secInDay % 60;
  // Interpret wall clock as EDT → UTC by adding 4 hours
  return Math.floor(Date.UTC(y, mo, d + extraDays, h + 4, mi, s) / 1000);
}

async function ensureStopTimes(): Promise<string> {
  if (fs.existsSync(STOP_TIMES_PATH)) return STOP_TIMES_PATH;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log("[schedule] downloading MARTA static GTFS…");
  const res = await fetch(GTFS_URL);
  if (!res.ok) throw new Error(`GTFS download failed: ${res.status}`);
  const zipPath = path.join(DATA_DIR, "google_transit.zip");
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(zipPath));

  const { execFileSync } = await import("node:child_process");
  execFileSync("unzip", ["-o", zipPath, "stop_times.txt", "-d", DATA_DIR], {
    stdio: "inherit",
  });
  return STOP_TIMES_PATH;
}

async function buildFromCsv(): Promise<ScheduleIndex> {
  const filePath = await ensureStopTimes();
  console.log("[schedule] indexing stop_times.txt (one-time)…");
  const index: ScheduleIndex = new Map();

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let header: string[] | null = null;
  let tripIdx = -1;
  let stopIdx = -1;
  let arrIdx = -1;

  for await (const line of rl) {
    if (!header) {
      header = line.split(",");
      tripIdx = header.indexOf("trip_id");
      stopIdx = header.indexOf("stop_id");
      arrIdx = header.indexOf("arrival_time");
      continue;
    }
    const cols = line.split(",");
    const tripId = cols[tripIdx]?.trim();
    const stopId = cols[stopIdx]?.trim();
    const arrival = cols[arrIdx];
    if (!tripId || !stopId || !arrival) continue;
    index.set(scheduleKey(tripId, stopId), parseGtfsTimeToSeconds(arrival));
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`[schedule] writing cache (${index.size} keys)…`);
  fs.writeFileSync(CACHE_PATH, JSON.stringify(Object.fromEntries(index)));
  return index;
}

export async function loadScheduleIndex(): Promise<ScheduleIndex> {
  if (cached) return cached;

  if (fs.existsSync(CACHE_PATH)) {
    console.log("[schedule] loading schedule-index.json…");
    const obj = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) as Record<
      string,
      number
    >;
    cached = new Map(Object.entries(obj));
    console.log(`[schedule] loaded ${cached.size} trip/stop arrivals`);
    return cached;
  }

  cached = await buildFromCsv();
  console.log(`[schedule] indexed ${cached.size} trip/stop arrivals`);
  return cached;
}
