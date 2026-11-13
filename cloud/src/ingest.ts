// POST /api/ingest: unchanged from v1 except that it reports grid transitions to the caller.

import { DECODED_COLUMNS, REG_COUNT, REG_START, decode } from "./decode.ts";

const MAX_BODY_BYTES = 1_000_000;
const MAX_SAMPLES_PER_POST = 500;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const DEDUP_WINDOW_MS = 10_000; // samples are 30 s apart; a resent batch lands within a few seconds

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const log = (level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) =>
  console[level](JSON.stringify({ msg, ...extra }));

export interface GridTransition { ts: number; grid_on: number; prev_ts: number }


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

export async function ingest(request: Request, env: Env, transitions: GridTransition[] = []): Promise<Response> {
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
        transitions.push({ ts, grid_on: d.grid_on, prev_ts: last.ts });
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

