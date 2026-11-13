// Tab 3: Історія. Day/week/month charts with a date picker, per-phase kWh, self-sufficiency,
// the outage log against the schedule, solar forecast vs actual, a daily summary.

import { get, AuthError } from "../api.js";
import { h, put } from "../dom.js";
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
    date,
    summary: h("section.card"),
    main: h("section.card"),
    phases: h("section.card"),
    sun: h("section.card"),
    outages: h("section.card"),
  };
  put(root, 
    h("section.card", h("div.chart-head", seg, h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, prev, date, next))),
    els.summary, els.main, els.phases, els.sun, els.outages,
  );
  for (const k of ["summary", "main", "phases", "sun", "outages"]) els[k].append(h("p.muted", "Завантаження…"));
}

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
  const days = RANGES[range];
  const to = Math.min(Date.now(), midnightOf(endDate) + 30 * 3600e3 > Date.now() ? Date.now() : f.kyivMidnight(midnightOf(endDate) + 30 * 3600e3));
  const from = f.kyivMidnight(midnightOf(endDate) - (days - 1) * 86400e3 + 3600e3);
  const end = range === "day" ? Math.max(to, from + 3600e3) : to;
  try {
    const [daily, series, log, fa, outages] = await Promise.all([
      get(`/api/daily?days=${days}&end=${endDate}`),
      range === "day" || range === "week" ? get(`/api/series?from=${from}&to=${end}`) : Promise.resolve(null),
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

function draw() {
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
  const self = t.load_wh > 0 ? Math.max(0, Math.min(1, 1 - t.grid_import_wh / t.load_wh)) : null;
  const pvShare = t.load_wh > 0 ? Math.min(1, t.pv_wh / t.load_wh) : null;
  const title = range === "day" ? `Підсумок: ${f.weekday(midnightOf(endDate) + 12 * 3600e3)}` : `Підсумок за ${days.length} дн.`;
  const stat = (v, l) => h("div.stat", h("div.v", v), h("div.l", l));
  put(els.summary, 
    h("h2", title),
    t.hours === 0 ? h("p.muted", "За цей період даних немає.") : h("div.stats",
      stat(f.kWh(t.load_wh), "спожито"),
      stat(f.kWh(t.pv_wh), "дало сонце"),
      stat(f.kWh(t.grid_import_wh), "з мережі"),
      stat(self != null ? f.pct(self * 100) : "—", "без мережі (автономність)"),
      stat(pvShare != null ? f.pct(pvShare * 100) : "—", "покрило сонце"),
      stat(t.off_min ? f.duration(t.off_min * 60e3) : "0", `без світла${t.outages ? ` (${t.outages} раз)` : ""}`),
      stat(t.soc_min != null ? `${t.soc_min}–${t.soc_max}%` : "—", "заряд мін–макс"),
      stat(`${f.kWhNum(t.batt_discharge_wh)} / ${f.kWhNum(t.batt_charge_wh)}`, "батарея віддала / взяла, кВт·год"),
    ),
    t.hours > 0 ? h("p.note", `${names.a}: ${f.kWh(t.load_a_wh)} · ${names.b}: ${f.kWh(t.load_b_wh)} · ${names.c}: ${f.kWh(t.load_c_wh)}`) : null,
  );
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
  put(els.main, h("h2", "Потужність"), lg, pw, h("h3", "Заряд батареї, %"), soc,
    h("p.note", h("span.swatch-off"), " сірим — без світла. Батарея: «+» розряд, «−» заряд."),
    tableDetails(series));
  const shades = cache.outages.map((o) => ({ start: o.start, end: o.end ?? Date.now(), cls: "off" }));
  const step = series.step;
  const pt = (k) => series.points.map((p) => ({ t: p.t + step / 2, v: p[k] }));
  legend(lg, [{ name: "Споживання", color: "--s1" }, { name: "Сонце", color: "--s2" }, { name: "Батарея", color: "--s3" }]);
  timeChart(pw, {
    from, to, label: "Споживання, сонце, батарея", shades, gapMs: step * 2.5,
    series: [
      { name: "Споживання", color: "--s1", points: pt("load_total"), step },
      { name: "Сонце", color: "--s2", points: pt("pv_w"), step },
      { name: "Батарея", color: "--s3", points: pt("batt_w"), step },
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
    legend(lg, [{ name: names.a, color: "--s1" }, { name: names.b, color: "--s1" }, { name: names.c, color: "--s1" }]);
    get(`/api/hourly?from=${midnightOf(endDate)}&to=${f.kyivMidnight(midnightOf(endDate) + 30 * 3600e3)}`).then((r) => {
      if (!alive) return;
      barChart(c, {
        label: "Споживання по фазах за годинами", yFmt: (v) => `${v / 1000}`,
        items: hourSlots(r.hours).map((x) => ({
          label: f.time(x.hour_ts).slice(0, 2), title: `${f.time(x.hour_ts)}–${f.time(x.hour_ts + 3600e3)}`,
          parts: [{ v: x.load_a_wh, cls: "bar-a", name: names.a, color: "--s1" }, { v: x.load_b_wh, cls: "bar-b", name: names.b }, { v: x.load_c_wh, cls: "bar-c", name: names.c }],
          extra: [{ name: "сонце", v: x.pv_wh }, { name: "з мережі", v: x.grid_import_wh }],
        })),
      });
      // Shades for the legend swatches.
      lg.children[1]?.style.setProperty("--c", "color-mix(in srgb, var(--s1) 62%, var(--surface))");
      lg.children[2]?.style.setProperty("--c", "color-mix(in srgb, var(--s1) 34%, var(--surface))");
    }).catch(() => {});
    return;
  }
  const c = h("div.chart"), lg = h("div.legend");
  put(els.phases, h("h2", "Споживання по фазах, кВт·год за добу"), lg, c, dailyTable(days, names));
  legend(lg, [{ name: names.a, color: "--s1" }, { name: names.b, color: "--s1" }, { name: names.c, color: "--s1" }]);
  lg.children[1]?.style.setProperty("--c", "color-mix(in srgb, var(--s1) 62%, var(--surface))");
  lg.children[2]?.style.setProperty("--c", "color-mix(in srgb, var(--s1) 34%, var(--surface))");
  barChart(c, {
    label: "Споживання по фазах за днями",
    items: days.map((d) => ({
      label: String(Number(d.date.slice(8))), title: f.weekday(midnightOf(d.date) + 12 * 3600e3),
      parts: [{ v: d.load_a_wh, cls: "bar-a", name: names.a, color: "--s1" }, { v: d.load_b_wh, cls: "bar-b", name: names.b }, { v: d.load_c_wh, cls: "bar-c", name: names.c }],
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
  put(els.sun, h("h2", "Сонце: прогноз і факт"), lg, c,
    h("p.note", n >= 4 ? `На неурізаних даних факт = ${f.pct((sa / sf) * 100)} від прогнозу (${n} півгодин).`
      : "Мало даних для порівняння: коли батарея повна, панелі урізаються, і такі проміжки не враховуються."),
    h("p.note", "Світлі точки — батарея повна, сонце урізане (не порівнюється)."));
  legend(lg, [{ name: "Факт", color: "--s2" }, { name: "Прогноз", color: "--s4" }, { name: "Прогноз на початок дня", color: "--s4", dash: true }]);
  const mid = (pe) => pe - 15 * 60e3;
  const r = timeChart(c, {
    from, to, label: "Сонце: прогноз і факт", shades: nights(from, to),
    series: [
      { name: "Факт", color: "--s2", points: fa.actual.map((a) => ({ t: mid(a.pe), v: a.pv })), step: 30 * 60e3, gap: true },
      { name: "Прогноз", color: "--s4", points: fa.forecast.map((x) => ({ t: mid(x.period_end), v: x.p50 * 1000 })), step: 30 * 60e3 },
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
      dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.setAttribute("r", 3); dot.setAttribute("class", "dotp");
      dot.setAttribute("fill", "var(--surface-2)"); dot.setAttribute("stroke", "var(--s2)");
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
