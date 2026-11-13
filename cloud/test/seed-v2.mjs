// Seeds the LOCAL D1 with a mocked Yasno schedule and Solcast forecast (no network, no real Solcast calls).
// Run after `wrangler dev` + test/seed-local.mjs:  node test/seed-v2.mjs [scenario]
// scenario: "outage" (default: an outage now, another tonight), "calm" (no outages), "emergency".
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scenario = process.argv[2] ?? "outage";
const now = Date.now();
const kyivDate = (ts) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(ts);
const kyivMin = (ts) => {
  const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ts).split(":").map(Number);
  return h * 60 + m;
};
const today = kyivDate(now), tomorrow = kyivDate(now + 86400e3);
const nowMin = kyivMin(now);
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

let homeToday, homeTomorrow, nbToday;
if (scenario === "calm") {
  homeToday = { status: "ScheduleApplies", slots: [] };
  homeTomorrow = { status: "ScheduleApplies", slots: [] };
  nbToday = { status: "ScheduleApplies", slots: [] };
} else if (scenario === "emergency") {
  homeToday = { status: "EmergencyShutdowns", slots: [] };
  homeTomorrow = { status: "WaitingForSchedule", slots: [] };
  nbToday = { status: "EmergencyShutdowns", slots: [] };
} else {
  const a = Math.max(0, Math.floor(nowMin / 30) * 30 - 60), b = Math.min(1440, a + 240);
  const c = Math.min(1410, b + 300), d = Math.min(1440, c + 240);
  homeToday = { status: "ScheduleApplies", slots: [[a, b], ...(c < d ? [[c, d]] : [])] };
  homeTomorrow = { status: "ScheduleApplies", slots: [[360, 600], [1080, 1320]] };
  nbToday = { status: "ScheduleApplies", slots: [[Math.max(0, a - 120), Math.max(60, a + 120)], [1140, 1380]] };
}

const sql = [];
const cfg = (k, v) => sql.push(`INSERT INTO config (key, value, updated_at) VALUES (${q(k)}, ${q(JSON.stringify(v))}, ${now}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`);
cfg("addr_home", { street: "вул. Тестова", house: "1", group: "30.1", checked_at: now });
cfg("addr_neighbour", { street: "вул. Сусідня", house: "2-А", group: "26.1", checked_at: now });
cfg("yasno_status", { ok_at: now });
cfg("solcast_status", { ok_at: now - 40 * 60e3 });
cfg("solcast_budget", { utc_date: new Date(now).toISOString().slice(0, 10), calls: 3, last_call: now - 40 * 60e3 });
cfg("phase_names", { a: "Кухня", b: "Другий поверх", c: "Майстерня" });
sql.push("DELETE FROM outage_days;");
const day = (role, date, grp, d) => sql.push(`INSERT INTO outage_days (role, date, grp, status, slots, updated_on, fetched_at) VALUES (${q(role)}, ${q(date)}, ${q(grp)}, ${q(d.status)}, ${q(JSON.stringify(d.slots))}, ${q(new Date(now - 3600e3).toISOString())}, ${now});`);
day("home", today, "30.1", homeToday);
day("home", tomorrow, "30.1", homeTomorrow);
day("neighbour", today, "26.1", nbToday);
day("neighbour", tomorrow, "26.1", { status: "WaitingForSchedule", slots: [] });
sql.push(`INSERT INTO outage_changes (ts, role, date, before, after) VALUES (${now - 2 * 3600e3}, 'home', ${q(today)}, ${q(JSON.stringify({ status: "ScheduleApplies", slots: [[480, 720]] }))}, ${q(JSON.stringify(homeToday))});`);

// Forecast: a November-like day (peak ~2.5 kW at noon Kyiv) for 3 days, from 2 days back.
sql.push("DELETE FROM pv_forecast; DELETE FROM pv_forecast_first;");
const start = Math.floor((now - 2 * 86400e3) / 1800e3) * 1800e3;
for (let pe = start + 1800e3; pe <= now + 3 * 86400e3; pe += 1800e3) {
  const m = kyivMin(pe - 900e3) / 60;
  const sun = Math.max(0, Math.sin(((m - 7.3) / 8.9) * Math.PI));
  const dayN = Math.floor((pe - start) / 86400e3);
  const p50 = +(sun * [2.6, 1.2, 2.2, 3.0, 0.8][dayN % 5]).toFixed(3);
  const row = `${pe}, ${p50}, ${(p50 * 0.4).toFixed(3)}, ${(p50 * 1.4).toFixed(3)}, ${now - 40 * 60e3}`;
  sql.push(`INSERT INTO pv_forecast (period_end, p50, p10, p90, fetched_at) VALUES (${row});`);
  if (pe < now + 86400e3) sql.push(`INSERT OR IGNORE INTO pv_forecast_first (period_end, p50, p10, p90, fetched_at) VALUES (${pe}, ${(p50 * 1.1).toFixed(3)}, ${(p50 * 0.5).toFixed(3)}, ${(p50 * 1.5).toFixed(3)}, ${now - 6 * 3600e3});`);
}

const dir = mkdtempSync(join(tmpdir(), "seed-"));
const file = join(dir, "seed.sql");
writeFileSync(file, sql.join("\n"));
execFileSync("npx", ["wrangler", "d1", "execute", "deye", "--local", "--file", file], { stdio: ["ignore", "ignore", "inherit"] });
console.log(`seeded scenario=${scenario}: home today ${JSON.stringify(homeToday)}`);
