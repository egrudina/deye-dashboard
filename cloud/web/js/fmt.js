// Formatting (Ukrainian, Kyiv time).

export const TZ = "Europe/Kyiv";
const nf = new Intl.NumberFormat("uk-UA");
const nf1 = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 1 });
const timeF = new Intl.DateTimeFormat("uk-UA", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const dateF = new Intl.DateTimeFormat("uk-UA", { timeZone: TZ, day: "numeric", month: "short" });
const dateKeyF = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const wdF = new Intl.DateTimeFormat("uk-UA", { timeZone: TZ, weekday: "short", day: "numeric", month: "numeric" });

export const int = (v) => (v == null ? "—" : nf.format(Math.round(v)));
export const W = (w) => (w == null ? "—" : Math.abs(w) >= 1000 ? `${nf1.format(w / 1000)} кВт` : `${nf.format(Math.round(w))} Вт`);
export const kWh = (wh) => (wh == null ? "—" : `${wh >= 10000 ? nf.format(Math.round(wh / 1000)) : nf1.format(wh / 1000)} кВт·год`);
export const kWhNum = (wh) => (wh == null ? "—" : wh >= 10000 ? nf.format(Math.round(wh / 1000)) : nf1.format(wh / 1000));
export const pct = (v) => (v == null ? "—" : `${Math.round(v)}%`);
export const time = (ts) => timeF.format(ts);
export const dateKey = (ts) => dateKeyF.format(ts);
export const weekday = (ts) => wdF.format(ts);

/** "14:30", "завтра 03:40", "15 лист. 10:00" */
export function when(ts, now = Date.now()) {
  const d = dateKey(ts), today = dateKey(now), tomorrow = dateKey(now + 86400e3), yesterday = dateKey(now - 86400e3);
  if (d === today) return time(ts);
  if (d === tomorrow) return `завтра ${time(ts)}`;
  if (d === yesterday) return `вчора ${time(ts)}`;
  return `${dateF.format(ts)} ${time(ts)}`;
}
export const day = (ts) => dateF.format(ts);

export function duration(ms) {
  const min = Math.round(ms / 60e3);
  if (min < 1) return "< 1 хв";
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return [d && `${d} д`, h && `${h} год`, !d && m && `${m} хв`].filter(Boolean).join(" ");
}
export const ago = (ms) => (ms < 60e3 ? "щойно" : `${duration(ms)} тому`);

/** Kyiv midnight (ms) of the day containing ts. */
export function kyivMidnight(ts) {
  const [y, m, d] = dateKey(ts).split("-").map(Number);
  const utcMid = Date.UTC(y, m - 1, d);
  // Kyiv is ahead of UTC: the Kyiv clock at UTC midnight shows the offset.
  const [hh, mm] = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(utcMid).split(":").map(Number);
  return utcMid - (hh * 60 + mm) * 60e3;
}

/** Sunrise and sunset (ms) for Kyiv on the day containing ts (NOAA approximation). */
export function sunTimes(ts, lat = 50.45, lon = 30.52) {
  const rad = Math.PI / 180;
  const midnightUtc = Date.UTC(...dateKey(ts).split("-").map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  const n = Math.ceil(midnightUtc / 86400e3 + 2440587.5 - 2451545.0 + 0.0008);
  const Js = n - lon / 360;
  const M = (357.5291 + 0.98560028 * Js) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const L = (M + C + 180 + 102.9372) % 360;
  const Jt = 2451545.0 + Js + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * L * rad);
  const dec = Math.asin(Math.sin(L * rad) * Math.sin(23.44 * rad));
  const cosW = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(dec)) / (Math.cos(lat * rad) * Math.cos(dec));
  if (cosW > 1 || cosW < -1) return null;
  const w = Math.acos(cosW) / rad;
  const toMs = (j) => (j - 2440587.5) * 86400e3;
  return { rise: toMs(Jt - w / 360), set: toMs(Jt + w / 360) };
}
