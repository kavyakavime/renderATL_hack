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
const ZIP_PATH = path.join(DATA_DIR, "google_transit.zip");
const CACHE_PATH = path.join(DATA_DIR, "stop-routes.json");

export type StopInfo = {
  id: string;
  name: string;
  lat: number;
  lon: number;
};

export type DestinationIndex = {
  built_at: string;
  stops: StopInfo[];
  /** stop_id → route short names that serve it */
  routesByStop: Record<string, string[]>;
};

let cached: DestinationIndex | null = null;
let loadPromise: Promise<DestinationIndex> | null = null;

async function ensureGtfsZip(): Promise<string> {
  if (fs.existsSync(ZIP_PATH)) return ZIP_PATH;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log("[destinations] downloading MARTA static GTFS…");
  const res = await fetch(GTFS_URL);
  if (!res.ok) throw new Error(`GTFS download failed: ${res.status}`);
  await pipeline(
    Readable.fromWeb(res.body as never),
    createWriteStream(ZIP_PATH)
  );
  return ZIP_PATH;
}

async function ensureGtfsFile(name: string): Promise<string> {
  const dest = path.join(DATA_DIR, name);
  if (fs.existsSync(dest)) return dest;
  const zipPath = await ensureGtfsZip();
  const { execFileSync } = await import("node:child_process");
  execFileSync("unzip", ["-o", zipPath, name, "-d", DATA_DIR], {
    stdio: "inherit",
  });
  if (!fs.existsSync(dest)) throw new Error(`GTFS missing ${name}`);
  return dest;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

async function buildIndex(): Promise<DestinationIndex> {
  const [stopsPath, tripsPath, routesPath, stopTimesPath] = await Promise.all([
    ensureGtfsFile("stops.txt"),
    ensureGtfsFile("trips.txt"),
    ensureGtfsFile("routes.txt"),
    ensureGtfsFile("stop_times.txt"),
  ]);

  console.log("[destinations] building stop→routes index…");

  const routeShort = new Map<string, string>();
  {
    const rl = readline.createInterface({
      input: fs.createReadStream(routesPath),
      crlfDelay: Infinity,
    });
    let header: string[] | null = null;
    let idIdx = -1;
    let shortIdx = -1;
    for await (const line of rl) {
      if (!line.trim()) continue;
      const cols = parseCsvLine(line);
      if (!header) {
        header = cols;
        idIdx = header.indexOf("route_id");
        shortIdx = header.indexOf("route_short_name");
        continue;
      }
      const id = cols[idIdx];
      const short = cols[shortIdx] || id;
      if (id) routeShort.set(id, short);
    }
  }

  const tripRoute = new Map<string, string>();
  {
    const rl = readline.createInterface({
      input: fs.createReadStream(tripsPath),
      crlfDelay: Infinity,
    });
    let header: string[] | null = null;
    let tripIdx = -1;
    let routeIdx = -1;
    for await (const line of rl) {
      if (!line.trim()) continue;
      const cols = parseCsvLine(line);
      if (!header) {
        header = cols;
        tripIdx = header.indexOf("trip_id");
        routeIdx = header.indexOf("route_id");
        continue;
      }
      const tripId = cols[tripIdx];
      const routeId = cols[routeIdx];
      if (!tripId || !routeId) continue;
      const short = routeShort.get(routeId) || routeId;
      tripRoute.set(tripId, short);
    }
  }

  const routesByStop = new Map<string, Set<string>>();
  {
    const rl = readline.createInterface({
      input: fs.createReadStream(stopTimesPath),
      crlfDelay: Infinity,
    });
    let header: string[] | null = null;
    let tripIdx = -1;
    let stopIdx = -1;
    for await (const line of rl) {
      if (!line.trim()) continue;
      const cols = parseCsvLine(line);
      if (!header) {
        header = cols;
        tripIdx = header.indexOf("trip_id");
        stopIdx = header.indexOf("stop_id");
        continue;
      }
      const tripId = cols[tripIdx];
      const stopId = cols[stopIdx];
      if (!tripId || !stopId) continue;
      const route = tripRoute.get(tripId);
      if (!route) continue;
      let set = routesByStop.get(stopId);
      if (!set) {
        set = new Set();
        routesByStop.set(stopId, set);
      }
      set.add(route);
    }
  }

  const stops: StopInfo[] = [];
  {
    const rl = readline.createInterface({
      input: fs.createReadStream(stopsPath),
      crlfDelay: Infinity,
    });
    let header: string[] | null = null;
    let idIdx = -1;
    let nameIdx = -1;
    let latIdx = -1;
    let lonIdx = -1;
    for await (const line of rl) {
      if (!line.trim()) continue;
      const cols = parseCsvLine(line);
      if (!header) {
        header = cols;
        idIdx = header.indexOf("stop_id");
        nameIdx = header.indexOf("stop_name");
        latIdx = header.indexOf("stop_lat");
        lonIdx = header.indexOf("stop_lon");
        continue;
      }
      const id = cols[idIdx];
      const name = cols[nameIdx];
      const lat = Number(cols[latIdx]);
      const lon = Number(cols[lonIdx]);
      if (!id || !name || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        continue;
      }
      stops.push({ id, name, lat, lon });
    }
  }

  const index: DestinationIndex = {
    built_at: new Date().toISOString(),
    stops,
    routesByStop: Object.fromEntries(
      [...routesByStop.entries()].map(([k, v]) => [k, [...v].sort()])
    ),
  };

  fs.writeFileSync(CACHE_PATH, JSON.stringify(index));
  console.log(
    `[destinations] wrote stop-routes.json (${stops.length} stops, ${routesByStop.size} with routes)`
  );
  return index;
}

export async function loadDestinationIndex(): Promise<DestinationIndex> {
  if (cached) return cached;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    if (fs.existsSync(CACHE_PATH)) {
      console.log("[destinations] loading stop-routes.json…");
      cached = JSON.parse(
        fs.readFileSync(CACHE_PATH, "utf8")
      ) as DestinationIndex;
      console.log(
        `[destinations] loaded ${cached.stops.length} stops`
      );
      return cached;
    }
    cached = await buildIndex();
    return cached;
  })();
  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function searchStops(
  index: DestinationIndex,
  query: string,
  limit = 12
): StopInfo[] {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const scored: { stop: StopInfo; rank: number }[] = [];
  for (const stop of index.stops) {
    const name = stop.name.toLowerCase();
    if (!name.includes(q)) continue;
    let rank = 2;
    if (name.startsWith(q)) rank = 0;
    else if (name.split(/\W+/).some((w) => w.startsWith(q))) rank = 1;
    scored.push({ stop, rank });
  }
  scored.sort(
    (a, b) => a.rank - b.rank || a.stop.name.localeCompare(b.stop.name)
  );
  return scored.slice(0, limit).map((s) => s.stop);
}

/**
 * Landmarks riders actually type — GTFS stop names are street intersections
 * ("NORTH AVE NW @ LUCKIE ST NW"), so "Georgia Tech" matches nothing without
 * this. Each alias resolves to coords + a wider radius to catch the corridors
 * around the landmark.
 */
const LANDMARKS: Array<{
  keys: string[];
  name: string;
  lat: number;
  lon: number;
  radius_m: number;
}> = [
  {
    keys: ["georgia tech", "gatech", "ga tech", "gt", "georgia institute of technology", "tech campus", "culc"],
    name: "Georgia Tech campus",
    lat: 33.7756,
    lon: -84.3937,
    radius_m: 900,
  },
  {
    keys: ["tech square", "scheller"],
    name: "Tech Square",
    lat: 33.7767,
    lon: -84.3893,
    radius_m: 600,
  },
  {
    keys: ["georgia state", "gsu"],
    name: "Georgia State University",
    lat: 33.7531,
    lon: -84.3853,
    radius_m: 600,
  },
  {
    keys: ["airport", "hartsfield", "atl airport"],
    name: "Airport Station",
    lat: 33.6407,
    lon: -84.4463,
    radius_m: 600,
  },
  {
    keys: ["ponce city market", "pcm"],
    name: "Ponce City Market",
    lat: 33.7726,
    lon: -84.3665,
    radius_m: 600,
  },
  {
    keys: ["mercedes", "benz stadium", "mercedes-benz stadium"],
    name: "Mercedes-Benz Stadium",
    lat: 33.7554,
    lon: -84.4008,
    radius_m: 700,
  },
  {
    keys: ["lenox", "buckhead mall"],
    name: "Lenox Square",
    lat: 33.8463,
    lon: -84.3621,
    radius_m: 700,
  },
  {
    keys: ["piedmont park"],
    name: "Piedmont Park",
    lat: 33.7851,
    lon: -84.3738,
    radius_m: 700,
  },
  {
    keys: ["little five points", "l5p"],
    name: "Little Five Points",
    lat: 33.7651,
    lon: -84.3494,
    radius_m: 600,
  },
];

export function matchLandmark(query: string) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return null;
  for (const lm of LANDMARKS) {
    if (lm.keys.some((k) => q === k || q.includes(k))) return lm;
  }
  return null;
}

export type ResolvedDestination = {
  stop: StopInfo;
  nearby_stops: Array<StopInfo & { distance_m: number }>;
  candidate_routes: string[];
  match: "stop_id" | "search" | "coords";
};

/** Resolve a destination to a stop + routes that serve it (and nearby stops). */
export function resolveDestination(
  index: DestinationIndex,
  opts: {
    stop_id?: string;
    destination?: string;
    lat?: number;
    lon?: number;
    radius_m?: number;
  }
): ResolvedDestination | { error: string } {
  let radius = opts.radius_m ?? 450;
  let stop: StopInfo | null = null;
  let match: ResolvedDestination["match"] = "search";

  // Landmark aliases win over raw stop-name search ("Georgia Tech" would
  // otherwise match Georgia Piedmont Tech on Memorial Dr, or nothing).
  if (!opts.stop_id && opts.destination && opts.lat == null) {
    const lm = matchLandmark(opts.destination);
    if (lm) {
      opts = { ...opts, lat: lm.lat, lon: lm.lon, destination: undefined };
      radius = Math.max(radius, lm.radius_m);
    }
  }

  if (opts.stop_id) {
    stop = index.stops.find((s) => s.id === opts.stop_id) ?? null;
    match = "stop_id";
    if (!stop) return { error: `Unknown stop_id ${opts.stop_id}` };
  } else if (
    opts.lat != null &&
    opts.lon != null &&
    Number.isFinite(opts.lat) &&
    Number.isFinite(opts.lon)
  ) {
    let best: StopInfo | null = null;
    let bestD = Infinity;
    for (const s of index.stops) {
      const d = haversineMeters(opts.lat, opts.lon, s.lat, s.lon);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (!best || bestD > 1500) {
      return { error: "No MARTA stop within 1.5 km of that location" };
    }
    stop = best;
    match = "coords";
  } else if (opts.destination) {
    const hits = searchStops(index, opts.destination, 1);
    if (!hits.length) {
      return {
        error: `No MARTA stop matching “${opts.destination}”. Try a stop name like “North Ave Station” or “Georgia Tech”.`,
      };
    }
    stop = hits[0];
    match = "search";
  } else {
    return { error: "destination, stop_id, or lat/lon is required" };
  }

  const nearby: Array<StopInfo & { distance_m: number }> = [];
  for (const s of index.stops) {
    const d = haversineMeters(stop.lat, stop.lon, s.lat, s.lon);
    if (d <= radius) {
      nearby.push({ ...s, distance_m: Math.round(d) });
    }
  }
  nearby.sort((a, b) => a.distance_m - b.distance_m);

  const routeSet = new Set<string>();
  for (const s of nearby) {
    for (const r of index.routesByStop[s.id] || []) routeSet.add(r);
  }

  return {
    stop,
    nearby_stops: nearby.slice(0, 12),
    candidate_routes: [...routeSet].sort(),
    match,
  };
}
