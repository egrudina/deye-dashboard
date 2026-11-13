// Tab 4: Система. Personal settings, notifications, shared settings, health, grid voltages.

import { send, cached, load, AuthError } from "../api.js";
import { h, keepScroll } from "../dom.js";
import * as f from "../fmt.js";

let root, app, alive = false, health = null;


export function mount(el, a) {
  root = el; app = a; alive = true;
  health = cached("health");
  render();
  refresh();
}
export function unmount() { alive = false; }
export const redraw = () => render();
export async function tick() { refreshHealth(); }
export async function refresh() {
  await Promise.all([app.refreshMe(), refreshHealth()]);
  if (alive) render();
}
async function refreshHealth() {
  try { health = await load("health", "/api/health"); } catch (e) { if (!(e instanceof AuthError)) health = health ?? null; }
  if (alive) renderHealth();
}

const NOTIFY = [
  ["grid", "Світло зникло / з'явилося", ""],
  ["wont_last", "Батареї не вистачить", "прогноз: сяде до повернення світла (і в тихі години)"],
  ["low_batt", "Низький заряд", "коли світла немає"],
  ["schedule", "Графік змінився", "або почалися екстрені відключення"],
  ["outage_soon", "Скоро відключення", "за 30 хв за графіком"],
  ["generator_soon", "Скоро генератор сусідів", "за 15 хв"],
  ["stale", "Немає даних", "15 хв без даних від інвертора"],
];

let els = {};
function render() { keepScroll(renderNow); }
function renderNow() {
  const me = app.me;
  if (!me) { root.replaceChildren(h("p.empty-state", "Завантаження…")); return; }
  const s = me.settings, sh = me.shared;
  const msg = (el) => (text, ok = true) => { el.textContent = text; el.className = ok ? "saved" : "err"; if (ok) setTimeout(() => { el.textContent = ""; }, 2500); };

  // ---------- personal ----------
  const pStatus = h("span");
  const savePersonal = async (patch) => {
    try {
      const r = await send("PUT", "/api/settings", patch);
      app.me = { ...app.me, settings: r.settings };
      msg(pStatus)("Збережено");
    } catch (e) { msg(pStatus)(`Помилка: ${e.message}`, false); }
  };
  const phaseOpts = [["all", "Усі фази"], ["a", sh.phase_names.a], ["b", sh.phase_names.b], ["c", sh.phase_names.c]];
  const personal = h("section.card",
    h("h2", "Мої налаштування"),
    h("p.note", `Ви: ${me.email}. Налаштування діють на всіх ваших пристроях.`),
    h("fieldset", h("legend", "Головне число на екрані «Зараз»"),
      h("div.radios", phaseOpts.map(([v, label]) => h("label", h("input", { type: "radio", name: "phase", value: v, checked: s.phase === v,
        onchange: () => savePersonal({ phase: v }) }), label)))),
    h("div.switch", h("span", "Генератор сусідів", h("small", "рядок на «Зараз», смуга на «План», сповіщення")),
      h("input", { type: "checkbox", role: "switch", checked: s.neighbour, "aria-label": "Показувати генератор сусідів",
        onchange: (e) => savePersonal({ neighbour: e.target.checked }) })),
    pStatus,
  );

  // ---------- notifications ----------
  const nStatus = h("span");
  const saveN = async (patch) => {
    try { const r = await send("PUT", "/api/settings", patch); app.me = { ...app.me, settings: r.settings }; msg(nStatus)("Збережено"); }
    catch (e) { msg(nStatus)(`Помилка: ${e.message}`, false); }
  };
  const pushBox = h("div");
  const notify = h("section.card",
    h("h2", "Сповіщення"),
    pushBox,
    h("div", NOTIFY.map(([k, label, hint]) => h("div.switch",
      h("span", label, hint ? h("small", hint) : null),
      h("input", { type: "checkbox", role: "switch", checked: s.notify[k], disabled: k === "generator_soon" && !s.neighbour, "aria-label": label,
        onchange: (e) => saveN({ notify: { [k]: e.target.checked } }) })))),
    h("div.inline", { style: { marginTop: "8px" } },
      h("label.field", "Низький заряд, %", h("input", { type: "number", min: 16, max: 90, value: s.low_batt_pct, inputmode: "numeric",
        onchange: (e) => saveN({ low_batt_pct: Number(e.target.value) }) })),
      h("span")),
    h("div.switch", h("span", "Тихі години", h("small", "без сповіщень, крім «батареї не вистачить»")),
      h("input", { type: "checkbox", role: "switch", checked: s.quiet.on, "aria-label": "Тихі години", onchange: (e) => saveN({ quiet: { on: e.target.checked } }) })),
    h("div.inline",
      h("label.field", "з", h("input", { type: "time", value: s.quiet.from, onchange: (e) => saveN({ quiet: { from: e.target.value } }) })),
      h("label.field", "до", h("input", { type: "time", value: s.quiet.to, onchange: (e) => saveN({ quiet: { to: e.target.value } }) }))),
    nStatus,
  );
  import("../push.js").then((m) => { if (alive) m.renderPush(pushBox, app); }).catch(() => {
    pushBox.replaceChildren(h("p.hint", "Сповіщення на телефон з'являться в наступному оновленні."));
  });

  // ---------- shared ----------
  const shStatus = h("span");
  const saveShared = async (patch) => {
    try {
      const r = await send("PUT", "/api/shared", patch);
      app.me = { ...app.me, shared: r.shared };
      msg(shStatus)("Збережено. Графік оновиться за хвилину.");
      setTimeout(() => { if (alive) refresh(); }, 6000);
    } catch (e) { msg(shStatus)(`Помилка: ${e.message}`, false); }
  };
  const names = { a: h("input", { type: "text", value: sh.phase_names.a, maxlength: 30 }), b: h("input", { type: "text", value: sh.phase_names.b, maxlength: 30 }), c: h("input", { type: "text", value: sh.phase_names.c, maxlength: 30 }) };
  const addr = (role, title) => {
    const a = sh[`addr_${role}`] ?? {};
    const street = h("input", { type: "text", value: a.street ?? "", placeholder: "вул. Назва", autocomplete: "off" });
    const house = h("input", { type: "text", value: a.house ?? "", placeholder: "12-А", autocomplete: "off" });
    const status = a.street
      ? a.error ? h("p.err", `Не вдалося знайти: ${a.error}`)
        : a.group ? h("p.note", `Черга ${a.group}${a.pending_group ? ` (перевіряємо зміну на ${a.pending_group})` : ""}`)
        : h("p.note", "Шукаємо чергу…")
      : h("p.note", "Не задано");
    return { street, house, el: h("fieldset", h("legend", title), h("div.inline", h("label.field", "Вулиця", street), h("label.field", "Будинок", house)), status) };
  };
  const home = addr("home", "Наша адреса (графік Yasno)");
  const nb = addr("neighbour", "Сусіди з генератором");
  const cap = h("input", { type: "number", min: 1, max: 100, step: 0.5, value: sh.battery.capacity_wh / 1000, inputmode: "decimal" });
  const floor = h("input", { type: "number", min: 0, max: 60, value: sh.battery.floor_pct, inputmode: "numeric" });
  const shared = h("section.card",
    h("h2", "Спільні налаштування"),
    h("p.note", "Однакові для всіх у домі."),
    h("form", { onsubmit: (e) => {
      e.preventDefault();
      const patch = {
        phase_names: { a: names.a.value, b: names.b.value, c: names.c.value },
        battery: { capacity_wh: Math.round(Number(cap.value) * 1000), floor_pct: Number(floor.value) },
      };
      for (const [role, x] of [["home", home], ["neighbour", nb]]) {
        const st = x.street.value.trim(), hs = x.house.value.trim();
        const cur = sh[`addr_${role}`] ?? {};
        if (st !== (cur.street ?? "") || hs !== (cur.house ?? "")) patch[`addr_${role}`] = st && hs ? { street: st, house: hs } : null;
      }
      saveShared(patch);
    } },
      h("fieldset", h("legend", "Назви фаз"), h("label.field", "Фаза A", names.a), h("label.field", "Фаза B", names.b), h("label.field", "Фаза C", names.c)),
      home.el, nb.el,
      h("fieldset", h("legend", "Батарея"), h("div.inline", h("label.field", "Ємність, кВт·год", cap), h("label.field", "Інвертор вимикається на, %", floor))),
      h("div", h("button.btn.primary", { type: "submit" }, "Зберегти"), " ", shStatus),
    ),
  );

  els.health = h("section.card");
  els.grid = h("section.card");
  root.replaceChildren(personal, notify, els.grid, els.health, shared);
  renderHealth();
}

function renderHealth() {
  if (!els.health || !app.me) return;
  const now = Date.now();
  const hl = health;
  const rows = [];
  const add = (k, v) => rows.push(h("dt", k), h("dd", v));
  if (hl) {
    add("Останні дані", hl.last_sample_ts ? `${f.when(hl.last_sample_ts)} (${f.ago(now - hl.last_sample_ts)})` : "—");
    add("Записів за добу", `${f.int(hl.samples_24h)} з ~2 880`);
    const hb = hl.heartbeat;
    if (hb) {
      add("Сигнал від Pi", `${f.when(hb.received_at)} (${f.ago(now - hb.received_at)})`);
      add("Версія pusher", hb.pusher_version ?? "—");
      add("Pi працює", hb.boot_age_s != null ? f.duration(hb.boot_age_s * 1000) : "—");
      add("Черга / втрачено", `${hb.queue_len ?? "—"} / ${hb.dropped ?? "—"}`);
      add("Помилки читання / відправки", `${hb.read_errors ?? "—"} / ${hb.send_errors ?? "—"}`);
      if (hb.last_error) add("Остання помилка Pi", String(hb.last_error));
    }
    const job = (st) => !st ? "ще не було" : st.error_at && (!st.ok_at || st.error_at > st.ok_at) ? `помилка ${f.ago(now - st.error_at)}: ${st.error}` : st.ok_at ? `оновлено ${f.ago(now - st.ok_at)}` : "—";
    add("Графік Yasno", job(hl.yasno));
    add("Прогноз Solcast", hl.solcast?.configured ? job(hl.solcast) : "не налаштовано");
    add("Запити Solcast сьогодні", `${hl.solcast?.calls_today ?? 0} з 10 (план до 8)`);
    if (hl.pv_factor) add("Поправка прогнозу сонця", `×${(hl.pv_factor.factor ?? 1).toFixed(2)} (${hl.pv_factor.pairs} півгодин)`);
    add("Заряд від мережі", hl.charge_w?.w ? `${f.W(hl.charge_w.w)} (виміряно)` : "~3 кВт (ще не виміряно)");
    add("Ємність батареї (оцінка)", hl.capacity_est?.wh ? `${f.kWh(hl.capacity_est.wh)} на 100%` : "мало даних");
    add("Підписок на сповіщення", String(hl.push_subscriptions ?? 0));
  }
  els.health.replaceChildren(h("h2", "Стан системи"), hl ? h("dl.kv", rows) : h("p.muted", "Завантаження…"),
    h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "10px" } },
      h("button.btn", { onclick: (e) => runJob(e.target, "yasno") }, "Оновити графік"),
      h("button.btn", { onclick: (e) => runJob(e.target, "rollup") }, "Перерахувати енергію"),
      // The installed PWA has no browser reload; this loads a newly deployed version (the service worker is network-first).
      h("button.btn", { onclick: () => location.reload() }, "Перезавантажити")));

  // Grid voltages from the last /api/now.
  const s = cached("now")?.sample;
  const g = [];
  const addG = (k, v) => g.push(h("dt", k), h("dd", v));
  if (s) {
    addG("Напруга A / B / C", s.grid_on ? `${[s.grid_v_a, s.grid_v_b, s.grid_v_c].map((v) => Math.round(v)).join(" / ")} В` : "немає");
    addG("Частота", s.grid_on ? `${s.grid_hz?.toFixed(2)} Гц` : "—");
    addG("Потужність з мережі", f.W(s.grid_total_w));
    addG("Панелі 1 / 2", `${f.W(s.pv1_w)} / ${f.W(s.pv2_w)}`);
  }
  els.grid.replaceChildren(h("h2", "Мережа і інвертор"), s ? h("dl.kv", g) : h("p.muted", "Немає даних"));
}

async function runJob(btn, job) {
  btn.disabled = true;
  try { await send("POST", "/api/run", { job }); await refresh(); }
  catch (e) { btn.after(h("span.err", ` ${e.message}`)); }
  finally { btn.disabled = false; }
}


