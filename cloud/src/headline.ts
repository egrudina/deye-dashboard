// The one plain sentence on the main screen. Pure; texts in Ukrainian.

import type { Projection } from "./projection.ts";
import { kyivDate, kyivParts, addDays } from "./time.ts";

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
const runtime = (h: number) => (h >= 48 ? "понад дві доби" : `приблизно ${fmtHours(h * 3_600_000)}`);

export function headline(inp: HeadlineInput): Headline {
  const { now, proj } = inp;
  const outageMode = !inp.gridOnNow || inp.scheduledSoon || inp.emergency || inp.recentDrop;
  if (outageMode && proj) return outageHeadline(inp, proj);
  return sunHeadline(inp);
}

function outageHeadline(inp: HeadlineInput, proj: Projection): Headline {
  const { now } = inp;
  const cur = proj.outages.find((o) => o.in_progress);
  const known = proj.confidence === "schedule";
  const noSchedule = inp.emergency
    ? "Yasno: екстрені відключення, графік не діє."
    : !inp.scheduleKnown ? "Графіка від Yasno немає." : "";

  if (!inp.gridOnNow) {
    if (cur && cur.end != null && known) {
      if (cur.lasts) {
        return { mode: "outage", tone: "ok", text: `Вистачить до повернення світла ${atClock(cur.end, now)}. Залишиться ${pct(cur.soc_end_low)}.` };
      }
      const empty = cur.empty_at ?? proj.empty_at_low ?? now;
      const before = fmtHours(cur.end - empty);
      const cut = cur.cut_w != null ? ` Зменште споживання на ${cur.cut_w} Вт, щоб дотягнути.` : " Зменште споживання до мінімуму.";
      return { mode: "outage", tone: "bad", text: `Батарея сяде близько ${fmtClock(empty, now)}, за ${before} до повернення світла.${cut}` };
    }
    // Unknown end: history or nothing.
    const base = `Світла немає. За поточного споживання батареї вистачить ${runtime(proj.runtime_h)}.`;
    return { mode: "outage", tone: proj.runtime_h < 4 ? "warn" : "info", text: base, detail: noSchedule || "Кінець відключення невідомий." };
  }

  // Grid on now.
  const next = proj.outages.find((o) => !o.in_progress);
  if (next && known) {
    if (!next.lasts) {
      const empty = next.empty_at ?? next.start;
      const cut = next.cut_w != null ? ` Під час нього зменште споживання на ${next.cut_w} Вт.` : "";
      return {
        mode: "outage", tone: "warn",
        text: `Відключення ${atClock(next.start, now)}: батарея сяде близько ${fmtClock(empty, now)}, раніше, ніж повернеться світло.${cut}`,
      };
    }
    if (inp.soc >= 99) {
      return { mode: "outage", tone: "ok", text: `Батарея повна. Відключення ${atClock(next.start, now)} витримає.`, detail: lastsDetail(next, now) };
    }
    if (proj.full_at != null && proj.full_at <= next.start) {
      return { mode: "outage", tone: "ok", text: `Зарядиться до 100% до наступного відключення ${atClock(next.start, now)}.`, detail: lastsDetail(next, now) };
    }
    return {
      mode: "outage", tone: "ok",
      text: `До відключення ${atClock(next.start, now)} зарядиться до ${pct(next.soc_start)}. Цього вистачить.`,
      detail: lastsDetail(next, now),
    };
  }
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

function lastsDetail(o: { end: number | null; soc_end_low: number }, now: number): string | undefined {
  if (o.end == null) return undefined;
  return `Світло повернеться ${atClock(o.end, now)}, залишиться ${pct(o.soc_end_low)}.`;
}

function sunHeadline(inp: HeadlineInput): Headline {
  const { sunWh, needWh } = inp;
  if (sunWh == null || needWh == null || needWh <= 0) {
    return { mode: "plain", tone: "ok", text: inp.gridOnNow ? `Світло є. Батарея ${pct(inp.soc)}.` : `Світла немає. Батарея ${pct(inp.soc)}.` };
  }
  if (sunWh >= needWh) {
    return {
      mode: "sun_covers", tone: "ok",
      text: "Сьогодні сонце покриває все: можна жити без мережі.",
      detail: `Прогноз ${kwh(sunWh)} кВт·год, потреба ${kwh(needWh)} кВт·год.`,
    };
  }
  const share = (sunWh / needWh) * 100;
  if (share < 3) {
    return { mode: "sun_partial", tone: "info", text: "Сьогодні сонця майже не буде: усе з мережі.", detail: `Потреба ${kwh(needWh)} кВт·год.` };
  }
  return {
    mode: "sun_partial", tone: "info",
    text: `Сьогодні сонце покриє близько ${pct(share)} потреби.`,
    detail: `Сонце ${kwh(sunWh)} з ${kwh(needWh)} кВт·год, решта ${kwh(needWh - sunWh)} кВт·год з мережі.`,
  };
}
