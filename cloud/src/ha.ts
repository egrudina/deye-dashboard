// GET /api/ha: one flat JSON for Home Assistant's REST integration (see docs/home-assistant.md).
// Energy totals are running sums since the first sample (kWh, only ever increase) for HA's Energy dashboard.

import { integrateSpan, type PowerSample } from "./energy.ts";
import { POWER_COLS } from "./jobs.ts";
import { analyse, loadContext } from "./summary.ts";
import { HOUR, MIN, addDays, kyivDate, kyivParts, kyivTime } from "./time.ts";
import { forecastEnergy } from "./solcast.ts";

const iso = (ts: number | null | undefined) => (ts == null ? null : new Date(ts).toISOString());
const r1 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const mm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const slotsText = (d: { status: string; slots: [number, number][] } | null | undefined) =>
  !d ? null : d.status !== "ScheduleApplies" ? d.status : d.slots.length ? d.slots.map(([a, b]) => `${mm(a)}–${mm(b)}`).join(", ") : "немає";

// HA polls often; several pollers (and retries) share one answer for 20 s within an isolate.
let cache: { at: number; body: unknown } | null = null;

const TOTALS = ["load_wh", "load_a_wh", "load_b_wh", "load_c_wh", "pv_wh", "grid_import_wh", "batt_charge_wh", "batt_discharge_wh"] as const;

async function energyTotals(env: Env, now: number) {
  // Closed, stable hours from the rollups; the last ~2 h from raw samples (same integration, so the sum never drops).
  const cut = Math.floor(now / HOUR) * HOUR - 2 * HOUR;
  const [sum, raw] = await env.DB.batch([
    env.DB.prepare(`SELECT ${TOTALS.map((k) => `COALESCE(SUM(${k}), 0) AS ${k}`).join(", ")} FROM hourly WHERE hour_ts < ?`).bind(cut),
    env.DB.prepare(`SELECT ${POWER_COLS} FROM samples WHERE ts >= ? ORDER BY ts`).bind(cut - 5 * MIN),
  ]);
  const tail = integrateSpan(raw.results as PowerSample[], cut, now);
  const s = sum.results[0] as Record<(typeof TOTALS)[number], number>;
  const out: Record<string, number> = {};
  for (const k of TOTALS) out[k.replace(/_wh$/, "_kwh")] = r3((s[k] + tail[k]) / 1000);
  return out;
}

export async function haPayload(env: Env) {
  const now = Date.now();
  if (cache && now - cache.at < 20_000) return cache.body;
  const [ctx, totals] = await Promise.all([loadContext(env, now), energyTotals(env, now)]);
  const a = analyse(ctx);
  const s = ctx.sample;
  const p = a.proj;
  const cur = p?.outages.find((o) => o.in_progress) ?? null;
  const next = p?.outages.find((o) => !o.in_progress) ?? null;
  const nextSched = a.homeIntervals.find((i) => i.start > now) ?? null;
  const loud = a.loudIntervals.filter((i) => i.end > now);
  const today = kyivDate(now), tomorrow = addDays(today, 1);
  const tomorrowStart = kyivTime(tomorrow, 0), dayAfter = kyivTime(addDays(today, 2), 0);
  const names = { a: "Фаза A", b: "Фаза B", c: "Фаза C", ...((ctx.config.phase_names as Record<string, string>) ?? {}) };
  const fcTomorrow = ctx.forecast.some((x) => x.period_end > tomorrowStart && x.period_end <= dayAfter)
    ? forecastEnergy(ctx.forecast, tomorrowStart, dayAfter) * a.sun.factor : null;
  const overhead = s ? (s.grid_on ? Math.max(0, s.grid_total_w ?? 0) : 0) + Math.max(0, s.pv_w ?? 0) + (s.batt_w ?? 0) - (s.load_total ?? 0) : null;

  const body = {
    updated: iso(now),
    sample_time: iso(s?.ts),
    data_age_s: s ? Math.round((now - s.ts) / 1000) : null,

    // live
    grid_on: s ? !!s.grid_on : null,
    soc: s?.soc ?? null,
    battery_w: s?.batt_w ?? null,                         // + discharge, - charge (Deye)
    battery_charge_w: s ? Math.max(0, -(s.batt_w ?? 0)) : null,
    battery_discharge_w: s ? Math.max(0, s.batt_w ?? 0) : null,
    load_w: s?.load_total ?? null,
    load_a_w: s?.load_a ?? null,
    load_b_w: s?.load_b ?? null,
    load_c_w: s?.load_c ?? null,
    pv_w: s?.pv_w ?? null,
    pv1_w: s?.pv1_w ?? null,
    pv2_w: s?.pv2_w ?? null,
    grid_w: s ? (s.grid_on ? Math.max(0, s.grid_total_w ?? 0) : 0) : null,
    inverter_overhead_w: overhead != null ? Math.round(overhead) : null,
    grid_v_a: s?.grid_on ? r1(s.grid_v_a) : null,
    grid_v_b: s?.grid_on ? r1(s.grid_v_b) : null,
    grid_v_c: s?.grid_on ? r1(s.grid_v_c) : null,
    grid_hz: s?.grid_on ? s.grid_hz : null,
    grid_since: iso(ctx.gridSince?.ts),

    // energy: last hour, today, running totals (kWh)
    last_hour_load_kwh: r3(ctx.lastHour.load_wh / 1000),
    today_load_kwh: r3(ctx.today.load_wh / 1000),
    today_pv_kwh: r3(ctx.today.pv_wh / 1000),
    today_grid_import_kwh: r3(ctx.today.grid_import_wh / 1000),
    today_self_sufficiency: ctx.today.load_wh > 0 ? Math.round(Math.max(0, 1 - ctx.today.grid_import_wh / ctx.today.load_wh) * 100) : null,
    ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [`total_${k}`, v])),

    // plan
    headline: a.headline.text,
    headline_detail: a.headline.detail ?? null,
    headline_tone: a.headline.tone,               // ok | info | warn | bad
    headline_mode: a.headline.mode,
    confidence: a.confidence,                     // schedule | history | none
    battery_empty_at: iso(p?.empty_at_low),       // pessimistic
    battery_full_at: iso(p?.full_at),
    battery_runtime_h: p ? r1(p.runtime_h) : null,
    outage_in_progress: !!cur,
    outage_expected_end: iso(cur?.end),
    outage_end_soc: cur ? Math.round(cur.soc_end_low) : null,
    next_outage_start: iso(next?.start ?? nextSched?.start),
    next_outage_end: iso(next?.end ?? nextSched?.end),
    next_outage_end_soc: next ? Math.round(next.soc_end_low) : null,
    next_outage_lasts: next ? next.lasts : null,
    cut_w_needed: (cur && !cur.lasts ? cur.cut_w : next && !next.lasts ? next.cut_w : null) ?? null,
    schedule_mismatch: a.schedule.mismatch,
    schedule_today: slotsText(a.schedule.today),
    schedule_tomorrow: slotsText(a.schedule.tomorrow),
    schedule_status_today: a.schedule.today?.status ?? null,
    schedule_updated: iso(a.schedule.fetched_at),
    generator_next_start: iso(loud[0]?.start),
    generator_next_end: iso(loud[0]?.end),
    generator_today: loud.filter((i) => i.start < tomorrowStart).map((i) => `${mmOf(i.start)}–${mmOf(i.end)}`).join(", ") || null,

    // sun
    sun_forecast_today_kwh: a.sun.forecast_today_wh != null ? r3(a.sun.forecast_today_wh / 1000) : null,
    sun_forecast_rest_kwh: a.sun.forecast_rest_wh != null ? r3(a.sun.forecast_rest_wh / 1000) : null,
    sun_forecast_tomorrow_kwh: fcTomorrow != null ? r3(fcTomorrow / 1000) : null,
    need_today_kwh: a.needWh != null ? r3(a.needWh / 1000) : null,
    forecast_updated: iso(a.sun.fetched_at),

    phase_names: names,
  };
  cache = { at: now, body };
  return body;
}

function mmOf(ts: number) {
  const p = kyivParts(ts);
  return `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
}
