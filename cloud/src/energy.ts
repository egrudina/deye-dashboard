// Energy from 30 s power samples: power × time to the next sample, gaps > 5 min skipped.

import { HOUR, MIN } from "./time.ts";

export const MAX_GAP_MS = 5 * MIN;

export interface PowerSample {
  ts: number;
  grid_on: number;
  soc: number | null;
  batt_w: number | null;       // + discharge, - charge
  grid_total_w: number | null;
  load_total: number | null;
  load_a: number | null;
  load_b: number | null;
  load_c: number | null;
  pv_w: number | null;
}

export interface HourRow {
  hour_ts: number;
  covered_s: number;
  load_wh: number;
  load_a_wh: number;
  load_b_wh: number;
  load_c_wh: number;
  pv_wh: number;
  batt_charge_wh: number;
  batt_discharge_wh: number;
  grid_import_wh: number;
  soc_min: number | null;
  soc_max: number | null;
  off_min: number;
}

export const HOUR_FIELDS = [
  "covered_s", "load_wh", "load_a_wh", "load_b_wh", "load_c_wh", "pv_wh",
  "batt_charge_wh", "batt_discharge_wh", "grid_import_wh", "soc_min", "soc_max", "off_min",
] as const;

const emptyHour = (hour_ts: number): HourRow => ({
  hour_ts, covered_s: 0, load_wh: 0, load_a_wh: 0, load_b_wh: 0, load_c_wh: 0, pv_wh: 0,
  batt_charge_wh: 0, batt_discharge_wh: 0, grid_import_wh: 0, soc_min: null, soc_max: null, off_min: 0,
});

const n = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? 0 : v);

/** Add the energy of one sample held for [a, b) to `h`. */
function addSpan(h: HourRow, s: PowerSample, a: number, b: number) {
  const sec = (b - a) / 1000;
  const wh = sec / 3600;
  h.covered_s += sec;
  h.load_wh += n(s.load_total) * wh;
  h.load_a_wh += n(s.load_a) * wh;
  h.load_b_wh += n(s.load_b) * wh;
  h.load_c_wh += n(s.load_c) * wh;
  h.pv_wh += Math.max(0, n(s.pv_w)) * wh;
  const bw = n(s.batt_w);
  if (bw < 0) h.batt_charge_wh += -bw * wh; else h.batt_discharge_wh += bw * wh;
  if (s.grid_on) h.grid_import_wh += Math.max(0, n(s.grid_total_w)) * wh;
  else h.off_min += sec / 60;
}

function addSoc(h: HourRow, soc: number | null) {
  if (soc == null) return;
  h.soc_min = h.soc_min == null ? soc : Math.min(h.soc_min, soc);
  h.soc_max = h.soc_max == null ? soc : Math.max(h.soc_max, soc);
}

/**
 * Integrate samples (sorted by ts) into hourly rows for hours in [fromHour, toHour).
 * A sample's power applies until the next sample (if the gap is ≤ 5 min). The last sample applies
 * until `endTs` (e.g. now) when that is within 5 min, so the running hour stays current.
 */
export function integrateHours(samples: PowerSample[], fromHour: number, toHour: number, endTs?: number): HourRow[] {
  const hours = new Map<number, HourRow>();
  const get = (t: number) => {
    const k = Math.floor(t / HOUR) * HOUR;
    let h = hours.get(k);
    if (!h) { h = emptyHour(k); hours.set(k, h); }
    return h;
  };
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const next = i + 1 < samples.length ? samples[i + 1].ts : endTs;
    if (s.ts >= fromHour && s.ts < toHour) addSoc(get(s.ts), s.soc);
    if (next == null || next - s.ts > MAX_GAP_MS || next <= s.ts) continue;
    let a = Math.max(s.ts, fromHour);
    const end = Math.min(next, toHour);
    while (a < end) {
      const b = Math.min(end, Math.floor(a / HOUR) * HOUR + HOUR);
      addSpan(get(a), s, a, b);
      a = b;
    }
  }
  return [...hours.values()].filter((h) => h.hour_ts >= fromHour && h.hour_ts < toHour).sort((x, y) => x.hour_ts - y.hour_ts);
}

/** Energy over [from, to) as one summed row (hour_ts = from). */
export function integrateSpan(samples: PowerSample[], from: number, to: number): HourRow {
  const total = emptyHour(from);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const next = i + 1 < samples.length ? samples[i + 1].ts : to;
    if (s.ts >= from && s.ts < to) addSoc(total, s.soc);
    if (next - s.ts > MAX_GAP_MS || next <= s.ts) continue;
    const a = Math.max(s.ts, from), b = Math.min(next, to);
    if (b > a) addSpan(total, s, a, b);
  }
  return total;
}

/** Sum hour rows into one (soc min/max combined). */
export function sumRows(rows: HourRow[], hour_ts = rows[0]?.hour_ts ?? 0): HourRow {
  const t = emptyHour(hour_ts);
  for (const r of rows) {
    for (const k of HOUR_FIELDS) {
      if (k === "soc_min" || k === "soc_max") continue;
      t[k] += r[k];
    }
    if (r.soc_min != null) t.soc_min = t.soc_min == null ? r.soc_min : Math.min(t.soc_min, r.soc_min);
    if (r.soc_max != null) t.soc_max = t.soc_max == null ? r.soc_max : Math.max(t.soc_max, r.soc_max);
  }
  return t;
}
