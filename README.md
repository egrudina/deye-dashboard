# deye-dashboard

A web app (PWA) with live data and history for the Deye inverter. The data comes from the Orange Pi
that already runs the Telegram bot. The bot itself stays untouched.

```
Inverter ─Wi-Fi─ router ─LAN─ Orange Pi (bot + pusher) ──HTTPS──▶ Cloudflare Worker + D1 ◀── web app
```

| Folder | What | Deployed by |
|---|---|---|
| `pi/pusher/` | Python add-on that runs inside the bot's process and pushes raw registers every 30 s | Cloning the SD card + `debugfs` (no SSH), see `docs/pi-deployment.md` |
| `cloud/` | Worker (ingest + read API + static web app) and D1 schema | `wrangler deploy`, see `docs/cloudflare-setup.md` |
| `tools/` | Fake inverter, local test runner, card-writing script | – |

Docs:
- `docs/existing-system.md`: how the existing bot and Pi work (from the SD image analysis)
- `docs/architecture.md`: design, safety rules, payload contract, DB, testing plan
- `docs/pi-deployment.md`: clone the card, write files, swap, roll back
- `docs/cloudflare-setup.md`: what to set up in Cloudflare
- `CLAUDE.md`: handover/status for Claude sessions

Rollback on the Pi: put the original SD card back.
