#!/usr/bin/env bash
# Builds tools/.work/deye_telegram_bot: his bot at the deployed commit + our pusher/, laid out like on the Pi.
# Usage: tools/make_workdir.sh [his repo path]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HIS="${1:-$HOME/git-personal2/deye_telegram_bot}"
COMMIT=d537b04
W="$ROOT/tools/.work/deye_telegram_bot"
rm -rf "$W" && mkdir -p "$W"
git -C "$HIS" archive "$COMMIT" | tar -x -C "$W"
ln -s "$ROOT/tools/.venv" "$W/.venv"
mkdir "$W/pusher"
cp "$ROOT"/pi/pusher/{pusher.py,push_start.py,run_push.sh} "$W/pusher/"
# Bot config: the user's TEST bot and TEST group (tools/.env, gitignored). Never his real .env.
if [ -f "$ROOT/tools/.env" ]; then cp "$ROOT/tools/.env" "$W/.env"; fi
# Pusher → local `wrangler dev` (cloud/.dev.vars has the same key).
printf 'PUSH_URL=http://127.0.0.1:8787/api/ingest\nPUSH_KEY=local-test-key\nPUSH_INTERVAL=30\n' > "$W/pusher/push.env"
chmod 600 "$W/pusher/push.env"
echo "$W"
