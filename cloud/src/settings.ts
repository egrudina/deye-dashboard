// Shared config (table `config`) and per-user settings (table `user_settings`).

import type { AddressState } from "./yasno.ts";

export interface PhaseNames { a: string; b: string; c: string }
export interface BatteryConfig { capacity_wh: number; floor_pct: number }

export const DEFAULT_PHASES: PhaseNames = { a: "Фаза A", b: "Фаза B", c: "Фаза C" };
export const DEFAULT_BATTERY: BatteryConfig = { capacity_wh: 20000, floor_pct: 15 };

export const NOTIFY_TYPES = ["grid", "wont_last", "low_batt", "schedule", "outage_soon", "generator_soon", "stale"] as const;
export type NotifyType = (typeof NOTIFY_TYPES)[number];

export interface UserSettings {
  phase: "all" | "a" | "b" | "c";
  neighbour: boolean;
  notify: Record<NotifyType, boolean>;
  low_batt_pct: number;
  quiet: { on: boolean; from: string; to: string }; // "HH:MM" Kyiv
}

export const DEFAULT_SETTINGS: UserSettings = {
  phase: "all",
  neighbour: true,
  notify: { grid: true, wont_last: true, low_batt: true, schedule: true, outage_soon: false, generator_soon: false, stale: false },
  low_batt_pct: 30,
  quiet: { on: false, from: "23:00", to: "07:00" },
};

export async function getConfig<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare("SELECT value FROM config WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return null;
  try { return JSON.parse(row.value) as T; } catch { return null; }
}

export async function getAllConfig(db: D1Database): Promise<Record<string, unknown>> {
  const { results } = await db.prepare("SELECT key, value FROM config").all<{ key: string; value: string }>();
  const out: Record<string, unknown> = {};
  for (const r of results) { try { out[r.key] = JSON.parse(r.value); } catch { /* skip */ } }
  return out;
}

export const setConfigStmt = (db: D1Database, key: string, value: unknown) =>
  db.prepare("INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(key, JSON.stringify(value), Date.now());

export async function setConfig(db: D1Database, key: string, value: unknown) {
  await setConfigStmt(db, key, value).run();
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

/** Merge a (possibly partial, untrusted) object into settings. */
export function mergeSettings(base: UserSettings, patch: unknown): UserSettings {
  const p = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  const out: UserSettings = structuredClone(base);
  if (p.phase === "all" || p.phase === "a" || p.phase === "b" || p.phase === "c") out.phase = p.phase;
  out.neighbour = bool(p.neighbour, out.neighbour);
  if (p.notify && typeof p.notify === "object") {
    const n = p.notify as Record<string, unknown>;
    for (const t of NOTIFY_TYPES) out.notify[t] = bool(n[t], out.notify[t]);
  }
  if (typeof p.low_batt_pct === "number" && p.low_batt_pct >= 16 && p.low_batt_pct <= 90) out.low_batt_pct = Math.round(p.low_batt_pct);
  if (p.quiet && typeof p.quiet === "object") {
    const q = p.quiet as Record<string, unknown>;
    out.quiet.on = bool(q.on, out.quiet.on);
    if (typeof q.from === "string" && HHMM.test(q.from)) out.quiet.from = q.from;
    if (typeof q.to === "string" && HHMM.test(q.to)) out.quiet.to = q.to;
  }
  return out;
}

export async function getUserSettings(db: D1Database, email: string): Promise<UserSettings> {
  const row = await db.prepare("SELECT json FROM user_settings WHERE email = ?").bind(email).first<{ json: string }>();
  let parsed: unknown = null;
  try { parsed = row ? JSON.parse(row.json) : null; } catch { /* default */ }
  return mergeSettings(DEFAULT_SETTINGS, parsed);
}

export async function putUserSettings(db: D1Database, email: string, patch: unknown): Promise<UserSettings> {
  const s = mergeSettings(await getUserSettings(db, email), patch);
  await db.prepare("INSERT INTO user_settings (email, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at")
    .bind(email, JSON.stringify(s), Date.now()).run();
  return s;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : null);

/** Validate a shared-settings patch. Returns config statements to run. Throws on bad input. */
export async function sharedPatch(db: D1Database, patch: unknown): Promise<D1PreparedStatement[]> {
  const p = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  const stmts: D1PreparedStatement[] = [];
  if (p.phase_names && typeof p.phase_names === "object") {
    const cur = (await getConfig<PhaseNames>(db, "phase_names")) ?? DEFAULT_PHASES;
    const n = p.phase_names as Record<string, unknown>;
    const next = { a: str(n.a, 30) || cur.a, b: str(n.b, 30) || cur.b, c: str(n.c, 30) || cur.c };
    stmts.push(setConfigStmt(db, "phase_names", next));
  }
  if (p.battery && typeof p.battery === "object") {
    const b = p.battery as Record<string, unknown>;
    const cur = (await getConfig<BatteryConfig>(db, "battery")) ?? DEFAULT_BATTERY;
    const cap = typeof b.capacity_wh === "number" && b.capacity_wh >= 1000 && b.capacity_wh <= 100000 ? Math.round(b.capacity_wh) : cur.capacity_wh;
    const floor = typeof b.floor_pct === "number" && b.floor_pct >= 0 && b.floor_pct <= 60 ? Math.round(b.floor_pct) : cur.floor_pct;
    stmts.push(setConfigStmt(db, "battery", { capacity_wh: cap, floor_pct: floor }));
  }
  for (const role of ["home", "neighbour"] as const) {
    const v = p[`addr_${role}`];
    if (v === undefined) continue;
    if (v === null) { stmts.push(setConfigStmt(db, `addr_${role}`, { street: "", house: "" })); continue; }
    const a = v as Record<string, unknown>;
    const street = str(a.street, 80), house = str(a.house, 20);
    if (!street || !house) throw new Error("street and house required");
    const cur = await getConfig<AddressState>(db, `addr_${role}`);
    if (cur && cur.street === street && cur.house === house) continue;
    // New address: resolve from scratch on the next cron run.
    stmts.push(setConfigStmt(db, `addr_${role}`, { street, house } satisfies AddressState));
  }
  return stmts;
}
