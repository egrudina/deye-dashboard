// App shell: bottom tabs (hash routes), no reloads between tabs, refresh on a timer and on return to foreground.

import { cached, load, AuthError } from "./api.js";

const TABS = {
  now: { title: "Зараз", load: () => import("./tabs/now.js") },
  plan: { title: "План", load: () => import("./tabs/plan.js") },
  history: { title: "Історія", load: () => import("./tabs/history.js") },
  system: { title: "Система", load: () => import("./tabs/system.js") },
};

const view = document.getElementById("view");
const fresh = document.getElementById("freshness");
let current = null, currentName = null, routeSeq = 0;

export const app = {
  me: cached("me"),
  async refreshMe() {
    try { app.me = await load("me", "/api/me", true); } catch (e) { if (!(e instanceof AuthError)) console.warn(e); }
    return app.me;
  },
  /** Shown only when there is something to say (stale data, no connection). */
  freshness(text, warn = false) {
    fresh.hidden = !text;
    fresh.textContent = text ?? "";
    fresh.classList.toggle("warn", warn);
  },
  settings() {
    return app.me?.settings ?? { phase: "all", neighbour: true, notify: {} };
  },
  shared() {
    return app.me?.shared ?? { phase_names: { a: "Фаза A", b: "Фаза B", c: "Фаза C" }, battery: { capacity_wh: 20000, floor_pct: 15 } };
  },
};

async function route() {
  const name = TABS[location.hash.slice(1)] ? location.hash.slice(1) : "now";
  if (name === currentName) return;
  const seq = ++routeSeq;
  const mod = await TABS[name].load();
  if (seq !== routeSeq) return;
  current?.unmount?.();
  currentName = name;
  current = mod;
  document.getElementById("title").textContent = TABS[name].title;
  for (const a of document.querySelectorAll(".tabbar a")) {
    if (a.dataset.tab === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  app.freshness(null);
  view.replaceChildren();
  window.scrollTo(0, 0);
  mod.mount(view, app);
}

window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) current?.refresh?.();
});
setInterval(() => { if (!document.hidden) current?.tick?.(); }, 30e3);
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => current?.redraw?.(), 150); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => current?.redraw?.());

app.refreshMe().then(() => current?.redraw?.());
route();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
