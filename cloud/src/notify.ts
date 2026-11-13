// Push notifications: subscriptions, per-user toggles and quiet hours, triggers, deduplication.
// Everything here runs from ctx.waitUntil or the cron; errors are swallowed by the callers.

import { fmtClock, fmtHours } from "./headline.ts";
import type { GridTransition } from "./ingest.ts";
import type { ScheduleChange } from "./jobs.ts";
import { DEFAULT_SETTINGS, mergeSettings, type NotifyType, type UserSettings } from "./settings.ts";
import { BLIP_MS, analyse, loadContext } from "./summary.ts";
import { kyivDate, kyivMinuteOfDay, addDays } from "./time.ts";
import { sendPush, type VapidKeys } from "./webpush.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export interface Message { title: string; body: string; tag?: string; url?: string }

export function vapid(env: Env): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || "mailto:admin@example.com" };
}

const toMin = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

/** Is `now` inside the user's quiet hours (Kyiv time)? */
export function inQuiet(s: UserSettings, now: number): boolean {
  if (!s.quiet.on) return false;
  const m = kyivMinuteOfDay(now), a = toMin(s.quiet.from), b = toMin(s.quiet.to);
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/** Does this user want this notification now? */
export function wants(s: UserSettings, type: NotifyType, now: number): boolean {
  if (!s.notify[type]) return false;
  if (type === "generator_soon" && !s.neighbour) return false;
  if (type !== "wont_last" && inQuiet(s, now)) return false;
  return true;
}

/**
 * Send `msg` of `type` to every subscribed user who wants it, once per (key, user).
 * `filter` can narrow per user (e.g. the low-battery threshold).
 */
export async function notify(env: Env, type: NotifyType, key: string, msg: Message, now = Date.now(),
  filter?: (s: UserSettings) => boolean): Promise<number> {
  const v = vapid(env);
  if (!v) return 0;
  const [subs, settings] = await env.DB.batch([
    env.DB.prepare("SELECT endpoint, email, p256dh, auth FROM push_subscriptions"),
    env.DB.prepare("SELECT email, json FROM user_settings"),
  ]);
  const byEmail = new Map<string, UserSettings>();
  for (const r of settings.results as { email: string; json: string }[]) {
    try { byEmail.set(r.email, mergeSettings(DEFAULT_SETTINGS, JSON.parse(r.json))); } catch { /* default */ }
  }
  const list = subs.results as { endpoint: string; email: string; p256dh: string; auth: string }[];
  const emails = [...new Set(list.map((s) => s.email))];
  let sent = 0;
  for (const email of emails) {
    const s = byEmail.get(email) ?? DEFAULT_SETTINGS;
    if (!wants(s, type, now) || (filter && !filter(s))) continue;
    // Deduplicate per user: claim the key first, so parallel runs cannot both send.
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO notifications_sent (dedup_key, type, ts) VALUES (?, ?, ?)")
      .bind(`${key}|${email}`, type, now).run();
    if (!claim.meta.changes) continue;
    for (const sub of list.filter((x) => x.email === email)) {
      const status = await sendPush(sub, { ...msg, tag: msg.tag ?? type }, v, type === "stale" ? 3600 : 6 * 3600);
      await afterSend(env, sub.endpoint, status, now);
      if (status >= 200 && status < 300) sent++;
    }
  }
  return sent;
}

async function afterSend(env: Env, endpoint: string, status: number, now: number) {
  if (status === 404 || status === 410) {
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
  } else if (status >= 200 && status < 300) {
    await env.DB.prepare("UPDATE push_subscriptions SET last_success = ?, failures = 0 WHERE endpoint = ?").bind(now, endpoint).run();
  } else {
    await env.DB.prepare("UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?").bind(endpoint).run();
  }
}

// ---------- triggers ----------

/**
 * Grid off/on, from ingest (via waitUntil). A flicker shorter than BLIP_MS sends nothing: "off" is sent
 * only once the grid has stayed off that long (`gridOff` = the newest sample is off), and "on" only
 * after a real outage.
 */
export async function onIngest(env: Env, transitions: GridTransition[], gridOff = false): Promise<void> {
  const now = Date.now();
  if (gridOff) {
    const ev = await env.DB.prepare("SELECT ts, grid_on FROM grid_events ORDER BY ts DESC LIMIT 1").first<{ ts: number; grid_on: number }>();
    if (ev && ev.grid_on === 0 && now - ev.ts >= BLIP_MS && now - ev.ts <= BLIP_MS + 10 * 60_000) {
      const ctx = await loadContext(env, now);
      const soc = ctx.sample?.soc;
      await notify(env, "grid", `grid:${ev.ts}`, { title: "Світло зникло", body: `${soc != null ? `Батарея ${soc}%. ` : ""}${analyse(ctx).headline.text}`, tag: "grid" }, now);
    }
  }
  for (const t of transitions) {
    if (t.grid_on !== 1 || now - t.ts > 30 * 60_000) continue; // a late batch from the Pi: too old to be useful
    // The stored event (a resent batch has a slightly different ts) is the dedup key.
    const ev = await env.DB.prepare("SELECT ts, grid_on, prev_ts FROM grid_events WHERE ts BETWEEN ? AND ? AND grid_on = 1 LIMIT 1")
      .bind(t.ts - 10_000, t.ts + 10_000).first<{ ts: number; grid_on: number; prev_ts: number }>();
    if (!ev) continue;
    const prevOff = await env.DB.prepare("SELECT ts FROM grid_events WHERE ts < ? AND grid_on = 0 ORDER BY ts DESC LIMIT 1").bind(ev.ts).first<{ ts: number }>();
    if (prevOff && ev.ts - prevOff.ts < BLIP_MS) continue; // a flicker, not an outage
    const soc = (await loadContext(env, now)).sample?.soc;
    const dur = prevOff ? `Не було ${fmtHours(ev.ts - prevOff.ts)}. ` : "";
    await notify(env, "grid", `grid:${ev.ts}`, { title: "Світло з'явилося", body: `${dur}${soc != null ? `Батарея ${soc}%.` : ""}`, tag: "grid" }, now);
  }
}

const mm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const slotsText = (slots: [number, number][]) => (slots.length ? slots.map(([a, b]) => `${mm(a)}–${mm(b)}`).join(", ") : "без відключень");

/** Every 15 minutes, after the Yasno fetch. */
export async function onCron(env: Env, now: number, changes: ScheduleChange[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!vapid(env)) return out;
  const sub = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>();
  if (!sub?.n) return out;
  const ctx = await loadContext(env, now);
  const a = analyse(ctx);
  const s = ctx.sample;
  const add = (k: string, n: number) => { out[k] = (out[k] ?? 0) + n; };

  // Battery will not last until the grid returns (current outage, or one starting within 24 h).
  const p = a.proj;
  if (p && (a.confidence === "schedule" || p.outages.some((o) => o.in_progress))) {
    const o = p.outages.find((x) => !x.lasts && (x.in_progress || x.start < now + 24 * 3_600_000));
    if (o) {
      const key = `wont_last:${o.in_progress ? (ctx.gridSince?.ts ?? o.start) : o.start}`;
      add("wont_last", await notify(env, "wont_last", key, { title: "Батареї не вистачить", body: a.headline.text, tag: "wont_last", url: "/#plan" }, now));
    }
  }

  // Low battery while the grid is off (per-user threshold).
  if (s && !s.grid_on && s.soc != null) {
    const since = ctx.gridSince?.ts ?? 0;
    add("low_batt", await notify(env, "low_batt", `low:${since}`, {
      title: `Батарея ${s.soc}%`, body: `Світла немає${ctx.gridSince ? ` ${fmtHours(now - ctx.gridSince.ts)}` : ""}. ${a.headline.text}`, tag: "low_batt",
    }, now, (u) => (s.soc ?? 100) < u.low_batt_pct));
  }

  // Schedule changes of the main address.
  const today = kyivDate(now), tomorrow = addDays(today, 1);
  for (const c of changes) {
    if (c.role !== "home" || !c.before) continue;
    const day = c.date === today ? "сьогодні" : c.date === tomorrow ? "завтра" : c.date;
    let body: string;
    if (c.after.status === "EmergencyShutdowns") body = `Yasno: екстрені відключення ${day}, графік не діє.`;
    else if (c.after.status === "ScheduleApplies") body = `Графік на ${day}: ${slotsText(c.after.slots)}.`;
    else continue; // WaitingForSchedule etc.: nothing useful to say
    const title = c.before.status === "WaitingForSchedule" ? "Графік опубліковано" : "Графік змінився";
    add("schedule", await notify(env, "schedule", `sched:${c.date}:${c.after.status}:${JSON.stringify(c.after.slots)}`, { title, body, tag: `sched-${c.date}`, url: "/#plan" }, now));
  }

  // Outage soon (30 min) and generator soon (15 min). The cron runs every 15 min, so the windows overlap the runs.
  if (a.confidence === "schedule") {
    const soon = a.homeIntervals.find((i) => i.start > now && i.start <= now + 30 * 60_000);
    if (soon && s?.grid_on) {
      const o = p?.outages.find((x) => Math.abs(x.start - soon.start) < 31 * 60_000);
      add("outage_soon", await notify(env, "outage_soon", `soon:${soon.start}`, {
        title: `Відключення о ${fmtClock(soon.start, now)}`,
        body: `До ${fmtClock(soon.end, now)}. Батарея ${s.soc}%${o ? `, на ${fmtClock(soon.end, now)} залишиться близько ${Math.round(o.soc_end_low)}%` : ""}.`,
        tag: "outage_soon",
      }, now));
    }
  }
  const gen = a.loudIntervals.find((i) => i.start > now && i.start <= now + 20 * 60_000);
  if (gen) {
    add("generator_soon", await notify(env, "generator_soon", `gen:${gen.start}`, {
      title: "Скоро генератор сусідів", body: `З ${fmtClock(gen.start, now)} до ${fmtClock(gen.end, now)}.`, tag: "generator",
    }, now));
  }

  // Stale data.
  if (s && now - s.ts > 15 * 60_000) {
    add("stale", await notify(env, "stale", `stale:${s.ts}`, {
      title: "Немає даних від інвертора", body: `Останні дані ${fmtClock(s.ts, now)}. Можливо, немає інтернету або світла в роутера.`, tag: "stale",
    }, now));
  }
  return out;
}

// ---------- endpoints ----------

export async function pushEndpoints(_r: Request, env: Env, url: URL, email: string, body: unknown): Promise<Response | null> {
  const b = (body ?? {}) as Record<string, unknown>;
  switch (url.pathname) {
    case "/api/push/subscribe": {
      const keys = (b.keys ?? {}) as Record<string, unknown>;
      const endpoint = b.endpoint, p256dh = keys.p256dh, auth = keys.auth;
      if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint) || endpoint.length > 1000) return json({ error: "bad endpoint" }, 400);
      if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 200 || auth.length > 100) return json({ error: "bad keys" }, 400);
      await env.DB.prepare(
        `INSERT INTO push_subscriptions (endpoint, email, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET email = excluded.email, p256dh = excluded.p256dh, auth = excluded.auth, failures = 0`,
      ).bind(endpoint, email, p256dh, auth, Date.now()).run();
      return json({ ok: true });
    }
    case "/api/push/unsubscribe": {
      if (typeof b.endpoint !== "string") return json({ error: "bad endpoint" }, 400);
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND email = ?").bind(b.endpoint, email).run();
      return json({ ok: true });
    }
    case "/api/push/test": {
      const v = vapid(env);
      if (!v) return json({ error: "push not configured" }, 503);
      const { results } = await env.DB.prepare("SELECT endpoint, email, p256dh, auth FROM push_subscriptions WHERE email = ?")
        .bind(email).all<{ endpoint: string; email: string; p256dh: string; auth: string }>();
      const statuses: number[] = [];
      for (const sub of results) {
        const st = await sendPush(sub, { title: "Тест", body: "Сповіщення працюють.", tag: "test" }, v, 600);
        await afterSend(env, sub.endpoint, st, Date.now());
        statuses.push(st);
      }
      return json({ ok: true, devices: results.length, statuses });
    }
  }
  return null;
}
