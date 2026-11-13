// Push subscription UI for the System tab. iPhone: only from the Home Screen app (iOS 16.4+), asked from a tap.

import { send } from "./api.js";
import { h } from "./dom.js";

export const isIos = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

const keyBytes = (b64u) => {
  const s = atob(b64u.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64u.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

export async function renderPush(box, app) {
  const status = h("span");
  const say = (text, ok = true) => { status.textContent = text; status.className = ok ? "saved" : "err"; };
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  if (!supported) {
    box.replaceChildren(isIos() && !isStandalone()
      ? h("p.hint", "Щоб отримувати сповіщення на iPhone, додайте застосунок на Початковий екран: кнопка «Поділитися» → «На Початковий екран». Потім відкрийте його з іконки й увімкніть сповіщення тут.")
      : h("p.hint", "Цей браузер не підтримує сповіщення."));
    return;
  }
  const vapid = app.me?.vapid_public;
  if (!vapid) { box.replaceChildren(h("p.hint", "Сповіщення ще не налаштовані на сервері.")); return; }

  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  const draw = (sub) => {
    if (Notification.permission === "denied") {
      box.replaceChildren(h("p.hint", "Сповіщення заборонені для цього застосунку. Дозвольте їх у налаштуваннях телефона (Сповіщення → Інвертор) і поверніться сюди."));
      return;
    }
    if (sub) {
      box.replaceChildren(
        h("p.note", "Цей пристрій отримує сповіщення. Типи — нижче."),
        h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", margin: "6px 0" } },
          h("button.btn", { onclick: async () => {
            try { const r = await send("POST", "/api/push/test", {}); say(r.devices ? "Надіслано" : "Немає пристроїв"); } catch (e) { say(`Помилка: ${e.message}`, false); }
          } }, "Надіслати тест"),
          h("button.btn", { onclick: async () => {
            try { await send("POST", "/api/push/unsubscribe", { endpoint: sub.endpoint }); await sub.unsubscribe(); draw(null); } catch (e) { say(`Помилка: ${e.message}`, false); }
          } }, "Вимкнути на цьому пристрої")),
        status);
      return;
    }
    box.replaceChildren(
      h("button.btn.primary", { onclick: async () => {
        try {
          const perm = await Notification.requestPermission(); // must be called from the tap
          if (perm !== "granted") { draw(null); say("Дозвіл не надано", false); return; }
          const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapid) });
          await send("POST", "/api/push/subscribe", s.toJSON());
          draw(s);
          say("Увімкнено");
        } catch (e) { say(`Помилка: ${e.message}`, false); }
      } }, "Увімкнути сповіщення на цьому пристрої"),
      " ", status);
  };
  draw(sub);
}
