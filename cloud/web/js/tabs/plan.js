// Tab 2: План. One 48-hour timeline (lanes + battery + power) and the same in words. Data: /api/plan.

import { cached, load, AuthError } from "../api.js";
import { h, keepScroll } from "../dom.js";
import * as f from "../fmt.js";
import { el, legend, nights, timeChart } from "../svg.js";

let root, app, data, alive = false;

export function mount(el_, a) {
  root = el_; app = a; alive = true;
  data = cached("plan");
  if (data) render(); else root.append(h("p.empty-state", "Завантаження…"));
  refresh();
}
export function unmount() { alive = false; }
export const redraw = () => { if (data) render(); };
export async function tick() { /* the plan changes slowly: refresh every 5 min */ if (Date.now() - (data?.server_ms ?? 0) > 5 * 60e3) refresh(); }
export async function refresh() {
  try {
    const d = await load("plan", "/api/plan", true);
    if (!alive) return;
    data = d;
    render();
  } catch (e) {
    if (alive && !(e instanceof AuthError)) app.freshness("немає зв'язку", true);
  }
}

const CONF = {
  schedule: "Прогноз за графіком Yasno.",
  history: "Графіка немає: тривалість відключення взято з історії.",
  none: "Графіка й історії відключень немає: прогноз приблизний.",
};

function render() { keepScroll(renderNow); }
function renderNow() {
  const d = data, now = d.server_ms, p = d.projection;
  const showNeighbour = app.settings().neighbour !== false;
  const lanes = h("div.chart", { style: { height: showNeighbour ? "52px" : "34px" } });
  const socChart = h("div.chart.chart-small");
  const powChart = h("div.chart");
  const socLegend = h("div.legend"), powLegend = h("div.legend");

  root.replaceChildren(
    h("section.card", h("p", { style: { margin: 0, fontWeight: 600 } }, d.headline?.text ?? ""), h("p.note", CONF[d.confidence] ?? "")),
    h("section.card",
      h("h2", "Наступні 48 годин"),
      lanes,
      h("h3", "Заряд батареї, %"), socLegend, socChart,
      h("h3", "Сонце і споживання"), powLegend, powChart,
      h("p.note", "Сірим — ніч. Пунктир — песимістичний прогноз (мало сонця)."),
    ),
    h("section.card", h("h2", "Що буде"), eventsList(d, now, showNeighbour)),
    scheduleCard(d, now),
  );

  const from = d.from, to = d.to;
  const night = nights(from, to);
  drawLanes(lanes, d, from, to, showNeighbour);

  const off = (d.projection?.points ?? []).length ? offSpans(p.points) : d.home.map((i) => ({ ...i, cls: "off" }));
  legend(socLegend, [{ name: "Очікуваний", color: "--s3" }, { name: "Песимістичний", color: "--s3", dash: true }]);
  timeChart(socChart, {
    from, to, now, label: "Прогноз заряду батареї",
    y: { min: 0, max: 100, fmt: (v) => `${v}` },
    floor: d.floor_pct,
    shades: [...night, ...off],
    series: p ? [
      { name: "Заряд", color: "--s3", points: p.points.map((x) => ({ t: x.t, v: x.soc })), fmt: f.pct, step: p.step_ms },
      { name: "Песимістично", color: "--s3", dash: true, points: p.points.map((x) => ({ t: x.t, v: x.soc_low })), fmt: f.pct, step: p.step_ms },
    ] : [],
    emptyText: "Немає даних для прогнозу",
  });

  const fc = d.forecast ?? [];
  const k = d.pv_factor ?? 1;
  const mid = (pe) => pe - 15 * 60e3;
  legend(powLegend, [
    { name: "Сонце (прогноз)", color: "--s2" }, { name: "Розкид прогнозу", color: "--s2", band: true },
    { name: "Споживання (очікуване)", color: "--s1" },
  ]);
  timeChart(powChart, {
    from, to, now, label: "Прогноз сонця і очікуване споживання",
    shades: night,
    series: [
      { name: "Сонце", color: "--s2", points: fc.map((x) => ({ t: mid(x.period_end), v: x.p50 * 1000 * k })),
        band: fc.map((x) => ({ t: mid(x.period_end), lo: x.p10 * 1000 * k, hi: x.p90 * 1000 * k })), step: 30 * 60e3 },
      { name: "Споживання", color: "--s1", points: (p?.points ?? []).map((x) => ({ t: x.t, v: x.load_w })), step: 30 * 60e3 },
    ],
    emptyText: "Прогнозу немає",
  });
}

function offSpans(points) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    if (points[i].grid_on) continue;
    const start = points[i].t;
    while (i < points.length && !points[i].grid_on) i++;
    out.push({ start, end: points[Math.min(i, points.length - 1)].t, cls: "off" });
  }
  return out;
}

function drawLanes(container, d, from, to, showNeighbour) {
  container.replaceChildren();
  const W = container.clientWidth || 320, H = showNeighbour ? 52 : 34, l = 40, r = 8;
  const x = (t) => l + ((Math.min(Math.max(t, from), to) - from) / (to - from)) * (W - l - r);
  const desc = [`Відключення: ${d.home.map((i) => `${f.when(i.start)}–${f.time(i.end)}`).join(", ") || "немає"}`];
  if (showNeighbour) desc.push(`генератор сусідів: ${d.loud.map((i) => `${f.when(i.start)}–${f.time(i.end)}`).join(", ") || "ні"}`);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": desc.join("; ") }, container);
  el("text", { class: "lane-label", x: 0, y: 15 }, svg).textContent = "Світло";
  el("rect", { class: "lane-bg", x: l, y: 4, width: W - l - r, height: 14, rx: 4 }, svg);
  for (const i of d.home) el("rect", { class: "lane-out", x: x(i.start), y: 4, width: Math.max(2, x(i.end) - x(i.start)), height: 14, rx: 3 }, svg);
  // What the projection assumes when there is no schedule.
  if (d.confidence !== "schedule") {
    for (const s of offSpans(d.projection?.points ?? [])) el("rect", { class: "lane-out", x: x(s.start), y: 4, width: Math.max(2, x(s.end) - x(s.start)), height: 14, rx: 3, opacity: 0.4 }, svg);
  }
  if (showNeighbour) {
    el("text", { class: "lane-label", x: 0, y: 36 }, svg).textContent = "Сусіди";
    el("rect", { class: "lane-bg", x: l, y: 30, width: W - l - r, height: 6, rx: 3 }, svg);
    for (const i of d.neighbour) el("rect", { class: "lane-loud", x: x(i.start), y: 30, width: Math.max(2, x(i.end) - x(i.start)), height: 6, rx: 3, opacity: 0.25 }, svg);
    for (const i of d.loud) el("rect", { class: "lane-loud", x: x(i.start), y: 30, width: Math.max(2, x(i.end) - x(i.start)), height: 6, rx: 3 }, svg);
  }
  const now = d.server_ms;
  if (now > from && now < to) el("line", { class: "nowline", x1: x(now), x2: x(now), y1: 0, y2: H }, svg);
}

function eventsList(d, now, showNeighbour) {
  const p = d.projection;
  const ev = [];
  for (const o of p?.outages ?? []) {
    const end = o.end ? f.time(o.end) : "…";
    const what = o.in_progress
      ? `Відключення триває до ${o.end ? f.when(o.end, now) : "невідомо"}: ${f.pct(o.soc_start)} → ${f.pct(o.soc_end_low)}`
      : `Відключення до ${end}: заряд ${f.pct(o.soc_start)} → ${f.pct(o.soc_end_low)}`;
    const tag = o.lasts ? null : h("span.tag.bad", o.cut_w ? `не вистачить, −${o.cut_w} Вт` : "не вистачить");
    ev.push({ t: o.in_progress ? now : o.start, text: [what, tag] });
    if (!o.lasts && o.empty_at) ev.push({ t: o.empty_at, text: [`Батарея може сісти (до ${d.floor_pct}%)`] });
  }
  if (p?.full_at && p.full_at > now) ev.push({ t: p.full_at, text: ["Батарея повна (100%)"] });
  if (showNeighbour) for (const i of d.loud ?? []) ev.push({ t: i.start, text: [h("span.muted", `Генератор сусідів до ${f.time(i.end)}`)] });
  // Sun per day.
  const fc = d.forecast ?? [];
  const byDay = new Map();
  for (const x of fc) {
    const k = f.dateKey(x.period_end - 1);
    byDay.set(k, (byDay.get(k) ?? 0) + x.p50 * 500 * (d.pv_factor ?? 1));
  }
  for (const [k, wh] of byDay) {
    const t = f.kyivMidnight(Date.parse(`${k}T12:00:00Z`)) + 12 * 3600e3;
    if (t < now - 12 * 3600e3) continue;
    ev.push({ t: Math.max(t - 12 * 3600e3 + 1, now - 1), day: true, text: [h("span.muted", `${f.dateKey(now) === k ? "Сьогодні" : f.weekday(t)}: сонце ~${f.kWh(wh)}`)] });
  }
  ev.sort((a, b) => a.t - b.t);
  if (!ev.length) return h("p.muted", "Нічого особливого: відключень за графіком немає.");
  return h("ul.list", ev.map((e) => h("li", h("span.when", e.day ? "" : f.when(e.t, now)), h("span.what", ...e.text))));
}

function scheduleCard(d, now) {
  const rows = [];
  const label = { ScheduleApplies: "діє", WaitingForSchedule: "ще не опубліковано", EmergencyShutdowns: "екстрені відключення" };
  for (const [role, title] of [["home", "Наша адреса"], ["neighbour", "Сусіди"]]) {
    if (role === "neighbour" && app.settings().neighbour === false) continue;
    for (const day of d.days?.[role] ?? []) {
      if (day.date < f.dateKey(now)) continue;
      const slots = day.slots.map(([a, b]) => `${mm(a)}–${mm(b)}`).join(", ");
      rows.push(h("li", h("span.when", `${title}, ${day.date === f.dateKey(now) ? "сьогодні" : "завтра"}`),
        h("span.what", day.status === "ScheduleApplies" ? (slots || "без відключень") : label[day.status] ?? day.status)));
    }
  }
  return h("section.card", h("h2", "Графік Yasno"),
    rows.length ? h("ul.list", rows) : h("p.muted", "Графіка немає. Задайте адреси в розділі «Система»."),
    d.schedule?.fetched_at ? h("p.note", `Оновлено ${f.ago(now - d.schedule.fetched_at)}`) : null);
}

const mm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
