// API calls. An expired Cloudflare Access session shows up as a redirect or 401/403: reload to log in again.

export class AuthError extends Error {}

async function call(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", cache: "no-store", ...opts });
  if (res.redirected || res.status === 401 || res.status === 403) {
    try { sessionStorage.setItem("scrollY", String(window.scrollY)); } catch { /* blocked */ }
    location.reload();
    throw new AuthError("auth");
  }
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error ?? msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return res.json();
}

export const get = (path) => call(path);
export const send = (method, path, body) =>
  call(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

// Last answers, kept in memory and (for a cold start) in localStorage.
const mem = new Map();
export function cached(key) {
  if (mem.has(key)) return mem.get(key);
  try {
    const raw = localStorage.getItem(`c:${key}`);
    if (raw) { const v = JSON.parse(raw); mem.set(key, v); return v; }
  } catch { /* storage blocked */ }
  return null;
}
export function remember(key, value, persist = false) {
  mem.set(key, value);
  if (persist) { try { localStorage.setItem(`c:${key}`, JSON.stringify(value)); } catch { /* full or blocked */ } }
  return value;
}
export async function load(key, path, persist = false) {
  return remember(key, await get(path), persist);
}
