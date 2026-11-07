import { checkBearer, verifyAccess } from "./auth";
import { DECODED_COLUMNS, REG_COUNT, REG_START, decode } from "./decode";

const MAX_BODY_BYTES = 1_000_000;
const MAX_SAMPLES_PER_POST = 500;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const DEDUP_WINDOW_MS = 10_000; // samples are 30 s apart; a resent batch lands within a few seconds
const RAW_KEEP_MS = 7 * 24 * 3600 * 1000;
const MAX_POINTS = 1500;

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const log = (level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) =>
  console[level](JSON.stringify({ msg, ...extra }));

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/ingest") {
      if (request.method !== "POST") return json({ error: "method" }, 405);
      if (!(await checkBearer(request, env.PUSH_KEY))) return json({ error: "unauthorized" }, 401);
      return ingest(request, env);
    }

    // Everything else: only for users that passed Cloudflare Access.
    if (!env.DEV_NO_AUTH) {
      if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return new Response("Access not configured", { status: 503 });
      const email = await verifyAccess(request, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
      if (!email) return new Response("Forbidden", { status: 403 });
    }

    if (url.pathname.startsWith("/api/")) {
      if (request.method !== "GET") return json({ error: "method" }, 405);
      try {
        switch (url.pathname) {
          case "/api/now": return json(await apiNow(env));
          case "/api/series": return json(await apiSeries(env, url));
          case "/api/outages": return json(await apiOutages(env, url));
          case "/api/health": return json(await apiHealth(env));
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

  async scheduled(_controller, env, _ctx): Promise<void> {
    const cutoff = Date.now() - RAW_KEEP_MS;
    const res = await env.DB.batch([
      env.DB.prepare("DELETE FROM raw_samples WHERE ts < ?").bind(cutoff),
      // Keep at least the latest heartbeat even if it is old.
      env.DB.prepare(
        "DELETE FROM heartbeats WHERE received_at < ? AND received_at < (SELECT MAX(received_at) FROM heartbeats)",
      ).bind(cutoff),
    ]);
    log("info", "purge", { raw: res[0].meta.changes, heartbeats: res[1].meta.changes });
  },
} satisfies ExportedHandler<Env>;

class BadRequest extends Error {}

// ---------- ingest ----------

interface IngestSample { age_ms: number; start: number; regs: number[] }
interface IngestBody { v: number; pi_wall_ms?: number; samples?: IngestSample[]; heartbeat?: Record<string, unknown> }

function validSample(s: unknown): s is IngestSample {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return (
    Number.isInteger(o.age_ms) && (o.age_ms as number) >= 0 && (o.age_ms as number) <= MAX_AGE_MS &&
    o.start === REG_START &&
    Array.isArray(o.regs) && o.regs.length === REG_COUNT &&
    o.regs.every((r) => Number.isInteger(r) && r >= 0 && r <= 0xffff)
  );
}

async function ingest(request: Request, env: Env): Promise<Response> {
  const received = Date.now();
  const len = Number(request.headers.get("content-length") ?? "NaN");
  if (!Number.isFinite(len) || len > MAX_BODY_BYTES) return json({ error: "content-length required, max 1 MB" }, 413);

  let body: IngestBody;
  try {
    body = JSON.parse(await request.text()) as IngestBody;
  } catch {
    return json({ error: "bad json" }, 400);
  }
  if (body?.v !== 1) return json({ error: "unsupported version" }, 400);
  const samples = body.samples ?? [];
  if (!Array.isArray(samples) || samples.length > MAX_SAMPLES_PER_POST) return json({ error: "bad samples" }, 400);

  // Bad samples are skipped, not fatal: the Pi must never get stuck resending a batch.
  const good = samples.filter(validSample).map((s) => ({ ts: received - s.age_ms, s }));
  const rejected = samples.length - good.length;
  good.sort((a, b) => a.ts - b.ts);

  const stmts: D1PreparedStatement[] = [];

  // Grid transitions: compare each sample with the previous one (the latest stored sample before the batch).
  if (good.length) {
    const prev = await env.DB.prepare("SELECT ts, grid_on FROM samples WHERE ts < ? ORDER BY ts DESC LIMIT 1")
      .bind(good[0].ts - DEDUP_WINDOW_MS)
      .first<{ ts: number; grid_on: number }>();
    let last = prev ?? null;

    const cols = DECODED_COLUMNS.join(", ");
    const qs = DECODED_COLUMNS.map(() => "?").join(", ");
    const insertSample = env.DB.prepare(
      `INSERT INTO samples (ts, ${cols}) SELECT ?, ${qs}
       WHERE NOT EXISTS (SELECT 1 FROM samples WHERE ts BETWEEN ? AND ?)`,
    );
    const insertRaw = env.DB.prepare(
      `INSERT INTO raw_samples (ts, start, regs) SELECT ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM raw_samples WHERE ts BETWEEN ? AND ?)`,
    );
    const insertEvent = env.DB.prepare(
      `INSERT INTO grid_events (ts, grid_on, prev_ts) SELECT ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM grid_events WHERE ts BETWEEN ? AND ?)`,
    );

    for (const { ts, s } of good) {
      const d = decode(s.start, s.regs);
      const lo = ts - DEDUP_WINDOW_MS, hi = ts + DEDUP_WINDOW_MS;
      stmts.push(insertSample.bind(ts, ...DECODED_COLUMNS.map((c) => d[c]), lo, hi));
      stmts.push(insertRaw.bind(ts, s.start, JSON.stringify(s.regs), lo, hi));
      if (last && last.ts < lo && last.grid_on !== d.grid_on) {
        stmts.push(insertEvent.bind(ts, d.grid_on, last.ts, lo, hi));
      }
      if (!last || last.ts < lo) last = { ts, grid_on: d.grid_on };
    }
  }

  if (body.heartbeat && typeof body.heartbeat === "object") {
    stmts.push(
      env.DB.prepare("INSERT OR REPLACE INTO heartbeats (received_at, pi_wall_ms, json) VALUES (?, ?, ?)")
        .bind(received, Number.isFinite(body.pi_wall_ms) ? body.pi_wall_ms : null, JSON.stringify(body.heartbeat).slice(0, 4000)),
    );
  }

  let inserted = 0;
  if (stmts.length) {
    const results = await env.DB.batch(stmts);
    // Every first statement of a sample pair is the samples insert.
    for (let i = 0; i < good.length; i++) inserted += results[i * 2]?.meta.changes ?? 0;
  }
  if (rejected) log("warn", "ingest rejected samples", { rejected });
  return json({ ok: true, inserted, duplicates: good.length - inserted, rejected });
}

// ---------- read API ----------

async function apiNow(env: Env) {
  const [latest, lastEvent, hb] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM samples ORDER BY ts DESC LIMIT 1"),
    env.DB.prepare("SELECT ts, grid_on, prev_ts FROM grid_events ORDER BY ts DESC LIMIT 1"),
    env.DB.prepare("SELECT received_at, json FROM heartbeats ORDER BY received_at DESC LIMIT 1"),
  ]);
  const sample = (latest.results[0] as Record<string, number> | undefined) ?? null;
  const event = (lastEvent.results[0] as { ts: number; grid_on: number; prev_ts: number } | undefined) ?? null;
  const heartbeat = parseHeartbeat(hb.results[0] as { received_at: number; json: string } | undefined);
  return {
    server_ms: Date.now(),
    sample,
    // Grid state has been the same since this event (if it matches the current state).
    grid_since: event && sample && event.grid_on === sample.grid_on ? { ts: event.ts, prev_ts: event.prev_ts } : null,
    heartbeat,
  };
}

function parseHeartbeat(row: { received_at: number; json: string } | undefined) {
  if (!row) return null;
  try {
    return { received_at: row.received_at, ...(JSON.parse(row.json) as Record<string, unknown>) };
  } catch {
    return { received_at: row.received_at };
  }
}

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
            AVG(pv_w) AS pv_w, AVG(grid_w) AS grid_w, AVG(ext_ct_w) AS ext_ct_w
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

  const outages: { start: number; start_after: number; end: number | null; end_after: number | null }[] = [];
  for (const e of results) {
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
  return { from, to, outages: outages.filter((o) => (o.end ?? Infinity) >= from).reverse() };
}

async function apiHealth(env: Env) {
  const [last, hb, counts] = await env.DB.batch([
    env.DB.prepare("SELECT MAX(ts) AS ts FROM samples"),
    env.DB.prepare("SELECT received_at, json FROM heartbeats ORDER BY received_at DESC LIMIT 1"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM samples WHERE ts > ?").bind(Date.now() - 24 * 3600 * 1000),
  ]);
  return {
    server_ms: Date.now(),
    last_sample_ts: (last.results[0] as { ts: number | null }).ts,
    samples_24h: (counts.results[0] as { n: number }).n,
    heartbeat: parseHeartbeat(hb.results[0] as { received_at: number; json: string } | undefined),
  };
}
