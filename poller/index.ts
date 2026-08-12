import "dotenv/config";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { createPool } from "../web/db.js";
import {
  loadScheduleIndex,
  loadTripSchedule,
  scheduleKey,
  scheduledUnix,
  type ScheduleIndex,
} from "./schedule.js";

const VEHICLE_URL =
  "https://gtfs-rt.itsmarta.com/TMGTFSRealTimeWebService/vehicle/vehiclepositions.pb";
const TRIP_UPDATE_URL =
  "https://gtfs-rt.itsmarta.com/TMGTFSRealTimeWebService/tripupdate/tripupdates.pb";

type VehicleRow = {
  time: Date;
  vehicle_id: string;
  route_id: string | null;
  trip_id: string | null;
  lat: number | null;
  lon: number | null;
  speed: number | null;
};

type DelayRow = {
  time: Date;
  trip_id: string | null;
  route_id: string | null;
  stop_id: string | null;
  delay_sec: number;
};

async function fetchFeed(url: string) {
  const res = await fetch(url, {
    headers: { Accept: "application/x-protobuf, application/octet-stream, */*" },
  });
  if (!res.ok) {
    throw new Error(`Fetch failed ${url}: ${res.status} ${res.statusText}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);
}

function toNumber(seconds: unknown): number | null {
  if (seconds == null) return null;
  const n =
    typeof seconds === "object" &&
    seconds !== null &&
    "toNumber" in seconds &&
    typeof (seconds as { toNumber: unknown }).toNumber === "function"
      ? (seconds as { toNumber: () => number }).toNumber()
      : Number(seconds);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toDateFromUnix(seconds: unknown, fallback: Date): Date {
  const n = toNumber(seconds);
  return n == null ? fallback : new Date(n * 1000);
}

/** Prefer real delay field; else predicted time − static schedule. */
function delayForStopUpdate(
  stu: GtfsRealtimeBindings.transit_realtime.IStopTimeUpdate,
  tripId: string | null,
  startDate: string | null | undefined,
  schedule: ScheduleIndex
): number | null {
  const events = [stu.arrival, stu.departure].filter(Boolean);
  for (const ev of events) {
    if (!ev) continue;
    const json = typeof ev.toJSON === "function" ? ev.toJSON() : (ev as object);
    if (json && (json as { delay?: unknown }).delay != null) {
      const d = Number((json as { delay: unknown }).delay);
      if (Number.isFinite(d)) return Math.trunc(d);
    }
  }

  if (!tripId || !startDate || !stu.stopId) return null;
  const schedSec = schedule.get(scheduleKey(tripId, stu.stopId));
  if (schedSec == null) return null;

  for (const ev of events) {
    const predicted = toNumber(ev?.time);
    if (predicted == null) continue;
    return predicted - scheduledUnix(startDate, schedSec);
  }
  return null;
}

function parseVehicles(feed: GtfsRealtimeBindings.transit_realtime.FeedMessage): {
  rows: VehicleRow[];
  routeIds: Set<string>;
} {
  const now = new Date();
  const rows: VehicleRow[] = [];
  const routeIds = new Set<string>();

  for (const entity of feed.entity) {
    const v = entity.vehicle;
    if (!v) continue;

    const vehicleId =
      v.vehicle?.id || v.vehicle?.label || entity.id || null;
    if (!vehicleId) continue;

    const routeId = v.trip?.routeId || null;
    const tripId = v.trip?.tripId || null;
    if (routeId) routeIds.add(routeId);

    rows.push({
      time: toDateFromUnix(v.timestamp, now),
      vehicle_id: String(vehicleId),
      route_id: routeId,
      trip_id: tripId,
      lat: v.position?.latitude ?? null,
      lon: v.position?.longitude ?? null,
      speed: v.position?.speed ?? null,
    });
  }

  return { rows, routeIds };
}

function parseDelays(
  feed: GtfsRealtimeBindings.transit_realtime.FeedMessage,
  schedule: ScheduleIndex
): { rows: DelayRow[]; routeIds: Set<string> } {
  const now = new Date();
  const rows: DelayRow[] = [];
  const routeIds = new Set<string>();

  for (const entity of feed.entity) {
    const tu = entity.tripUpdate;
    if (!tu) continue;

    const tripId = tu.trip?.tripId || null;
    const routeId = tu.trip?.routeId || null;
    const startDate = tu.trip?.startDate || null;
    if (routeId) routeIds.add(routeId);

    const eventTime = toDateFromUnix(tu.timestamp, now);

    for (const stu of tu.stopTimeUpdate ?? []) {
      const delay = delayForStopUpdate(stu, tripId, startDate, schedule);
      if (delay == null || !Number.isFinite(delay)) continue;

      rows.push({
        time: eventTime,
        trip_id: tripId,
        route_id: routeId,
        stop_id: stu.stopId || null,
        delay_sec: Math.trunc(delay),
      });
    }
  }

  return { rows, routeIds };
}

async function insertVehiclePositions(
  pool: ReturnType<typeof createPool>,
  rows: VehicleRow[]
): Promise<number> {
  if (rows.length === 0) return 0;

  const client = await pool.connect();
  try {
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let i = 1;
    for (const r of rows) {
      placeholders.push(
        `($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`
      );
      values.push(
        r.time,
        r.vehicle_id,
        r.route_id,
        r.trip_id,
        r.lat,
        r.lon,
        r.speed
      );
    }
    await client.query(
      `INSERT INTO vehicle_positions
        (time, vehicle_id, route_id, trip_id, lat, lon, speed)
       VALUES ${placeholders.join(",")}`,
      values
    );
    return rows.length;
  } finally {
    client.release();
  }
}

async function insertTripDelays(
  pool: ReturnType<typeof createPool>,
  rows: DelayRow[]
): Promise<number> {
  if (rows.length === 0) return 0;

  const chunkSize = 500;
  let inserted = 0;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let i = 1;
    for (const r of chunk) {
      placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
      values.push(r.time, r.trip_id, r.route_id, r.stop_id, r.delay_sec);
    }
    await pool.query(
      `INSERT INTO trip_delays (time, trip_id, route_id, stop_id, delay_sec)
       VALUES ${placeholders.join(",")}`,
      values
    );
    inserted += chunk.length;
  }
  return inserted;
}

async function upsertRoutes(
  pool: ReturnType<typeof createPool>,
  routeIds: Set<string>
): Promise<void> {
  if (routeIds.size === 0) return;
  const ids = [...routeIds];
  const values: unknown[] = [];
  const placeholders: string[] = [];
  let i = 1;
  for (const id of ids) {
    placeholders.push(`($${i++})`);
    values.push(id);
  }
  await pool.query(
    `INSERT INTO routes (route_id)
     VALUES ${placeholders.join(",")}
     ON CONFLICT (route_id) DO UPDATE SET last_seen = NOW()`,
    values
  );
}

async function main() {
  console.log(`[poller] fetching MARTA GTFS-RT @ ${new Date().toISOString()}`);

  const schedule = await loadScheduleIndex();
  try {
    await loadTripSchedule();
  } catch (err) {
    console.warn("[poller] trip windows (ghosts) failed:", err);
  }

  const [vehicleFeed, tripFeed] = await Promise.all([
    fetchFeed(VEHICLE_URL),
    fetchFeed(TRIP_UPDATE_URL),
  ]);

  const vehicles = parseVehicles(vehicleFeed);
  const delays = parseDelays(tripFeed, schedule);

  const routeIds = new Set([...vehicles.routeIds, ...delays.routeIds]);
  const nonzero = delays.rows.filter((r) => r.delay_sec !== 0).length;

  const pool = createPool();
  try {
    const [vpCount, delayCount] = await Promise.all([
      insertVehiclePositions(pool, vehicles.rows),
      insertTripDelays(pool, delays.rows),
    ]);
    await upsertRoutes(pool, routeIds);

    console.log(
      `[poller] inserted vehicle_positions=${vpCount} trip_delays=${delayCount} (nonzero_delay=${nonzero}) routes_seen=${routeIds.size}`
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[poller] failed:", err);
  process.exit(1);
});
