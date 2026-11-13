// Builds the data for the Now and Plan tabs: energy, schedule, forecast, projection, headline.

import { integrateSpan, sumRows, type HourRow, type PowerSample } from "./energy.ts";
import { headline, type Headline } from "./headline.ts";
import { POWER_COLS, dayFromRow, type JobStatus } from "./jobs.ts";
import { SWITCH_GRACE_MS, loadProfile, project, typicalOutageMs, type Confidence, type Interval, type Projection } from "./projection.ts";
import { DEFAULT_BATTERY, DEFAULT_PHASES, getAllConfig, type BatteryConfig, type PhaseNames } from "./settings.ts";
import { forecastEnergy, type ForecastPeriod, type SolcastBudget } from "./solcast.ts";
import { DAY, HOUR, addDays, kyivDate, kyivMidnight, kyivTime } from "./time.ts";
import { loudHours, scheduleApplies, type AddressState, type OutageDay } from "./yasno.ts";

export interface DaySchedule { date: string; status: string; slots: [number, number][]; fetched_at: number; updated_on: string | null }

/** Absolute intervals from schedule days (only days where the schedule applies), merged across midnight. */
export function intervalsFromDays(days: OutageDay[], loud = false): Interval[] {
  const out: Interval[] = [];
  for (const d of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!scheduleApplies(d)) continue;
    for (const [a, b] of loud ? loudHours(d.slots) : d.slots) {
      const start = kyivTime(d.date, a), end = kyivTime(d.date, b);
      const last = out[out.length - 1];
      if (last && start <= last.end) last.end = Math.max(last.end, end);
      else out.push({ start, end });
    }
  }
  return out;
}

export interface Context {
  now: number;
  sample: (PowerSample & Record<string, number | null>) | null;
  gridSince: { ts: number; prev_ts: number } | null;
  heartbeat: unknown;
  lastHour: HourRow;
  recentLoadW: number;
  today: HourRow;            // energy today so far (Kyiv day)
  hourlyRecent: HourRow[];
  forecast: ForecastPeriod[];
  days: { home: DaySchedule[]; neighbour: DaySchedule[] };
  events: { ts: number; grid_on: number; prev_ts: number }[];
  config: Record<string, unknown>;
}

function parseHeartbeat(row: { received_at: number; json: string } | undefined) {
  if (!row) return null;
  try { return { received_at: row.received_at, ...(JSON.parse(row.json) as Record<string, unknown>) }; }
  catch { return { received_at: row.received_at }; }
}

export async function loadContext(env: Env, now = Date.now()): Promise<Context> {
  const midnight = kyivMidnight(now);
  const today = kyivDate(now);
  const [latest, lastEvent, hb, recent, hourly, fc, days, events, cfgRows, todaySamples] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM samples ORDER BY ts DESC LIMIT 1"),
    env.DB.prepare("SELECT ts, grid_on, prev_ts FROM grid_events ORDER BY ts DESC LIMIT 1"),
    env.DB.prepare("SELECT received_at, json FROM heartbeats ORDER BY received_at DESC LIMIT 1"),
    env.DB.prepare(`SELECT ${POWER_COLS} FROM samples WHERE ts >= ? ORDER BY ts`).bind(now - HOUR - 5 * 60_000),
    env.DB.prepare("SELECT * FROM hourly WHERE hour_ts >= ? ORDER BY hour_ts").bind(now - 28 * DAY),
    env.DB.prepare("SELECT period_end, p50, p10, p90 FROM pv_forecast WHERE period_end > ? AND period_end <= ? ORDER BY period_end")
      .bind(midnight, now + 50 * HOUR),
    env.DB.prepare("SELECT role, date, status, slots, fetched_at, updated_on FROM outage_days WHERE date >= ? ORDER BY date")
      .bind(addDays(today, -1)),
    env.DB.prepare("SELECT ts, grid_on, prev_ts FROM grid_events WHERE ts >= ? ORDER BY ts").bind(now - 30 * DAY),
    env.DB.prepare("SELECT key, value FROM config"),
    // The current, not yet rolled-up hour.
    env.DB.prepare(`SELECT ${POWER_COLS} FROM samples WHERE ts >= ? ORDER BY ts`).bind(Math.max(midnight, Math.floor(now / HOUR) * HOUR - 2 * HOUR) - 5 * 60_000),
  ]);

  const sample = (latest.results[0] as Context["sample"]) ?? null;
  // One-sample flickers are not outages: "since" and the history ignore them.
  const evList = dropBlips(events.results as { ts: number; grid_on: number; prev_ts: number }[]);
  const ev = evList[evList.length - 1] ?? (lastEvent.results[0] as { ts: number; grid_on: number; prev_ts: number } | undefined) ?? null;
  const recentSamples = recent.results as PowerSample[];
  const lastHour = integrateSpan(recentSamples, now - HOUR, now);
  const recentLoadW = lastHour.covered_s > 600 ? lastHour.load_wh / (lastHour.covered_s / 3600) : (sample?.load_total ?? 0);

  const hourlyRows = hourly.results as unknown as HourRow[];
  // Energy today: rolled-up hours before the last 2, then the last ones from raw samples (the rollup lags up to 15 min).
  const cut = Math.max(midnight, Math.floor(now / HOUR) * HOUR - 2 * HOUR);
  const fromRollup = sumRows(hourlyRows.filter((h) => h.hour_ts >= midnight && h.hour_ts < cut), midnight);
  const fromRaw = integrateSpan(todaySamples.results as PowerSample[], cut, now);
  const todayRow = sumRows([fromRollup, fromRaw], midnight);

  const config: Record<string, unknown> = {};
  for (const r of cfgRows.results as { key: string; value: string }[]) { try { config[r.key] = JSON.parse(r.value); } catch { /* skip */ } }

  const dayRows = days.results as { role: string; date: string; status: string; slots: string; fetched_at: number; updated_on: string | null }[];
  const parseDays = (role: string) => dayRows.filter((d) => d.role === role).map((d) => ({ ...dayFromRow(d), fetched_at: d.fetched_at, updated_on: d.updated_on }));

  return {
    now, sample,
    gridSince: ev && sample && ev.grid_on === sample.grid_on ? { ts: ev.ts, prev_ts: ev.prev_ts } : null,
    heartbeat: parseHeartbeat(hb.results[0] as { received_at: number; json: string } | undefined),
    lastHour, recentLoadW, today: todayRow, hourlyRecent: hourlyRows,
    forecast: fc.results as unknown as ForecastPeriod[],
    days: { home: parseDays("home"), neighbour: parseDays("neighbour") },
    events: evList,
    config,
  };
}

/** The grid can flicker off for one sample when the inverter switches over. Shorter than this is not an outage. */
export const BLIP_MS = 2 * 60_000;

/** Drop off→on pairs shorter than `minMs` from grid events (sorted by ts). An outage still in progress is kept. */
export function dropBlips<T extends { ts: number; grid_on: number }>(events: T[], minMs = BLIP_MS): T[] {
  const out: T[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (e.grid_on === 1 && last && last.grid_on === 0 && e.ts - last.ts < minMs) out.pop();
    else out.push(e);
  }
  return out;
}

/** Past outage durations (ms) from grid events. */
export function outageDurations(events: { ts: number; grid_on: number }[]): number[] {
  const out: number[] = [];
  let off: number | null = null;
  for (const e of events) {
    if (e.grid_on === 0) off = e.ts;
    else if (off != null) { out.push(e.ts - off); off = null; }
  }
  return out;
}

export interface Analysis {
  proj: Projection | null;
  headline: Headline;
  confidence: Confidence;
  homeIntervals: Interval[];
  loudIntervals: Interval[];
  neighbourIntervals: Interval[];
  schedule: { today: DaySchedule | null; tomorrow: DaySchedule | null; fetched_at: number | null; mismatch: string | null };
  sun: { today_wh: number; forecast_today_wh: number | null; forecast_rest_wh: number | null; forecast_rest_low_wh: number | null; fetched_at: number | null; factor: number };
  needWh: number | null;
  profile: number[] | null;
  chargeW: number;
  battery: BatteryConfig;
  typicalOutageMs: number | null;
}

export function analyse(ctx: Context): Analysis {
  const { now, sample, config } = ctx;
  const today = kyivDate(now), tomorrow = addDays(today, 1);
  const battery = { ...DEFAULT_BATTERY, ...((config.battery as BatteryConfig) ?? {}) };
  const pvFactor = (config.pv_factor as { factor?: number } | undefined)?.factor ?? 1;
  const chargeW = (config.charge_w as { w?: number | null } | undefined)?.w ?? 3000;

  const homeToday = ctx.days.home.find((d) => d.date === today) ?? null;
  const homeTomorrow = ctx.days.home.find((d) => d.date === tomorrow) ?? null;
  const fetchedAt = ctx.days.home.reduce<number | null>((m, d) => Math.max(m ?? 0, d.fetched_at), null);
  // A schedule older than 6 h is not trusted (Yasno can change it at any time).
  const fresh = fetchedAt != null && now - fetchedAt < 6 * HOUR;
  const scheduleKnown = fresh && scheduleApplies(homeToday);
  const emergency = [homeToday, homeTomorrow].some((d) => d?.status === "EmergencyShutdowns");
  const homeIntervals = intervalsFromDays(ctx.days.home);
  const neighbourIntervals = intervalsFromDays(ctx.days.neighbour);
  const loudIntervals = intervalsFromDays(ctx.days.neighbour, true);

  const durations = outageDurations(ctx.events);
  const typical = typicalOutageMs(durations);
  const profile = loadProfile(ctx.hourlyRecent);
  const forecast = ctx.forecast;

  const confidence: Confidence = scheduleKnown && !emergency ? "schedule" : typical != null ? "history" : "none";
  let proj: Projection | null = null;
  const gridOn = !!sample?.grid_on;
  if (sample && sample.soc != null) {
    const outageStart = !gridOn ? (ctx.gridSince?.ts ?? now) : now;
    const unknownEnd = Math.max(now + 30 * 60_000, outageStart + (typical ?? 4 * HOUR));
    proj = project({
      now, soc: sample.soc, capacityWh: battery.capacity_wh, floorPct: battery.floor_pct,
      gridOnNow: gridOn, recentLoadW: ctx.recentLoadW, loadProfileW: profile,
      pv: forecast, pvFactor, outages: confidence === "schedule" ? homeIntervals.filter((i) => i.end > now) : [],
      unknownOutageEnd: unknownEnd, chargeW, confidence,
    });
    // The in-progress outage really started earlier.
    const cur = proj.outages.find((o) => o.in_progress);
    if (cur && ctx.gridSince) cur.start = ctx.gridSince.ts;
  }

  const midnight = kyivMidnight(now), nextMidnight = kyivTime(tomorrow, 0);
  const hasFc = forecast.some((p) => p.period_end > midnight && p.period_end <= nextMidnight);
  const fcToday = hasFc ? forecastEnergy(forecast, midnight, nextMidnight) * pvFactor : null;
  const fcRest = hasFc ? forecastEnergy(forecast, now, nextMidnight) * pvFactor : null;
  const fcRestLow = hasFc ? forecastEnergy(forecast, now, nextMidnight, "p10") * pvFactor : null;
  const needWh = profile ? profile.reduce((s, w) => s + w, 0) : ctx.recentLoadW > 0 ? ctx.recentLoadW * 24 : null;
  // Expected sun today = what came so far + the rest of the forecast (the panels are throttled when full).
  const sunWh = fcRest != null ? ctx.today.pv_wh + fcRest : null;

  const scheduledSoon = confidence === "schedule" && homeIntervals.some((i) => i.end > now && i.start < now + 48 * HOUR);
  const recentDrop = ctx.events.some((e) => e.grid_on === 0 && e.ts > now - 7 * DAY);

  // Switching can take a few minutes after the scheduled time: no "mismatch" inside that window.
  let mismatch: string | null = null;
  let lateReturn: number | null = null;
  if (sample && scheduleKnown) {
    const cur = homeIntervals.find((i) => i.start <= now && i.end > now);
    const nearEdge = homeIntervals.some((i) => Math.abs(now - i.start) <= SWITCH_GRACE_MS || Math.abs(now - i.end) <= SWITCH_GRACE_MS);
    if (cur && gridOn && !nearEdge) mismatch = "За графіком зараз відключення, але світло є.";
    if (!cur && !gridOn && !nearEdge) mismatch = "Світла немає, хоча за графіком воно має бути.";
    if (!cur && !gridOn) lateReturn = homeIntervals.find((i) => i.end <= now && now - i.end <= SWITCH_GRACE_MS)?.end ?? null;
  }

  const hl = headline({
    now, gridOnNow: gridOn, soc: sample?.soc ?? 0, proj, scheduleKnown, emergency, scheduledSoon, recentDrop,
    sunWh, needWh, lateReturn,
  });

  return {
    proj, headline: hl, confidence, homeIntervals, loudIntervals, neighbourIntervals,
    schedule: { today: homeToday, tomorrow: homeTomorrow, fetched_at: fetchedAt, mismatch },
    sun: {
      today_wh: ctx.today.pv_wh, forecast_today_wh: fcToday, forecast_rest_wh: fcRest, forecast_rest_low_wh: fcRestLow,
      fetched_at: (config.solcast_status as JobStatus | undefined)?.ok_at ?? null, factor: pvFactor,
    },
    needWh, profile, chargeW, battery, typicalOutageMs: typical,
  };
}

const publicAddr = (a: unknown) => {
  const x = a as AddressState | undefined;
  return x ? { street: x.street, house: x.house, group: x.group ?? null, pending_group: x.pending_group ?? null, error: x.error ?? null, checked_at: x.checked_at ?? null } : null;
};

export function sharedConfig(config: Record<string, unknown>) {
  return {
    phase_names: { ...DEFAULT_PHASES, ...((config.phase_names as PhaseNames) ?? {}) },
    battery: { ...DEFAULT_BATTERY, ...((config.battery as BatteryConfig) ?? {}) },
    addr_home: publicAddr(config.addr_home),
    addr_neighbour: publicAddr(config.addr_neighbour),
  };
}

/** GET /api/now */
export function nowPayload(ctx: Context, a: Analysis) {
  const { now, proj } = ctx.sample ? { now: ctx.now, proj: a.proj } : { now: ctx.now, proj: null };
  const curOut = proj?.outages.find((o) => o.in_progress) ?? null;
  const nextHome = a.homeIntervals.find((i) => i.start > now) ?? null;
  const curHome = a.homeIntervals.find((i) => i.start <= now && i.end > now) ?? null;
  const loud = a.loudIntervals.filter((i) => i.end > now && i.start < kyivTime(addDays(kyivDate(now), 2), 0));
  return {
    server_ms: now,
    sample: ctx.sample,
    grid_since: ctx.gridSince,
    heartbeat: ctx.heartbeat,
    last_hour: ctx.lastHour,
    today: ctx.today,
    headline: a.headline,
    confidence: a.confidence,
    battery: {
      floor_pct: a.battery.floor_pct, capacity_wh: a.battery.capacity_wh,
      empty_at: proj?.empty_at ?? null, full_at: proj?.full_at ?? null,
      runtime_h: proj?.runtime_h ?? null,
      end_soc: proj ? proj.points[proj.points.length - 1].soc : null,
      outage_end_soc: curOut ? curOut.soc_end_low : null,
    },
    grid: {
      scheduled_now: curHome, next_outage: nextHome,
      expected_return: curOut?.end ?? null,
      return_scheduled: !!curOut && a.confidence === "schedule" && !curOut.end_guessed,
      mismatch: a.schedule.mismatch,
    },
    schedule: { today: a.schedule.today, tomorrow: a.schedule.tomorrow, fetched_at: a.schedule.fetched_at },
    sun: a.sun,
    need_wh: a.needWh,
    generator: loud,
    home_intervals: a.homeIntervals.filter((i) => i.end > kyivMidnight(now) && i.start < kyivTime(addDays(kyivDate(now), 2), 0)),
    ghost: ghost(proj),
    shared: sharedConfig(ctx.config),
  };
}

/** Where the projection says the battery will be: end of the current/next outage, else in 48 h. */
function ghost(proj: Projection | null): { soc: number; at: number | null; kind: "outage_end" | "horizon"; guessed?: boolean } | null {
  if (!proj) return null;
  const o = proj.outages.find((x) => x.in_progress) ?? proj.outages[0];
  if (o) return { soc: o.soc_end_low, at: o.end, kind: "outage_end", guessed: !!o.end_guessed || proj.confidence !== "schedule" };
  const last = proj.points[proj.points.length - 1];
  return { soc: last.soc, at: last.t, kind: "horizon" };
}

/** GET /api/plan */
export function planPayload(ctx: Context, a: Analysis) {
  const now = ctx.now;
  const from = now - HOUR, to = now + 48 * HOUR;
  const clip = (l: Interval[]) => l.filter((i) => i.end > from && i.start < to);
  return {
    server_ms: now,
    from, to,
    confidence: a.confidence,
    headline: a.headline,
    projection: a.proj,
    floor_pct: a.battery.floor_pct,
    home: clip(a.homeIntervals),
    neighbour: clip(a.neighbourIntervals),
    loud: clip(a.loudIntervals),
    forecast: ctx.forecast.filter((p) => p.period_end > from && p.period_end <= to + 30 * 60_000),
    pv_factor: a.sun.factor,
    schedule: a.schedule,
    days: ctx.days,
    sample: ctx.sample ? { ts: ctx.sample.ts, soc: ctx.sample.soc, grid_on: ctx.sample.grid_on } : null,
    grid_since: ctx.gridSince,
    typical_outage_ms: a.typicalOutageMs,
  };
}

export type { SolcastBudget };
export { getAllConfig };
