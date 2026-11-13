// Solcast rooftop forecast: call budget and parsing (pure). Network and DB code is in jobs.ts.

import { kyivMinuteOfDay, kyivDate, kyivTime } from "./time.ts";

export const SOLCAST_DAILY_LIMIT = 10;  // free plan, per UTC day
export const SOLCAST_RESERVE = 2;

/** Planned call times, Kyiv minutes from midnight: before sunrise to mid-afternoon, none at night. */
export const CALL_SLOTS = [5 * 60, 7 * 60, 8 * 60 + 30, 10 * 60, 11 * 60 + 30, 13 * 60, 14 * 60 + 30, 16 * 60];

export interface SolcastBudget {
  utc_date: string;   // UTC day the counter belongs to
  calls: number;      // calls made that UTC day (successful or not)
  last_call?: number; // ms
}

/**
 * Is a forecast call due now? `sites` = number of rooftop sites (each call counts per site).
 * With 2 sites, only every second slot is used.
 */
export function solcastDue(now: number, budget: SolcastBudget | null, sites = 1): boolean {
  const utc = new Date(now).toISOString().slice(0, 10);
  const calls = budget && budget.utc_date === utc ? budget.calls : 0;
  if ((calls + 1) * sites > SOLCAST_DAILY_LIMIT - SOLCAST_RESERVE) return false;
  const slots = sites > 1 ? CALL_SLOTS.filter((_, i) => i % sites === 0) : CALL_SLOTS;
  const minute = kyivMinuteOfDay(now);
  const today = kyivDate(now);
  // The latest slot that has started today.
  let slotStart: number | null = null;
  for (const s of slots) if (s <= minute) slotStart = kyivTime(today, s);
  if (slotStart == null) return false;
  return !budget?.last_call || budget.last_call < slotStart;
}

export function countCall(now: number, budget: SolcastBudget | null): SolcastBudget {
  const utc = new Date(now).toISOString().slice(0, 10);
  const calls = budget && budget.utc_date === utc ? budget.calls : 0;
  return { utc_date: utc, calls: calls + 1, last_call: now };
}

export interface ForecastPeriod { period_end: number; p50: number; p10: number; p90: number } // kW

export class SolcastFormatError extends Error {}

export function parseForecast(body: unknown): ForecastPeriod[] {
  const list = (body as { forecasts?: unknown })?.forecasts;
  if (!Array.isArray(list)) throw new SolcastFormatError("no forecasts array");
  const out: ForecastPeriod[] = [];
  for (const f of list as Record<string, unknown>[]) {
    const end = Date.parse(String(f.period_end));
    const p50 = Number(f.pv_estimate), p10 = Number(f.pv_estimate10 ?? f.pv_estimate), p90 = Number(f.pv_estimate90 ?? f.pv_estimate);
    if (!Number.isFinite(end) || !Number.isFinite(p50)) continue;
    out.push({ period_end: end, p50, p10: Number.isFinite(p10) ? p10 : p50, p90: Number.isFinite(p90) ? p90 : p50 });
  }
  if (!out.length) throw new SolcastFormatError("empty forecast");
  return out.sort((a, b) => a.period_end - b.period_end);
}

/** Forecast power (W) at time `t` from 30-min periods (value of the period containing t). */
export function forecastAt(periods: ForecastPeriod[], t: number, key: "p50" | "p10" | "p90" = "p50"): number | null {
  // Periods are sorted; binary search for the first period_end > t.
  let lo = 0, hi = periods.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (periods[m].period_end > t) hi = m; else lo = m + 1; }
  const p = periods[lo];
  if (!p || p.period_end - 30 * 60_000 > t) return null;
  return p[key] * 1000;
}

/** Forecast energy (Wh) over [from, to). */
export function forecastEnergy(periods: ForecastPeriod[], from: number, to: number, key: "p50" | "p10" | "p90" = "p50"): number {
  let wh = 0;
  for (const p of periods) {
    const a = Math.max(from, p.period_end - 30 * 60_000), b = Math.min(to, p.period_end);
    if (b > a) wh += p[key] * 1000 * ((b - a) / 3_600_000);
  }
  return wh;
}

/** A sample is "throttled" when the battery is full and not charging: pv_w shows use, not potential. */
export const isThrottled = (soc: number | null, batt_w: number | null) => (soc ?? 0) >= 98 && (batt_w ?? 0) >= -50;

/**
 * Correction factor: actual / forecast over daytime periods where every sample was not throttled.
 * Returns 1 when there is too little data. Clamped to 0.5–1.5.
 */
export function correctionFactor(pairs: { forecast_w: number; actual_w: number }[], minPairs = 20): number {
  const ok = pairs.filter((p) => p.forecast_w >= 300);
  if (ok.length < minPairs) return 1;
  const f = ok.reduce((s, p) => s + p.forecast_w, 0), a = ok.reduce((s, p) => s + p.actual_w, 0);
  if (f <= 0) return 1;
  return Math.min(1.5, Math.max(0.5, a / f));
}
