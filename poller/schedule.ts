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
const TRIP_WINDOWS_PATH = path.join(DATA_DIR, "trip-windows.json");
const ZIP_PATH = path.join(DATA_DIR, "google_transit.zip");

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

async function ensureGtfsZip(): Promise<string> {
  if (fs.existsSync(ZIP_PATH)) return ZIP_PATH;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log("[schedule] downloading MARTA static GTFS…");
  const res = await fetch(GTFS_URL);
  if (!res.ok) throw new Error(`GTFS download failed: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(ZIP_PATH));
  return ZIP_PATH;
}

async function ensureGtfsFile(name: string, required = true): Promise<string | null> {
  const dest = path.join(DATA_DIR, name);
  if (fs.existsSync(dest)) return dest;
  const zipPath = await ensureGtfsZip();
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("unzip", ["-o", zipPath, name, "-d", DATA_DIR], {
      stdio: "inherit",
    });
  } catch (err) {
    if (!required) return null;
    throw err;
  }
  if (!fs.existsSync(dest)) {
    if (!required) return null;
    throw new Error(`GTFS missing ${name}`);
  }
  return dest;
}

async function ensureStopTimes(): Promise<string> {
  return (await ensureGtfsFile("stop_times.txt", true)) as string;
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

/** Compact trip row: trip_id, gtfs route_id, service_id, first_sec, last_sec */
export type TripRow = [string, string, string, number, number];

export type RouteMeta = { short_name: string; long_name: string };

export type CalendarService = {
  days: boolean[]; // index 0 = Sunday
  start: string;
  end: string;
};

export type CalendarException = {
  service_id: string;
  date: string;
  type: 1 | 2;
};

export type TripSchedule = {
  routes: Record<string, RouteMeta>;
  calendar: Record<string, CalendarService>;
  exceptions: CalendarException[];
  trips: TripRow[];
};

export type ResolvedRoute = {
  gtfs_route_id: string;
  short_name: string;
  long_name: string;
  db_ids: string[];
};

export type ExpectedTrip = {
  trip_id: string;
  route_id: string;
  route_short_name: string;
  service_date: string;
  start_unix: number;
  end_unix: number;
  minutes_since_start: number;
};

let tripCached: TripSchedule | null = null;
let tripLoad: Promise<TripSchedule> | null = null;

function parseCsvLine(line: string): string[] {
  return line.split(",").map((c) => c.trim());
}

function atlantaParts(d: Date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).map((p) => [p.type, p.value])
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    parts.weekday
  );
  return {
    ymd: `${parts.year}${parts.month}${parts.day}`,
    dow: weekday < 0 ? d.getDay() : weekday,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function shiftYmd(ymd: string, days: number): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function ymdDow(ymd: string): number {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

async function readCsv(
  filePath: string
): Promise<{ header: string[]; rows: string[][] }> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });
  let header: string[] | null = null;
  const rows: string[][] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (!header) {
      header = cols;
      continue;
    }
    rows.push(cols);
  }
  return { header: header ?? [], rows };
}

async function buildTripWindows(): Promise<TripSchedule> {
  const tripsPath = (await ensureGtfsFile("trips.txt", true)) as string;
  const calPath = (await ensureGtfsFile("calendar.txt", true)) as string;
  const routesPath = (await ensureGtfsFile("routes.txt", true)) as string;
  const datesPath = await ensureGtfsFile("calendar_dates.txt", false);
  const stopTimesPath = await ensureStopTimes();

  console.log("[schedule] building trip windows from GTFS…");

  const firstLast = new Map<string, { first: number; last: number }>();
  const st = readline.createInterface({
    input: fs.createReadStream(stopTimesPath),
    crlfDelay: Infinity,
  });
  let header: string[] | null = null;
  let tripIdx = -1;
  let arrIdx = -1;
  for await (const line of st) {
    if (!header) {
      header = parseCsvLine(line);
      tripIdx = header.indexOf("trip_id");
      arrIdx = header.indexOf("arrival_time");
      continue;
    }
    const cols = parseCsvLine(line);
    const tripId = cols[tripIdx];
    const arrival = cols[arrIdx];
    if (!tripId || !arrival) continue;
    const sec = parseGtfsTimeToSeconds(arrival);
    const cur = firstLast.get(tripId);
    if (!cur) firstLast.set(tripId, { first: sec, last: sec });
    else {
      if (sec < cur.first) cur.first = sec;
      if (sec > cur.last) cur.last = sec;
    }
  }

  const tripsFile = await readCsv(tripsPath);
  const tTrip = tripsFile.header.indexOf("trip_id");
  const tRoute = tripsFile.header.indexOf("route_id");
  const tSvc = tripsFile.header.indexOf("service_id");
  const trips: TripRow[] = [];
  for (const cols of tripsFile.rows) {
    const tripId = cols[tTrip];
    const routeId = cols[tRoute];
    const serviceId = cols[tSvc];
    const span = tripId ? firstLast.get(tripId) : undefined;
    if (!tripId || !routeId || !serviceId || !span) continue;
    trips.push([tripId, routeId, serviceId, span.first, span.last]);
  }

  const routesFile = await readCsv(routesPath);
  const rId = routesFile.header.indexOf("route_id");
  const rShort = routesFile.header.indexOf("route_short_name");
  const rLong = routesFile.header.indexOf("route_long_name");
  const routes: Record<string, RouteMeta> = {};
  for (const cols of routesFile.rows) {
    const id = cols[rId];
    if (!id) continue;
    routes[id] = {
      short_name: cols[rShort] || id,
      long_name: cols[rLong] || "",
    };
  }

  const calFile = await readCsv(calPath);
  const cId = calFile.header.indexOf("service_id");
  const cStart = calFile.header.indexOf("start_date");
  const cEnd = calFile.header.indexOf("end_date");
  const dayCols = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ].map((d) => calFile.header.indexOf(d));
  const calendar: Record<string, CalendarService> = {};
  for (const cols of calFile.rows) {
    const id = cols[cId];
    if (!id) continue;
    calendar[id] = {
      days: dayCols.map((i) => cols[i] === "1"),
      start: cols[cStart] || "19700101",
      end: cols[cEnd] || "20991231",
    };
  }

  const exceptions: CalendarException[] = [];
  if (datesPath) {
    const datesFile = await readCsv(datesPath);
    const dId = datesFile.header.indexOf("service_id");
    const dDate = datesFile.header.indexOf("date");
    const dType = datesFile.header.indexOf("exception_type");
    for (const cols of datesFile.rows) {
      const type = Number(cols[dType]) as 1 | 2;
      if (type !== 1 && type !== 2) continue;
      exceptions.push({
        service_id: cols[dId],
        date: cols[dDate],
        type,
      });
    }
  }

  const sched: TripSchedule = { routes, calendar, exceptions, trips };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TRIP_WINDOWS_PATH, JSON.stringify(sched));
  console.log(
    `[schedule] wrote trip-windows.json (${trips.length} trips, ${Object.keys(routes).length} routes)`
  );
  return sched;
}

export async function loadTripSchedule(): Promise<TripSchedule> {
  if (tripCached) return tripCached;
  if (tripLoad) return tripLoad;
  tripLoad = (async () => {
    if (fs.existsSync(TRIP_WINDOWS_PATH)) {
      console.log("[schedule] loading trip-windows.json…");
      tripCached = JSON.parse(
        fs.readFileSync(TRIP_WINDOWS_PATH, "utf8")
      ) as TripSchedule;
      console.log(
        `[schedule] loaded ${tripCached.trips.length} trip windows`
      );
      return tripCached;
    }
    tripCached = await buildTripWindows();
    return tripCached;
  })();
  try {
    return await tripLoad;
  } finally {
    tripLoad = null;
  }
}

export function resolveRoute(
  sched: TripSchedule,
  input: string
): ResolvedRoute {
  const q = String(input || "").trim();
  const lower = q.toLowerCase();
  for (const [id, meta] of Object.entries(sched.routes)) {
    if (
      id === q ||
      meta.short_name.toLowerCase() === lower ||
      meta.short_name.replace(/^0+/, "") === q.replace(/^0+/, "")
    ) {
      return {
        gtfs_route_id: id,
        short_name: meta.short_name,
        long_name: meta.long_name,
        db_ids: [...new Set([meta.short_name, id, q].filter(Boolean))],
      };
    }
  }
  return {
    gtfs_route_id: q,
    short_name: q,
    long_name: "",
    db_ids: q ? [q] : [],
  };
}

function activeServiceIds(sched: TripSchedule, ymd: string): Set<string> {
  const dow = ymdDow(ymd);
  const ids = new Set<string>();
  for (const [id, cal] of Object.entries(sched.calendar)) {
    if (ymd >= cal.start && ymd <= cal.end && cal.days[dow]) ids.add(id);
  }
  for (const ex of sched.exceptions) {
    if (ex.date !== ymd) continue;
    if (ex.type === 1) ids.add(ex.service_id);
    else ids.delete(ex.service_id);
  }
  return ids;
}

const GHOST_GRACE_SEC = 8 * 60;
const GHOST_STILL_OUT_SEC = 5 * 60;

/** Trips that should already be on the road (started ≥8m ago, not yet finished). */
export function tripsExpectedNow(
  sched: TripSchedule,
  opts: { route?: string; now?: Date } = {}
): ExpectedTrip[] {
  const now = opts.now ?? new Date();
  const nowUnix = Math.floor(now.getTime() / 1000);
  const today = atlantaParts(now).ymd;
  const dates = [today, shiftYmd(today, -1)];
  const resolved = opts.route ? resolveRoute(sched, opts.route) : null;
  const routeFilter = resolved
    ? new Set([resolved.gtfs_route_id, resolved.short_name])
    : null;

  const out: ExpectedTrip[] = [];
  const seen = new Set<string>();

  for (const ymd of dates) {
    const services = activeServiceIds(sched, ymd);
    if (services.size === 0) continue;
    for (const [tripId, routeId, serviceId, firstSec, lastSec] of sched.trips) {
      if (!services.has(serviceId)) continue;
      if (routeFilter && !routeFilter.has(routeId)) {
        const short = sched.routes[routeId]?.short_name;
        if (!short || !routeFilter.has(short)) continue;
      }
      const startUnix = scheduledUnix(ymd, firstSec);
      const endUnix = scheduledUnix(ymd, lastSec);
      if (nowUnix < startUnix + GHOST_GRACE_SEC) continue;
      if (nowUnix > endUnix + GHOST_STILL_OUT_SEC) continue;
      if (seen.has(tripId)) continue;
      seen.add(tripId);
      out.push({
        trip_id: tripId,
        route_id: routeId,
        route_short_name: sched.routes[routeId]?.short_name || routeId,
        service_date: ymd,
        start_unix: startUnix,
        end_unix: endUnix,
        minutes_since_start: Math.round((nowUnix - startUnix) / 60),
      });
    }
  }
  return out;
}

export function atlantaNowParts(d = new Date()) {
  return atlantaParts(d);
}
