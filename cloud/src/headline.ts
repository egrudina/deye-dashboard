// The one plain sentence on the main screen. Pure; texts in Ukrainian.

import type { Projection } from "./projection.ts";
import { HOUR, kyivDate, kyivParts, kyivTime, addDays } from "./time.ts";

export type Tone = "ok" | "info" | "warn" | "bad";
export type Mode = "outage" | "sun_covers" | "sun_partial" | "plain";

export interface Headline { mode: Mode; tone: Tone; text: string; detail?: string }

export interface HeadlineInput {
  now: number;
  gridOnNow: boolean;
  soc: number;
  proj: Projection | null;
  scheduleKnown: boolean;       // ScheduleApplies for today (and tomorrow if published)
  emergency: boolean;           // EmergencyShutdowns today or tomorrow
  scheduledSoon: boolean;       // a scheduled outage starts within 48 h (or is in progress)
  recentDrop: boolean;          // the grid went off in the last 7 days
  sunWh: number | null;         // forecast sun energy today (Kyiv day), corrected; null = no forecast
  needWh: number | null;        // expected need today
  sunRestWh?: number | null;    // forecast sun still to come today; ~0 = the sun's day is over (past tense)
  lateReturn?: number | null;   // grid still off although the scheduled outage ended at this time, a few minutes ago
}

export function fmtClock(ts: number, now: number): string {
  const p = kyivParts(ts);
  const hm = `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
  const today = kyivDate(now);
  if (p.date === today) return hm;
  if (p.date === addDays(today, 1)) return `завтра ${hm}`;
  if (p.date === addDays(today, 2)) return `післязавтра ${hm}`;
  return `${p.d}.${String(p.mo).padStart(2, "0")} ${hm}`;
}

/** "о 18:00" / "завтра о 03:40" */
export function atClock(ts: number, now: number): string {
  const s = fmtClock(ts, now);
  return s.startsWith("завтра ") ? `завтра о ${s.slice(7)}` : s.startsWith("післязавтра ") ? `післязавтра о ${s.slice(12)}` : `о ${s}`;
}

export function fmtHours(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(min / 60), m = min % 60;
  if (h === 0) return `${m} хв`;
  if (m === 0 || h >= 10) return `${h} год`;
  return `${h} год ${m} хв`;
}

const kwh = (wh: number) => {
  const v = wh / 1000;
  return v >= 10 ? Math.round(v).toString() : v.toFixed(1).replace(".", ",");
};
const pct = (v: number) => `${Math.round(v)}%`;
/** The sun is done for today (after sunset): talk about it in the past tense. */
const sunDone = (inp: HeadlineInput) =>
  inp.sunRestWh != null && inp.sunWh != null && inp.sunRestWh < Math.max(30, inp.sunWh * 0.01);

const runtime = (h: number) => (h >= 48 ? "понад дві доби" : `приблизно ${fmtHours(h * 3_600_000)}`);

export function headline(inp: HeadlineInput): Headline {
  const { now, proj } = inp;
  const outageMode = !inp.gridOnNow || inp.scheduledSoon || inp.emergency || inp.recentDrop;
  if (outageMode && proj) return outageHeadline(inp, proj);
  return sunHeadline(inp);
}

/** "Till tomorrow's sun": the next 08:00 (Kyiv) that is at least 6 h away. */
export function nextMorning(now: number): number {
  const today = kyivDate(now);
  const t = kyivTime(today, 8 * 60);
  return t - now >= 6 * HOUR ? t : kyivTime(addDays(today, 1), 8 * 60);
}

/** One short remark about today's sun, or nothing without a forecast. */
function sunNote(inp: HeadlineInput): string | undefined {
  const { sunWh, needWh } = inp;
  if (sunWh == null || needWh == null || needWh <= 0) return undefined;
  const share = (sunWh / needWh) * 100;
  const done = sunDone(inp);
  if (share >= 100) return done ? "Сьогодні сонце покрило все" : "Сьогодні сонце покриває все";
  if (share < 3) return done ? "Сьогодні сонця майже не було" : "Сьогодні сонця майже немає";
  if (share < 25) return done ? "Сьогодні сонця було мало" : "Сьогодні сонця мало";
  return `Сьогодні сонце ${done ? "покрило" : "покриє"} близько ${pct(share)} потреби`;
}

const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).map((p) => `${p}.`).join(" ") || undefined;

/**
 * Schedule known: one verdict for the whole stretch until the morning, counting every outage, the grid
 * hours in between and the sun (pessimistic scenario).
 */
function verdict(inp: HeadlineInput, proj: Projection): Headline {
  const { now } = inp;
  const until = nextMorning(now);
  const sun = sunNote(inp);
  const fail = proj.outages.find((o) => !o.lasts && o.start < until);
  if (fail) {
    const empty = fail.empty_at ?? proj.empty_at_low ?? fail.start;
    const cut = fail.cut_w != null ? ` Зменште споживання на ${fail.cut_w} Вт${fail.in_progress ? "" : " під час відключення"}.` : " Зменште споживання до мінімуму.";
    const back = fail.end != null ? `Світло повернеться ${atClock(fail.end, now)}` : undefined;
    return { mode: "outage", tone: fail.in_progress ? "bad" : "warn", text: `Батарея сяде близько ${fmtClock(empty, now)}.${cut}`, detail: join(back, sun) };
  }
  let low = proj.points[0];
  for (const p of proj.points) if (p.t <= until && p.soc_low < low.soc_low) low = p;
  const morning = kyivDate(until) === kyivDate(now) || kyivParts(now).h >= 15 ? "ранку" : "завтрашнього ранку";
  const min = low.soc_low < inp.soc - 1 ? `Найменше буде близько ${pct(low.soc_low)} ${atClock(low.t, now)}` : undefined;
  return { mode: "outage", tone: "ok", text: `Батареї вистачить до ${morning}.`, detail: join(min, sun) };
}

function outageHeadline(inp: HeadlineInput, proj: Projection): Headline {
  const { now } = inp;
  const cur = proj.outages.find((o) => o.in_progress);
  const known = proj.confidence === "schedule";
  const noSchedule = inp.emergency
    ? "Yasno: екстрені відключення, графік не діє."
    : !inp.scheduleKnown ? "Графіка від Yasno немає." : "";

  if (!inp.gridOnNow) {
    if (cur && cur.end != null && known && !cur.end_guessed) return verdict(inp, proj);
    if (inp.lateReturn != null && known) {
      return { mode: "outage", tone: "info", text: `Світло мало повернутися ${atClock(inp.lateReturn, now)}. Перемикання може тривати до 10 хв.` };
    }
    // Unknown end: history or nothing.
    const base = `Світла немає. За поточного споживання батареї вистачить ${runtime(proj.runtime_h)}.`;
    return { mode: "outage", tone: proj.runtime_h < 4 ? "warn" : "info", text: base, detail: noSchedule || "Кінець відключення невідомий." };
  }

  // Grid on now.
  if (known && proj.outages.some((o) => !o.in_progress)) return verdict(inp, proj);
  if (inp.emergency || !inp.scheduleKnown) {
    return {
      mode: "outage", tone: "info",
      text: `${noSchedule} За поточного споживання батареї вистачить ${runtime(proj.runtime_h)}.`,
    };
  }
  // Schedule known and no outage within 48 h (recent drop triggered the mode): fall through to the sun.
  const sun = sunHeadline(inp);
  return { ...sun, detail: sun.detail ?? "За графіком відключень найближчі 48 год немає." };
}

function sunHeadline(inp: HeadlineInput): Headline {
  const { sunWh, needWh } = inp;
  if (sunWh == null || needWh == null || needWh <= 0) {
    return { mode: "plain", tone: "ok", text: inp.gridOnNow ? `Світло є. Батарея ${pct(inp.soc)}.` : `Світла немає. Батарея ${pct(inp.soc)}.` };
  }
  const done = sunDone(inp);
  if (sunWh >= needWh) {
    return {
      mode: "sun_covers", tone: "ok",
      text: done ? "Сьогодні сонце покрило все." : "Сьогодні сонце покриває все: можна жити без мережі.",
      detail: `${done ? "Сонце дало" : "Прогноз"} ${kwh(sunWh)} кВт·год, потреба ${kwh(needWh)} кВт·год.`,
    };
  }
  const share = (sunWh / needWh) * 100;
  if (share < 3) {
    return { mode: "sun_partial", tone: "info", text: done ? "Сьогодні сонця майже не було: усе з мережі." : "Сьогодні сонця майже не буде: усе з мережі.", detail: `Потреба ${kwh(needWh)} кВт·год.` };
  }
  return {
    mode: "sun_partial", tone: "info",
    text: `Сьогодні сонце ${done ? "покрило" : "покриє"} близько ${pct(share)} потреби.`,
    detail: `Сонце ${kwh(sunWh)} з ${kwh(needWh)} кВт·год, решта ${kwh(needWh - sunWh)} кВт·год з мережі.`,
  };
}
