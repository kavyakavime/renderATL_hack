import type pg from "pg";
import {
  atlantaNowParts,
  loadTripSchedule,
  resolveRoute,
  scheduledUnix,
} from "../poller/schedule.js";
import {
  getGhostBuses,
  getHeadwayGaps,
  getRouteReliability,
  routeDbIds,
} from "./tools.js";

export type CommuteVerdict =
  | "take_bus"
  | "take_uber"
  | "toss_up"
  | "no_service";

function avg(nums: number[]): number | null {
  const vals = nums.filter((n) => Number.isFinite(n));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function nextYmd(ymd: string): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, "0")}${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function parseArriveBy(
  arriveBy: string | undefined,
  now: Date
): { display: string; iso: string; minutes_until: number } | null {
  const m = String(arriveBy || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  const display = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const ymd = atlantaNowParts(now).ymd;
  let unix = scheduledUnix(ymd, hour * 3600 + minute * 60);
  let minutesUntil = Math.round((unix * 1000 - now.getTime()) / 60_000);
  if (minutesUntil < -30) {
    unix = scheduledUnix(nextYmd(ymd), hour * 3600 + minute * 60);
    minutesUntil = Math.round((unix * 1000 - now.getTime()) / 60_000);
  }
  return {
    display,
    iso: new Date(unix * 1000).toISOString(),
    minutes_until: minutesUntil,
  };
}

async function lastVehicleOnRoute(pool: pg.Pool, route: string) {
  const ids = await routeDbIds(route);
  if (!ids.length) return null;
  const result = await pool.query(
    `
    SELECT time, vehicle_id, trip_id, route_id
    FROM vehicle_positions
    WHERE route_id = ANY($1::text[])
      AND time >= NOW() - INTERVAL '2 hours'
    ORDER BY time DESC
    LIMIT 1
    `,
    [ids]
  );
  const row = result.rows[0];
  if (!row) return null;
  const lastSeen = new Date(row.time);
  return {
    last_seen: lastSeen.toISOString(),
    last_seen_min_ago: Math.max(
      0,
      Math.round((Date.now() - lastSeen.getTime()) / 60_000)
    ),
    vehicle_id: String(row.vehicle_id),
    trip_id: row.trip_id ? String(row.trip_id) : null,
  };
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

/** Bus vs Uber for a named route, from live reliability + scheduled no-shows. */
export async function getCommuteVerdict(
  pool: pg.Pool,
  routeInput: string,
  arriveBy?: string
) {
  const routeQ = String(routeInput || "").trim();
  if (!routeQ) {
    return { error: "route is required" };
  }

  const now = new Date();
  const hours = 2;
  let resolved = {
    short_name: routeQ,
    long_name: "",
    gtfs_route_id: routeQ,
  };
  try {
    const sched = await loadTripSchedule();
    resolved = resolveRoute(sched, routeQ);
  } catch {
    // still score from whatever is in the DB
  }

  const label = resolved.short_name || routeQ;
  const arrive = parseArriveBy(arriveBy, now);

  const [reliability, ghosts, gaps, lastSeen] = await Promise.all([
    getRouteReliability(pool, routeQ, hours),
    getGhostBuses(pool, routeQ),
    getHeadwayGaps(pool, routeQ),
    lastVehicleOnRoute(pool, routeQ),
  ]);

  const onTime = avg(reliability.points.map((p) => Number(p.on_time_pct)));
  const avgDelaySec = avg(
    reliability.points.map((p) => Number(p.avg_delay_sec))
  );
  const sampleCount = reliability.points.reduce(
    (n, p) => n + Number(p.sample_count || 0),
    0
  );
  const expected = ghosts.expected_trips;
  const ghostCount = ghosts.count;
  const showRate = ghosts.show_rate_pct;
  const lastSeenMin = lastSeen?.last_seen_min_ago ?? null;
  const gapCount = gaps.gap_count ?? 0;

  const noLive =
    sampleCount === 0 &&
    lastSeenMin == null &&
    (ghosts.interpretation?.includes("poller") ||
      ghosts.interpretation?.includes("cannot call no-shows"));

  if (noLive) {
    return {
      route: label,
      route_long_name: resolved.long_name,
      arrive_by: arrive?.display ?? null,
      minutes_until: arrive?.minutes_until ?? null,
      verdict: "toss_up" as CommuteVerdict,
      headline: `No live data for Route ${label} yet`,
      reason:
        "The poller may not have run — cannot tell you whether to trust this route.",
      score: null as number | null,
      metrics: {
        on_time_pct: null,
        avg_delay_min: null,
        hours,
        sample_count: 0,
        expected_trips: 0,
        ghost_count: 0,
        show_rate_pct: null,
        last_seen: null,
        last_seen_min_ago: null,
        gap_count: 0,
      },
    };
  }

  if (expected === 0 && (lastSeenMin == null || lastSeenMin > 30)) {
    return {
      route: label,
      route_long_name: resolved.long_name,
      arrive_by: arrive?.display ?? null,
      minutes_until: arrive?.minutes_until ?? null,
      verdict: "no_service" as CommuteVerdict,
      headline: `Route ${label} isn't running right now`,
      reason: resolved.long_name
        ? `${resolved.long_name} has no trips in their scheduled window right now. Don't wait on it.`
        : `No trips are scheduled on Route ${label} right now. Don't wait on it.`,
      score: 0,
      metrics: {
        on_time_pct: onTime == null ? null : Math.round(onTime * 10) / 10,
        avg_delay_min:
          avgDelaySec == null ? null : Math.round((avgDelaySec / 60) * 10) / 10,
        hours,
        sample_count: sampleCount,
        expected_trips: 0,
        ghost_count: 0,
        show_rate_pct: null,
        last_seen: lastSeen?.last_seen ?? null,
        last_seen_min_ago: lastSeenMin,
        gap_count: gapCount,
      },
    };
  }

  const bits: string[] = [];
  let score = onTime ?? 55;

  if (onTime != null) {
    bits.push(
      `on-time is ${onTime.toFixed(0)}% over the last ${hours} hours`
    );
  } else {
    bits.push("not enough delay samples yet");
  }

  if (expected > 0 && showRate != null) {
    score = score * 0.55 + showRate * 0.45;
    if (ghostCount === 0) {
      bits.push(`all ${expected} scheduled trips showed up on GPS`);
    } else {
      bits.push(
        `${ghostCount} of ${expected} scheduled trips never showed (ghosts)`
      );
      score -= Math.min(20, ghostCount * 8);
    }
  }

  if (lastSeenMin != null) {
    bits.push(`last bus seen ${lastSeenMin} min ago`);
    if (lastSeenMin > 20) score -= 12;
    if (lastSeenMin > 40) score -= 10;
  } else if (expected > 0) {
    bits.push("no GPS on this route recently");
    score -= 20;
  }

  if (gapCount > 0) {
    score -= Math.min(15, gapCount * 6);
    bits.push(`${gapCount} service gap(s) over 15 minutes`);
  }

  const tight =
    arrive != null &&
    arrive.minutes_until >= 0 &&
    arrive.minutes_until <= 90;
  if (tight) {
    bits.push(`you need to arrive by ${arrive.display}`);
    if (
      ghostCount > 0 ||
      (lastSeenMin != null && lastSeenMin > 15) ||
      (onTime != null && onTime < 60)
    ) {
      score -= 10;
    }
  }

  score = Math.round(clamp(score, 0, 100));

  let verdict: CommuteVerdict = "toss_up";
  if (score >= 75) verdict = "take_bus";
  else if (score < 50) verdict = "take_uber";

  const headline =
    verdict === "take_bus"
      ? `Take Route ${label}`
      : verdict === "take_uber"
        ? `Don't trust Route ${label} — Uber`
        : `Coin flip on Route ${label}`;

  const reason = `${bits[0] ? bits[0].charAt(0).toUpperCase() + bits[0].slice(1) : "Limited data"}${
    bits.length > 1 ? `, and ${bits.slice(1).join("; ")}` : ""
  }.`;

  return {
    route: label,
    route_long_name: resolved.long_name,
    arrive_by: arrive?.display ?? null,
    minutes_until: arrive?.minutes_until ?? null,
    verdict,
    headline,
    reason,
    score,
    metrics: {
      on_time_pct: onTime == null ? null : Math.round(onTime * 10) / 10,
      avg_delay_min:
        avgDelaySec == null ? null : Math.round((avgDelaySec / 60) * 10) / 10,
      hours,
      sample_count: sampleCount,
      expected_trips: expected,
      ghost_count: ghostCount,
      show_rate_pct: showRate,
      last_seen: lastSeen?.last_seen ?? null,
      last_seen_min_ago: lastSeenMin,
      gap_count: gapCount,
    },
    ghosts: ghosts.buses.slice(0, 8),
  };
}
