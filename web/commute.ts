import type pg from "pg";
import {
  atlantaNowParts,
  loadTripSchedule,
  resolveRoute,
  scheduledUnix,
} from "../poller/schedule.js";
import {
  loadDestinationIndex,
  resolveDestination,
  type ResolvedDestination,
} from "./destinations.js";
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

export type AlternativeRoute = {
  route_id: string;
  on_time_pct: number | null;
  score?: number | null;
  serves_destination?: boolean;
};

export type CommuteQuery = {
  route?: string;
  destination?: string;
  stop_id?: string;
  lat?: number;
  lon?: number;
  arrive_by?: string;
};

type RouteScore = {
  route: string;
  route_long_name: string;
  excludeIds: string[];
  verdict: CommuteVerdict;
  headline: string;
  reason: string;
  score: number | null;
  metrics: {
    on_time_pct: number | null;
    avg_delay_min: number | null;
    hours: number;
    sample_count: number;
    expected_trips: number;
    ghost_count: number;
    show_rate_pct: number | null;
    last_seen: string | null;
    last_seen_min_ago: number | null;
    gap_count: number;
  };
  ghosts: unknown[];
};

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

/** Top routes by on-time % in the newest route_reliability_15m bucket. */
async function topReliableRoutesNow(
  pool: pg.Pool,
  excludeRouteIds: string[],
  limit = 3
): Promise<AlternativeRoute[]> {
  const exclude = excludeRouteIds.filter(Boolean);
  const result = await pool.query(
    `
    WITH latest_bucket AS (
      SELECT MAX(bucket) AS bucket
      FROM route_reliability_15m
    )
    SELECT
      r.route_id,
      ROUND(r.on_time_pct::numeric, 1) AS on_time_pct
    FROM route_reliability_15m r
    JOIN latest_bucket b ON r.bucket = b.bucket
    WHERE r.sample_count >= 5
      AND (
        cardinality($1::text[]) = 0
        OR NOT (r.route_id = ANY($1::text[]))
      )
    ORDER BY r.on_time_pct DESC NULLS LAST, r.sample_count DESC
    LIMIT $2
    `,
    [exclude, limit]
  );
  return result.rows.map((row) => ({
    route_id: String(row.route_id),
    on_time_pct: Number(row.on_time_pct),
  }));
}

async function scoreRoute(
  pool: pg.Pool,
  routeInput: string,
  arrive: ReturnType<typeof parseArriveBy>
): Promise<RouteScore> {
  const routeQ = String(routeInput || "").trim();
  const hours = 2;
  let resolved = {
    short_name: routeQ,
    long_name: "",
    gtfs_route_id: routeQ,
    db_ids: [routeQ] as string[],
  };
  try {
    const sched = await loadTripSchedule();
    resolved = resolveRoute(sched, routeQ);
  } catch {
    // still score from whatever is in the DB
  }

  const label = resolved.short_name || routeQ;
  const excludeIds = resolved.db_ids?.length
    ? resolved.db_ids
    : [resolved.gtfs_route_id || routeQ];

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

  const metricsBase = {
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
  };

  const noLive =
    sampleCount === 0 &&
    lastSeenMin == null &&
    (ghosts.interpretation?.includes("poller") ||
      ghosts.interpretation?.includes("cannot call no-shows"));

  if (noLive) {
    return {
      route: label,
      route_long_name: resolved.long_name,
      excludeIds,
      verdict: "toss_up",
      headline: `No live data for Route ${label} yet`,
      reason:
        "The poller may not have run — cannot tell you whether to trust this route.",
      score: null,
      metrics: {
        ...metricsBase,
        on_time_pct: null,
        avg_delay_min: null,
        expected_trips: 0,
        ghost_count: 0,
        show_rate_pct: null,
        last_seen: null,
        last_seen_min_ago: null,
        gap_count: 0,
        sample_count: 0,
      },
      ghosts: [],
    };
  }

  if (expected === 0 && (lastSeenMin == null || lastSeenMin > 30)) {
    return {
      route: label,
      route_long_name: resolved.long_name,
      excludeIds,
      verdict: "no_service",
      headline: `Route ${label} isn't running right now`,
      reason: resolved.long_name
        ? `${resolved.long_name} has no trips in their scheduled window right now. Don't wait on it.`
        : `No trips are scheduled on Route ${label} right now. Don't wait on it.`,
      score: 0,
      metrics: metricsBase,
      ghosts: [],
    };
  }

  const bits: string[] = [];
  let score = onTime ?? 55;

  if (onTime != null) {
    bits.push(`on-time is ${onTime.toFixed(0)}% over the last ${hours} hours`);
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
    arrive != null && arrive.minutes_until >= 0 && arrive.minutes_until <= 90;
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
    excludeIds,
    verdict,
    headline,
    reason,
    score,
    metrics: metricsBase,
    ghosts: ghosts.buses.slice(0, 8),
  };
}

function verdictRank(v: CommuteVerdict): number {
  if (v === "take_bus") return 3;
  if (v === "toss_up") return 2;
  if (v === "take_uber") return 1;
  return 0;
}

function withDestinationCopy(
  scored: RouteScore,
  dest: ResolvedDestination,
  arrive: ReturnType<typeof parseArriveBy>,
  preferredAsked: boolean
): RouteScore {
  const stopName = dest.stop.name;
  const by = arrive?.display ? ` by ${arrive.display}` : "";
  if (scored.verdict === "take_bus") {
    return {
      ...scored,
      headline: preferredAsked
        ? `Take Route ${scored.route} to ${stopName}`
        : `Best bet: Route ${scored.route} to ${stopName}`,
      reason: `${scored.reason.replace(/\.$/, "")} — gets you near ${stopName}${by}.`,
    };
  }
  if (scored.verdict === "toss_up") {
    return {
      ...scored,
      headline: `Risky: Route ${scored.route} → ${stopName}`,
      reason: `${scored.reason.replace(/\.$/, "")} Destination: ${stopName}${by}.`,
    };
  }
  if (scored.verdict === "no_service") {
    return {
      ...scored,
      headline: `Route ${scored.route} won't get you to ${stopName}`,
      reason: scored.reason,
    };
  }
  return {
    ...scored,
    headline: `Don't trust Route ${scored.route} for ${stopName} — Uber`,
    reason: `${scored.reason.replace(/\.$/, "")} Looking at routes that actually serve ${stopName}${by}.`,
  };
}

async function planForDestination(
  pool: pg.Pool,
  query: CommuteQuery,
  arrive: ReturnType<typeof parseArriveBy>
) {
  const index = await loadDestinationIndex();
  const dest = resolveDestination(index, {
    stop_id: query.stop_id,
    destination: query.destination,
    lat: query.lat,
    lon: query.lon,
  });
  if ("error" in dest) return dest;

  const preferred = String(query.route || "").trim();
  let candidates = [...dest.candidate_routes];
  if (preferred && !candidates.includes(preferred)) {
    // still score preferred, but mark that it may not serve the stop
    candidates = [preferred, ...candidates];
  }
  if (!candidates.length) {
    return {
      error: `No MARTA routes found near ${dest.stop.name}`,
      destination: {
        stop_id: dest.stop.id,
        stop_name: dest.stop.name,
        lat: dest.stop.lat,
        lon: dest.stop.lon,
      },
    };
  }

  // Cap for latency — prefer routes that appear in live reliability later via score
  const toScore = candidates.slice(0, preferred ? 9 : 8);
  if (preferred && !toScore.includes(preferred)) {
    toScore.unshift(preferred);
    toScore.length = Math.min(toScore.length, 9);
  }

  const scored = await Promise.all(
    toScore.map((r) => scoreRoute(pool, r, arrive))
  );

  const preferredScore = preferred
    ? scored.find(
        (s) =>
          s.route.toLowerCase() === preferred.toLowerCase() ||
          s.excludeIds.some((id) => id.toLowerCase() === preferred.toLowerCase())
      )
    : null;

  const serving = scored.filter((s) =>
    dest.candidate_routes.includes(s.route)
  );
  const ranked = (serving.length ? serving : scored).slice();
  ranked.sort((a, b) => {
    const vr = verdictRank(b.verdict) - verdictRank(a.verdict);
    if (vr !== 0) return vr;
    return (b.score ?? -1) - (a.score ?? -1);
  });

  // Prefer a user-named route only if it actually serves the destination.
  const preferredServes =
    !!preferredScore && dest.candidate_routes.includes(preferredScore.route);
  const primary =
    preferred && preferredScore && preferredServes
      ? preferredScore
      : ranked[0];

  const primaryDecorated = withDestinationCopy(
    primary,
    dest,
    arrive,
    Boolean(preferred && preferredServes)
  );

  const alts: AlternativeRoute[] = ranked
    .filter((s) => s.route !== primary.route)
    .slice(0, 3)
    .map((s) => ({
      route_id: s.route,
      on_time_pct: s.metrics.on_time_pct,
      score: s.score,
      serves_destination: true,
    }));

  // If primary is bad, surface destination-serving alts even on take_bus? only when needed
  const showAlts =
    primaryDecorated.verdict === "take_uber" ||
    primaryDecorated.verdict === "toss_up" ||
    primaryDecorated.verdict === "no_service";

  return {
    route: primaryDecorated.route,
    route_long_name: primaryDecorated.route_long_name,
    arrive_by: arrive?.display ?? null,
    minutes_until: arrive?.minutes_until ?? null,
    verdict: primaryDecorated.verdict,
    headline: primaryDecorated.headline,
    reason: primaryDecorated.reason,
    score: primaryDecorated.score,
    metrics: primaryDecorated.metrics,
    ghosts: primaryDecorated.ghosts,
    alternativeRoutes: showAlts ? alts : [],
    destination: {
      stop_id: dest.stop.id,
      stop_name: dest.stop.name,
      lat: dest.stop.lat,
      lon: dest.stop.lon,
      match: dest.match,
      nearby_stop_count: dest.nearby_stops.length,
      candidate_route_count: dest.candidate_routes.length,
    },
    preferred_route: preferred || null,
    preferred_serves_destination: preferred ? preferredServes : null,
  };
}

function normalizeQuery(
  routeOrQuery: string | CommuteQuery,
  arriveBy?: string
): CommuteQuery {
  if (typeof routeOrQuery === "string") {
    return { route: routeOrQuery, arrive_by: arriveBy };
  }
  return {
    ...routeOrQuery,
    arrive_by: routeOrQuery.arrive_by ?? arriveBy,
  };
}

/** Bus vs Uber — by preferred route and/or destination stop. */
export async function getCommuteVerdict(
  pool: pg.Pool,
  routeOrQuery: string | CommuteQuery,
  arriveBy?: string
) {
  const query = normalizeQuery(routeOrQuery, arriveBy);
  const routeQ = String(query.route || "").trim();
  const hasDest = Boolean(
    query.stop_id ||
      query.destination ||
      (query.lat != null && query.lon != null)
  );

  if (!routeQ && !hasDest) {
    return { error: "destination or route is required" };
  }

  const now = new Date();
  const arrive = parseArriveBy(query.arrive_by, now);

  if (hasDest) {
    return planForDestination(pool, query, arrive);
  }

  const scored = await scoreRoute(pool, routeQ, arrive);
  const alts =
    scored.verdict === "take_uber" || scored.verdict === "toss_up"
      ? await topReliableRoutesNow(pool, scored.excludeIds, 3)
      : [];

  return {
    route: scored.route,
    route_long_name: scored.route_long_name,
    arrive_by: arrive?.display ?? null,
    minutes_until: arrive?.minutes_until ?? null,
    verdict: scored.verdict,
    headline: scored.headline,
    reason: scored.reason,
    score: scored.score,
    metrics: scored.metrics,
    ghosts: scored.ghosts,
    alternativeRoutes: alts,
    destination: null,
  };
}
