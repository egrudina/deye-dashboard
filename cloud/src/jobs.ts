// Cron jobs: hourly energy rollups, Yasno schedule, Solcast forecast, calibration. Each job is independent.

import { HOUR_FIELDS, MAX_GAP_MS, integrateHours, type PowerSample } from "./energy.ts";
import { countCall, correctionFactor, markBusy, isThrottled, parseForecast, solcastDue, type SolcastBudget } from "./solcast.ts";
import { getConfig, setConfig, setConfigStmt } from "./settings.ts";
import { DAY, HOUR, kyivDate } from "./time.ts";
import {
  ADDR_BASE, applyResolved, parseGroup, pickMatch, plannedUrl, resolveDue, sameSlots, streetQuery, yasnoArea,
  type AddressState, type OutageDay, type Slot, type YasnoArea,
} from "./yasno.ts";

export const POWER_COLS = "ts, grid_on, soc, batt_w, grid_total_w, load_total, load_a, load_b, load_c, pv_w";

const log = (level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) =>
  console[level](JSON.stringify({ msg, ...extra }));

export interface JobStatus { ok_at?: number; error?: string; error_at?: number }

async function status(db: D1Database, key: string, err?: unknown) {
  const cur = (await getConfig<JobStatus>(db, key)) ?? {};
  const next: JobStatus = err === undefined
    ? { ok_at: Date.now() }
    : { ...cur, error: String(err).slice(0, 300), error_at: Date.now() };
  await setConfig(db, key, next);
}

// ---------- hourly rollups ----------

/** Recompute the last few hours (and backfill up to 3 days per run while behind). */
export async function rollup(env: Env, now = Date.now()): Promise<number> {
  const last = await env.DB.prepare("SELECT MAX(hour_ts) AS h FROM hourly").first<{ h: number | null }>();
  let from: number;
  if (last?.h != null) from = last.h - 2 * HOUR;
  else {
    const first = await env.DB.prepare("SELECT MIN(ts) AS t FROM samples").first<{ t: number | null }>();
    if (first?.t == null) return 0;
    from = Math.floor(first.t / HOUR) * HOUR;
  }
  const to = Math.min(from + 3 * DAY, Math.floor(now / HOUR) * HOUR + HOUR);
  const { results } = await env.DB.prepare(`SELECT ${POWER_COLS} FROM samples WHERE ts >= ? AND ts < ? ORDER BY ts`)
    .bind(from - MAX_GAP_MS, to + MAX_GAP_MS).all<PowerSample>();
  const rows = integrateHours(results, from, to, now);
  if (!rows.length) {
    // Gap in data: move on so the backfill does not get stuck.
    if (to < Math.floor(now / HOUR) * HOUR) {
      await env.DB.prepare(`INSERT OR IGNORE INTO hourly (hour_ts, covered_s, load_wh, load_a_wh, load_b_wh, load_c_wh, pv_wh,
        batt_charge_wh, batt_discharge_wh, grid_import_wh, off_min, updated_at) VALUES (?, 0,0,0,0,0,0,0,0,0,0, ?)`).bind(to - HOUR, now).run();
    }
    return 0;
  }
  const cols = ["hour_ts", ...HOUR_FIELDS, "updated_at"];
  const stmt = env.DB.prepare(
    `INSERT INTO hourly (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
     ON CONFLICT(hour_ts) DO UPDATE SET ${[...HOUR_FIELDS, "updated_at"].map((c) => `${c} = excluded.${c}`).join(", ")}`,
  );
  await env.DB.batch(rows.map((r) => stmt.bind(r.hour_ts, ...HOUR_FIELDS.map((k) => r[k]), now)));
  return rows.length;
}

// ---------- Yasno ----------

export interface ScheduleChange { role: string; date: string; before: { status: string; slots: Slot[] } | null; after: { status: string; slots: Slot[] } }

const UA = { "user-agent": "deye-dashboard/2 (home use)", accept: "application/json" };

async function getJson(url: string, timeoutMs = 10_000): Promise<unknown> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${url.replace(/\?.*/, "")}`);
  return res.json();
}

async function resolveGroup(a: AddressState, area: YasnoArea): Promise<string> {
  const q = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
  const sq = streetQuery(a.street);
  if (sq.length < 3) throw new Error("street name too short");
  const streets = (await getJson(`${ADDR_BASE}/streets?${q({ regionId: area.region, dsoId: area.dso, query: sq })}`)) as { id: number; value: string }[];
  const street = pickMatch(streets ?? [], a.street);
  if (!street) throw new Error(`street not found: ${a.street}`);
  const houses = (await getJson(`${ADDR_BASE}/houses?${q({ regionId: area.region, dsoId: area.dso, streetId: street.id, query: a.house.replace(/[-\s].*$/, "") })}`)) as { id: number; value: string }[];
  const house = pickMatch(houses ?? [], a.house);
  if (!house) throw new Error(`house not found: ${a.house}`);
  const g = (await getJson(`${ADDR_BASE}/group?${q({ regionId: area.region, dsoId: area.dso, streetId: street.id, houseId: house.id })}`)) as { group?: number; subgroup?: number };
  if (g?.group == null) throw new Error("no group in answer");
  return `${g.group}.${g.subgroup ?? 1}`;
}

export async function yasno(env: Env, now = Date.now()): Promise<ScheduleChange[]> {
  const roles = ["home", "neighbour"] as const;
  const area = yasnoArea(env);
  const addrs: Partial<Record<(typeof roles)[number], AddressState>> = {};
  for (const role of roles) {
    let a = await getConfig<AddressState>(env.DB, `addr_${role}`);
    if (!a?.street) continue;
    if (resolveDue(a, now)) {
      try {
        a = applyResolved(a, await resolveGroup(a, area), now);
      } catch (e) {
        a = { ...a, checked_at: now, error: String(e).slice(0, 200) };
        log("warn", "yasno resolve failed", { role, error: String(e) });
      }
      await setConfig(env.DB, `addr_${role}`, a);
    }
    if (a.group) addrs[role] = a;
  }
  if (!addrs.home && !addrs.neighbour) return [];

  let body: unknown;
  try {
    body = await getJson(plannedUrl(area), 15_000);
  } catch (e) {
    await status(env.DB, "yasno_status", e);
    throw e;
  }

  const changes: ScheduleChange[] = [];
  const stmts: D1PreparedStatement[] = [];
  for (const role of roles) {
    const a = addrs[role];
    if (!a?.group) continue;
    const sched = parseGroup(body, a.group);
    if (!sched) { log("warn", "yasno group missing", { role, group: a.group }); continue; }
    for (const day of [sched.today, sched.tomorrow]) {
      if (!day) continue;
      const prev = await env.DB.prepare("SELECT status, slots, grp FROM outage_days WHERE role = ? AND date = ?")
        .bind(role, day.date).first<{ status: string; slots: string; grp: string }>();
      const before = prev ? { status: prev.status, slots: JSON.parse(prev.slots) as Slot[] } : null;
      const after = { status: day.status, slots: day.slots };
      const changed = !before || before.status !== after.status || !sameSlots(before.slots, after.slots) || prev?.grp !== a.group;
      stmts.push(env.DB.prepare(
        `INSERT INTO outage_days (role, date, grp, status, slots, updated_on, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(role, date) DO UPDATE SET grp = excluded.grp, status = excluded.status, slots = excluded.slots,
           updated_on = excluded.updated_on, fetched_at = excluded.fetched_at`,
      ).bind(role, day.date, a.group, day.status, JSON.stringify(day.slots), sched.updatedOn, now));
      if (changed) {
        stmts.push(env.DB.prepare("INSERT INTO outage_changes (ts, role, date, before, after) VALUES (?, ?, ?, ?, ?)")
          .bind(now, role, day.date, before ? JSON.stringify(before) : null, JSON.stringify(after)));
        changes.push({ role, date: day.date, before, after });
      }
    }
  }
  stmts.push(setConfigStmt(env.DB, "yasno_status", { ok_at: now }));
  await env.DB.batch(stmts);
  return changes;
}

export function dayFromRow(r: { date: string; status: string; slots: string }): OutageDay {
  let slots: Slot[] = [];
  try { slots = JSON.parse(r.slots) as Slot[]; } catch { /* empty */ }
  return { date: r.date, status: r.status, slots };
}

// ---------- Solcast ----------

export async function solcast(env: Env, now = Date.now(), force = false): Promise<boolean> {
  const key = env.SOLCAST_API_KEY, site = env.SOLCAST_RESOURCE_ID;
  if (!key || !site) return false;
  const budget = await getConfig<SolcastBudget>(env.DB, "solcast_budget");
  if (!force && !solcastDue(now, budget)) return false;
  if (force && budget && budget.utc_date === new Date(now).toISOString().slice(0, 10) && budget.calls >= 9) return false;
  // Count the call before making it: a failed call may still use quota.
  const wasRetry = !!budget?.busy_at && budget.busy_at === budget.last_call;
  const counted = countCall(now, budget);
  await setConfig(env.DB, "solcast_budget", counted);
  try {
    const res = await fetch(`https://api.solcast.com.au/rooftop_sites/${encodeURIComponent(site)}/forecasts?format=json&hours=72`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429) {
      // Hobbyist keys get 429 when Solcast is busy, not only when the daily quota is used up.
      const text = (await res.text()).trim().slice(0, 120);
      await setConfig(env.DB, "solcast_budget", markBusy(counted, wasRetry));
      throw new Error(`solcast 429 (${text || "сервер зайнятий"})${wasRetry ? "" : ", повтор за 15 хв"}`);
    }
    if (!res.ok) throw new Error(`solcast ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const periods = parseForecast(await res.json());
    const today = kyivDate(now);
    const up = env.DB.prepare(
      `INSERT INTO pv_forecast (period_end, p50, p10, p90, fetched_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(period_end) DO UPDATE SET p50 = excluded.p50, p10 = excluded.p10, p90 = excluded.p90, fetched_at = excluded.fetched_at`,
    );
    const first = env.DB.prepare("INSERT OR IGNORE INTO pv_forecast_first (period_end, p50, p10, p90, fetched_at) VALUES (?, ?, ?, ?, ?)");
    const stmts: D1PreparedStatement[] = [];
    for (const p of periods) {
      stmts.push(up.bind(p.period_end, p.p50, p.p10, p.p90, now));
      if (kyivDate(p.period_end - 1) === today) stmts.push(first.bind(p.period_end, p.p50, p.p10, p.p90, now));
    }
    stmts.push(setConfigStmt(env.DB, "solcast_status", { ok_at: now }));
    await env.DB.batch(stmts);
    return true;
  } catch (e) {
    await status(env.DB, "solcast_status", e);
    throw e;
  }
}

// ---------- calibration (hourly) ----------

export async function calibrate(env: Env, now = Date.now()) {
  const since = now - 14 * DAY;
  const [actual, fc, charge, hours] = await env.DB.batch([
    env.DB.prepare(
      `SELECT (ts / 1800000) * 1800000 + 1800000 AS pe, AVG(pv_w) AS pv, COUNT(*) AS n,
              SUM(CASE WHEN soc >= 98 AND batt_w >= -50 THEN 1 ELSE 0 END) AS thr
       FROM samples WHERE ts >= ? GROUP BY pe`,
    ).bind(since),
    env.DB.prepare("SELECT period_end, p50 FROM pv_forecast WHERE period_end >= ? AND period_end <= ?").bind(since, now),
    env.DB.prepare("SELECT AVG(-batt_w) AS w, COUNT(*) AS n FROM samples WHERE ts >= ? AND grid_on = 1 AND batt_w < -1000 AND soc < 90")
      .bind(now - 30 * DAY),
    env.DB.prepare(
      `SELECT batt_discharge_wh AS d, soc_max - soc_min AS drop_pct FROM hourly
       WHERE hour_ts >= ? AND batt_charge_wh < 20 AND soc_max - soc_min >= 2 AND covered_s > 3000`,
    ).bind(now - 30 * DAY),
  ]);
  const fcMap = new Map((fc.results as { period_end: number; p50: number }[]).map((r) => [r.period_end, r.p50 * 1000]));
  const pairs: { forecast_w: number; actual_w: number }[] = [];
  for (const r of actual.results as { pe: number; pv: number; n: number; thr: number }[]) {
    const f = fcMap.get(r.pe);
    if (f == null || r.thr > 0 || r.n < 40) continue;
    pairs.push({ forecast_w: f, actual_w: r.pv });
  }
  const factor = correctionFactor(pairs);
  const ch = charge.results[0] as { w: number | null; n: number };
  const hs = hours.results as { d: number; drop_pct: number }[];
  const dropSum = hs.reduce((s, h) => s + h.drop_pct, 0);
  const capEst = dropSum >= 10 ? (hs.reduce((s, h) => s + h.d, 0) / dropSum) * 100 : null;
  await env.DB.batch([
    setConfigStmt(env.DB, "pv_factor", { factor, pairs: pairs.length, at: now }),
    setConfigStmt(env.DB, "charge_w", { w: ch.n >= 20 && ch.w ? Math.round(ch.w) : null, samples: ch.n, at: now }),
    setConfigStmt(env.DB, "capacity_est", { wh: capEst != null ? Math.round(capEst) : null, drop_pct: dropSum, at: now }),
  ]);
}

export { isThrottled };
