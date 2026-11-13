# Dashboard v2: build log

Built overnight on 2026-11-13, branch `dashboard-v2`, from `docs/dashboard-v2-plan.md`.
Deployed to https://deye.grudina.info after each step. Ingest code is unchanged (moved to `src/ingest.ts`;
it now also reports grid transitions to the push code, which runs in `ctx.waitUntil` and swallows errors).

## Status

| Step | State |
|---|---|
| 1. Shell and energy | done: tabs, hourly rollups (self-backfilling, ≤ 3 days per cron run), last-hour total, phases, per-user settings |
| 2. Yasno | done: 15-min fetch, both addresses (resolved by name; a changed group needs two checks ≥ 1 h apart), schedule on Now/Plan, generator line and setting |
| 3. Solcast | done: 8 calls/day plan (05:00–16:00 Kyiv), counted in D1 before each call, day-start snapshot, correction factor on non-throttled data |
| 4. Projection | done: 48 h engine + tests, headline, plan curves, confidence `schedule`/`history`/`none` |
| 5. Graphics | done: energy flow, battery ring with floor and ghost marker, day strip, phase bars, 48 h timeline |
| 6. Push | done: VAPID + aes128gcm in Web Crypto, 7 types, quiet hours, dedup per user |
| 7. History extras | done: self-sufficiency, forecast vs actual (throttled marked), outage log vs schedule, schedule changes, daily summary |

## Where things are

- `cloud/src/`: `index.ts` (routes, cron dispatch), `ingest.ts`, `jobs.ts` (rollup, Yasno, Solcast, calibration),
  `summary.ts` (data for Now/Plan), `projection.ts`, `headline.ts`, `energy.ts`, `yasno.ts`, `solcast.ts`,
  `settings.ts`, `notify.ts`, `webpush.ts`, `time.ts`.
- `cloud/web/js/`: `main.js` (tabs), `api.js`, `fmt.js`, `dom.js`, `svg.js` (charts), `graphics.js`, `push.js`, `tabs/*.js`.
- Tests: `npm test` (unit), `node test/seed-local.mjs` + `node test/seed-v2.mjs [outage|calm|emergency]` against `wrangler dev`.
  Local Solcast is mocked by the seed (empty key in `.dev.vars`): no real calls from tests.
- Secrets (Worker): `PUSH_KEY`, `SOLCAST_API_KEY`, `SOLCAST_RESOURCE_ID`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
  Local copies of the keys: `cloud/.env.local` (gitignored). New VAPID keys: `node test/gen-vapid.mjs` (devices must re-subscribe).
- The two addresses are only in D1 `config` (`addr_home`, `addr_neighbour`); change them in the System tab.

## API (all behind Access, except ingest)

GET `/api/now`, `/api/plan`, `/api/me`, `/api/series`, `/api/outages`, `/api/hourly`, `/api/daily?days&end`,
`/api/outage-log`, `/api/forecast-actual?from&to`, `/api/health`.
Writes (JSON only, same origin): PUT `/api/settings`, PUT `/api/shared`, POST `/api/run {job}`,
POST `/api/push/subscribe|unsubscribe|test`.

## Decisions taken without the user (easy to change)

- Grid import = `max(0, grid_total_w)` while the grid is on (matches the load plus ~80 W inverter overhead).
- Projection: grid charges at the measured rate (fallback 3 kW), 40% of that above 95%; battery losses √0.95 each way;
  load = median per Kyiv hour over 28 days, blended with the last hour (e^(−t/1 h)).
- A Yasno schedule older than 6 h is not trusted (falls back to history).
- When the grid is on but the schedule says off, reality wins for that slot.
- "Outage mode" also triggers when the grid dropped in the last 7 days; with a known schedule and no outage in 48 h
  the headline then falls back to the sun sentence.
- Solcast slots: 05:00, 07:00, 08:30, 10:00, 11:30, 13:00, 14:30, 16:00 Kyiv.

## For the user to do

- Cloudflare Access: set the application's session duration to about 1 month (Zero Trust → Access → Applications
  → deye → Session duration), so the installed app does not bounce to the login page.
- iPhone: open the site in Safari → Share → Add to Home Screen → open from the icon → System → enable notifications.
- Set the phase names in System (they are "Фаза A/B/C" now).
- Check on a real iPhone and Android: tab bar, safe areas, push permission, a received notification, login after expiry.

## Open points

- The load profile has ~1 day of history; it improves as data arrives.
- PV factor, charge rate and capacity estimate show in System once there is enough non-throttled data.
