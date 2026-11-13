// Battery projection: simulate the next 48 h in 30-min steps. Pure, no I/O.

import { forecastAt, type ForecastPeriod } from "./solcast.ts";
import { HOUR, kyivHour } from "./time.ts";

export type Confidence = "schedule" | "history" | "none";
export interface Interval { start: number; end: number }

export interface ProjectionInput {
  now: number;
  soc: number;                 // %
  capacityWh: number;          // nominal, e.g. 20000
  floorPct: number;            // the inverter shuts down here, e.g. 15
  gridOnNow: boolean;
  recentLoadW: number;         // average load over the last hour
  loadProfileW: number[] | null; // typical load per Kyiv hour 0..23
  pv: ForecastPeriod[];        // Solcast periods (kW); empty = no sun assumed
  pvFactor: number;            // forecast correction
  outages: Interval[];         // grid-off intervals expected (schedule or history)
  unknownOutageEnd?: number;   // grid is off now but no interval covers now: assume it returns here
  chargeW: number;             // grid charge rate
  confidence: Confidence;
  horizonMs?: number;
  stepMs?: number;
}

export interface ProjPoint { t: number; grid_on: boolean; load_w: number; pv_w: number; pv_low_w: number; soc: number; soc_low: number }

export interface ProjOutage {
  start: number;
  end: number | null;          // null: beyond the horizon
  soc_start: number;
  soc_end: number;
  soc_end_low: number;
  lasts: boolean;              // pessimistic scenario stays above the floor until the end
  empty_at: number | null;     // pessimistic time the floor is reached during this outage
  cut_w: number | null;        // load cut (W) that makes it last; null when it already lasts or no cut helps
  in_progress: boolean;
}

export interface Projection {
  confidence: Confidence;
  step_ms: number;
  points: ProjPoint[];
  empty_at: number | null;     // middle scenario
  empty_at_low: number | null; // pessimistic scenario
  full_at: number | null;      // middle scenario reaches 100%
  outages: ProjOutage[];
  runtime_h: number;           // hours the battery lasts at the recent load with no sun and no grid
}

const EFF = 0.95;              // battery round trip losses, split between charge and discharge
const MAX_CUT_W = 4000;

interface SimResult { soc: number[]; grid: boolean[]; load: number[]; pv: number[]; emptyAt: number | null; fullAt: number | null }

function gridPlan(inp: ProjectionInput, times: number[], ends: number[]): boolean[] {
  const { now, outages, gridOnNow } = inp;
  const covering = outages.find((o) => o.start <= now && o.end > now);
  let list = outages;
  if (gridOnNow && covering) {
    // Reality wins: the scheduled outage did not start (yet). Assume the grid stays on for this slot.
    list = outages.filter((o) => o !== covering);
  } else if (!gridOnNow && !covering) {
    list = [...outages, { start: now, end: inp.unknownOutageEnd ?? now + 4 * HOUR }];
  }
  return times.map((t, i) => {
    if (i === 0 && !list.some((o) => o.start <= now && o.end > now)) return gridOnNow;
    const mid = (t + ends[i]) / 2;
    return !list.some((o) => o.start <= mid && o.end > mid);
  });
}

function loadAt(inp: ProjectionInput, t: number): number {
  const prof = inp.loadProfileW?.[kyivHour(t)];
  const typical = prof != null && Number.isFinite(prof) ? prof : inp.recentLoadW;
  // Blend the real last hour into the first steps.
  const w = Math.exp(-(t - inp.now) / HOUR);
  return w * inp.recentLoadW + (1 - w) * typical;
}

function simulate(inp: ProjectionInput, times: number[], ends: number[], grid: boolean[], pvKey: "p50" | "p10", cut: Interval | null, cutW: number): SimResult {
  const cap = inp.capacityWh, floor = inp.floorPct;
  let soc = inp.soc;
  const out: SimResult = { soc: [], grid, load: [], pv: [], emptyAt: null, fullAt: soc >= 100 ? inp.now : null };
  for (let i = 0; i < times.length; i++) {
    const t = times[i], dtH = (ends[i] - t) / HOUR, mid = (t + ends[i]) / 2;
    let load = loadAt(inp, mid);
    if (cut && mid >= cut.start && mid < cut.end) load = Math.max(0, load - cutW);
    const pv = Math.max(0, (forecastAt(inp.pv, mid, pvKey) ?? 0) * inp.pvFactor);
    out.load.push(load); out.pv.push(pv);
    if (grid[i]) {
      // Grid feeds the load; the battery charges from the grid and the PV surplus. Slower near full.
      let charge = Math.max(inp.chargeW, pv - load);
      if (soc >= 95) charge *= 0.4;
      soc = Math.min(100, soc + (charge * dtH * Math.sqrt(EFF)) / cap * 100);
    } else {
      const net = pv - load;
      if (net >= 0) soc = Math.min(100, soc + (net * dtH * Math.sqrt(EFF)) / cap * 100);
      else {
        const next = soc - (-net * dtH / Math.sqrt(EFF)) / cap * 100;
        if (next <= floor && soc > floor && out.emptyAt == null) {
          out.emptyAt = t + (ends[i] - t) * ((soc - floor) / (soc - next));
        }
        soc = Math.max(floor, next);
        if (soc <= floor && out.emptyAt == null) out.emptyAt = t;
      }
    }
    if (soc >= 99.5 && out.fullAt == null) out.fullAt = ends[i];
    out.soc.push(soc);
  }
  return out;
}

export function project(inp: ProjectionInput): Projection {
  const step = inp.stepMs ?? 30 * 60_000;
  const horizon = inp.horizonMs ?? 48 * HOUR;
  // Steps aligned to the clock grid (:00/:30), with a partial first step from now.
  const times: number[] = [inp.now];
  for (let t = Math.floor(inp.now / step) * step + step; t < inp.now + horizon; t += step) {
    if (t - inp.now < 60_000) continue;
    times.push(t);
  }
  const ends = times.map((t, i) => times[i + 1] ?? Math.max(t + 60_000, inp.now + horizon));
  const grid = gridPlan(inp, times, ends);
  const mid = simulate(inp, times, ends, grid, "p50", null, 0);
  const low = simulate(inp, times, ends, grid, "p10", null, 0);

  // Points: soc at the end of each step, plus the starting point.
  const points: ProjPoint[] = [{
    t: inp.now, grid_on: grid[0], load_w: mid.load[0], pv_w: mid.pv[0], pv_low_w: low.pv[0], soc: inp.soc, soc_low: inp.soc,
  }];
  for (let i = 0; i < times.length; i++) {
    points.push({
      t: ends[i], grid_on: grid[i + 1] ?? grid[i], load_w: mid.load[i + 1] ?? mid.load[i],
      pv_w: mid.pv[i + 1] ?? mid.pv[i], pv_low_w: low.pv[i + 1] ?? low.pv[i], soc: mid.soc[i], soc_low: low.soc[i],
    });
  }

  // Outages from the grid plan.
  const outages: ProjOutage[] = [];
  for (let i = 0; i < times.length; i++) {
    if (grid[i] || (i > 0 && !grid[i - 1])) continue;
    let j = i;
    while (j < times.length && !grid[j]) j++;
    const start = i === 0 ? inp.now : times[i];
    const end = j < times.length ? times[j] : null;
    const socStart = i === 0 ? inp.soc : mid.soc[i - 1];
    const socEndLow = low.soc[j - 1];
    const emptyLow = firstFloor(low.soc, ends, i, j, inp.floorPct);
    const lasts = emptyLow == null;
    let cutW: number | null = null;
    if (!lasts) cutW = findCut(inp, times, ends, grid, { start, end: end ?? Infinity }, i, j);
    outages.push({
      start: i === 0 && !inp.gridOnNow ? inp.now : start, end, soc_start: socStart, soc_end: mid.soc[j - 1], soc_end_low: socEndLow,
      lasts, empty_at: emptyLow, cut_w: cutW, in_progress: i === 0 && !grid[0],
    });
  }

  const usableWh = Math.max(0, (inp.soc - inp.floorPct) / 100 * inp.capacityWh * Math.sqrt(EFF));
  return {
    confidence: inp.confidence,
    step_ms: step,
    points,
    empty_at: mid.emptyAt,
    empty_at_low: low.emptyAt,
    full_at: mid.fullAt,
    outages,
    runtime_h: usableWh / Math.max(inp.recentLoadW, 50),
  };
}

function firstFloor(soc: number[], ends: number[], i: number, j: number, floor: number): number | null {
  for (let k = i; k < j; k++) if (soc[k] <= floor + 1e-9) return ends[k];
  return null;
}

/** Smallest load cut (W, rounded up to 50) during the outage that keeps the pessimistic scenario above the floor. */
function findCut(inp: ProjectionInput, times: number[], ends: number[], grid: boolean[], iv: Interval, i: number, j: number): number | null {
  const ok = (w: number) => {
    const r = simulate(inp, times, ends, grid, "p10", iv, w);
    return firstFloor(r.soc, ends, i, j, inp.floorPct) == null;
  };
  if (!ok(MAX_CUT_W)) return null;
  let lo = 0, hi = MAX_CUT_W;
  while (hi - lo > 25) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m; }
  return Math.ceil(hi / 50) * 50;
}

// ---------- inputs from history ----------

/** Median of numbers (null for an empty list). */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Typical load per Kyiv hour from hourly rows (hour_ts, load_wh, covered_s). Rows covering < 80% of the
 * hour are skipped. Hours without data are filled from the overall median.
 */
export function loadProfile(rows: { hour_ts: number; load_wh: number; covered_s: number }[]): number[] | null {
  const byHour: number[][] = Array.from({ length: 24 }, () => []);
  for (const r of rows) {
    if (r.covered_s < 0.8 * 3600) continue;
    byHour[kyivHour(r.hour_ts)].push(r.load_wh / (r.covered_s / 3600));
  }
  const all = byHour.flat();
  const overall = median(all);
  if (overall == null) return null;
  return byHour.map((xs) => median(xs) ?? overall);
}

/** Typical outage length from past outages (ms); null when there are none. */
export function typicalOutageMs(durations: number[]): number | null {
  const m = median(durations.filter((d) => d > 10 * 60_000));
  return m;
}
