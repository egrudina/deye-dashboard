// Europe/Kyiv helpers. Works in Workers and Node (Intl with full ICU).

export const TZ = "Europe/Kyiv";
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

const dtf = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

export interface KyivParts { y: number; mo: number; d: number; h: number; mi: number; s: number; date: string }

export function kyivParts(ts: number): KyivParts {
  const p: Record<string, string> = {};
  for (const x of dtf.formatToParts(new Date(ts))) p[x.type] = x.value;
  const y = +p.year, mo = +p.month, d = +p.day;
  return { y, mo, d, h: +p.hour, mi: +p.minute, s: +p.second, date: `${p.year}-${p.month}-${p.day}` };
}

/** Kyiv UTC offset in minutes at `ts` (120 in winter, 180 in summer). */
export function kyivOffsetMin(ts: number): number {
  const p = kyivParts(ts);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(ts / 1000) * 1000) / MIN);
}

/** Kyiv date string (YYYY-MM-DD) of `ts`. */
export const kyivDate = (ts: number) => kyivParts(ts).date;

/** Minutes since Kyiv midnight. */
export function kyivMinuteOfDay(ts: number): number {
  const p = kyivParts(ts);
  return p.h * 60 + p.mi + p.s / 60;
}

/** ms of Kyiv local time `minute` (0..1440, may exceed) on Kyiv date `date` (YYYY-MM-DD). DST-safe. */
export function kyivTime(date: string, minute = 0): number {
  const [y, mo, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d) + minute * MIN;
  // Two passes handle the offset change on DST days.
  let ts = guess - kyivOffsetMin(guess) * MIN;
  ts = guess - kyivOffsetMin(ts) * MIN;
  return ts;
}

/** Kyiv midnight (ms) of the day containing `ts`. */
export const kyivMidnight = (ts: number) => kyivTime(kyivDate(ts), 0);

/** Kyiv date string `n` days after `date`. */
export function addDays(date: string, n: number): string {
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

/** Kyiv hour of day (0..23) of `ts`. */
export const kyivHour = (ts: number) => kyivParts(ts).h;

export const utcDate = (ts: number) => new Date(ts).toISOString().slice(0, 10);
