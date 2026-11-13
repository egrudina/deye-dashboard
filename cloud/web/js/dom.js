// Tiny DOM helper: h("div.card#id", { attrs }, ...children). Text children are escaped (textContent).
export function h(tag, attrs, ...children) {
  const [, name, rest] = /^([a-z0-9]+)(.*)$/i.exec(tag);
  const e = document.createElement(name);
  for (const m of rest.matchAll(/([.#])([\w-]+)/g)) m[1] === "." ? e.classList.add(m[2]) : (e.id = m[2]);
  if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}

/** replaceChildren without the null/false entries (which it would print as text). */
export const put = (el, ...children) => el.replaceChildren(...children.flat().filter((c) => c != null && c !== false));

/** Re-render without moving the page: keep the scroll position across a full replace of the content. */
export function keepScroll(fn) {
  const y = window.scrollY;
  fn();
  if (Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y);
  // Some browsers (iOS) settle the layout a frame later.
  requestAnimationFrame(() => { if (Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y); });
}
