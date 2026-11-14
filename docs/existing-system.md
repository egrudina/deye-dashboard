# Existing system (as found on 2026-11-06)

> **Author's own setup.** This page is about one specific install: the pusher runs inside an existing Telegram bot's
> process on an Orange Pi with no SSH access. For a normal install (standalone pusher) see the README.

## Physical setup and network

```
Deye inverter ── Solarman Wi-Fi logger stick ──Wi-Fi──▶ home router (MikroTik, 192.168.88.0/24) ◀──Ethernet── Orange Pi
                                                               │
                                                            Internet
```

- The Orange Pi One has **no Wi-Fi**. It uses Ethernet DHCP only (netplan `10-dhcp-all-interfaces.yaml`, systemd-networkd).
- It talks to the logger stick at `INVERTER_IP` (192.168.88.x) on TCP port 8899 (Solarman V5 protocol).
- There's no public IP and no tunnel or VPN. All traffic is outbound (Telegram long polling).

### Power situation (important)

- An **automatic transfer switch (ATS)** feeds the **whole house** from the grid or from the inverter output.
- When the grid fails, the house is **without power for 1–3 s** during the switch. The Pi (on a normal
  socket) and probably the router **reboot on every grid loss**. Switching back is usually seamless.
- Consequences:
  - Each outage starts with a **data gap** of roughly 1–2 minutes (Pi boot + router/internet back).
  - **The Orange Pi One has no RTC.** After a reboot the system clock is wrong until NTP syncs,
    and the internet is down during boot. **Don't trust the Pi's absolute timestamps** (see architecture.md).
  - His bot probably **misses most "switched to battery" announcements**: after a reboot the
    `Looper` starts with the current state (battery), so it sees no change. The group gets "A am alive!"
    in the debug chat instead.
  - At boot, `Inverter.__init__` reads the inverter synchronously. If the router or logger isn't up yet, it
    raises → the service crash-loops → `StartLimitAction=reboot` may reboot the Pi until the network is up.
    That's existing behavior. Don't make it worse.
  - Frequent hard power cuts risk SD card corruption. The `orangepi.dmg` backup exists.

## The Orange Pi (from the SD card image)

- Board: Orange Pi One (sun8i, ARMv7, 512 MB RAM). OS: **Armbian 24.8.1 bookworm** (Debian 12). Hostname `orangepione`.
- **Python 3.11** (system), venv at `/home/deye/deye_telegram_bot/.venv` with his `requirements.txt`
  (aiogram 3.12, aiohttp 3.10.5, pysolarmanv5 3.0.4, python-dotenv 1.0.1, babel …).
- Users: `root` and `deye` (uid/gid 1000), both with passwords (unknown to us). No `authorized_keys` anywhere.
- sshd: `PermitRootLogin yes`, password auth on. Reachable only from the LAN.
- Enabled units: `deye_bot.service` + stock ones (ssh, cron, rsyslog, networkd, wpa_supplicant (unused)).
  No custom cron jobs or timers. No auto-deploy: he updated the code by hand with `git pull` + restart.
- Logs: Armbian ramlog. `/var/log` on disk is mostly empty or old.
- The card holds the bot author's credentials (bot token, a GitHub token). Never copy them anywhere.

### systemd unit `/etc/systemd/system/deye_bot.service` (a copy of the repo file)

```
[Unit]
Wants=network-online.target
After=network.target network-online.target
StartLimitIntervalSec=5
[Service]
Type=simple
Restart=always
RestartSec=1
StartLimitAction=reboot
User=deye
ExecStart=/home/deye/deye_telegram_bot/run.sh
StandardOutput=console
KillSignal=SIGKILL
```

- `StartLimitIntervalSec=5` + the default `StartLimitBurst=5` + `RestartSec=1` → a fast crash loop **reboots the Pi**.
- There's no `WorkingDirectory`, so the cwd is `/`. `KillSignal=SIGKILL` means no graceful shutdown.
- `run.sh`: `source /home/deye/deye_telegram_bot/.venv/bin/activate; python -u /home/deye/deye_telegram_bot/start.py`

## His bot (repo `~/git-personal2/deye_telegram_bot`, about 460 lines)

- `start.py`: `dotenv_values()` (loads `.env`) → `Inverter(ip, serial)` → `DeyeBot(token, group_id, debug_id, inverter)`
  → `Looper(...)` → `asyncio.gather(loop.start(), bot.start())`.
- `inverter.py`: `class Inverter(PySolarmanV5)` with `auto_reconnect=True` and the default `socket_timeout=60`.
  - The constructor does blocking reads (will raise if the logger is unreachable).
  - `__get_without_errors()` wraps reads: on `queue.Empty` → disconnect + `_reconnect()`. On `V5FrameError`/`NoSocketAvailableError` →
    reconnect + `error_count += 1` + `last_error = e`.
  - It does **not** override `read_holding_registers`, so `inverter.read_holding_registers(...)` is the plain
    library method (no counting). The pusher uses that.
- `looper.py`: every `LOOP_TIMEOUT` (= 5 s) it runs `update_state()` (reg 607). On a grid change → message to the group.
  On battery: reads reg 590 (the high-usage warning is commented out on this branch) and 650–653 (critical-load alert).
  If `error_count` grew during the task → it sends a traceback to the debug chat.
  `start()` sends "A am alive!" to the debug chat on each start.
- `deye_bot.py`: aiogram 3 long polling. Buttons: Status, Battery, Consumption. Hidden commands: `bans`, `errors`,
  `last_error`, `greetings`. Access = members of `GROUP_ID`.
- **Concurrency:** single thread, single asyncio loop. pysolarmanv5 calls are **blocking** (they wait on a queue fed by a
  reader thread), so inverter requests are serialized, but a hung logger freezes the whole process for up to 60 s.

### Known bugs in his code (don't fix, just be aware)

- `battery_power()` stores into `last_battery_level` (so the SOC fallback can show watts after an error).
- `battery_load()` stores into `last_input_power` (the two values overwrite each other).
- `human_timedelta()` crashes if `last_state_update is None`. `Looper.__check_state` doesn't guard against it.

### `.env` keys (values are secret, never copy them)

`BOT_TOKEN, GROUP_ID, DEBUG_ID, INVERTER_IP, INVERTER_SERIAL, LOOP_TIMEOUT(=5), POWER_WARNING, WARNING_PERIOD,
WARNING_THRESHOLD, POWER_CRITICAL`

## Registers known to work (used by his code)

| Reg | Meaning | Notes |
|---|---|---|
| 588 | Battery SOC % | |
| 590 | Battery power W | signed int16, the sign gives charge/discharge |
| 607 | Grid power | `> 0` = grid present (that's how he detects outages) |
| 619 | "input power" | used when on grid |
| 650–652 | Load phase A/B/C W | |
| 653 | Load total W | |

Inverter model: **SUN-10K-SG04LP3-EU** (3-phase, 48 V LV battery, 10 kW, 2 MPPT: 26 A + 13 A PV input).
Other registers in 588–675 (PV power, voltages, etc.) are **unverified**. Use the Deye 3-phase LV hybrid map
(the `deye_p3.yaml` definitions in the ha-solarman project, which covers SG04LP3) and check against real data
after deployment. With 2 MPPTs, only PV1/PV2 power (672/673) should be non-zero; PV3/PV4 (674/675) should read 0.
