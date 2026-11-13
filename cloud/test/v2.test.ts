import { test } from "node:test";
import assert from "node:assert/strict";
import { integrateHours, integrateSpan, sumRows, type PowerSample } from "../src/energy.ts";
import { applyResolved, loudHours, mergeSlots, norm, parseGroup, pickMatch, resolveDue, streetQuery, YasnoFormatError } from "../src/yasno.ts";
import { correctionFactor, countCall, forecastAt, forecastEnergy, parseForecast, solcastDue, isThrottled } from "../src/solcast.ts";
import { loadProfile, median, project, type ProjectionInput } from "../src/projection.ts";
import { headline, fmtClock } from "../src/headline.ts";
import { kyivDate, kyivMinuteOfDay, kyivOffsetMin, kyivTime, addDays, HOUR } from "../src/time.ts";
import { dropBlips, intervalsFromDays, outageDurations } from "../src/summary.ts";
import { mergeSettings, DEFAULT_SETTINGS } from "../src/settings.ts";

// ---------- time ----------

test("Kyiv time helpers, winter and summer, DST day", () => {
  assert.equal(kyivOffsetMin(Date.parse("2026-11-13T12:00:00Z")), 120);
  assert.equal(kyivOffsetMin(Date.parse("2026-07-01T12:00:00Z")), 180);
  assert.equal(kyivTime("2026-11-13", 0), Date.parse("2026-11-12T22:00:00Z"));
  assert.equal(kyivTime("2026-07-01", 18 * 60), Date.parse("2026-07-01T15:00:00Z"));
  assert.equal(kyivTime("2026-11-13", 1440), kyivTime("2026-11-14", 0));
  // 2026-03-29: clocks go 03:00 → 04:00.
  assert.equal(kyivTime("2026-03-29", 6 * 60), Date.parse("2026-03-29T03:00:00Z"));
  assert.equal(kyivDate(Date.parse("2026-11-12T22:30:00Z")), "2026-11-13");
  assert.equal(kyivMinuteOfDay(Date.parse("2026-11-13T05:30:00Z")), 7 * 60 + 30);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

// ---------- energy ----------

const smp = (ts: number, o: Partial<PowerSample> = {}): PowerSample => ({
  ts, grid_on: 1, soc: 80, batt_w: 0, grid_total_w: 1000, load_total: 1000, load_a: 300, load_b: 300, load_c: 400, pv_w: 0, ...o,
});

test("energy: 1 kW for one hour of 30 s samples = 1 kWh, phases split", () => {
  const h0 = Date.parse("2026-11-13T10:00:00Z");
  const s: PowerSample[] = [];
  for (let t = h0; t <= h0 + HOUR; t += 30_000) s.push(smp(t));
  const [r] = integrateHours(s, h0, h0 + HOUR);
  assert.equal(Math.round(r.load_wh), 1000);
  assert.equal(Math.round(r.load_c_wh), 400);
  assert.equal(Math.round(r.grid_import_wh), 1000);
  assert.equal(r.covered_s, 3600);
});

test("energy: gaps over 5 min are skipped; spans split at hour boundaries; charge/discharge and off minutes", () => {
  const h0 = Date.parse("2026-11-13T10:00:00Z");
  const s = [
    smp(h0 + 50 * 60_000, { batt_w: -2000, grid_on: 1 }),        // 10 min to next, crosses the hour → 600 s each side? no: 10:50→11:00 and 11:00→
    smp(h0 + 60 * 60_000 + 4 * 60_000, { batt_w: 600, grid_on: 0 }), // gap 14 min → skipped
    smp(h0 + 60 * 60_000 + 6 * 60_000, { batt_w: 600, grid_on: 0 }),
  ];
  // First → second gap is 14 min: skipped entirely.
  const rows = integrateHours(s, h0, h0 + 2 * HOUR, h0 + 60 * 60_000 + 8 * 60_000);
  const h11 = rows.find((r) => r.hour_ts === h0 + HOUR)!;
  // 11:04→11:06 (2 min) and 11:06→11:08 (endTs) at 600 W discharge, grid off.
  assert.equal(Math.round(h11.batt_discharge_wh), 40);
  assert.equal(Math.round(h11.off_min), 4);
  assert.equal(h11.grid_import_wh, 0);
  const h10 = rows.find((r) => r.hour_ts === h0)!;
  assert.equal(h10.covered_s, 0);
  assert.equal(h10.soc_min, 80);
});

test("energy: a span crossing the hour is split", () => {
  const h0 = Date.parse("2026-11-13T10:00:00Z");
  const s = [smp(h0 + 58 * 60_000, { batt_w: -3000 }), smp(h0 + 62 * 60_000)];
  const rows = integrateHours(s, h0, h0 + 2 * HOUR);
  assert.equal(Math.round(rows[0].batt_charge_wh), 100);
  assert.equal(Math.round(rows[1].batt_charge_wh), 100);
});

test("energy: last-hour span and sumRows", () => {
  const now = Date.parse("2026-11-13T10:30:00Z");
  const s: PowerSample[] = [];
  for (let t = now - 70 * 60_000; t < now; t += 30_000) s.push(smp(t, { load_total: 600 }));
  const r = integrateSpan(s, now - HOUR, now);
  assert.equal(Math.round(r.load_wh), 600);
  const sum = sumRows([r, r]);
  assert.equal(Math.round(sum.load_wh), 1200);
});

// ---------- Yasno ----------

const yasnoBody = {
  "30.1": {
    today: { slots: [{ start: 0, end: 60, type: "Definite" }, { start: 60, end: 480, type: "NotPlanned" }, { start: 480, end: 720, type: "Definite" }, { start: 1260, end: 1440, type: "Definite" }], date: "2026-11-13T00:00:00+02:00", status: "ScheduleApplies" },
    tomorrow: { slots: [], date: "2026-11-14T00:00:00+02:00", status: "WaitingForSchedule" },
    updatedOn: "2026-11-12T19:30:02+00:00",
  },
  "26.1": {
    today: { slots: [{ start: 360, end: 600, type: "Definite" }, { start: 1200, end: 1440, type: "Definite" }], date: "2026-11-13T00:00:00+02:00", status: "EmergencyShutdowns" },
    tomorrow: null,
  },
};

test("yasno: parse statuses, Definite only, missing group, bad answers", () => {
  const g = parseGroup(yasnoBody, "30.1")!;
  assert.equal(g.today!.date, "2026-11-13");
  assert.equal(g.today!.status, "ScheduleApplies");
  assert.deepEqual(g.today!.slots, [[0, 60], [480, 720], [1260, 1440]]);
  assert.equal(g.tomorrow!.status, "WaitingForSchedule");
  assert.deepEqual(g.tomorrow!.slots, []);
  assert.equal(parseGroup(yasnoBody, "26.1")!.today!.status, "EmergencyShutdowns");
  assert.equal(parseGroup(yasnoBody, "26.1")!.tomorrow, null);
  assert.equal(parseGroup(yasnoBody, "99.1"), null);
  assert.throws(() => parseGroup([], "30.1"), YasnoFormatError);
  assert.throws(() => parseGroup("nope", "30.1"), YasnoFormatError);
  assert.throws(() => parseGroup({ "30.1": { today: { slots: "x", date: "2026-11-13", status: "ScheduleApplies" } } }, "30.1"), YasnoFormatError);
  assert.throws(() => parseGroup({ "30.1": { today: { slots: [], status: "ScheduleApplies" } } }, "30.1"), YasnoFormatError);
});

test("yasno: merge slots and loud hours (07:00–22:00)", () => {
  assert.deepEqual(mergeSlots([[100, 200], [0, 50], [200, 300], [250, 260]]), [[0, 50], [100, 300]]);
  assert.deepEqual(loudHours([[0, 480], [600, 840], [1260, 1440]]), [[420, 480], [600, 840], [1260, 1320]]);
  assert.deepEqual(loudHours([[0, 400], [1320, 1440]]), []);
});

test("yasno: names match, query strips the street type", () => {
  assert.equal(norm("вул. Садова"), norm("Садова"));
  assert.equal(norm("12-А"), norm("12А"));
  assert.equal(norm("12-A"), norm("12А")); // Latin A
  assert.equal(streetQuery("вул. Садова"), "Садова");
  const streets = [{ id: 429, value: "вул. Верхньосадова" }, { id: 888, value: "вул. Садова" }];
  assert.equal(pickMatch(streets, "вул. Садова")!.id, 888);
  assert.equal(pickMatch([{ id: 1, value: "12" }, { id: 2, value: "12А" }], "12-А")!.id, 2);
  assert.equal(pickMatch([{ id: 1, value: "12" }, { id: 2, value: "12Б" }], "12-А"), null);
});

test("yasno: a changed group is accepted only after two matching checks ≥ 1 h apart", () => {
  const t0 = 1_000_000_000_000;
  let a = applyResolved({ street: "x", house: "1" }, "30.1", t0);
  assert.equal(a.group, "30.1");
  assert.equal(resolveDue(a, t0 + 3600_000), false);
  assert.equal(resolveDue(a, t0 + 8 * 86_400_000), true);
  a = applyResolved(a, "31.1", t0 + 8 * 86_400_000);
  assert.equal(a.group, "30.1");
  assert.equal(a.pending_group, "31.1");
  assert.equal(resolveDue(a, t0 + 8 * 86_400_000 + 30 * 60_000), false);
  assert.equal(resolveDue(a, t0 + 8 * 86_400_000 + 3600_000), true);
  const early = applyResolved(a, "31.1", t0 + 8 * 86_400_000 + 10 * 60_000);
  assert.equal(early.group, "30.1");
  a = applyResolved(a, "31.1", t0 + 8 * 86_400_000 + 3600_000);
  assert.equal(a.group, "31.1");
  assert.equal(a.pending_group, undefined);
  // A flip-flop back to the old group clears the pending one.
  const b = applyResolved({ ...a, pending_group: "32.1", pending_at: t0 }, "31.1", t0 + 1);
  assert.equal(b.pending_group, undefined);
});

test("schedule days → absolute intervals, merged across midnight", () => {
  const iv = intervalsFromDays([
    { date: "2026-11-13", status: "ScheduleApplies", slots: [[480, 720], [1260, 1440]] },
    { date: "2026-11-14", status: "ScheduleApplies", slots: [[0, 120]] },
    { date: "2026-11-15", status: "WaitingForSchedule", slots: [[0, 120]] },
  ]);
  assert.equal(iv.length, 2);
  assert.equal(iv[1].start, kyivTime("2026-11-13", 1260));
  assert.equal(iv[1].end, kyivTime("2026-11-14", 120));
  const loud = intervalsFromDays([{ date: "2026-11-13", status: "ScheduleApplies", slots: [[360, 600]] }], true);
  assert.equal(loud[0].start, kyivTime("2026-11-13", 420));
});

test("outage durations from grid events", () => {
  assert.deepEqual(outageDurations([{ ts: 0, grid_on: 1 }, { ts: 10, grid_on: 0 }, { ts: 40, grid_on: 1 }, { ts: 50, grid_on: 0 }]), [30]);
});

test("a one-sample grid flicker is not an outage; a real or ongoing outage is kept", () => {
  const m = 60_000, e = (ts: number, grid_on: number) => ({ ts, grid_on });
  const ev = [e(0, 0), e(200 * m, 1), e(500 * m, 0), e(500.5 * m, 1), e(900 * m, 0)];
  assert.deepEqual(dropBlips(ev), [e(0, 0), e(200 * m, 1), e(900 * m, 0)]);
  assert.deepEqual(dropBlips([e(0, 0), e(0.5 * m, 1)]), []);
  assert.deepEqual(dropBlips([e(0, 0)]), [e(0, 0)]);
});

// ---------- Solcast ----------

test("solcast budget: slots in Kyiv time, never more than 8 a UTC day, none at night", () => {
  const at = (iso: string) => Date.parse(iso);
  // 03:00 Kyiv (01:00Z): before the first slot.
  assert.equal(solcastDue(at("2026-11-13T01:00:00Z"), null), false);
  // 05:10 Kyiv: first slot due.
  const t1 = at("2026-11-13T03:10:00Z");
  assert.equal(solcastDue(t1, null), true);
  let b = countCall(t1, null);
  assert.equal(solcastDue(t1 + 15 * 60_000, b), false);
  // 07:05 Kyiv: next slot.
  assert.equal(solcastDue(at("2026-11-13T05:05:00Z"), b), true);
  // Over budget.
  b = { utc_date: "2026-11-13", calls: 8, last_call: at("2026-11-13T05:05:00Z") };
  assert.equal(solcastDue(at("2026-11-13T12:00:00Z"), b), false);
  // Evening: the last slot (16:00) was already used → nothing until tomorrow.
  b = { utc_date: "2026-11-13", calls: 5, last_call: at("2026-11-13T14:01:00Z") };
  assert.equal(solcastDue(at("2026-11-13T20:00:00Z"), b), false);
  // New UTC day resets the counter.
  assert.equal(countCall(at("2026-11-14T03:10:00Z"), { utc_date: "2026-11-13", calls: 8 }).calls, 1);
  // Two sites: every second slot, and the count doubles.
  assert.equal(solcastDue(at("2026-11-13T05:05:00Z"), { utc_date: "2026-11-13", calls: 1, last_call: at("2026-11-13T03:10:00Z") }, 2), false);
  assert.equal(solcastDue(at("2026-11-13T06:35:00Z"), { utc_date: "2026-11-13", calls: 3, last_call: at("2026-11-13T03:10:00Z") }, 2), true);
  assert.equal(solcastDue(at("2026-11-13T06:35:00Z"), { utc_date: "2026-11-13", calls: 4, last_call: at("2026-11-13T03:10:00Z") }, 2), false);
});

test("solcast parse, lookup and energy", () => {
  const p = parseForecast({ forecasts: [
    { pv_estimate: 2, pv_estimate10: 1, pv_estimate90: 3, period_end: "2026-11-13T10:30:00.0000000Z", period: "PT30M" },
    { pv_estimate: 4, pv_estimate10: 2, pv_estimate90: 5, period_end: "2026-11-13T10:00:00.0000000Z", period: "PT30M" },
  ] });
  assert.equal(p[0].p50, 4);
  assert.equal(forecastAt(p, Date.parse("2026-11-13T09:45:00Z")), 4000);
  assert.equal(forecastAt(p, Date.parse("2026-11-13T10:15:00Z"), "p10"), 1000);
  assert.equal(forecastAt(p, Date.parse("2026-11-13T11:15:00Z")), null);
  assert.equal(forecastEnergy(p, Date.parse("2026-11-13T09:00:00Z"), Date.parse("2026-11-13T12:00:00Z")), 3000);
  assert.throws(() => parseForecast({}));
  assert.throws(() => parseForecast({ forecasts: [] }));
});

test("solcast: throttling and correction factor", () => {
  assert.equal(isThrottled(100, 10), true);
  assert.equal(isThrottled(99, -800), false);
  assert.equal(isThrottled(80, 10), false);
  assert.equal(correctionFactor([{ forecast_w: 1000, actual_w: 800 }]), 1);
  const pairs = Array.from({ length: 30 }, () => ({ forecast_w: 1000, actual_w: 800 }));
  assert.equal(correctionFactor(pairs), 0.8);
  assert.equal(correctionFactor(pairs.map((p) => ({ ...p, actual_w: 100 }))), 0.5);
});

// ---------- projection ----------

const NOW = Date.parse("2026-11-13T10:00:00Z"); // 12:00 Kyiv
const base = (o: Partial<ProjectionInput> = {}): ProjectionInput => ({
  now: NOW, soc: 80, capacityWh: 20000, floorPct: 15, gridOnNow: true, recentLoadW: 1000,
  loadProfileW: null, pv: [], pvFactor: 1, outages: [], chargeW: 3000, confidence: "schedule", ...o,
});

test("projection: no outages, grid on → charges to 100%", () => {
  const p = project(base());
  assert.ok(p.full_at != null && p.full_at < NOW + 4 * HOUR, `full_at ${p.full_at}`);
  assert.equal(p.empty_at, null);
  assert.equal(p.outages.length, 0);
  assert.equal(p.points.length, 97);
  assert.equal(p.points[0].soc, 80);
});

test("projection: outage that lasts, and one that does not, with a cut", () => {
  // 1 kW for 4 h = 4 kWh ≈ 21% of 20 kWh: lasts from 80%.
  const ok = project(base({ outages: [{ start: NOW + 2 * HOUR, end: NOW + 6 * HOUR }] }));
  assert.equal(ok.outages.length, 1);
  assert.equal(ok.outages[0].lasts, true);
  assert.ok(ok.outages[0].soc_end_low > 70 && ok.outages[0].soc_end_low < 85, String(ok.outages[0].soc_end_low));
  // Grid off now at 30%, 2 kW, 6 h outage: (30-15)% = 3 kWh, needs 12 kWh → empty.
  const bad = project(base({ gridOnNow: false, soc: 30, recentLoadW: 2000, outages: [{ start: NOW - HOUR, end: NOW + 6 * HOUR }] }));
  const o = bad.outages[0];
  assert.equal(o.in_progress, true);
  assert.equal(o.lasts, false);
  assert.ok(o.empty_at! > NOW && o.empty_at! < NOW + 2 * HOUR, `empty ${new Date(o.empty_at!).toISOString()}`);
  // Usable ≈ 2.92 kWh over 6 h → ≈ 490 W allowed → cut ≈ 1550 W.
  assert.ok(o.cut_w! >= 1400 && o.cut_w! <= 1700, String(o.cut_w));
  assert.ok(bad.empty_at_low != null);
  // Floor holds.
  assert.ok(bad.points.every((pt) => pt.soc >= 15 - 1e-9));
});

test("projection: reality beats the schedule; unknown outage end; sun charges during an outage", () => {
  // Schedule says off now, but the grid is on: no outage in progress.
  const p = project(base({ outages: [{ start: NOW - HOUR, end: NOW + HOUR }] }));
  assert.equal(p.outages.length, 0);
  // Grid off, no schedule: assume it returns at unknownOutageEnd.
  const q = project(base({ gridOnNow: false, confidence: "history", unknownOutageEnd: NOW + 3 * HOUR }));
  assert.equal(q.outages.length, 1);
  assert.equal(q.outages[0].end, NOW + 3 * HOUR);
  // Sun 3 kW while off and load 1 kW: soc rises.
  const pv = Array.from({ length: 8 }, (_, i) => ({ period_end: NOW + (i + 1) * 30 * 60_000, p50: 3, p10: 3, p90: 3 }));
  const r = project(base({ gridOnNow: false, outages: [{ start: NOW, end: NOW + 4 * HOUR }], pv }));
  assert.ok(r.outages[0].soc_end > 80);
});

test("projection: load profile from hourly rows; median", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), null);
  const rows = [
    { hour_ts: kyivTime("2026-11-12", 18 * 60), load_wh: 2000, covered_s: 3600 },
    { hour_ts: kyivTime("2026-11-11", 18 * 60), load_wh: 1000, covered_s: 3600 },
    { hour_ts: kyivTime("2026-11-12", 3 * 60), load_wh: 250, covered_s: 1800 }, // 50% covered → skipped
    { hour_ts: kyivTime("2026-11-12", 4 * 60), load_wh: 400, covered_s: 3600 },
  ];
  const prof = loadProfile(rows, 1)!;
  assert.equal(prof[18], 1500);
  assert.equal(prof[4], 400);
  assert.equal(prof[3], 1000); // overall median of [2000, 1000, 400]
  assert.equal(loadProfile([]), null);
  // Few days of history: an hour is pulled towards the overall median (1000).
  const soft = loadProfile(rows)!;
  assert.equal(soft[18], (2000 + 1000 + 1000) / 3);
  assert.equal(soft[4], (400 + 2 * 1000) / 3);
});

// ---------- headline ----------

const hin = (o = {}) => ({
  now: NOW, gridOnNow: true, soc: 80, proj: null, scheduleKnown: true, emergency: false, scheduledSoon: false,
  recentDrop: false, sunWh: null, needWh: null, ...o,
});

test("headline: one verdict until the morning / runs out / no schedule", () => {
  const lasts = project(base({ gridOnNow: false, outages: [{ start: NOW - HOUR, end: NOW + 6 * HOUR }] }));
  const h1 = headline(hin({ gridOnNow: false, proj: lasts, scheduledSoon: true, sunWh: 1000, needWh: 20000 }));
  assert.equal(h1.text, "Батареї вистачить до завтрашнього ранку.");
  assert.match(h1.detail!, /^Найменше буде близько \d+% о 18:00\. Сьогодні сонця мало\.$/);
  assert.equal(h1.tone, "ok");

  const bad = project(base({ gridOnNow: false, soc: 30, recentLoadW: 2000, outages: [{ start: NOW - HOUR, end: NOW + 6 * HOUR }] }));
  const h2 = headline(hin({ gridOnNow: false, proj: bad, scheduledSoon: true }));
  assert.match(h2.text, /^Батарея сяде близько \d\d:\d\d\. Зменште споживання на \d+ Вт\.$/);
  assert.equal(h2.detail, "Світло повернеться о 18:00.");
  assert.equal(h2.tone, "bad");

  // Grid on, an outage later: the same verdict, the lowest point is the end of the outage.
  const full = project(base({ soc: 100, outages: [{ start: NOW + 8 * HOUR, end: NOW + 12 * HOUR }] }));
  const h3 = headline(hin({ proj: full, soc: 100, scheduledSoon: true }));
  assert.equal(h3.text, "Батареї вистачить до завтрашнього ранку.");
  assert.match(h3.detail!, /^Найменше буде близько \d+% завтра о 00:00\.$/);

  // The current outage lasts, the evening one does not.
  const outs = [{ start: NOW - HOUR, end: NOW + 4 * HOUR }, { start: NOW + 5.5 * HOUR, end: NOW + 11.5 * HOUR }];
  const h6 = headline(hin({ gridOnNow: false, proj: project(base({ gridOnNow: false, soc: 99, recentLoadW: 2500, chargeW: 500, outages: outs })), scheduledSoon: true }));
  assert.equal(h6.tone, "warn");
  assert.match(h6.text, /^Батарея сяде близько \d\d:\d\d\. Зменште споживання на \d+ Вт під час відключення\.$/);

  const none = project(base({ confidence: "history" }));
  const h4 = headline(hin({ proj: none, scheduleKnown: false, recentDrop: true }));
  assert.match(h4.text, /^Графіка від Yasno немає\. За поточного споживання батареї вистачить приблизно/);
  const h5 = headline(hin({ proj: none, emergency: true, scheduleKnown: false }));
  assert.match(h5.text, /екстрені/);
});

test("headline: sun modes", () => {
  assert.equal(headline(hin({ sunWh: 12000, needWh: 10000 })).mode, "sun_covers");
  const p = headline(hin({ sunWh: 1500, needWh: 10000 }));
  assert.equal(p.text, "Сьогодні сонце покриє близько 15% потреби.");
  assert.match(p.detail!, /1,5 з 10 кВт·год/);
  assert.equal(headline(hin({ sunWh: 100, needWh: 10000 })).text, "Сьогодні сонця майже не буде: усе з мережі.");
  assert.equal(headline(hin()).mode, "plain");
});

test("fmtClock: today, tomorrow", () => {
  assert.equal(fmtClock(NOW + 6 * HOUR, NOW), "18:00");
  assert.equal(fmtClock(NOW + 16 * HOUR, NOW), "завтра 04:00");
});

test("switch-over tolerance: a few minutes late or early is still the scheduled outage", () => {
  const MIN = 60_000;
  // 5 min past the scheduled start, grid still on: the outage is still expected.
  const late = project(base({ soc: 100, outages: [{ start: NOW - 5 * MIN, end: NOW + 6 * HOUR }] }));
  assert.equal(late.outages.length, 1);
  assert.equal(late.outages[0].overdue, true);
  assert.equal(late.outages[0].start, NOW - 5 * MIN);
  assert.equal(late.outages[0].in_progress, false);
  assert.equal(headline(hin({ proj: late, soc: 100, scheduledSoon: true })).text, "Батареї вистачить до завтрашнього ранку.");
  // 20 min past: reality wins, the outage is dropped.
  assert.equal(project(base({ outages: [{ start: NOW - 20 * MIN, end: NOW + 6 * HOUR }] })).outages.length, 0);
  // Off 5 min before the scheduled start: it is that outage, with its scheduled end.
  const early = project(base({ gridOnNow: false, outages: [{ start: NOW + 5 * MIN, end: NOW + 6 * HOUR }] }));
  assert.equal(early.outages.length, 1);
  assert.equal(early.outages[0].in_progress, true);
  assert.equal(early.outages[0].end, NOW + 6 * HOUR);
  assert.equal(early.outages[0].end_guessed, undefined);
  // Off outside the schedule: the end is a guess and the headline does not present it as a scheduled return.
  const off = project(base({ gridOnNow: false, outages: [{ start: NOW + 8 * HOUR, end: NOW + 12 * HOUR }], unknownOutageEnd: NOW + 3 * HOUR }));
  assert.equal(off.outages[0].end_guessed, true);
  assert.match(headline(hin({ gridOnNow: false, proj: off, scheduledSoon: true })).text, /^Світла немає\./);
  // Still off 5 min after the scheduled end.
  const lr = headline(hin({ gridOnNow: false, proj: off, scheduledSoon: true, lateReturn: NOW - 5 * MIN }));
  assert.match(lr.text, /^Світло мало повернутися о 11:55\. Перемикання може тривати до 10 хв\.$/);
});

// ---------- settings ----------

test("settings: merge validates input", () => {
  const s = mergeSettings(DEFAULT_SETTINGS, { phase: "c", neighbour: false, notify: { stale: true, grid: "yes" }, low_batt_pct: 5, quiet: { on: true, from: "22:30", to: "25:00" }, evil: 1 });
  assert.equal(s.phase, "c");
  assert.equal(s.neighbour, false);
  assert.equal(s.notify.stale, true);
  assert.equal(s.notify.grid, true);
  assert.equal(s.low_batt_pct, 30);
  assert.deepEqual(s.quiet, { on: true, from: "22:30", to: "07:00" });
  assert.equal(DEFAULT_SETTINGS.phase, "all");
  assert.equal(mergeSettings(DEFAULT_SETTINGS, null).phase, "all");
});

test("energy totals: rolled-up hours + raw tail = one integration, whatever the cut (HA totals never drop)", () => {
  const start = Date.parse("2026-11-13T00:00:00Z");
  const s: PowerSample[] = [];
  for (let t = start + 7_000; t < start + 6 * HOUR; t += 30_000 + ((t / 1000) % 7) * 1000) {
    if (t > start + 2.2 * HOUR && t < start + 2.4 * HOUR) continue; // a gap > 5 min
    s.push(smp(t, { load_total: 500 + ((t / 30_000) % 13) * 50, batt_w: ((t / 30_000) % 3) - 1 > 0 ? 400 : -900 }));
  }
  const now = start + 6 * HOUR - 10_000;
  const whole = integrateSpan(s, start, now);
  for (const h of [1, 2, 3, 4]) {
    const cut = start + h * HOUR;
    const rolled = sumRows(integrateHours(s, start, cut));
    const tail = integrateSpan(s, cut, now);
    for (const k of ["load_wh", "batt_charge_wh", "batt_discharge_wh", "grid_import_wh"] as const) {
      assert.ok(Math.abs(rolled[k] + tail[k] - whole[k]) < 1e-6, `${k} cut=${h}h: ${rolled[k] + tail[k]} vs ${whole[k]}`);
    }
  }
});
