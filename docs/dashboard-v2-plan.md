# Dashboard v2: plan

Agreed with the user on 2026-11-13. This is the brief for the agent that builds it.
Read `CLAUDE.md` first: its hard constraints still apply. This work is **cloud only**
(`cloud/`). Nothing changes on the Pi, and no card visit is needed.

## Goal

Turn the current single-page dashboard into an app-like PWA for 2–3 people in one house.
The most important information shows fast, in big numbers and one plain sentence.
Details, history and filters exist for those who look for them.

- The UI stays in **Ukrainian**.
- Most users have iPhones and will add the app to the Home Screen. Android must work too.
- The app is **read-only**: it advises, it cannot control the inverter.

## The house (facts for the calculations)

| Fact | Value |
|---|---|
| Inverter | Deye SUN-10K-SG04LP3-EU, 3-phase, read every 30 s |
| Solar panels | about 11 kW; orientation unknown (the user set it approximately in Solcast) |
| Battery | 20 kWh nominal, shared by all 3 phases |
| Battery floor | the Deye shuts down at about 15% → about 17 kWh usable |
| Grid export | **disabled** |
| Phases | 3, each used by different people in a different part of the house |
| Grid operator | DTEK Kyiv Grids, for both addresses (Yasno region 25, DSO 902) |
| Timezone | Europe/Kyiv |

What one day of real data showed (2026-11-12):

- Load averages 0.6–1.3 kW. One phase (`load_c`) takes 60–75% of it.
- A 4-hour outage took the battery from 99% to 81%.
- Charging from the grid runs at about 3 kW.
- PV peaked at 1.2 kW, but the battery was at 98–100% all day.

**PV throttling.** With export disabled, the inverter throttles the panels when the battery
is full and the load is small. Measured `pv_w` then shows what was *used*, not what the
panels *could* give. Treat a sample as throttled when `soc >= 98` and the battery is not
charging. Leave throttled samples out of any forecast-vs-actual comparison.

## What exists now

- `cloud/src/index.ts`: one Worker. `POST /api/ingest` (bearer key), and `GET /api/now`,
  `/api/series`, `/api/outages`, `/api/health` behind Cloudflare Access. The Worker
  verifies the Access JWT itself (`auth.ts`) and gets the user's **email** from it.
- D1 tables: `samples` (decoded, every 30 s, kept forever), `raw_samples` (7 days),
  `grid_events` (grid off/on transitions, written at ingest), `heartbeats`.
- `cloud/web/`: a no-build vanilla JS page (`app.js`, about 350 lines), a manifest and a
  minimal service worker.
- An hourly cron purges old raw rows.
- Deploy and local dev: see `CLAUDE.md`.

## Decisions

### 1. One projection engine drives the main screen

Simulate the battery charge for the next 48 hours in 30-minute steps. Run it in the Worker,
as a pure function with unit tests.

Inputs:

- **Battery**: current `soc`; usable energy = capacity × (soc − 15%). Start with 20 kWh.
  Later calibrate the capacity from real data (kWh discharged per 1% of `soc`).
- **Load**: the typical load for each hour of the day, from history (median of the same
  hour over the last 2–4 weeks; fall back to all available days while history is short).
  Blend it with the real last hour for the first steps.
- **Sun**: the Solcast forecast. Use the pessimistic value (`pv_estimate10`) for warnings
  and the middle value (`pv_estimate`) for the displayed curve.
- **Grid**: the Yasno schedule of the main address. When the grid is on, the battery
  charges at up to about 3 kW (measure the real rate from history).

Outputs:

- the projected `soc` curve, in a middle and a pessimistic version;
- the time the battery reaches 15%, if it does;
- the time it reaches 100%, if it does;
- the `soc` at the start and the end of each scheduled outage;
- how many watts to cut to last until the grid returns, when it would not last;
- a **confidence** flag: `schedule` (Yasno schedule known), `history` (no schedule, the
  typical outage length from `grid_events` is used) or `none`.

The headline sentence on the main screen comes from these outputs. Examples (write the
final texts in Ukrainian):

- "Enough until the grid returns at 18:00. 62% will remain."
- "The battery runs out around 03:40, 2 hours before the grid returns. Cut 300 W to make it."
- "Will charge to 100% before the next outage at 20:30."
- "No schedule from Yasno. At the current load the battery lasts about 14 hours."
- "Today the sun covers about 15% of the need." / "Today the sun covers everything."

### 2. Seasons: no calendar switch, the forecast decides

The user expects that in December the sun gives less than the house needs. So there is no
"summer mode" by date. Each day the app compares the forecast sun energy with the expected
need and picks the headline by priority:

1. **Outage now or scheduled within 48 h** (or Yasno reports emergency shutdowns, or the
   grid dropped in the last 7 days): the headline is about lasting through the outage and
   recharging between outages.
2. **No outages, the sun covers the need**: "today you can live without the grid", with the
   forecast and need in kWh.
3. **No outages, the sun does not cover the need**: the share of the need the sun covers
   and how much comes from the grid.

A manual override in settings is not needed in the first version.

### 3. Phases: everyone sees everything

- Every user sees all three phases. The **main number is the total**; the three phases
  show next to it as smaller values or bars.
- A per-user setting can narrow the view to one phase. Then that phase is the main number
  and the total becomes secondary.
- The battery is shared, so battery numbers are never split by phase.
- Phase names are editable in settings (shared by all users), so they read as people or
  rooms, not "A/B/C".

### 4. Yasno outage schedule, two addresses

Source: the public Yasno API (the same one `ALERTua/ha-svitlo-yeah` uses).

- Schedule for all groups in one request:
  `GET https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages`
  The answer is an object keyed by group (`"12.1"`). Each group has `today` and `tomorrow`
  with `date`, `status` and `slots` (`start` and `end` in minutes from midnight, `type`
  `Definite` or `NotPlanned`), plus `updatedOn`.
- Day `status`: `ScheduleApplies` (slots are valid), `WaitingForSchedule` (not published
  yet), `EmergencyShutdowns` (schedules do not apply; outages are unpredictable).
- Address → group: base
  `https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2/`, then
  `streets?regionId=25&dsoId=902&query=…` (3 or more letters),
  `houses?regionId=25&dsoId=902&streetId=…&query=…`,
  `group?regionId=25&dsoId=902&streetId=…&houseId=…` → `{group, subgroup}`.
- Yasno changes its IDs every few days. Store the street and house **names**, resolve them
  again once a day, and accept a changed group only after two matching checks at least an
  hour apart.

How to use it:

- A cron every 15 minutes fetches the schedule and stores the two groups' days. One
  request covers both addresses.
- If Yasno does not answer, keep the last stored schedule and show its age. If the status
  is `EmergencyShutdowns` or the schedule is missing, say so plainly and let the projection
  fall back to history (`confidence = history`).
- The real grid state always comes from the inverter (`grid_on`), not from Yasno. Show it
  when reality and the schedule disagree.
- Record each schedule change (the slots before and after), so the app can notify about it.

The two addresses are personal data. Do not commit them. Keep them in D1 (`config`), set
through the settings page or a one-off `wrangler d1 execute`.

### 5. The neighbour's generator: secondary, and optional

The house next door has an industrial generator. It starts automatically when their
address has no grid, but only between 07:00 and 22:00. So:

`loud hours = the neighbour's outage slots ∩ 07:00–22:00`

- This is **less visible** than the main address everywhere. On the main screen it is one
  small muted line ("generator next door: 14:30–18:00"), shown only when there are loud
  hours today or tomorrow. On the plan page it is a thin lane under the main schedule.
- Each user can **turn it off** in settings. Off hides the line, the lane and the
  generator notification. The default is on.
- For the neighbour there is only the schedule. If both addresses are in the same group,
  the house's own `grid_on` is also the live signal.

### 6. Solcast solar forecast

- The free plan allows **10 requests per UTC day** and 2 rooftop sites. The API key is in
  `cloud/.env.local` as `SOLCAST_API_KEY`; add it as a Worker secret. Never commit it.
- Endpoint: `GET https://api.solcast.com.au/rooftop_sites/{resource_id}/forecasts?format=json`
  with `Authorization: Bearer <key>`. It returns 30-minute periods with `pv_estimate`,
  `pv_estimate10`, `pv_estimate90` (kW) and `period_end`. Find the resource id in the
  user's Solcast account (ask the user, or list the sites; check in the docs whether
  listing costs quota).
- Budget: about 8 forecast calls a day, placed from before sunrise to mid-afternoon Kyiv
  time, none at night. Keep 2 in reserve. If the user has two sites, each call counts per
  site, so halve the schedule. Count the calls of the day in D1 and never go over.
- Store every forecast period (upsert by `period_end`), and keep the value that was
  forecast at the start of each day, to compare with reality later.
- Do not spend calls on `estimated_actuals`. Compare the forecast with the house's own
  `pv_w` instead, on non-throttled samples only. If the forecast is off by a steady factor,
  apply a correction factor in the projection.
- If Solcast fails or the quota is used up, keep the last forecast and show its age.

### 7. Energy totals in the cloud

The pusher sends power, not energy counters. Compute energy in the cloud from the 30 s
samples (power × time between samples; skip gaps longer than 5 minutes).

- Add an hourly rollup table: kWh for the total load, each phase, PV, battery charge,
  battery discharge and grid import, plus min/max `soc` and minutes without grid.
- Fill it from the cron and backfill from `samples` once.
- "Total for the last hour" on the main screen is the sum over the last 60 minutes of raw
  samples, not the last closed clock hour.
- History pages read the rollups, so week and month views stay fast.

### 8. Screens

A bottom tab bar with four tabs, most important first. Each tab is its own JS module.

**1. Зараз (Now)**

- The headline sentence from the projection engine.
- Battery: `soc` in the biggest type, with charge or discharge power and the time to
  empty or full.
- Load: the total now, **the total for the last hour (kWh)**, and the three phases.
- Sun: power now, energy today so far and the forecast for the rest of the day.
- Grid: on or off and since when; the next scheduled outage or return.
- The small generator line (see 5).
- Data freshness, visible when the data is stale.

**2. План (Plan)**

One 48-hour timeline with a shared time axis:

- the outage schedule of the main address;
- the thin neighbour and generator lane;
- the solar forecast with its pessimistic–optimistic band;
- the projected battery curve, with the 15% floor marked;
- the expected load.

Below it, the same in words: a short list of what happens when.

**3. Історія (History)**

- Day, week, month charts (the current ones, moved here), with a date picker.
- kWh per phase and in total, per day.
- Share of the load covered by the sun and the battery (self-sufficiency), and grid import.
- The outage log: real outages from `grid_events` next to what Yasno had scheduled.
- Solar forecast vs actual.
- A daily summary card.

**4. Система (System)**

- Settings (see 9) and notification toggles (see 10).
- Health: last sample, pusher heartbeat, Yasno and Solcast freshness, Solcast calls used.
- Grid voltages and frequency.

### 9. Per-user settings

Stored in D1, keyed by the Access email, so they follow the user across devices.

- phases: all (default) or one chosen phase;
- neighbour and generator: shown (default) or hidden;
- notifications: one toggle per type (see 10), plus quiet hours.

Shared settings (any user may edit): phase names, the two addresses, battery capacity and
floor.

`/api/*` currently accepts only GET. Add the write endpoints for settings and push
subscriptions behind the same Access check.

### 10. Push notifications

Standard Web Push with VAPID keys, sent from the Worker. No app store is involved.

- **iPhone**: works only after the app is added to the Home Screen (iOS 16.4 or later),
  and the permission must be asked from a button tap. Show a short "add to Home Screen"
  hint in Safari when the app is not installed. **Android**: works in Chrome directly.
- A device subscribes from the System tab. Store each subscription with the user's email.
  Delete a subscription when the push service answers 404 or 410.
- Each user turns each type on or off:

| Type | Trigger | Default |
|---|---|---|
| Grid off / grid on | the transition seen at ingest | on |
| Battery will not last | the projection shows 15% before the grid returns | on |
| Low battery | `soc` under a threshold (default 30%) while the grid is off | on |
| Schedule changed | the main address's slots changed, or emergency shutdowns began | on |
| Outage soon | 30 minutes before a scheduled outage | off |
| Generator soon | 15 minutes before loud hours; only if the neighbour is shown | off |
| Data stale | no samples for 15 minutes | off |

- Send each event once: keep a log of sent notifications with a deduplication key.
- Respect quiet hours, except for "battery will not last".
- **Ingest must never fail or slow down because of push.** Send from `ctx.waitUntil` and
  swallow every error. The Pi must always get its normal answer.
- VAPID keys are Worker secrets. Use Web Crypto or a small Workers-compatible library;
  the `web-push` npm package needs Node APIs.
- The service worker gets `push` and `notificationclick` handlers. Keep its rule that
  navigations and `/api` are not intercepted, so the Access login keeps working.

### 11. Graphics

The user wants graphics next to the numbers, not only text. All in inline SVG, no chart
library, working in light and dark themes:

- **Energy flow** on the Now tab: sun, grid, battery and house as four nodes, with animated
  lines whose direction and thickness follow the live power. Respect
  `prefers-reduced-motion`.
- **Battery ring or bar**: the `soc`, the 15% floor as a marked zone, and a ghost marker
  for where the projection ends.
- **Phase bars**: three bars for the three phases next to the total.
- **Day strip**: a thin 24-hour bar under the headline: outage slots, now-marker, sunrise
  and sunset.
- **Plan timeline** (see 8): the main graphic of the second tab.

The numbers stay readable without the graphics, and every graphic has a text equivalent.

### 12. Frontend and platform

- Keep it no-build: vanilla ES modules, one per tab, plus shared modules for the API,
  formatting and SVG charts. Move to a framework only if this starts to hurt.
- App feel: `display: standalone`, a bottom tab bar with safe-area insets, no page reload
  between tabs, the last data shown at once from memory while fresh data loads.
- Auto-refresh the Now tab every 30 s, and when the app returns to the foreground.
- Ask the user to set the Cloudflare Access session to about a month, so the installed
  app does not bounce to the login page often.
- New crons: every 15 minutes (Yasno, rollups, notification checks, Solcast when a call
  is due). The existing hourly purge stays.

## New data (D1 migration `0002`)

Names are suggestions; keep the meaning.

| Table | Holds |
|---|---|
| `hourly` | energy rollups per hour (see 7) |
| `pv_forecast` | Solcast periods: `period_end`, three estimates, `fetched_at`; plus the day-start snapshot |
| `outage_days` | per address role (`home`, `neighbour`) and date: status, slots, `updated_on`, `fetched_at` |
| `outage_changes` | the log of schedule changes |
| `config` | shared settings: addresses, groups, phase names, battery capacity, Solcast call counter |
| `user_settings` | per email: JSON of the settings in 9 |
| `push_subscriptions` | per device: email, endpoint, keys, created, last success |
| `notifications_sent` | deduplication key, type, time |

## Build order

Each step is deployable alone and leaves the app working.

1. **Shell and energy.** Tab bar, the four modules, hourly rollups with backfill, the
   last-hour total, all three phases with the total as the main number, per-user settings
   storage with the phase choice.
2. **Yasno.** The 15-minute fetch, both addresses, the stored schedule, the next outage on
   the Now tab, the outage lanes on the Plan tab, the generator line and its setting.
3. **Solcast.** The call budget, the stored forecast, sun today and the rest of the day on
   the Now tab, the forecast on the Plan tab.
4. **Projection.** The engine with tests, the headline sentence, the projected battery
   curve on the Plan tab, the confidence states.
5. **Graphics.** The energy flow, the battery ring, the day strip.
6. **Push.** Subscriptions, the per-type toggles, the triggers.
7. **History extras.** Self-sufficiency, forecast vs actual, the outage log against the
   schedule, daily summaries.

## Testing

- Unit tests (the project already uses a test runner for `decode.ts`): the projection
  engine, the energy integration, the Yasno parser (all three statuses, a missing group,
  a bad answer), the loud-hours intersection, the Solcast call budget.
- Local: `wrangler dev` with `cloud/test/seed-local.mjs`; extend the seed with a schedule
  and a forecast. Mock Yasno and Solcast locally; do not spend Solcast calls on tests.
- Check on a real iPhone (installed to the Home Screen) and on Android Chrome: tab bar,
  safe areas, push permission, a received notification, the Access login after expiry.

## Open points

- The Solcast site setup is approximate (the user cannot see the panels). The first
  comparison with real data looked right. Re-check after a week of non-throttled data.
- The real charge rate from the grid and the real usable battery capacity: measure both
  from history instead of trusting 3 kW and 20 kWh.
- Whether the PV registers and the per-phase load are decoded right is still being
  verified (see the status list in `CLAUDE.md`). The engine depends on them.
- With few days of history, the load profile is weak. Show the projection anyway and
  improve as data arrives.
