// Small inline-SVG chart kit: time-series lines/bands, stacked bars, lanes. No dependencies.

import * as f from "./fmt.js";

export const NS = "http://www.w3.org/2000/svg";
export function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  parent?.append(e);
  return e;
}
// One tooltip for all charts. On phones there is no "pointer leave", so hide it on scroll,
// on a tap outside a chart, on tab switch, on redraw, and 3 s after a touch.
let tipTimer;
export function hideTip() {
  clearTimeout(tipTimer);
  const t = document.getElementById("tooltip");
  if (t) t.hidden = true;
  for (const c of document.querySelectorAll("svg .cross")) c.setAttribute("visibility", "hidden");
}
function autoHide(ev) {
  clearTimeout(tipTimer);
  if (ev.pointerType !== "mouse") tipTimer = setTimeout(hideTip, 3000);
}
window.addEventListener("scroll", hideTip, { passive: true });
document.addEventListener("pointerdown", (e) => { if (!e.target.closest?.(".chart")) hideTip(); });
document.addEventListener("visibilitychange", hideTip);

export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function niceTicks(min, max, count) {
  const span = max - min || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.floor(min / step) * step; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

/** X ticks at Kyiv-local round hours/days. */
function timeTicks(from, to) {
  const span = to - from;
  const step = span <= 13 * 3600e3 ? 2 * 3600e3 : span <= 30 * 3600e3 ? 4 * 3600e3 : span <= 60 * 3600e3 ? 12 * 3600e3 : span <= 9 * 86400e3 ? 86400e3 : 5 * 86400e3;
  const ticks = [];
  let t = f.kyivMidnight(from);
  if (step >= 86400e3) {
    for (; t <= to; t = f.kyivMidnight(t + 30 * 3600e3)) if (t >= from) ticks.push({ t, label: f.day(t) });
  } else {
    for (; t <= to; t += step) if (t >= from) ticks.push({ t, label: f.time(t) === "00:00" ? f.day(t) : f.time(t) });
  }
  return ticks.filter((x, i, a) => !(step >= 86400e3 && a.length > 8 && i % 2));
}

/**
 * Time-series chart.
 * opts: { from, to, series: [{ name, color, points: [{t, v}], dash, band: [{t, lo, hi}], fmt, step }],
 *         (series also: area — fill down to zero, opacity)
 *         y: { min, max, unit, fmt } (default: watts shown as kW numbers), shades: [{ start, end, cls }], floor: number, now: ms, label, gapMs }
 */
export function timeChart(container, opts) {
  hideTip();
  container.replaceChildren();
  const W = container.clientWidth || 320, H = container.clientHeight || 200;
  const m = { l: 40, r: 8, t: 8, b: 22 };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.label ?? "" }, container);
  const { from, to } = opts;
  const x = (t) => m.l + ((t - from) / (to - from)) * (W - m.l - m.r);

  let lo = opts.y?.min ?? Infinity, hi = opts.y?.max ?? -Infinity;
  if (opts.y?.min == null || opts.y?.max == null) {
    for (const s of opts.series) {
      for (const p of s.points ?? []) if (p.v != null) { if (opts.y?.min == null) lo = Math.min(lo, p.v); if (opts.y?.max == null) hi = Math.max(hi, p.v); }
      for (const p of s.band ?? []) { if (opts.y?.max == null) hi = Math.max(hi, p.hi); if (opts.y?.min == null) lo = Math.min(lo, p.lo); }
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1000; }
    if (opts.y?.min == null) lo = Math.min(lo, 0);
    hi = Math.max(hi, lo + (opts.y?.minSpan ?? 100));
  }
  const ticks = niceTicks(lo, hi, 4);
  lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo || 1)) * (H - m.t - m.b);
  const yFmt = opts.y?.fmt ?? f.kW;

  for (const s of opts.shades ?? []) {
    const a = Math.max(s.start, from), b = Math.min(s.end ?? to, to);
    if (b > a) el("rect", { class: s.cls ?? "off", x: x(a), y: m.t, width: Math.max(1, x(b) - x(a)), height: H - m.t - m.b }, svg);
  }
  if (opts.floor != null) {
    el("rect", { class: "floor-zone", x: m.l, y: y(opts.floor), width: W - m.l - m.r, height: Math.max(0, y(lo) - y(opts.floor)) }, svg);
    el("line", { class: "floor-line", x1: m.l, x2: W - m.r, y1: y(opts.floor), y2: y(opts.floor) }, svg);
  }
  for (const t of ticks) {
    el("line", { class: t === 0 ? "base-line" : "grid-line", x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }, svg);
    el("text", { class: "tick", x: m.l - 6, y: y(t) + 4, "text-anchor": "end" }, svg).textContent = yFmt(t);
  }
  // A label at the right edge would stick out of the card: align it to the edge, and drop a neighbour it would cover.
  const boxes = [];
  for (const tk of timeTicks(from, to).reverse()) {
    const edge = x(tk.t) > W - m.r - 24, w = tk.label.length * 6;
    const a = edge ? W - m.r - w : x(tk.t) - w / 2, b = a + w;
    if (boxes.some(([p, q]) => a < q + 3 && b > p - 3)) continue;
    boxes.push([a, b]);
    el("text", { class: "tick", x: edge ? W - m.r : x(tk.t), y: H - 6, "text-anchor": edge ? "end" : "middle" }, svg).textContent = tk.label;
  }
  if (opts.now != null && opts.now > from && opts.now < to) {
    el("line", { class: "nowline", x1: x(opts.now), x2: x(opts.now), y1: m.t, y2: H - m.b }, svg);
  }

  const any = opts.series.some((s) => (s.points?.length ?? 0) || (s.band?.length ?? 0));
  if (!any) {
    el("text", { class: "empty", x: (W + m.l) / 2, y: H / 2, "text-anchor": "middle" }, svg).textContent = opts.emptyText ?? "Немає даних";
    return;
  }

  const gapMs = opts.gapMs ?? Infinity;
  for (const s of opts.series) {
    if (s.band?.length) {
      let top = "", bot = "";
      s.band.forEach((p, i) => { top += `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.hi).toFixed(1)}`; });
      [...s.band].reverse().forEach((p) => { bot += `L${x(p.t).toFixed(1)},${y(p.lo).toFixed(1)}`; });
      el("path", { class: "band", d: `${top}${bot}Z`, fill: cssVar(s.color) }, svg);
    }
    if (s.points?.length) {
      // Unbroken runs of points; a gap longer than gapMs starts a new run.
      const runs = [];
      let prev = null;
      for (const p of s.points) {
        if (p.v == null) { prev = null; continue; }
        if (prev == null || p.t - prev > gapMs) runs.push([]);
        runs[runs.length - 1].push(p);
        prev = p.t;
      }
      const line = (run) => run.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
      const base = y(Math.max(lo, 0)).toFixed(1);
      if (s.area) {
        for (const run of runs) {
          el("path", { class: "area", d: `${line(run)}L${x(run[run.length - 1].t).toFixed(1)},${base}L${x(run[0].t).toFixed(1)},${base}Z`, fill: cssVar(s.color) }, svg);
        }
      }
      el("path", { class: `series${s.dash ? " dash" : ""}`, d: runs.map(line).join(""), stroke: cssVar(s.color), opacity: s.opacity }, svg);
    }
  }

  // Crosshair + tooltip over all series.
  const cross = el("line", { class: "cross", y1: m.t, y2: H - m.b, visibility: "hidden" }, svg);
  const tip = document.getElementById("tooltip");
  const hide = () => { cross.setAttribute("visibility", "hidden"); tip.hidden = true; };
  const nearest = (pts, t) => {
    let best = null;
    for (const p of pts) if (p.v != null && (!best || Math.abs(p.t - t) < Math.abs(best.t - t))) best = p;
    return best;
  };
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    if (px < m.l || px > W - m.r) return hide();
    const t = from + ((px - m.l) / (W - m.l - m.r)) * (to - from);
    const rows = [];
    let at = null;
    for (const s of opts.series) {
      if (!s.points?.length || s.noTip) continue;
      const p = nearest(s.points, t);
      if (!p || Math.abs(p.t - t) > (s.step ?? (to - from) / 50) * 1.5) continue;
      at ??= p.t;
      rows.push({ s, p });
    }
    if (!rows.length) return hide();
    cross.setAttribute("x1", x(at)); cross.setAttribute("x2", x(at)); cross.setAttribute("visibility", "visible");
    tip.replaceChildren();
    const head = document.createElement("div");
    head.className = "tt-time";
    head.textContent = opts.tipTime ? opts.tipTime(at) : f.when(at);
    tip.append(head);
    for (const { s, p } of rows) {
      const row = document.createElement("div");
      row.className = "tt-row";
      const key = document.createElement("i"); key.style.setProperty("--c", cssVar(s.color));
      const val = document.createElement("b"); val.textContent = (s.fmt ?? f.W)(p.v);
      const name = document.createElement("span"); name.textContent = s.name;
      row.append(key, val, name);
      tip.append(row);
    }
    tip.hidden = false;
    autoHide(ev);
    const tx = Math.min(ev.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${Math.max(8, tx)}px`;
    tip.style.top = `${Math.max(8, ev.clientY - tip.offsetHeight - 12)}px`;
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", hide);
  return { x, y, svg, m, W, H };
}

/**
 * Stacked bar chart by category.
 * opts: { items: [{ key, label, parts: [{ v, cls, name }], marker? }], unit fmt, label, line: [{ v }] }
 */
export function barChart(container, opts) {
  hideTip();
  container.replaceChildren();
  const W = container.clientWidth || 320, H = container.clientHeight || 200;
  const m = { l: 40, r: 8, t: 8, b: 22 };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.label ?? "" }, container);
  const items = opts.items;
  let hi = 0;
  for (const it of items) hi = Math.max(hi, it.parts.reduce((s, p) => s + Math.max(0, p.v ?? 0), 0), it.marker ?? 0);
  if (hi <= 0) hi = 1000;
  const ticks = niceTicks(0, hi, 4);
  // The top tick must not be below the tallest bar.
  const tickStep = ticks[1] - ticks[0];
  while (ticks[ticks.length - 1] < hi) ticks.push(Math.round((ticks[ticks.length - 1] + tickStep) * 1e6) / 1e6);
  hi = ticks[ticks.length - 1];
  const y = (v) => m.t + (1 - v / hi) * (H - m.t - m.b);
  const fmtY = opts.yFmt ?? f.kW;
  for (const t of ticks) {
    el("line", { class: t === 0 ? "base-line" : "grid-line", x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }, svg);
    el("text", { class: "tick", x: m.l - 6, y: y(t) + 4, "text-anchor": "end" }, svg).textContent = fmtY(t);
  }
  const bw = (W - m.l - m.r) / Math.max(1, items.length);
  const labelEvery = Math.ceil(items.length / Math.max(1, Math.floor((W - m.l) / 44)));
  const tip = document.getElementById("tooltip");
  items.forEach((it, i) => {
    const x0 = m.l + i * bw + bw * 0.15, w = Math.max(1, bw * 0.7);
    let acc = 0;
    const g = el("g", {}, svg);
    for (const p of it.parts) {
      const v = Math.max(0, p.v ?? 0);
      if (v > 0) el("rect", { class: p.cls, x: x0, y: y(acc + v), width: w, height: Math.max(0.5, y(acc) - y(acc + v)), rx: 1.5 }, g);
      acc += v;
    }
    if (it.marker != null) el("line", { x1: x0 - 2, x2: x0 + w + 2, y1: y(it.marker), y2: y(it.marker), stroke: cssVar("--ink-2"), "stroke-width": 2, "stroke-dasharray": "3 2" }, g);
    if (i % labelEvery === 0) el("text", { class: "tick", x: x0 + w / 2, y: H - 6, "text-anchor": "middle" }, svg).textContent = it.label;
    const hit = el("rect", { x: m.l + i * bw, y: m.t, width: bw, height: H - m.t - m.b, fill: "transparent" }, svg);
    const show = (ev) => {
      tip.replaceChildren();
      const head = document.createElement("div"); head.className = "tt-time"; head.textContent = it.title ?? it.label; tip.append(head);
      for (const p of [...it.parts, ...(it.extra ?? [])]) {
        const row = document.createElement("div"); row.className = "tt-row";
        const key = document.createElement("i"); key.style.setProperty("--c", p.color ? cssVar(p.color) : "transparent");
        const val = document.createElement("b"); val.textContent = p.text ?? (opts.fmt ?? f.kWh)(p.v);
        const name = document.createElement("span"); name.textContent = p.name;
        row.append(key, val, name); tip.append(row);
      }
      tip.hidden = false;
      autoHide(ev);
      const tx = Math.min(ev.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
      tip.style.left = `${Math.max(8, tx)}px`;
      tip.style.top = `${Math.max(8, ev.clientY - tip.offsetHeight - 12)}px`;
    };
    hit.addEventListener("pointermove", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("pointerleave", () => { tip.hidden = true; });
  });
}

export function legend(container, items) {
  container.replaceChildren();
  for (const it of items) {
    const s = document.createElement("span");
    s.style.setProperty("--c", cssVar(it.color));
    if (it.band) s.className = "band";
    if (it.dash) s.className = "dash";
    s.textContent = it.name;
    container.append(s);
  }
}

/** Nights (sunset→sunrise) as shade intervals over [from, to]. */
export function nights(from, to) {
  const out = [];
  for (let d = f.kyivMidnight(from) - 86400e3; d < to + 86400e3; d = f.kyivMidnight(d + 30 * 3600e3)) {
    const s = f.sunTimes(d + 12 * 3600e3);
    const n = f.sunTimes(d + 36 * 3600e3);
    if (s && n) out.push({ start: s.set, end: n.rise, cls: "night" });
  }
  return out.filter((i) => i.end > from && i.start < to);
}
