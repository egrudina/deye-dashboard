# Architecture

```
Orange Pi (one python process, run by deye_bot.service)
 ├─ DeyeBot   (his, unchanged)  ─┐
 ├─ Looper    (his, unchanged)  ─┼── share ONE Inverter object = one TCP connection to the logger stick
 └─ Pusher    (ours)            ─┘
        │ every 30 s: read regs 588–675 in one request → bounded queue
        │ sender task: POST batches over HTTPS (aiohttp)
        ▼
Cloudflare Worker  ── /api/ingest (bearer PUSH_KEY) ──▶ D1
                   ── /api/* read endpoints        ◀── web app (static files served by the same Worker)
                   (UI + read API behind Cloudflare Access)
```

## Pi side: `pi/pusher/` → `/home/deye/deye_telegram_bot/pusher/`

| File | Purpose | Owner, mode on the Pi |
|---|---|---|
| `push_start.py` | Entry point. Adds the parent dir to `sys.path`, loads `../.env` and `push.env` **by explicit path**, builds `Inverter`, `DeyeBot`, `Looper` like his `start.py`, and adds `Pusher` | deye, 644 |
| `pusher.py` | Reader loop + sender loop + heartbeat | deye, 644 |
| `run_push.sh` | Activates `../.venv`, runs `push_start.py`; if that fails → `exec` his `start.py` | deye, 755 |
| `push.env` | `PUSH_URL`, `PUSH_KEY`, `PUSH_INTERVAL=30` (secret, not in git; commit `push.env.example`) | deye, 600 |
| `override.conf` | Reference copy of the systemd drop-in | – |

systemd drop-in `/etc/systemd/system/deye_bot.service.d/override.conf` (root, 644):

```
[Service]
ExecStart=
ExecStart=/home/deye/deye_telegram_bot/pusher/run_push.sh
```

### Safety rules (the bot has priority)

- Importing and constructing the pusher in `push_start.py` happens inside try/except. If anything fails, **run the bot without the pusher**.
- Every pusher loop iteration catches `Exception` (but not `CancelledError`). Errors go to the heartbeat and the stdout log, **never Telegram**.
- Bounded queue (e.g. max 2,880 samples = 24 h). When full, drop the oldest and count the drops.
- aiohttp: short timeouts (connect 5 s, total 15 s), exponential backoff on failure, batches of up to ~100 samples.
- The pusher only reads with `inverter.read_holding_registers(588, 88)` (the base library method), so it never touches his
  `error_count`/`last_error`. Otherwise the Looper could report pusher errors to the debug chat.
  On `queue.Empty` (timeout), mirror his recovery (`disconnect()` + `_reconnect()`) inside try/except. That way a late
  response can't be mistaken for the reply to his next request. No counters are touched. *(Decide finally when implementing,
  and test it with the fake inverter.)*
- `run_push.sh` fallback: if `push_start.py` exits non-zero → `exec python -u ../start.py`. Note: at boot, when the network is
  down, both fail (like his code today). The service then restarts as usual. Don't add sleeps that change his restart behavior.
- One extra request every 30 s, compared with his 2–3 every 5 s. A hung logger (60 s timeout) freezes the whole process, whoever
  sent the request. That's an accepted, existing risk.
- Python 3.11 + only the libraries already in his venv (aiohttp, python-dotenv, pysolarmanv5). **No new pip installs on the Pi.**

### Timestamps: don't trust the Pi clock

The Pi has no RTC and reboots on every outage, so its clock can be wrong after boot.
- For each sample, record `time.monotonic()`. When sending, set `age_ms = monotonic_now - sample_mono`.
- The Worker computes `ts = request_received_at - age_ms`. Also send the Pi wall clock for debugging.
- Monotonic time resets on reboot, but the queue is in memory and is lost on reboot anyway, so this is consistent.

### Payload contract v1 (`POST /api/ingest`, `Authorization: Bearer <PUSH_KEY>`)

```json
{
  "v": 1,
  "pi_wall_ms": 1762460000000,
  "samples": [ { "age_ms": 31000, "start": 588, "regs": [ /* 88 uint16 */ ] } ],
  "heartbeat": {
    "pusher_version": "0.1.0",
    "boot_age_s": 4200,          // from /proc/uptime → reveals reboots (= outages)
    "process_age_s": 4150,
    "queue_len": 0, "dropped": 0,
    "last_read_ok_age_s": 12, "read_errors": 0, "send_errors": 0,
    "last_error": "..."          // short string, may be null
  }
}
```

Raw registers are decoded **in the Worker**, so mapping fixes never need a card swap.

## Cloud side: `cloud/`

- One Worker (TypeScript) with static assets (`cloud/web/`) + D1 binding. Wrangler config `cloud/wrangler.jsonc`.
- D1 tables (draft):
  - `samples(ts INTEGER PK, grid_on, soc, batt_w, load_a, load_b, load_c, load_total, pv_w, …)`: decoded, kept forever.
    At 30 s that's about 1.05 M rows/year at ~100 B, so ~100 MB/year. The D1 free plan limit is 500 MB per DB, so roll up later if needed.
  - `raw_samples(ts, regs TEXT)`: keep **7 days only** (for re-decoding after mapping fixes). Purge from a cron trigger.
  - `heartbeats(received_at, json)`: keep the latest + 7 days.
  - Outages are **derived** from `grid_on` transitions and data gaps. A gap followed by `grid_on=0` + a small `boot_age_s` =
    an outage that started during the gap (last known grid-on sample → upper bound).
- Read API: `/api/now`, `/api/series?from&to&step`, `/api/outages?from&to`, `/api/health`.
- Web app: a simple PWA (installable on the phone). Current state (grid/battery, SOC, load per phase, PV), charts
  (day/week/month), outage list with durations, health panel (last data age, heartbeat, reboots). UI language: Ukrainian
  (like the bot); confirm with the user.

### Auth (open question: does the user have a domain on the CF account?)

- **With a custom domain:** one Worker on `deye.<domain>`. Access application on the hostname with a **Bypass** policy for
  `/api/ingest` (protected by `PUSH_KEY` instead).
- **workers.dev only:** Access on workers.dev protects the whole Worker. Use **two Workers sharing one D1**:
  `deye-ingest` (no Access, key only) and `deye-app` (UI + read API, Access on).

## Testing plan (before touching the Pi)

The user's Mac can't reach the inverter. Run locally with Python 3.11 + his `requirements.txt`:
- `tools/`: a fake inverter. The simplest option is to monkeypatch `pysolarmanv5.PySolarmanV5.__init__` / `read_holding_registers`
  before importing his `inverter.py`. Fake values: grid on/off scenarios, plus `queue.Empty`, `V5FrameError`,
  `NoSocketAvailableError` and slow (blocking) reads.
- A local runner that starts `push_start.py` against his repo clone + the fake inverter + **the user's own test bot and test group**
  (local `.env`, gitignored).
- Check that the bot buttons answer and the Looper group messages still work while the pusher runs.
- Failure cases: cloud down / wrong URL / 401 / slow cloud; `push.env` missing or broken; exception inside the pusher;
  syntax error in `push_start.py` → `run_push.sh` falls back to `start.py`; queue overflow; long fake-inverter hang.
- Cloud: `wrangler dev` locally with a local D1, then deploy, then the local runner pushes fake data to the real Worker.
