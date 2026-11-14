// Yasno outage schedule: parsing and pure helpers. Network and DB code is in jobs.ts.

export const YASNO_BASE = "https://app.yasno.ua/api/blackout-service/public/shutdowns";
export const ADDR_BASE = `${YASNO_BASE}/addresses/v2`;

// Region and grid operator (DSO). Default: Kyiv, DTEK Kyiv Grids. Override with the Worker vars YASNO_REGION /
// YASNO_DSO (list: GET ${ADDR_BASE}/regions). Only Kyiv is tested; regions with cities (Dnipro) need a city step
// in the address lookup that is not implemented yet.
export const DEFAULT_REGION = 25;
export const DEFAULT_DSO = 902;

export interface YasnoArea { region: number; dso: number }

export function yasnoArea(env: object): YasnoArea {
  const vars = env as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : d);
  return { region: num(vars.YASNO_REGION, DEFAULT_REGION), dso: num(vars.YASNO_DSO, DEFAULT_DSO) };
}

export const plannedUrl = (a: YasnoArea) => `${YASNO_BASE}/regions/${a.region}/dsos/${a.dso}/planned-outages`;

export type Slot = [number, number]; // minutes from Kyiv midnight [start, end)

export interface OutageDay {
  date: string;     // YYYY-MM-DD (Kyiv)
  status: string;   // ScheduleApplies | WaitingForSchedule | EmergencyShutdowns | ...
  slots: Slot[];    // Definite outages only, merged and sorted
}

export interface GroupSchedule { today: OutageDay | null; tomorrow: OutageDay | null; updatedOn: string | null }

export class YasnoFormatError extends Error {}

export function mergeSlots(slots: Slot[]): Slot[] {
  const s = slots.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Slot[] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function parseDay(raw: unknown): OutageDay | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.date !== "string" || typeof o.status !== "string") throw new YasnoFormatError("day without date/status");
  const date = o.date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new YasnoFormatError(`bad date ${o.date}`);
  const slots: Slot[] = [];
  if (o.slots != null) {
    if (!Array.isArray(o.slots)) throw new YasnoFormatError("slots not an array");
    for (const s of o.slots as Record<string, unknown>[]) {
      if (!s || typeof s.start !== "number" || typeof s.end !== "number") throw new YasnoFormatError("bad slot");
      if (s.type === "Definite") slots.push([Math.max(0, s.start), Math.min(1440, s.end)]);
    }
  }
  return { date, status: o.status, slots: mergeSlots(slots) };
}

/** Parse the planned-outages answer for one group ("30.1"). Missing group → null. Bad answer → YasnoFormatError. */
export function parseGroup(body: unknown, group: string): GroupSchedule | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new YasnoFormatError("answer is not an object");
  const g = (body as Record<string, unknown>)[group];
  if (g == null) return null;
  if (typeof g !== "object") throw new YasnoFormatError("group is not an object");
  const o = g as Record<string, unknown>;
  return {
    today: parseDay(o.today),
    tomorrow: parseDay(o.tomorrow),
    updatedOn: typeof o.updatedOn === "string" ? o.updatedOn : null,
  };
}

/** Outages the schedule can be trusted for. */
export const scheduleApplies = (d: OutageDay | null | undefined) => d?.status === "ScheduleApplies";

export const LOUD_FROM = 7 * 60;
export const LOUD_TO = 22 * 60;

/** Neighbour's generator runs during their outages, but only 07:00–22:00. */
export function loudHours(slots: Slot[], from = LOUD_FROM, to = LOUD_TO): Slot[] {
  const out: Slot[] = [];
  for (const [a, b] of slots) {
    const s = Math.max(a, from), e = Math.min(b, to);
    if (e > s) out.push([s, e]);
  }
  return out;
}

export const sameSlots = (a: Slot[], b: Slot[]) =>
  a.length === b.length && a.every((s, i) => s[0] === b[i][0] && s[1] === b[i][1]);

// ---------- address → group, with the "two matching checks an hour apart" rule ----------

export interface AddressState {
  street: string;           // as typed by the user, e.g. "вул. Садова"
  house: string;            // e.g. "12" or "12-А"
  group?: string;           // accepted group, "30.1"
  checked_at?: number;      // last successful resolve
  pending_group?: string;   // a different group seen once
  pending_at?: number;
  error?: string;           // last resolve error (shown in System)
}

export const RESOLVE_EVERY_MS = 7 * 86_400_000;
export const CONFIRM_AFTER_MS = 3_600_000;

/** Is a resolve due for this address now? */
export function resolveDue(a: AddressState, now: number): boolean {
  if (!a.street || !a.house) return false;
  if (!a.group) return !a.checked_at || now - a.checked_at > 15 * 60_000 || !!a.error;
  if (a.pending_group) return now - (a.pending_at ?? 0) >= CONFIRM_AFTER_MS;
  return now - (a.checked_at ?? 0) >= RESOLVE_EVERY_MS;
}

/** Apply a resolved group to the state. Returns the new state. */
export function applyResolved(a: AddressState, group: string, now: number): AddressState {
  const base = { ...a, checked_at: now, error: undefined };
  if (!a.group) return { ...base, group, pending_group: undefined, pending_at: undefined };
  if (group === a.group) return { ...base, pending_group: undefined, pending_at: undefined };
  if (a.pending_group === group && now - (a.pending_at ?? 0) >= CONFIRM_AFTER_MS) {
    return { ...base, group, pending_group: undefined, pending_at: undefined };
  }
  if (a.pending_group === group) return base; // seen again too early: keep waiting
  return { ...base, pending_group: group, pending_at: now };
}

/** Normalise names for matching: lower case, no spaces/dashes/dots/quotes, Latin look-alikes → Cyrillic. */
export function norm(s: string): string {
  const lat: Record<string, string> = { a: "а", b: "в", c: "с", e: "е", h: "н", i: "і", k: "к", m: "м", o: "о", p: "р", t: "т", x: "х", y: "у" };
  return s.toLowerCase().replace(/[a-z]/g, (ch) => lat[ch] ?? ch).replace(/[\s\-–.,'"’«»/]/g, "")
    .replace(/^(вулиця|вул|проспект|просп|пров|провулок|бульвар|бульв|площа|пл)(?=.)/, "");
}

/** Pick the best match from Yasno's list ({id, value}) for a typed name. */
export function pickMatch(list: { id: number; value: string }[], typed: string): { id: number; value: string } | null {
  const t = norm(typed);
  return list.find((x) => norm(x.value) === t) ?? (list.length === 1 ? list[0] : null);
}

/** The search query for streets: the name without the type prefix (Yasno needs ≥ 3 letters). */
export function streetQuery(street: string): string {
  return street.replace(/^\s*(вулиця|вул\.?|проспект|просп\.?|провулок|пров\.?|бульвар|бульв\.?|площа|пл\.?)\s*/i, "").trim();
}
