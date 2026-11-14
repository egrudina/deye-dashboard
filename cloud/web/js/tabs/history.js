// Tab 3: Історія. Day/week/month charts with a date picker, per-phase kWh, self-sufficiency,
// the outage log against the schedule, solar forecast vs actual, a daily summary.

import { get, AuthError } from "../api.js";
import { h, put, keepScroll } from "../dom.js";
import * as f from "../fmt.js";
import { barChart, legend, nights, timeChart } from "../svg.js";

const RANGES = { day: 1, week: 7, month: 30 };
let root, app, alive = false;
let range = "day", endDate = null, cache = {};
let reqSeq = 0;

export function mount(el, a) {
  root = el; app = a; alive = true;
  endDate ??= f.dateKey(Date.now());
  build();
  refresh();
}
export function unmount() { alive = false; }
export const redraw = () => draw();
export async function tick() { if (endDate === f.dateKey(Date.now()) && Date.now() - (cache.at ?? 0) > 5 * 60e3) refresh(); }

let els = {};
function build() {
  const seg = h("div.seg", { role: "group", "aria-label": "Період" },
    Object.entries({ day: "Доба", week: "Тиждень", month: "Місяць" }).map(([k, label]) =>
      h("button", { "aria-pressed": String(k === range), onclick: () => { range = k; build(); refresh(); } }, label)));
  const date = h("input", { type: "date", value: endDate, max: f.dateKey(Date.now()), "aria-label": "Дата",
    onchange: (e) => { if (e.target.value) { endDate = e.target.value; refresh(); } } });
  const prev = h("button.btn", { "aria-label": "Раніше", onclick: () => shift(-1) }, "‹");
  const next = h("button.btn", { "aria-label": "Пізніше", onclick: () => shift(1) }, "›");
  els = {
    date, next,
    summary: h("section.card"),
    main: h("section.card"),
    phases: h("section.card"),
    sun: h("section.card"),
    outages: h("section.card"),
  };
  put(root, 
    h("section.card", h("div.chart-head", seg, h("div.datenav", prev, date, next))),
    els.summary, els.main, els.phases, els.sun, els.outages,
  );
  for (const k of ["summary", "main", "phases", "sun", "outages"]) els[k].append(h("p.muted", "Завантаження…"));
  syncNav();
}
/** "Later" is off when the period already ends today. */
function syncNav() { els.next.disabled = endDate >= f.dateKey(Date.now()); }

function shift(dir) {
  const [y, m, d] = endDate.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + dir * RANGES[range])).toISOString().slice(0, 10);
  if (next > f.dateKey(Date.now())) return;
  endDate = next;
  els.date.value = endDate;
  refresh();
}

const midnightOf = (date) => f.kyivMidnight(Date.parse(`${date}T12:00:00Z`));

export async function refresh() {
  const seq = ++reqSeq;
  syncNav();
  const days = RANGES[range];
  const to = Math.min(Date.now(), midnightOf(endDate) + 30 * 3600e3 > Date.now() ? Date.now() : f.kyivMidnight(midnightOf(endDate) + 30 * 3600e3));
  const from = f.kyivMidnight(midnightOf(endDate) - (days - 1) * 86400e3 + 3600e3);
  const end = range === "day" ? Math.max(to, from + 3600e3) : to;
  try {
    const [daily, series, log, fa, outages] = await Promise.all([
      get(`/api/daily?days=${days}&end=${endDate}`),
      range === "day" || range === "week" ? get(`/api/series?from=${from}&to=${end}${range === "day" ? "&step=300000" : ""}`) : Promise.resolve(null),
      get(`/api/outage-log?from=${Math.min(from, Date.now() - 30 * 86400e3)}&to=${Date.now()}`),
      get(`/api/forecast-actual?from=${from}&to=${f.kyivMidnight(midnightOf(endDate) + 30 * 3600e3)}`),
      get(`/api/outages?from=${from}&to=${end}`),
    ]);
    if (!alive || seq !== reqSeq) return;
    cache = { daily, series, log, fa, outages: outages.outages, from, to: range === "day" ? f.kyivMidnight(midnightOf(endDate) + 30 * 3600e3) : end, at: Date.now() };
    draw();
  } catch (e) {
    if (alive && !(e instanceof AuthError)) put(els.summary, h("p.err", `Не вдалося завантажити: ${e.message}`));
  }
}

function draw() { keepScroll(drawNow); }
function drawNow() {
  if (!cache.daily || !els.summary) return;
  drawSummary();
  drawMain();
  drawPhases();
  drawSun();
  drawOutages();
}

function totals(days) {
  const t = { load_wh: 0, load_a_wh: 0, load_b_wh: 0, load_c_wh: 0, pv_wh: 0, grid_import_wh: 0, batt_charge_wh: 0, batt_discharge_wh: 0, off_min: 0, soc_min: null, soc_max: null, hours: 0, outages: 0 };
  for (const d of days) {
    for (const k of ["load_wh", "load_a_wh", "load_b_wh", "load_c_wh", "pv_wh", "grid_import_wh", "batt_charge_wh", "batt_discharge_wh", "off_min", "hours", "outages"]) t[k] += d[k] ?? 0;
    if (d.soc_min != null) t.soc_min = t.soc_min == null ? d.soc_min : Math.min(t.soc_min, d.soc_min);
    if (d.soc_max != null) t.soc_max = t.soc_max == null ? d.soc_max : Math.max(t.soc_max, d.soc_max);
  }
  return t;
}

function drawSummary() {
  const days = cache.daily.days;
  const t = totals(days);
  const names = app.shared().phase_names;
  const title = range === "day" ? `Підсумок: ${f.weekday(midnightOf(endDate) + 12 * 3600e3)}` : `Підсумок за ${days.length} дн.`;
  if (t.hours === 0) { put(els.summary, h("h2", title), h("p.muted", "За цей період даних немає.")); return; }

  // Where the consumed energy came from. Grid first, the rest is our own: battery, then sun.
  const load = Math.max(0, t.load_wh);
  const grid = Math.min(load, Math.max(0, t.grid_import_wh));
  const batt = Math.min(load - grid, Math.max(0, t.batt_discharge_wh));
  const sun = load - grid - batt;
  const self = load > 0 ? 1 - grid / load : null;
  const mix = [
    { name: "сонце", v: sun, color: "var(--s2)" },
    { name: "батарея", v: batt, color: "var(--s3)" },
    { name: "мережа", v: grid, color: "var(--s4)" },
  ].filter((x) => x.v >= 50);
  const mixText = mix.map((x) => `${x.name} ${f.kWh(x.v)}`).join(", ");
  const bar = h("div.mix", { role: "img", "aria-label": `Звідки енергія: ${mixText}` },
    mix.map((x) => h("i", { style: { flexGrow: String(x.v), background: x.color } })));
  const key = h("div.mix-key", mix.map((x, i) => h("span", { style: `--c:${x.color}` }, `${x.name} `, h("b", i === mix.length - 1 ? f.kWh(x.v) : f.kWhNum(x.v)))));

  const soc = t.soc_min == null ? "—" : t.soc_min === t.soc_max ? `${t.soc_min}%` : `${t.soc_min}–${t.soc_max}%`;
  const off = t.off_min ? `${f.duration(t.off_min * 60e3)}${t.outages ? ` (${t.outages} раз)` : ""}` : "не було";
  const row = (k, v) => [h("dt", k), h("dd", v)];
  const phaseMax = Math.max(1, t.load_a_wh, t.load_b_wh, t.load_c_wh);
  const phase = (k, v) => h("div.phase",
    h("span.name", names[k]),
    h("span.bar", h("i", { style: { width: `${(Math.max(0, v) / phaseMax) * 100}%`, background: `var(--p${k})` } })),
    h("b", f.kWh(v)));

  put(els.summary,
    h("h2", title),
    h("div.row",
      h("div", h("div.big", ...unit(f.kWh(load))), h("div.sub", "спожито")),
      self != null ? h("div", { style: { textAlign: "right" } }, h("div.big", f.pct(self * 100)), h("div.sub", "без мережі")) : null),
    mix.length ? bar : null, mix.length ? key : null,
    h("dl.kv",
      row("Сонце виробило", f.kWh(t.pv_wh)),
      row("Без світла", off),
      row("Заряд батареї", soc),
      row("Батарея віддала / взяла", `${f.kWhNum(t.batt_discharge_wh)} / ${f.kWh(t.batt_charge_wh)}`)),
    h("h3", "По фазах"),
    h("div.phases", phase("a", t.load_a_wh), phase("b", t.load_b_wh), phase("c", t.load_c_wh)),
  );
}

/** "11 кВт·год" → ["11", <span.unit>кВт·год</span>] */
function unit(text) {
  const i = text.lastIndexOf(" ");
  return i < 0 ? [text] : [text.slice(0, i), h("span.unit", text.slice(i + 1))];
}

function drawMain() {
  const { series, from, to } = cache;
  if (range === "month" || !series) {
    // Month: daily energy bars (sources).
    const c = h("div.chart"), lg = h("div.legend");
    put(els.main, h("h2", "Енергія по днях, кВт·год"), lg, c,
      h("p.note", "Пунктир — скільки спожито. Автономність — частка споживання без мережі."));
    legend(lg, [{ name: "Сонце", color: "--s2" }, { name: "З мережі", color: "--s4" }]);
    barChart(c, {
      label: "Енергія по днях",
      items: cache.daily.days.map((d) => ({
        label: String(Number(d.date.slice(8))), title: f.weekday(midnightOf(d.date) + 12 * 3600e3),
        parts: [{ v: d.pv_wh, cls: "bar-pv", name: "сонце", color: "--s2" }, { v: d.grid_import_wh, cls: "bar-grid", name: "з мережі", color: "--s4" }],
        marker: d.load_wh || null,
        extra: [{ name: "спожито", v: d.load_wh }, { name: "автономність", text: d.self_sufficiency != null ? f.pct(d.self_sufficiency * 100) : "—" }],
      })),
    });
    return;
  }
  const pw = h("div.chart"), soc = h("div.chart.chart-small"), lg = h("div.legend");
  put(els.main, h("h2", "Потужність, кВт"), lg, pw, h("h3", "Заряд батареї, %"), soc,
    h("p.note", h("span.swatch-off"), " без світла. Батарея: «+» розряд, «−» заряд.",
      range === "day" ? " Середнє за 5 хвилин." : ""),
    tableDetails(series));
  const shades = cache.outages.map((o) => ({ start: o.start, end: o.end ?? Date.now(), cls: "outage" }));
  const step = series.step;
  const pt = (k) => series.points.map((p) => ({ t: p.t + step / 2, v: p[k] }));
  legend(lg, [{ name: "Споживання", color: "--s1" }, { name: "Сонце", color: "--s2" }, { name: "Мережа", color: "--s4" }, { name: "Батарея", color: "--s3" }]);
  timeChart(pw, {
    from, to, label: "Споживання, сонце, мережа, батарея", shades, gapMs: step * 2.5,
    series: [
      // Sun first and filled, so the consumption line stays visible on top of it.
      { name: "Сонце", color: "--s2", points: pt("pv_w"), step, area: true },
      { name: "Мережа", color: "--s4", points: pt("grid_import_w"), step },
      { name: "Батарея", color: "--s3", points: pt("batt_w"), step },
      { name: "Споживання", color: "--s1", points: pt("load_total"), step },
    ],
  });
  timeChart(soc, {
    from, to, label: "Заряд батареї", shades, gapMs: step * 2.5, y: { min: 0, max: 100, fmt: (v) => `${v}` },
    floor: app.shared().battery?.floor_pct ?? 15,
    series: [{ name: "Заряд", color: "--s3", points: pt("soc"), fmt: f.pct, step }],
  });
}

function tableDetails(series) {
  const rows = [...series.points].reverse().map((p) => h("tr",
    h("td", f.when(p.t)), h("td", f.W(p.load_total)), h("td", f.W(p.pv_w)), h("td", f.W(p.batt_w)), h("td", `${Math.round(p.soc)} %`),
    h("td", p.grid_on >= 1 ? "є" : p.grid_on <= 0 ? "немає" : "частково")));
  return h("details", h("summary", "Таблиця"), h("div.table-wrap", h("table",
    h("thead", h("tr", ["Час", "Споживання", "Сонце", "Батарея", "Заряд", "Світло"].map((x) => h("th", x)))), h("tbody", rows))));
}

function drawPhases() {
  const names = app.shared().phase_names;
  const days = cache.daily.days;
  if (range === "day") {
    // Hourly kWh per phase for the day.
    const c = h("div.chart"), lg = h("div.legend");
    put(els.phases, h("h2", "Споживання по фазах, кВт·год за годину"), lg, c);
    legend(lg, [{ name: names.a, color: "--pa" }, { name: names.b, color: "--pb" }, { name: names.c, color: "--pc" }]);
    get(`/api/hourly?from=${midnightOf(endDate)}&to=${f.kyivMidnight(midnightOf(endDate) + 30 * 3600e3)}`).then((r) => {
      if (!alive) return;
      barChart(c, {
        label: "Споживання по фазах за годинами",
        items: hourSlots(r.hours).map((x) => ({
          label: f.time(x.hour_ts).slice(0, 2), title: `${f.time(x.hour_ts)}–${f.time(x.hour_ts + 3600e3)}`,
          parts: [{ v: x.load_a_wh, cls: "bar-a", name: names.a, color: "--pa" }, { v: x.load_b_wh, cls: "bar-b", name: names.b, color: "--pb" }, { v: x.load_c_wh, cls: "bar-c", name: names.c, color: "--pc" }],
          extra: [{ name: "сонце", v: x.pv_wh }, { name: "з мережі", v: x.grid_import_wh }],
        })),
      });
    }).catch(() => {});
    return;
  }
  const c = h("div.chart"), lg = h("div.legend");
  put(els.phases, h("h2", "Споживання по фазах, кВт·год за добу"), lg, c, dailyTable(days, names));
  legend(lg, [{ name: names.a, color: "--pa" }, { name: names.b, color: "--pb" }, { name: names.c, color: "--pc" }]);
  barChart(c, {
    label: "Споживання по фазах за днями",
    items: days.map((d) => ({
      label: String(Number(d.date.slice(8))), title: f.weekday(midnightOf(d.date) + 12 * 3600e3),
      parts: [{ v: d.load_a_wh, cls: "bar-a", name: names.a, color: "--pa" }, { v: d.load_b_wh, cls: "bar-b", name: names.b, color: "--pb" }, { v: d.load_c_wh, cls: "bar-c", name: names.c, color: "--pc" }],
      extra: [{ name: "усього", v: d.load_wh }],
    })),
  });
}

/** All hours of the selected Kyiv day, empty where there is no rollup. */
function hourSlots(rows) {
  const by = new Map(rows.map((r) => [r.hour_ts, r]));
  const start = midnightOf(endDate), end = f.kyivMidnight(start + 30 * 3600e3);
  const out = [];
  for (let t = start; t < end; t += 3600e3) out.push(by.get(t) ?? { hour_ts: t, load_a_wh: 0, load_b_wh: 0, load_c_wh: 0, pv_wh: 0, grid_import_wh: 0 });
  return out;
}

function dailyTable(days, names) {
  const rows = [...days].reverse().map((d) => h("tr",
    h("td", f.weekday(midnightOf(d.date) + 12 * 3600e3)), h("td", f.kWhNum(d.load_wh)),
    h("td", f.kWhNum(d.load_a_wh)), h("td", f.kWhNum(d.load_b_wh)), h("td", f.kWhNum(d.load_c_wh)),
    h("td", f.kWhNum(d.pv_wh)), h("td", f.kWhNum(d.grid_import_wh)),
    h("td", d.self_sufficiency != null ? f.pct(d.self_sufficiency * 100) : "—"), h("td", d.off_min ? f.duration(d.off_min * 60e3) : "—")));
  return h("details", h("summary", "Таблиця по днях, кВт·год"), h("div.table-wrap", h("table",
    h("thead", h("tr", ["День", "Усього", names.a, names.b, names.c, "Сонце", "Мережа", "Автон.", "Без світла"].map((x) => h("th", x)))), h("tbody", rows))));
}

function drawSun() {
  const { fa, from, to } = cache;
  const c = h("div.chart"), lg = h("div.legend");
  const pairs = fa.actual.filter((a) => a.thr === 0 && a.n >= 40);
  const fcMap = new Map(fa.forecast.map((x) => [x.period_end, x.p50 * 1000]));
  let sf = 0, sa = 0, n = 0;
  for (const a of pairs) { const fw = fcMap.get(a.pe); if (fw != null && fw >= 300) { sf += fw; sa += a.pv; n++; } }
  const nowMs = Date.now();
  const seam = nowMs > from && nowMs < to;
  put(els.sun, h("h2", "Сонце: прогноз і факт, кВт"), lg, c,
    h("p.note", n >= 4 ? `На неурізаних даних факт = ${f.pct((sa / sf) * 100)} від прогнозу (${n} півгодин).`
      : "Мало даних для порівняння: коли батарея повна, панелі урізаються, і такі проміжки не враховуються."),
    h("p.note", "Порожні точки — батарея повна, сонце урізане (не порівнюється).",
      seam ? " Ліворуч від «зараз» — останній прогноз перед кожною годиною, праворуч — свіжий, тому на межі лінія може мати злам." : ""));
  legend(lg, [{ name: "Факт", color: "--s2" }, { name: "Прогноз", color: "--s4" }, { name: "Прогноз на початок дня", color: "--s4", dash: true }]);
  const mid = (pe) => pe - 15 * 60e3;
  const fcPts = fa.forecast.map((x) => ({ t: mid(x.period_end), v: x.p50 * 1000 }));
  const r = timeChart(c, {
    from, to, now: seam ? nowMs : null, label: "Сонце: прогноз і факт", shades: nights(from, to),
    series: [
      { name: "Факт", color: "--s2", points: fa.actual.map((a) => ({ t: mid(a.pe), v: a.pv })), step: 30 * 60e3, gap: true },
      // The stored forecast for past periods is frozen, for coming ones it is the latest: two runs, split at "now".
      { name: "Прогноз", color: "--s4", points: fcPts.filter((p) => p.t <= nowMs), step: 30 * 60e3 },
      { name: "Прогноз", color: "--s4", points: fcPts.filter((p) => p.t > nowMs), step: 30 * 60e3, opacity: 0.55 },
      { name: "На початок дня", color: "--s4", dash: true, points: fa.first.map((x) => ({ t: mid(x.period_end), v: x.p50 * 1000 })), step: 30 * 60e3 },
    ],
    gapMs: 45 * 60e3,
    emptyText: "Немає даних",
  });
  if (r) {
    for (const a of fa.actual) {
      if (!a.thr || a.pv < 20) continue;
      const x = r.x(mid(a.pe)), y = r.y(a.pv);
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.setAttribute("r", 3.5); dot.setAttribute("class", "dotp");
      r.svg.append(dot);
    }
  }
}

function drawOutages() {
  const { log } = cache;
  const real = log.real;
  const overlap = (o) => log.scheduled.some((s) => s.start < (o.end ?? Date.now()) && s.end > o.start);
  const items = real.slice(0, 40).map((o) => h("li",
    h("span.when", `${f.when(o.start)} – ${o.end ? f.time(o.end) : "триває"}`),
    h("span.what", h("b", f.duration((o.end ?? Date.now()) - o.start)), overlap(o) ? h("span.tag", "за графіком") : h("span.tag.bad", "поза графіком"))));
  const sched = log.scheduled.slice(0, 40).map((s) => h("li", h("span.when", `${f.when(s.start)} – ${f.time(s.end)}`), h("span.what", f.duration(s.end - s.start))));
  const changes = log.changes.filter((c) => c.role === "home" && c.before).slice(0, 20).map((c) => h("li",
    h("span.when", f.when(c.ts)),
    h("span.what", `${c.date}: ${slotsText(c.before)} → ${slotsText(c.after)}`)));
  const typical = log.durations_ms.length ? [...log.durations_ms].sort((a, b) => a - b)[log.durations_ms.length >> 1] : null;
  put(els.outages, 
    h("h2", "Відключення"),
    typical ? h("p.note", `Типова тривалість: ${f.duration(typical)} (${log.durations_ms.length} відключень за період)`) : null,
    real.length ? h("ul.list", items) : h("p.muted", "За останні 30 днів відключень не було."),
    h("details", h("summary", `За графіком Yasno (${log.scheduled.length})`), sched.length ? h("ul.list", sched) : h("p.muted", "Немає збережених графіків.")),
    changes.length ? h("details", h("summary", `Зміни графіка (${changes.length})`), h("ul.list", changes)) : null,
  );
}

const mm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
function slotsText(x) {
  if (x.status !== "ScheduleApplies") return { WaitingForSchedule: "очікується", EmergencyShutdowns: "екстрені" }[x.status] ?? x.status;
  return x.slots.length ? x.slots.map(([a, b]) => `${mm(a)}–${mm(b)}`).join(", ") : "без відключень";
}
