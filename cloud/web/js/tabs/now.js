// Tab 1: Зараз. The headline sentence, big numbers, graphics. Data: /api/now.

import { cached, load, AuthError } from "../api.js";
import { h, keepScroll } from "../dom.js";
import * as f from "../fmt.js";
import { batteryRing, dayStrip, energyFlow, phaseBars } from "../graphics.js";
import { isIos, isStandalone } from "../push.js";

const STALE_MS = 3 * 60e3;
let root, app, data, alive = false;

export function mount(el, a) {
  root = el; app = a; alive = true;
  data = cached("now");
  if (data) render(); else root.append(h("p.empty-state", "Завантаження…"));
  refresh();
}
export function unmount() { alive = false; }
export const tick = () => refresh();
export const redraw = () => { if (data) render(); };

export async function refresh() {
  try {
    const d = await load("now", "/api/now", true);
    if (!alive) return;
    data = d;
    render();
  } catch (e) {
    if (alive && !(e instanceof AuthError)) app.freshness("немає зв'язку", true);
  }
}

function render() { keepScroll(renderNow); }
function renderNow() {
  const d = data, s = d.sample, now = d.server_ms;
  const settings = app.settings();
  const names = app.me?.shared?.phase_names ?? d.shared?.phase_names ?? { a: "A", b: "B", c: "C" };
  const age = s ? Date.now() - s.ts : Infinity;
  const stale = age > STALE_MS;
  app.freshness(!s ? "даних немає" : stale ? `дані ${f.ago(age)}` : null, stale);

  if (!s) {
    root.replaceChildren(h("section.card", h("p.empty-state", "Даних від інвертора ще немає.")));
    return;
  }

  // ---------- headline ----------
  const hl = d.headline ?? { tone: "ok", text: "" };
  const notes = [];
  if (stale) notes.push(`Немає свіжих даних: останні ${f.ago(age)}. Можливо, немає інтернету або роутер вимкнений.`);
  if (d.grid?.mismatch) notes.push(d.grid.mismatch);
  const st = d.schedule?.today?.status;
  if (st === "WaitingForSchedule") notes.push("Yasno ще не опублікувало графік на сьогодні.");
  if (d.schedule?.fetched_at && now - d.schedule.fetched_at > 2 * 3600e3) notes.push(`Графік Yasno оновлювався ${f.ago(now - d.schedule.fetched_at)}.`);
  if (d.confidence === "history" && !s.grid_on) notes.push("Прогноз за історією відключень, без графіка.");

  const showLoud = settings.neighbour !== false && d.generator?.length;
  const strip = h("div.strip");
  const headline = h(`section.card.headline.${hl.tone}`, { "aria-live": "polite" },
    h("p.text", hl.text),
    hl.detail ? h("p.detail", hl.detail) : null,
    notes.length ? h("div.notes", notes.map((n) => h("p", n))) : null,
    strip,
    showLoud ? h("p.generator", `генератор сусідів: ${d.generator.map((g) => `${f.when(g.start, now)}–${f.time(g.end)}`).join(", ")}`) : null,
  );

  // ---------- battery ----------
  const ring = h("div.ring");
  const b = d.battery ?? {};
  const charging = s.batt_w < -30, discharging = s.batt_w > 30;
  let eta = null;
  if (discharging && b.empty_at) eta = `сяде близько ${f.when(b.empty_at, now)}`;
  else if (charging && b.full_at && b.full_at > now) eta = `зарядиться повністю близько ${f.when(b.full_at, now)}`;
  else if (s.soc >= 99 && !discharging) eta = "заряджена повністю";
  // The ring's tick and the "→" line: where the charge will be when the grid returns (same number as in the headline).
  const gh = d.ghost;
  let ghostSub = "", ghostWhen = "";
  if (gh && !(gh.kind === "horizon" && Math.round(gh.soc) === Math.round(s.soc))) {
    ghostSub = `→ ${f.pct(gh.soc)}`;
    ghostWhen = gh.kind === "horizon" ? "за 2 доби" : gh.guessed || !gh.at ? "орієнтовно" : `о ${f.when(gh.at, now)}`;
  }
  const battCard = h("section.card",
    h("div.battery",
      ring,
      h("div",
        h("div.label", "Батарея"),
        h("div.big", charging ? `+${f.W(-s.batt_w)}` : discharging ? `−${f.W(s.batt_w)}` : "у спокої"),
        charging || discharging ? h("div.sub", charging ? "заряджається" : "розряджається") : null,
        eta ? h("div.sub", eta) : null,
        b.runtime_h != null && !s.grid_on ? h("div.sub.muted", `без сонця і мережі: ≈${f.duration(b.runtime_h * 3600e3)}`) : null,
      ),
    ),
  );

  // ---------- flow ----------
  const flow = h("div.flow");
  // In = grid + sun + battery discharge; out = house + battery charge. The rest is the inverter's own use and losses.
  const overhead = (s.grid_on ? Math.max(0, s.grid_total_w ?? 0) : 0) + Math.max(0, s.pv_w ?? 0) + (s.batt_w ?? 0) - (s.load_total ?? 0);
  const flowCard = h("section.card", h("h2", "Потоки енергії"), flow,
    overhead >= 30 ? h("p.note", `Ще ${f.W(overhead)} — власне споживання і втрати інвертора.`) : null);

  // ---------- load ----------
  const main = settings.phase && settings.phase !== "all" ? settings.phase : null;
  const mainVal = main ? s[`load_${main}`] : s.load_total;
  const lh = d.last_hour ?? {};
  const lhMain = main ? lh[`load_${main}_wh`] : lh.load_wh;
  const today = d.today ?? {};
  const bars = h("div.phases");
  const loadCard = h("section.card",
    h("div.label", main ? names[main] : "Споживання"),
    h("div.row",
      h("div.huge", ...splitUnit(f.W(mainVal))),
      h("div", { style: { textAlign: "right" } },
        h("div.big", { style: { fontSize: "24px" } }, ...splitUnit(f.kWh(lhMain))),
        h("div.sub", "за останню годину")),
    ),
    h("div.sub", main ? `усього вдома ${f.W(s.load_total)} · за годину ${f.kWh(lh.load_wh)}` : `сьогодні ${f.kWh(today.load_wh)}`),
    bars,
  );

  // ---------- sun ----------
  const sun = d.sun ?? {};
  const sunCard = h("section.card",
    h("div.label", "Сонце"),
    h("div.row",
      h("div.big", ...splitUnit(f.W(s.pv_w))),
      h("div.sub", { style: { textAlign: "right" } }, `сьогодні ${f.kWh(sun.today_wh)}`)),
    sun.forecast_rest_wh != null
      ? h("div.sub", `прогноз до кінця дня ${f.kWh(sun.forecast_rest_wh)}${sun.forecast_rest_low_wh != null ? ` (мінімум ${f.kWhNum(sun.forecast_rest_low_wh)})` : ""}`)
      : h("div.sub.muted", "прогнозу сонця немає"),
    d.need_wh != null && sun.forecast_today_wh != null ? h("div.sub", `потреба за добу ~${f.kWh(d.need_wh)}`) : null,
    sun.fetched_at && now - sun.fetched_at > 6 * 3600e3 ? h("div.sub.muted", `прогноз ${f.ago(now - sun.fetched_at)}`) : null,
    s.soc >= 98 && s.batt_w >= -50 && s.pv_w > 0 ? h("div.sub.muted", "батарея повна: панелі віддають лише те, що споживається") : null,
  );

  // ---------- grid ----------
  const g = d.grid ?? {};
  const since = d.grid_since ? `${s.grid_on ? "є" : "немає"} ${f.duration(now - d.grid_since.ts)}, з ${f.when(d.grid_since.ts, now)}` : "";
  const gridLines = [];
  if (!s.grid_on && g.expected_return) gridLines.push(g.return_scheduled
    ? `повернення за графіком ${f.when(g.expected_return, now)}`
    : `повернення орієнтовно ${f.when(g.expected_return, now)}`);
  if (s.grid_on && g.next_outage) gridLines.push(`наступне відключення ${f.when(g.next_outage.start, now)}–${f.time(g.next_outage.end)}`);
  if (s.grid_on && !g.next_outage && d.schedule?.today?.status === "ScheduleApplies") gridLines.push("за графіком відключень більше немає");
  if (d.schedule?.today?.status === "EmergencyShutdowns") gridLines.push("екстрені відключення: графік не діє");
  if (!d.schedule?.today && !app.me?.shared?.addr_home?.group) gridLines.push("адресу для графіка не задано (Система)");
  const gridCard = h("section.card",
    h("div.label", "Мережа"),
    h("div.big", h("span", { class: `dot ${s.grid_on ? "on" : "off"}`, "aria-hidden": "true" }), s.grid_on ? "Світло є" : "Світла немає"),
    since ? h("div.sub", since) : null,
    s.grid_on ? h("div.sub", `з мережі ${f.W(Math.max(0, s.grid_total_w ?? 0))} · сьогодні ${f.kWh(today.grid_import_wh)}`) : null,
    gridLines.map((l) => h("div.sub", l)),
  );

  root.replaceChildren(...[
    installHint(),
    headline,
    h("div.grid2", battCard, flowCard),
    h("div.grid2", loadCard, sunCard),
    gridCard,
  ].filter(Boolean));

  dayStrip(strip, { now: Date.now(), outages: d.home_intervals ?? [], loud: showLoud ? d.generator : [] });
  batteryRing(ring, { soc: s.soc, floor: b.floor_pct ?? 15, ghost: ghostSub ? gh : null, sub: ghostSub, sub2: ghostWhen });
  energyFlow(flow, s);
  phaseBars(bars, { a: s.load_a, b: s.load_b, c: s.load_c, names, main });
}

/** "1,2 кВт" → ["1,2", <span.unit>кВт</span>] */
function splitUnit(text) {
  const i = text.lastIndexOf(" ");
  if (i < 0 || text === "—") return [text];
  const num = text.slice(0, i), unit = text.slice(i + 1);
  // "кВт·год" etc.
  return [num, h("span.unit", unit)];
}

/** Safari on iPhone, not installed: a short "add to Home Screen" hint (dismissible). */
function installHint() {
  let dismissed = false;
  try { dismissed = localStorage.getItem("hint-install") === "1"; } catch { /* blocked */ }
  if (dismissed || !isIos() || isStandalone()) return null;
  const card = h("section.card.hint",
    h("div.row", h("span", "Додайте застосунок на Початковий екран: «Поділитися» → «На Початковий екран». Так працюють сповіщення."),
      h("button.btn", { "aria-label": "Сховати", onclick: () => { try { localStorage.setItem("hint-install", "1"); } catch { /* */ } card.remove(); } }, "×")));
  return card;
}
