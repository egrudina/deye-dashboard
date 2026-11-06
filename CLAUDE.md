# deye-dashboard: handover for Claude sessions

Read this first, then `docs/`. Everything here was agreed with the user on 2026-11-06.

## Goal

Add a **web app** (PWA) that shows live and historical data from a Deye inverter.
An Orange Pi already runs a Telegram bot for this inverter.
The pusher **adds** to that setup. It must never break the bot or the group notifications.

## Hard constraints (agreed with the user)

1. **Don't touch the existing bot's tracked files**, on the Pi or in his repo. The bot was
   built by the previous tenant, who still uses it (with the house owner's consent). Don't
   contact him or depend on him.
2. **The bot has priority. Any pusher failure is ignored silently.** No crash, no restart
   loop, no Telegram messages. The user will notice stale data in the web app.
3. **The pusher never sends anything to Telegram** (not the group, not the debug chat).
   His existing "A am alive!" message on every start is OK. The user accepted it.
4. **No SSH access to the Pi.** Deploying means cloning the SD card image to a spare 32 GB card,
   writing files with `debugfs -w` from macOS, and swapping cards. The original card is the rollback.
   So keep the Pi side **minimal and stable**: send raw registers, decode in the cloud.
5. **The user's Mac can't reach the inverter.** Test locally with a **fake inverter** and the user's own
   **test Telegram bot and group** (not his test group). Real inverter = only after the card swap.
6. **Cloudflare is set up manually by the user.** Wrangler on this Mac is logged into a different
   CF account. See `docs/cloudflare-setup.md` for what to ask the user for.
7. Never commit secrets: bot tokens, PUSH_KEY, the GitHub PAT found on the card, the inverter serial.

## Agreed design (details in docs/architecture.md)

- New folder on the Pi: `/home/deye/deye_telegram_bot/pusher/` (untracked inside his git clone;
  `git pull` ignores it). Source lives in this repo at `pi/pusher/`.
- `push_start.py` is a copy of his `start.py` main(). It creates **one** `Inverter` and passes it to
  `DeyeBot`, `Looper` **and** `Pusher`, then `asyncio.gather` on all three.
- Every 30 s the pusher reads registers **588–675 in a single request**, using the base
  `read_holding_registers`, never his error-counting wrapper. It records a sample in a bounded in-memory
  queue. A separate async task POSTs batches over aiohttp.
- systemd **drop-in override** `/etc/systemd/system/deye_bot.service.d/override.conf` points
  `ExecStart` to `pusher/run_push.sh`. If `push_start.py` fails, `run_push.sh` falls back to his `start.py`.
  Removing the override restores his exact setup.
- Cloud: **one Cloudflare Worker** (ingest API + read API + static web app) + **D1** database.
  Web UI protected by Cloudflare Access (email login). Ingest uses a bearer key.
- One repo (this one): `pi/`, `cloud/`, `tools/`.

## Related paths

- His bot (reference only, don't modify): `~/git-personal2/deye_telegram_bot`
  (branch `temporary-disable-warnings`, commit `d537b04`, the same code that runs on the Pi).
- SD card image backup: `~/git-personal2/deye_telegram_bot/orangepi.dmg` (UDIF lzfse, 15,931,539,456 bytes
  raw, one ext4 partition). It contains secrets (bot token in `.env`, GitHub PAT). Never commit or share it.
  The user may move it out of that folder.
- `e2fsprogs` is installed via Homebrew: `/opt/homebrew/opt/e2fsprogs/sbin/{debugfs,e2fsck}`.

## Status

- [x] Analysis of the bot and the SD image (docs/existing-system.md)
- [x] Design agreed (docs/architecture.md)
- [ ] `pi/pusher/`: pusher.py, push_start.py, run_push.sh, push.env.example, override.conf
- [ ] `tools/`: fake inverter + local runner (his code + fake inverter + user's test bot), failure tests
- [ ] `cloud/`: Worker, D1 migrations, web app
- [ ] User sets up Cloudflare (docs/cloudflare-setup.md)
- [ ] Clone the card + write files (docs/pi-deployment.md, `tools/` script)
- [ ] Swap cards, verify via heartbeat in the web app, then verify the register decoding

## Open questions to ask the user

- Does the user have a domain on the target Cloudflare account? This decides the Access setup (see architecture.md).
- Inverter model (3-phase hybrid, probably SUN-*K-SG0*LP3). Needed to confirm the register map.
