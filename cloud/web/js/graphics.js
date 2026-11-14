// Now-tab graphics: battery ring, energy flow, day strip, phase bars. Each has a text equivalent.

import { el, cssVar } from "./svg.js";
import * as f from "./fmt.js";

/** Battery ring: soc arc, the floor as a marked zone, a ghost tick where the projection ends. */
export function batteryRing(container, { soc, floor = 15, ghost = null, sub = "", sub2 = "" }) {
  container.replaceChildren();
  const size = 132, r = 54, c = 2 * Math.PI * r, sw = 12;
  const svg = el("svg", { viewBox: `0 0 ${size} ${size}`, role: "img",
    "aria-label": `Заряд ${Math.round(soc)}%. Нижня межа ${floor}%.${ghost ? ` За прогнозом буде ${Math.round(ghost.soc)}%${sub2 ? ` ${sub2}` : ""}.` : ""}` }, container);
  const g = el("g", { transform: `rotate(-90 ${size / 2} ${size / 2})` }, svg);
  const arc = (cls, from, to, extra = {}) => el("circle", {
    class: cls, cx: size / 2, cy: size / 2, r, fill: "none", "stroke-width": sw,
    "stroke-dasharray": `${(c * Math.max(0, to - from)) / 100} ${c}`, "stroke-dashoffset": `${(-c * from) / 100}`, ...extra,
  }, g);
  arc("bg", 0, 100);
  arc("floor", 0, floor);
  const cls = soc <= floor + 5 ? "val crit" : soc <= 30 ? "val low" : "val";
  arc(cls, 0, Math.max(0.5, Math.min(100, soc)), { "stroke-linecap": "round" });
  if (ghost && Number.isFinite(ghost.soc)) {
    const a = (ghost.soc / 100) * 2 * Math.PI;
    const cx = size / 2 + Math.cos(a) * r, cy = size / 2 + Math.sin(a) * r;
    const dx = Math.cos(a), dy = Math.sin(a);
    el("line", { class: "ghost", x1: cx - dx * 9, y1: cy - dy * 9, x2: cx + dx * 9, y2: cy + dy * 9, "stroke-linecap": "round" }, g);
  }
  const up = sub && sub2 ? 5 : 0;
  el("text", { x: size / 2, y: size / 2 + 8 - up, "text-anchor": "middle", "font-size": 30 }, svg).textContent = `${Math.round(soc)}%`;
  if (sub) el("text", { class: "rsub", x: size / 2, y: size / 2 + 26 - up, "text-anchor": "middle" }, svg).textContent = sub;
  if (sub && sub2) el("text", { class: "rsub rsub2", x: size / 2, y: size / 2 + 33, "text-anchor": "middle" }, svg).textContent = sub2;
}

const ICONS = {
  sun: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 1v3M12 20v3M1 12h3M20 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1",
  grid: "M8 2 5 22M16 2l3 20M6.5 9h11M5.5 15h13M12 2v20",
  house: "M3 11 12 3l9 8M5 9.5V21h14V9.5M10 21v-6h4v6",
  battery: "M7 4h10v18H7zM10 2h4v2M9.5 17.5h5M9.5 14h5",
};

/**
 * Energy flow: sun (top), grid (left), house (right), battery (bottom) around a hub.
 * Line direction and thickness follow the live power.
 */
export function energyFlow(container, s) {
  container.replaceChildren();
  const W = 340, H = 286, R = 34, hub = { x: W / 2, y: 138 };
  const pv = Math.max(0, s.pv_w ?? 0);
  const grid = s.grid_on ? Math.max(0, s.grid_total_w ?? s.grid_w ?? 0) : 0;
  const load = Math.max(0, s.load_total ?? 0);
  const batt = s.batt_w ?? 0; // + discharge, - charge
  const label = [
    `Сонце ${f.W(pv)}`,
    s.grid_on ? `мережа ${f.W(grid)}` : "мережі немає",
    `дім ${f.W(load)}`,
    batt > 30 ? `батарея віддає ${f.W(batt)}` : batt < -30 ? `батарея заряджається ${f.W(-batt)}` : "батарея у спокої",
  ].join(", ");
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": label }, container);
  const nodes = {
    sun: { x: W / 2, y: 48, name: "Сонце", v: pv, color: "--s2" },
    grid: { x: 48, y: hub.y, name: s.grid_on ? "Мережа" : "Немає мережі", v: grid, color: "--s4" },
    house: { x: W - 48, y: hub.y, name: "Дім", v: load, color: "--s1" },
    battery: { x: W / 2, y: 228, name: batt < -30 ? "Заряд" : batt > 30 ? "Розряд" : "Батарея", v: Math.abs(batt), color: "--s3" },
  };
  // Wires: [node, power, towardsHub]
  const wires = [
    ["sun", pv, true],
    ["grid", grid, true],
    ["house", load, false],
    ["battery", Math.abs(batt), batt > 0],
  ];
  for (const [k, p, inward] of wires) {
    const n = nodes[k];
    const dx = hub.x - n.x, dy = hub.y - n.y, len = Math.hypot(dx, dy);
    const sx = n.x + (dx / len) * R, sy = n.y + (dy / len) * R, ex = hub.x - (dx / len) * 6, ey = hub.y - (dy / len) * 6;
    el("line", { class: "wire", x1: sx, y1: sy, x2: ex, y2: ey }, svg);
    if (p >= 20) {
      const w = Math.min(9, 1.5 + Math.sqrt(p) / 9);
      const [x1, y1, x2, y2] = inward ? [sx, sy, ex, ey] : [ex, ey, sx, sy];
      el("line", { class: "live", x1, y1, x2, y2, stroke: cssVar(n.color), "stroke-width": w,
        style: `animation-duration:${Math.max(0.5, 2.2 - Math.log10(p))}s` }, svg);
    }
  }
  el("circle", { cx: hub.x, cy: hub.y, r: 6, fill: cssVar("--ink-2") }, svg);
  const valText = { sun: f.W(pv), grid: s.grid_on ? f.W(grid) : "—", house: f.W(load), battery: f.W(Math.abs(batt)) };
  for (const [k, n] of Object.entries(nodes)) {
    const active = n.v >= 20;
    const g = el("g", { class: `node${active ? " active" : ""}`, transform: `translate(${n.x} ${n.y})` }, svg);
    el("circle", { r: R, style: active ? `stroke:${cssVar(n.color)}` : null }, g);
    el("path", { d: ICONS[k], transform: "translate(-12 -23)", style: `color:${active ? cssVar(n.color) : cssVar("--muted")}` }, g);
    el("text", { class: "v", y: 19 }, g).textContent = valText[k];
    el("text", { class: "n", y: k === "sun" ? -R - 6 : R + 14 }, g).textContent = n.name;
  }
}

/**
 * A thin 24-hour bar: outage slots, generator hours, night, now marker.
 * Before "now" it shows what really happened (`actual`); a planned slot that has passed is only a pale outline.
 */
export function dayStrip(container, { now, outages = [], loud = [], actual = null }) {
  container.replaceChildren();
  const W = container.clientWidth || 320, H = 36;
  const from = f.kyivMidnight(now), to = f.kyivMidnight(from + 30 * 3600e3);
  const x = (t) => ((Math.min(Math.max(t, from), to) - from) / (to - from)) * W;
  const today = outages.filter((o) => o.end > from && o.start < to);
  const parts = today.map((o) => `${f.time(Math.max(o.start, from))}–${o.end >= to ? "24:00" : f.time(o.end)}`);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": parts.length ? `Сьогодні відключення за графіком: ${parts.join(", ")}` : "Сьогодні відключень за графіком немає" }, container);
  el("rect", { class: "track", x: 0, y: 4, width: W, height: 12, rx: 6 }, svg);
  const sun = f.sunTimes(now);
  if (sun) {
    el("rect", { class: "night", x: 0, y: 4, width: x(sun.rise), height: 12 }, svg);
    el("rect", { class: "night", x: x(sun.set), y: 4, width: W - x(sun.set), height: 12 }, svg);
  }
  const bar = (cls, a, b) => { if (b > a) el("rect", { class: cls, x: x(a), y: 4, width: Math.max(2, x(b) - x(a)), height: 12, rx: 3 }, svg); };
  let missed = false;
  for (const o of today) {
    if (actual) {
      // Past part: planned only. Whether the light really went off comes from `actual` below.
      if (o.start < now) { bar("out plan", o.start, Math.min(o.end, now)); missed = true; }
      bar("out", Math.max(o.start, now), o.end);
    } else bar("out", o.start, o.end);
  }
  for (const o of actual ?? []) bar("out", Math.max(o.start, from), Math.min(o.end ?? now, now));
  for (const o of loud) if (o.end > from && o.start < to) el("rect", { class: "loud", x: x(o.start), y: 18, width: Math.max(2, x(o.end) - x(o.start)), height: 3, rx: 1.5 }, svg);
  el("line", { class: "nowline", x1: x(now), x2: x(now), y1: 1, y2: 19 }, svg);
  for (const h of [0, 6, 12, 18, 24]) {
    const t = from + h * 3600e3;
    el("text", { x: h === 0 ? 0 : h === 24 ? W : x(t), y: H - 2, "text-anchor": h === 0 ? "start" : h === 24 ? "end" : "middle" }, svg).textContent = String(h);
  }
  return { planned: today.length > 0, missed };
}

/** Three phase bars next to the total. `main` = the user's chosen phase (or null). */
export function phaseBars(container, { a, b, c, names, main }) {
  container.replaceChildren();
  const vals = { a, b, c };
  const max = Math.max(500, a ?? 0, b ?? 0, c ?? 0);
  for (const k of ["a", "b", "c"]) {
    const row = document.createElement("div");
    row.className = `phase${main === k ? " main" : ""}`;
    const name = document.createElement("span"); name.className = "name"; name.textContent = names[k];
    const bar = document.createElement("span"); bar.className = "bar";
    const fill = document.createElement("i"); fill.style.width = `${(Math.max(0, vals[k] ?? 0) / max) * 100}%`;
    bar.append(fill);
    const v = document.createElement("b"); v.textContent = f.W(vals[k]);
    row.append(name, bar, v);
    container.append(row);
  }
}
