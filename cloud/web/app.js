// Deye dashboard: no build step, no dependencies.

const RANGES = { day: 24 * 3600e3, week: 7 * 24 * 3600e3, month: 30 * 24 * 3600e3 };
const STALE_MS = 3 * 60e3; // the pusher sends every ~30-60 s
const POWER_SERIES = [
  { key: "load_total", name: "Споживання", color: "--s1" },
  { key: "pv_w", name: "Сонце", color: "--s2" },
  { key: "batt_w", name: "Батарея", color: "--s3" },
];
const SOC_SERIES = [{ key: "soc", name: "Заряд", color: "--s1" }];

let range = "day";
let series = null;
let outages = [];

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("uk-UA");
const fmtW = (w) => (w == null ? "—" : Math.abs(w) >= 1000 ? `${(w / 1000).toLocaleString("uk-UA", { maximumFractionDigits: 1 })} кВт` : `${nf.format(Math.round(w))} Вт`);
const fmtTime = (ts) => new Date(ts).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
const fmtDateTime = (ts) => new Date(ts).toLocaleString("uk-UA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function fmtDuration(ms) {
  const min = Math.round(ms / 60e3);
  if (min < 1) return "< 1 хв";
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return [d && `${d} д`, h && `${h} год`, m && `${m} хв`].filter(Boolean).join(" ");
}
function fmtAgo(ms) {
  return ms < 60e3 ? "щойно" : `${fmtDuration(ms)} тому`;
}

async function getJson(path) {
  const res = await fetch(path, { credentials: "same-origin", cache: "no-store" });
  // Expired Access session: Access answers with a redirect to its login page.
  if (res.redirected || res.status === 401 || res.status === 403) {
    location.reload();
    throw new Error("auth");
  }
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// ---------- current state ----------

function renderNow(now) {
  const s = now.sample;
  const statusEl = $("status");
  const age = s ? now.server_ms - s.ts : Infinity;
  const stale = age > STALE_MS;
  $("freshness").textContent = s ? `оновлено ${fmtAgo(age)}` : "даних ще немає";

  statusEl.className = "card status " + (!s ? "stale" : stale ? "stale" : s.grid_on ? "on" : "off");
  if (!s) {
    $("status-icon").textContent = "?";
    $("status-text").textContent = "Даних ще немає";
    $("status-since").textContent = "Чекаємо на перші дані від інвертора.";
    return;
  }
  if (stale) {
    $("status-icon").textContent = "!";
    $("status-text").textContent = "Немає свіжих даних";
    $("status-since").textContent =
      `Останні дані ${fmtAgo(age)} (${s.grid_on ? "світло було" : "світла не було"}). ` +
      "Можливо, немає інтернету або світла, і роутер вимкнений.";
  } else {
    $("status-icon").textContent = s.grid_on ? "✓" : "✕";
    $("status-text").textContent = s.grid_on ? "Світло є" : "Світла немає";
    $("status-since").textContent = now.grid_since
      ? `${s.grid_on ? "Є" : "Немає"} вже ${fmtDuration(now.server_ms - now.grid_since.ts)} (з ${fmtDateTime(now.grid_since.ts)})`
      : "";
  }

  $("t-soc").textContent = `${s.soc} %`;
  $("t-batt").textContent = s.batt_w > 0 ? `розряд ${fmtW(s.batt_w)}` : s.batt_w < 0 ? `заряд ${fmtW(-s.batt_w)}` : "у спокої";
  $("t-load").textContent = fmtW(s.load_total);
  $("t-phases").textContent = `A ${nf.format(s.load_a)} · B ${nf.format(s.load_b)} · C ${nf.format(s.load_c)} Вт`;
  $("t-pv").textContent = fmtW(s.pv_w);
  $("t-pv-sub").textContent = `1: ${nf.format(s.pv1_w)} · 2: ${nf.format(s.pv2_w)} Вт`;
  $("t-grid").textContent = s.grid_on ? fmtW(s.grid_w) : "—";
  $("t-grid-sub").textContent = s.grid_on
    ? `${[s.grid_v_a, s.grid_v_b, s.grid_v_c].map((v) => Math.round(v)).join(" / ")} В · ${s.grid_hz.toFixed(2)} Гц`
    : "немає напруги";
}

function renderHealth(now, health) {
  const hb = now.heartbeat;
  const rows = [
    ["Останні дані", health.last_sample_ts ? `${fmtDateTime(health.last_sample_ts)} (${fmtAgo(health.server_ms - health.last_sample_ts)})` : "—"],
    ["Записів за добу", `${nf.format(health.samples_24h)} з ~2 880`],
  ];
  if (hb) {
    rows.push(
      ["Останній сигнал", `${fmtDateTime(hb.received_at)} (${fmtAgo(now.server_ms - hb.received_at)})`],
      ["Версія", hb.pusher_version ?? "—"],
      ["Pi працює", hb.boot_age_s != null ? fmtDuration(hb.boot_age_s * 1000) : "—"],
      ["Черга / втрачено", `${hb.queue_len ?? "—"} / ${hb.dropped ?? "—"}`],
      ["Помилки читання / відправки", `${hb.read_errors ?? "—"} / ${hb.send_errors ?? "—"}`],
    );
    if (hb.last_error) rows.push(["Остання помилка", String(hb.last_error)]);
  }
  const dl = $("health");
  dl.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    dl.append(dt, dd);
  }
}

function renderOutages(list) {
  const ul = $("outages");
  ul.replaceChildren();
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "За останні 30 днів відключень не було.";
    ul.append(li);
    return;
  }
  for (const o of list) {
    const li = document.createElement("li");
    const when = document.createElement("span");
    when.textContent = `${fmtDateTime(o.start)} – ${o.end ? fmtTime(o.end) : "триває"}`;
    const dur = document.createElement("span");
    dur.className = "dur";
    dur.textContent = fmtDuration((o.end ?? Date.now()) - o.start);
    // The real start/end is known only within the gap between two samples.
    const slack = (o.start - o.start_after) + (o.end && o.end_after ? o.end - o.end_after : 0);
    if (slack > 5 * 60e3) li.title = `Точність ± ${fmtDuration(slack)} (у цей час не було даних)`;
    li.append(when, dur);
    ul.append(li);
  }
}

// ---------- charts ----------

function niceTicks(min, max, count) {
  const span = max - min || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.floor(min / step) * step; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

const SVG = "http://www.w3.org/2000/svg";
function el(name, attrs = {}, parent) {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.append(e);
  return e;
}

function drawChart(container, data, defs, opts = {}) {
  container.replaceChildren();
  const W = container.clientWidth, H = container.clientHeight;
  // Direct labels at line ends only when there is room; on phones the legend above does the job.
  const showEndLabels = defs.length > 1 && W >= 520;
  const m = { l: 44, r: showEndLabels ? 84 : 10, t: 8, b: 22 };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.label ?? "" }, container);
  const { from, to, step, points } = data;
  const x = (t) => m.l + ((t - from) / (to - from)) * (W - m.l - m.r);

  // Y domain
  let lo = opts.min ?? Infinity, hi = opts.max ?? -Infinity;
  if (opts.min == null || opts.max == null) {
    for (const p of points) for (const d of defs) {
      const v = p[d.key];
      if (v == null) continue;
      if (opts.min == null) lo = Math.min(lo, v);
      if (opts.max == null) hi = Math.max(hi, v);
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1000; } // no data: a sensible empty scale
    hi = Math.max(hi, lo + 100); // flat lines (e.g. all zeros at night) keep whole-watt ticks
    lo = Math.min(lo, 0);
  }
  const ticks = niceTicks(lo, hi, 4);
  lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo || 1)) * (H - m.t - m.b);

  // Grid-off bands (behind everything): buckets where the grid was off on average, plus known outages.
  for (const o of outages) {
    const a = Math.max(o.start, from), b = Math.min(o.end ?? to, to);
    if (b > a) el("rect", { class: "off", x: x(a), y: m.t, width: Math.max(1, x(b) - x(a)), height: H - m.t - m.b }, svg);
  }

  for (const t of ticks) {
    el("line", { class: t === 0 ? "base-line" : "grid-line", x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }, svg);
    const lbl = el("text", { class: "tick", x: m.l - 6, y: y(t) + 4, "text-anchor": "end" }, svg);
    lbl.textContent = opts.unit === "%" ? `${t}` : Math.abs(t) >= 1000 ? `${t / 1000}к` : `${t}`;
  }

  // X ticks
  const span = to - from;
  const xStep = span <= 26 * 3600e3 ? 4 * 3600e3 : span <= 8 * 86400e3 ? 86400e3 : 5 * 86400e3;
  const tzOff = new Date().getTimezoneOffset() * 60e3;
  for (let t = Math.ceil((from - tzOff) / xStep) * xStep + tzOff; t <= to; t += xStep) {
    const lbl = el("text", { class: "tick", x: x(t), y: H - 6, "text-anchor": "middle" }, svg);
    lbl.textContent = xStep < 86400e3 ? fmtTime(t) : new Date(t).toLocaleDateString("uk-UA", { day: "numeric", month: "numeric" });
  }

  if (!points.length) {
    const t = el("text", { class: "empty", x: (W - m.r + m.l) / 2, y: H / 2, "text-anchor": "middle" }, svg);
    t.textContent = "Немає даних за цей період";
    return;
  }

  // Lines, broken at data gaps.
  const endLabels = [];
  for (const d of defs) {
    let path = "", prevT = null, last = null;
    for (const p of points) {
      const v = p[d.key];
      if (v == null) { prevT = null; continue; }
      const cmd = prevT == null || p.t - prevT > step * 2.5 ? "M" : "L";
      path += `${cmd}${x(p.t + step / 2).toFixed(1)},${y(v).toFixed(1)}`;
      prevT = p.t; last = { t: p.t, v };
    }
    el("path", { class: "series", d: path, stroke: cssVar(d.color) }, svg);
    if (last && showEndLabels) endLabels.push({ name: d.name, y: y(last.v) });
  }
  // Direct labels at the right edge, de-overlapped.
  endLabels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < endLabels.length; i++) endLabels[i].y = Math.max(endLabels[i].y, endLabels[i - 1].y + 13);
  for (const l of endLabels) {
    const t = el("text", { class: "end-label", x: W - m.r + 6, y: l.y + 4 }, svg);
    t.textContent = l.name;
  }

  // Crosshair + tooltip.
  const cross = el("line", { class: "cross", y1: m.t, y2: H - m.b, visibility: "hidden" }, svg);
  const tip = $("tooltip");
  const hide = () => { cross.setAttribute("visibility", "hidden"); tip.hidden = true; };
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    if (px < m.l || px > W - m.r) return hide();
    const t = from + ((px - m.l) / (W - m.l - m.r)) * (to - from);
    let best = null;
    for (const p of points) if (!best || Math.abs(p.t + step / 2 - t) < Math.abs(best.t + step / 2 - t)) best = p;
    if (!best || Math.abs(best.t + step / 2 - t) > step * 2) return hide();
    const cx = x(best.t + step / 2);
    cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
    tip.replaceChildren();
    const head = document.createElement("div");
    head.className = "tt-time";
    head.textContent = `${fmtDateTime(best.t)}${step > 60e3 ? ` – ${fmtTime(best.t + step)}` : ""}` + (best.grid_on < 1 ? " · без світла" : "");
    tip.append(head);
    for (const d of defs) {
      const row = document.createElement("div");
      row.className = "tt-row";
      const key = document.createElement("i"); key.style.setProperty("--c", cssVar(d.color));
      const val = document.createElement("b"); val.textContent = opts.unit === "%" ? `${Math.round(best[d.key])} %` : fmtW(best[d.key]);
      const name = document.createElement("span"); name.textContent = d.name;
      row.append(key, val, name);
      tip.append(row);
    }
    tip.hidden = false;
    const tx = Math.min(ev.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${Math.max(8, tx)}px`;
    tip.style.top = `${Math.max(8, ev.clientY - tip.offsetHeight - 12)}px`;
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", hide);
}

function renderLegend() {
  const lg = $("legend-power");
  lg.replaceChildren();
  for (const d of POWER_SERIES) {
    const s = document.createElement("span");
    s.style.setProperty("--c", cssVar(d.color));
    s.textContent = d.name;
    lg.append(s);
  }
}

function renderTable(data) {
  const tb = document.querySelector("#table tbody");
  tb.replaceChildren();
  for (const p of [...data.points].reverse()) {
    const tr = document.createElement("tr");
    const cells = [
      fmtDateTime(p.t), fmtW(p.load_total), fmtW(p.pv_w), fmtW(p.batt_w), `${Math.round(p.soc)} %`,
      p.grid_on >= 1 ? "є" : p.grid_on <= 0 ? "немає" : "частково",
    ];
    for (const c of cells) { const td = document.createElement("td"); td.textContent = c; tr.append(td); }
    tb.append(tr);
  }
}

function renderCharts() {
  if (!series) return;
  renderLegend();
  drawChart($("chart-power"), series, POWER_SERIES, { label: "Потужність: споживання, сонце, батарея" });
  drawChart($("chart-soc"), series, SOC_SERIES, { min: 0, max: 100, unit: "%", label: "Заряд батареї" });
}

// ---------- refresh ----------

async function refreshNow() {
  const [now, health] = await Promise.all([getJson("/api/now"), getJson("/api/health")]);
  renderNow(now);
  renderHealth(now, health);
}

async function refreshSeries() {
  const to = Date.now(), from = to - RANGES[range];
  const [s, o] = await Promise.all([
    getJson(`/api/series?from=${from}&to=${to}`),
    getJson(`/api/outages?from=${to - RANGES.month}&to=${to}`),
  ]);
  series = s;
  outages = o.outages;
  renderOutages(outages);
  renderCharts();
  renderTable(series);
}

async function refreshAll() {
  try {
    await Promise.all([refreshNow(), refreshSeries()]);
  } catch (e) {
    if (e.message !== "auth") $("freshness").textContent = "немає зв'язку з сервером";
  }
}

for (const b of document.querySelectorAll(".seg button")) {
  b.addEventListener("click", () => {
    range = b.dataset.range;
    for (const o of document.querySelectorAll(".seg button")) o.setAttribute("aria-pressed", String(o === b));
    refreshSeries().catch(() => {});
  });
}

let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderCharts, 150); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderCharts);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAll(); });
setInterval(() => { if (!document.hidden) refreshNow().catch(() => {}); }, 30e3);
setInterval(() => { if (!document.hidden) refreshSeries().catch(() => {}); }, 5 * 60e3);
refreshAll();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
