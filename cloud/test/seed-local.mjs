// Posts ~2 days of fake samples to a local `wrangler dev` (one outage with a data gap at its start),
// then checks auth, dedup on resend, and bad-sample handling. Usage: node test/seed-local.mjs [baseUrl] [key]
const base = process.argv[2] ?? "http://localhost:8787";
const key = process.argv[3] ?? "local-test-key";
const STEP = 30_000, START = 588, N = 88;

function regs(t, gridOn) {
  const r = new Array(N).fill(0);
  const set = (reg, v) => (r[reg - START] = v & 0xffff);
  const hour = new Date(t).getHours() + new Date(t).getMinutes() / 60;
  const sun = Math.max(0, Math.sin(((hour - 6) / 13) * Math.PI));
  const load = 600 + 400 * Math.sin(t / 3.6e6) + (hour > 18 && hour < 23 ? 1200 : 0);
  const pv = Math.round(sun * 6500);
  const batt = gridOn ? -Math.min(3000, pv) : Math.round(load - pv);
  const soc = gridOn ? 90 : Math.max(20, 90 - Math.round((t % 1e7) / 2e5));
  set(588, soc); set(590, batt); set(607, gridOn ? Math.max(1, Math.round(load - pv * 0.3)) : 0);
  set(619, gridOn ? 300 : 0); set(625, gridOn ? Math.round(load) : 0);
  for (const reg of [598, 599, 600]) set(reg, gridOn ? 2300 + (reg % 7) : 0);
  set(609, gridOn ? 5000 : 0);
  set(650, load * 0.3); set(651, load * 0.3); set(652, load * 0.4); set(653, load);
  set(672, pv * 0.6); set(673, pv * 0.4);
  return r;
}

async function post(body, auth = `Bearer ${key}`) {
  const res = await fetch(`${base}/api/ingest`, {
    method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const now = Date.now();
const from = now - 2 * 86400e3;
const outStart = now - 20 * 3600e3, outEnd = outStart + 3 * 3600e3;
const gap = [outStart - 10 * 60e3, outStart + 15 * 60e3]; // Pi offline around the outage start
const all = [];
for (let t = from; t <= now; t += STEP) {
  if (t >= gap[0] && t < gap[1]) continue;
  all.push({ t, s: { age_ms: now - t, start: START, regs: regs(t, !(t >= outStart && t < outEnd)) } });
}

// Ages are relative to `now`, so all batches must arrive quickly; that's fine locally.
let inserted = 0;
for (let i = 0; i < all.length; i += 400) {
  const r = await post({ v: 1, pi_wall_ms: Date.now(), samples: all.slice(i, i + 400).map((x) => ({ ...x.s, age_ms: x.s.age_ms + (Date.now() - now) })) });
  if (r.status !== 200) throw new Error(JSON.stringify(r));
  inserted += r.body.inserted;
}
console.log("seeded", inserted, "of", all.length);

const hb = { pusher_version: "0.1.0-test", boot_age_s: 4200, process_age_s: 4150, queue_len: 0, dropped: 0, last_read_ok_age_s: 3, read_errors: 1, send_errors: 0, last_error: null };
const last = all.slice(-3).map((x) => ({ ...x.s, age_ms: x.s.age_ms + (Date.now() - now) + 2000 }));
const checks = {
  wrongKey: (await post({ v: 1, samples: [] }, "Bearer nope")).status,
  noKey: (await post({ v: 1, samples: [] }, "")).status,
  resend: (await post({ v: 1, samples: last, heartbeat: hb })).body,
  badSample: (await post({ v: 1, samples: [{ age_ms: 0, start: 588, regs: [1, 2] }] })).body,
  badVersion: (await post({ v: 2 })).status,
};
console.log(JSON.stringify(checks));
