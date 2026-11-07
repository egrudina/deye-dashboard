"""Entry point: his start.py main() plus the Pusher. Lives in <bot dir>/pusher/.

Exit codes (read by run_push.sh):
  0  normal exit (his Looper calls exit(0) on SIGTERM/SIGINT)
  3  his bot code failed at runtime -> run_push.sh exits too; systemd restarts it as before
  1  (Python itself) this file is broken -> run_push.sh falls back to his start.py
"""

import asyncio
import logging
import os
import sys
import traceback

PUSHER_DIR = os.path.dirname(os.path.abspath(__file__))
BOT_DIR = os.environ.get("DEYE_BOT_DIR") or os.path.dirname(PUSHER_DIR)
sys.path.insert(0, BOT_DIR)

from dotenv import dotenv_values  # noqa: E402

from deye_bot import DeyeBot  # noqa: E402
from inverter import Inverter  # noqa: E402
from looper import Looper  # noqa: E402

EXIT_BOT_FAILED = 3


def make_pusher(inverter):
    """Never raises. Returns None if the pusher can't be set up; the bot then runs alone."""
    try:
        sys.path.insert(0, PUSHER_DIR)
        from pusher import Pusher

        env_path = os.environ.get("PUSH_ENV") or os.path.join(PUSHER_DIR, "push.env")
        if not os.path.isfile(env_path):
            logging.getLogger("deye.pusher").warning("pusher disabled: %s not found", env_path)
            return None
        return Pusher(inverter, dotenv_values(env_path))
    except Exception as e:
        logging.getLogger("deye.pusher").warning("pusher disabled: %r", e)
        return None


async def main():
    # Same as his start.py main(), with the .env path made explicit and the pusher added.
    config = dotenv_values(os.path.join(BOT_DIR, ".env"))
    logging.basicConfig(level=logging.WARNING, stream=sys.stdout)
    inverter = Inverter(config['INVERTER_IP'], config['INVERTER_SERIAL'])
    bot = DeyeBot(config['BOT_TOKEN'], config['GROUP_ID'], config['DEBUG_ID'], inverter)
    loop = Looper(
        bot=bot,
        inverter=inverter,
        timeout=config['LOOP_TIMEOUT'],
        power_warning=config['POWER_WARNING'],
        warning_period=config['WARNING_PERIOD'],
        warning_threshold=config['WARNING_THRESHOLD'],
        power_critical=config['POWER_CRITICAL'],
    )

    tasks = [loop.start(), bot.start()]
    pusher = make_pusher(inverter)
    if pusher is not None:
        tasks.append(pusher.start())
    await asyncio.gather(*tasks)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except SystemExit:
        raise
    except BaseException:
        traceback.print_exc()
        sys.stdout.flush()
        sys.exit(EXIT_BOT_FAILED)
