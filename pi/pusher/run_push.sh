#!/usr/bin/env bash
# Started by systemd via the drop-in override.conf, instead of his run.sh.
# Runs the bot + pusher. Falls back to his exact start.py if push_start.py itself is broken.
BOT_DIR="${DEYE_BOT_DIR:-/home/deye/deye_telegram_bot}"  # override only for local tests
source "$BOT_DIR/.venv/bin/activate"

python -u "$BOT_DIR/pusher/push_start.py"
code=$?

# 0 = normal stop, 3 = his bot code failed (systemd restarts us, exactly like his run.sh exiting).
if [ "$code" -eq 0 ] || [ "$code" -eq 3 ]; then
  exit "$code"
fi

# Anything else (syntax error, import error in our file, crash of the interpreter): run his bot unchanged.
echo "run_push.sh: push_start.py exited with $code, falling back to start.py" >&2
exec python -u "$BOT_DIR/start.py"
