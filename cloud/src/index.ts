import { checkBearer, verifyAccess } from "./auth";
import { HOUR_FIELDS, sumRows, type HourRow } from "./energy.ts";
import { ingest, type GridTransition } from "./ingest.ts";
import { calibrate, rollup, solcast, yasno, type JobStatus } from "./jobs.ts";
import { onCron, onIngest, pushEndpoints } from "./notify.ts";
import { analyse, loadContext, nowPayload, outageDurations, planPayload, sharedConfig } from "./summary.ts";
import { haPayload } from "./ha.ts";
import { getAllConfig, getUserSettings, putUserSettings, sharedPatch } from "./settings.ts";
import { DAY, HOUR, kyivDate, kyivTime, addDays } from "./time.ts";

const RAW_KEEP_MS = 7 * 24 * 3600 * 1000;
const MAX_POINTS = 1500;

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const log = (level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) =>
  console[level](JSON.stringify({ msg, ...extra }));

export class BadRequest extends Error {}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/ingest") {
      if (request.method !== "POST") return json({ error: "method" }, 405);
      if (!(await checkBearer(request, env.PUSH_KEY))) return json({ error: "unauthorized" }, 401);
      const transitions: GridTransition[] = [];
      const res = await ingest(request, env, transitions);
      // Notifications must never slow down or fail the ingest answer.
      if (transitions.length) ctx.waitUntil(onIngest(env, transitions).catch((e) => log("warn", "push on ingest failed", { error: String(e) })));
      return res;
    }

    // Everything else: only for users that passed Cloudflare Access.
    let email = "dev@local";
    if (!env.DEV_NO_AUTH) {
      if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return new Response("Access not configured", { status: 503 });
      const e = await verifyAccess(request, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
      if (!e) return new Response("Forbidden", { status: 403 });
      email = e.toLowerCase();
    }
    // Service tokens (Home Assistant) may only read the HA endpoint.
    if (email.startsWith("service:") && !(request.method === "GET" && url.pathname === "/api/ha")) {
      return json({ error: "forbidden for service tokens" }, 403);
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        if (request.method !== "GET") {
          // Writes: JSON only (forces a CORS preflight from other origins) and same origin when the browser says so.
          const origin = request.headers.get("origin");
          if (origin && origin !== url.origin) return json({ error: "origin" }, 403);
          if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) return json({ error: "json only" }, 415);
          return await write(request, env, url, email, ctx);
        }
        switch (url.pathname) {
          case "/api/now": {
            const c = await loadContext(env);
            return json(nowPayload(c, analyse(c)));
          }
          case "/api/plan": {
            const c = await loadContext(env);
            return json(planPayload(c, analyse(c)));
          }
          case "/api/me": {
            const [settings, config] = await Promise.all([getUserSettings(env.DB, email), getAllConfig(env.DB)]);
            return json({ email, settings, shared: sharedConfig(config), vapid_public: env.VAPID_PUBLIC_KEY ?? null });
          }
          case "/api/series": return json(await apiSeries(env, url));
          case "/api/outages": return json(await apiOutages(env, url));
          case "/api/hourly": return json(await apiHourly(env, url));
          case "/api/daily": return json(await apiDaily(env, url));
          case "/api/outage-log": return json(await apiOutageLog(env, url));
          case "/api/forecast-actual": return json(await apiForecastActual(env, url));
          case "/api/health": return json(await apiHealth(env));
          case "/api/ha": return json(await haPayload(env));
        }
      } catch (e) {
        if (e instanceof BadRequest) return json({ error: e.message }, 400);
        log("error", "api failed", { path: url.pathname, error: String(e) });
        return json({ error: "internal" }, 500);
      }
      return json({ error: "not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx): Promise<void> {
    const now = Date.now();
    const run = async (name: string, f: () => Promise<unknown>) => {
      try {
        const r = await f();
        log("info", `cron ${name}`, { result: r ?? null });
        return r;
      } catch (e) {
        log("error", `cron ${name} failed`, { error: String(e) });
        return undefined;
      }
    };
    if (controller.cron === "17 * * * *") {
      await run("purge", () => purge(env));
      await run("calibrate", () => calibrate(env, now));
      return;
    }
    // Every 15 minutes.
    await run("rollup", () => rollup(env, now));
    const changes = await run("yasno", () => yasno(env, now));
    await run("solcast", () => solcast(env, now));
    await run("notify", () => onCron(env, now, Array.isArray(changes) ? changes : []));
    void ctx;
  },
} satisfies ExportedHandler<Env>;

async function purge(env: Env) {
  const cutoff = Date.now() - RAW_KEEP_MS;
  const res = await env.DB.batch([
    env.DB.prepare("DELETE FROM raw_samples WHERE ts < ?").bind(cutoff),
    // Keep at least the latest heartbeat even if it is old.
    env.DB.prepare(
      "DELETE FROM heartbeats WHERE received_at < ? AND received_at < (SELECT MAX(received_at) FROM heartbeats)",
    ).bind(cutoff),
    env.DB.prepare("DELETE FROM notifications_sent WHERE ts < ?").bind(Date.now() - 30 * DAY),
  ]);
  return { raw: res[0].meta.changes, heartbeats: res[1].meta.changes, notifications: res[2].meta.changes };
}

// ---------- writes ----------

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > 20_000) throw new BadRequest("too large");
  try { return JSON.parse(text || "{}"); } catch { throw new BadRequest("bad json"); }
}

async function write(request: Request, env: Env, url: URL, email: string, ctx: ExecutionContext): Promise<Response> {
  const body = await readBody(request);
  switch (`${request.method} ${url.pathname}`) {
    case "PUT /api/settings":
      return json({ settings: await putUserSettings(env.DB, email, body) });
    case "PUT /api/shared": {
      let stmts;
      try { stmts = await sharedPatch(env.DB, body); } catch (e) { throw new BadRequest(String((e as Error).message)); }
      if (stmts.length) await env.DB.batch(stmts);
      // A new address: resolve it and fetch its schedule right away.
      const b = body as Record<string, unknown>;
      if (b.addr_home !== undefined || b.addr_neighbour !== undefined) {
        ctx.waitUntil(yasno(env).catch((e) => log("warn", "yasno after address change", { error: String(e) })));
      }
      return json({ shared: sharedConfig(await getAllConfig(env.DB)) });
    }
    case "POST /api/run": {
      // Manual job run from the System tab (Solcast obeys its budget unless forced, and never goes over 9 calls).
      const job = (body as { job?: string }).job;
      const r = job === "rollup" ? await rollup(env)
        : job === "yasno" ? await yasno(env)
        : job === "solcast" ? await solcast(env, Date.now(), !!(body as { force?: boolean }).force)
        : job === "calibrate" ? await calibrate(env)
        : (() => { throw new BadRequest("unknown job"); })();
      return json({ ok: true, result: r ?? null });
    }
  }
  const push = await pushEndpoints(request, env, url, email, body);
  if (push) return push;
  return json({ error: "not found" }, 404);
}

// ---------- read API ----------

function rangeParams(url: URL, defaultSpanMs: number) {
  const now = Date.now();
  const to = url.searchParams.has("to") ? Number(url.searchParams.get("to")) : now;
  const from = url.searchParams.has("from") ? Number(url.searchParams.get("from")) : to - defaultSpanMs;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new BadRequest("bad from/to");
  if (to - from > 400 * 24 * 3600 * 1000) throw new BadRequest("range too long");
  return { from, to };
}

const STEPS = [30_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 86_400_000];

async function apiSeries(env: Env, url: URL) {
  const { from, to } = rangeParams(url, 24 * 3600 * 1000);
  let step = Number(url.searchParams.get("step") ?? 0);
  const minStep = (to - from) / MAX_POINTS;
  if (!Number.isFinite(step) || step < minStep || step <= 0) {
    step = STEPS.find((s) => s >= minStep) ?? STEPS[STEPS.length - 1];
  }
  const { results } = await env.DB.prepare(
    `SELECT (ts / CAST(?1 AS INTEGER)) * CAST(?1 AS INTEGER) AS t,
            COUNT(*) AS n,
            AVG(grid_on) AS grid_on,
            AVG(soc) AS soc, AVG(batt_w) AS batt_w,
            AVG(load_total) AS load_total, AVG(load_a) AS load_a, AVG(load_b) AS load_b, AVG(load_c) AS load_c,
            AVG(pv_w) AS pv_w, AVG(grid_w) AS grid_w, AVG(ext_ct_w) AS ext_ct_w,
            AVG(grid_v_a) AS grid_v_a, AVG(grid_v_b) AS grid_v_b, AVG(grid_v_c) AS grid_v_c, AVG(grid_hz) AS grid_hz
     FROM samples WHERE ts >= ?2 AND ts < ?3
     GROUP BY t ORDER BY t`,
  ).bind(step, from, to).all();
  return { from, to, step, points: results };
}

async function apiOutages(env: Env, url: URL) {
  const { from, to } = rangeParams(url, 30 * 24 * 3600 * 1000);
  // Include the event just before `from`, so an outage that started earlier is not lost.
  const { results } = await env.DB.prepare(
    `SELECT ts, grid_on, prev_ts FROM grid_events
     WHERE ts >= COALESCE((SELECT MAX(ts) FROM grid_events WHERE ts < ?1), ?1) AND ts < ?2
     ORDER BY ts`,
  ).bind(from, to).all<{ ts: number; grid_on: number; prev_ts: number }>();
  return { from, to, outages: outagesFromEvents(results).filter((o) => (o.end ?? Infinity) >= from).reverse() };
}

function outagesFromEvents(events: { ts: number; grid_on: number; prev_ts: number }[]) {
  const outages: { start: number; start_after: number; end: number | null; end_after: number | null }[] = [];
  for (const e of events) {
    if (e.grid_on === 0) {
      // Grid went off somewhere in (prev_ts, ts].
      outages.push({ start: e.ts, start_after: e.prev_ts, end: null, end_after: null });
    } else if (outages.length && outages[outages.length - 1].end === null) {
      // Grid came back somewhere in (prev_ts, ts].
      const o = outages[outages.length - 1];
      o.end = e.ts;
      o.end_after = e.prev_ts;
    }
  }
  return outages;
}

async function apiHourly(env: Env, url: URL) {
  const { from, to } = rangeParams(url, DAY);
  const { results } = await env.DB.prepare("SELECT * FROM hourly WHERE hour_ts >= ? AND hour_ts < ? ORDER BY hour_ts").bind(from, to).all();
  return { from, to, hours: results };
}

/** Per Kyiv day sums from the hourly rollups. ?days=N (default 30) ending today. */
async function apiDaily(env: Env, url: URL) {
  const n = Math.min(400, Math.max(1, Number(url.searchParams.get("days") ?? 30) || 30));
  const today = kyivDate(Date.now());
  const endDate = url.searchParams.get("end") && /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("end")!) ? url.searchParams.get("end")! : today;
  const firstDate = addDays(endDate, -(n - 1));
  const from = kyivTime(firstDate, 0), to = kyivTime(addDays(endDate, 1), 0);
  const [hours, fc, sched, events] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM hourly WHERE hour_ts >= ? AND hour_ts < ? ORDER BY hour_ts").bind(from, to),
    env.DB.prepare("SELECT period_end, p50 FROM pv_forecast_first WHERE period_end > ? AND period_end <= ?").bind(from, to),
    env.DB.prepare("SELECT date, status, slots FROM outage_days WHERE role = 'home' AND date >= ? AND date <= ?").bind(firstDate, endDate),
    env.DB.prepare(`SELECT ts, grid_on, prev_ts FROM grid_events WHERE ts >= COALESCE((SELECT MAX(ts) FROM grid_events WHERE ts < ?1), ?1) AND ts < ?2 ORDER BY ts`).bind(from, to),
  ]);
  const byDay = new Map<string, HourRow[]>();
  for (const h of hours.results as unknown as HourRow[]) {
    const d = kyivDate(h.hour_ts);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(h);
  }
  const fcByDay = new Map<string, number>();
  for (const p of fc.results as { period_end: number; p50: number }[]) {
    const d = kyivDate(p.period_end - 1);
    fcByDay.set(d, (fcByDay.get(d) ?? 0) + p.p50 * 500); // kW × 0.5 h → Wh
  }
  const schedByDay = new Map((sched.results as { date: string; status: string; slots: string }[]).map((r) => [r.date, r]));
  const outages = outagesFromEvents(events.results as { ts: number; grid_on: number; prev_ts: number }[]);
  const days = [];
  for (let d = firstDate; d <= endDate; d = addDays(d, 1)) {
    const rows = byDay.get(d) ?? [];
    const s = sumRows(rows, kyivTime(d, 0));
    const dayStart = kyivTime(d, 0), dayEnd = kyivTime(addDays(d, 1), 0);
    const sc = schedByDay.get(d);
    let schedMin = 0;
    try { if (sc?.status === "ScheduleApplies") for (const [a, b] of JSON.parse(sc.slots) as [number, number][]) schedMin += b - a; } catch { /* */ }
    days.push({
      date: d, ...s, hours: rows.length,
      self_sufficiency: s.load_wh > 0 ? Math.max(0, Math.min(1, 1 - s.grid_import_wh / s.load_wh)) : null,
      forecast_wh: fcByDay.get(d) ?? null,
      scheduled_off_min: sc ? schedMin : null,
      schedule_status: sc?.status ?? null,
      outages: outages.filter((o) => o.start < dayEnd && (o.end ?? Date.now()) > dayStart).length,
    });
  }
  return { first: firstDate, last: endDate, days };
}

/** Real outages next to what Yasno had scheduled (home address). */
async function apiOutageLog(env: Env, url: URL) {
  const { from, to } = rangeParams(url, 30 * DAY);
  const [events, sched, changes] = await env.DB.batch([
    env.DB.prepare(`SELECT ts, grid_on, prev_ts FROM grid_events WHERE ts >= COALESCE((SELECT MAX(ts) FROM grid_events WHERE ts < ?1), ?1) AND ts < ?2 ORDER BY ts`).bind(from, to),
    env.DB.prepare("SELECT date, status, slots, updated_on FROM outage_days WHERE role = 'home' AND date >= ? AND date <= ? ORDER BY date")
      .bind(kyivDate(from), kyivDate(to)),
    env.DB.prepare("SELECT ts, role, date, before, after FROM outage_changes WHERE ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 200").bind(from, to),
  ]);
  const real = outagesFromEvents(events.results as { ts: number; grid_on: number; prev_ts: number }[]).filter((o) => (o.end ?? Infinity) >= from);
  const scheduled: { start: number; end: number; date: string }[] = [];
  for (const r of sched.results as { date: string; status: string; slots: string }[]) {
    if (r.status !== "ScheduleApplies") continue;
    try { for (const [a, b] of JSON.parse(r.slots) as [number, number][]) scheduled.push({ date: r.date, start: kyivTime(r.date, a), end: kyivTime(r.date, b) }); } catch { /* */ }
  }
  return {
    from, to, real: real.reverse(), scheduled: scheduled.reverse(),
    statuses: (sched.results as { date: string; status: string }[]).map((r) => ({ date: r.date, status: r.status })),
    changes: (changes.results as { ts: number; role: string; date: string; before: string | null; after: string }[]).map((c) => ({
      ...c, before: c.before ? JSON.parse(c.before) : null, after: JSON.parse(c.after),
    })),
    durations_ms: outageDurations(events.results as { ts: number; grid_on: number }[]),
  };
}

/** Forecast vs actual per 30-min period, actual marked when throttled. ?from&to */
async function apiForecastActual(env: Env, url: URL) {
  const { from, to } = rangeParams(url, DAY);
  if (to - from > 62 * DAY) throw new BadRequest("range too long");
  const [actual, fc, first] = await env.DB.batch([
    env.DB.prepare(
      `SELECT (ts / 1800000) * 1800000 + 1800000 AS pe, AVG(pv_w) AS pv, COUNT(*) AS n,
              SUM(CASE WHEN soc >= 98 AND batt_w >= -50 THEN 1 ELSE 0 END) AS thr
       FROM samples WHERE ts >= ? AND ts < ? GROUP BY pe ORDER BY pe`,
    ).bind(from, to),
    env.DB.prepare("SELECT period_end, p10, p50, p90 FROM pv_forecast WHERE period_end > ? AND period_end <= ? ORDER BY period_end").bind(from, to),
    env.DB.prepare("SELECT period_end, p50 FROM pv_forecast_first WHERE period_end > ? AND period_end <= ? ORDER BY period_end").bind(from, to),
  ]);
  return { from, to, actual: actual.results, forecast: fc.results, first: first.results };
}

async function apiHealth(env: Env) {
  const now = Date.now();
  const [last, hb, counts, cfg, subs, hourly] = await env.DB.batch([
    env.DB.prepare("SELECT MAX(ts) AS ts FROM samples"),
    env.DB.prepare("SELECT received_at, json FROM heartbeats ORDER BY received_at DESC LIMIT 1"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM samples WHERE ts > ?").bind(now - 24 * HOUR),
    env.DB.prepare("SELECT key, value FROM config WHERE key IN ('yasno_status','solcast_status','solcast_budget','pv_factor','charge_w','capacity_est')"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions"),
    env.DB.prepare("SELECT MAX(hour_ts) AS h, MAX(updated_at) AS u FROM hourly"),
  ]);
  const config: Record<string, unknown> = {};
  for (const r of cfg.results as { key: string; value: string }[]) { try { config[r.key] = JSON.parse(r.value); } catch { /* */ } }
  const hbRow = hb.results[0] as { received_at: number; json: string } | undefined;
  let heartbeat: unknown = null;
  if (hbRow) { try { heartbeat = { received_at: hbRow.received_at, ...JSON.parse(hbRow.json) }; } catch { heartbeat = { received_at: hbRow.received_at }; } }
  const budget = config.solcast_budget as { utc_date: string; calls: number; last_call?: number } | undefined;
  return {
    server_ms: now,
    last_sample_ts: (last.results[0] as { ts: number | null }).ts,
    samples_24h: (counts.results[0] as { n: number }).n,
    heartbeat,
    yasno: (config.yasno_status as JobStatus) ?? null,
    solcast: {
      ...((config.solcast_status as JobStatus) ?? {}),
      calls_today: budget && budget.utc_date === new Date(now).toISOString().slice(0, 10) ? budget.calls : 0,
      last_call: budget?.last_call ?? null,
      configured: !!(env.SOLCAST_API_KEY && env.SOLCAST_RESOURCE_ID),
    },
    pv_factor: config.pv_factor ?? null,
    charge_w: config.charge_w ?? null,
    capacity_est: config.capacity_est ?? null,
    push_subscriptions: (subs.results[0] as { n: number }).n,
    rollup: hourly.results[0] ?? null,
    hour_fields: HOUR_FIELDS,
  };
}
