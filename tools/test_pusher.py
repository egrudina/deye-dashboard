"""Failure tests for the pusher, against the real bot Inverter class and tools/fake_inverter.py.
No Telegram: a 'bot-like' loop reads through his wrapper methods like his Looper does (every second),
and a local HTTP sink stands in for the Worker.

Run: tools/.venv/bin/python tools/test_pusher.py [path to his bot repo]
Needs fake_inverter.py running (python3 tools/fake_inverter.py --slow 12).
"""

import asyncio
import os
import sys
import time
import urllib.request

BOT_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/git-personal2/deye_telegram_bot")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BOT_DIR)
sys.path.insert(0, os.path.join(ROOT, "pi", "pusher"))

from aiohttp import web  # noqa: E402
from inverter import Inverter  # noqa: E402
import pusher as pusher_mod  # noqa: E402

pusher_mod.FIRST_READ_DELAY_S = 0
SINK_PORT = 8790


def fake(mode):
    urllib.request.urlopen(f"http://127.0.0.1:8898/mode/{mode}").read()


class Sink:
    def __init__(self):
        self.status = 200
        self.delay = 0
        self.posts = []

    async def handle(self, request):
        body = await request.json()
        if self.delay:
            await asyncio.sleep(self.delay)
        self.posts.append((self.status, request.headers.get("Authorization"), body))
        return web.json_response({"ok": self.status == 200}, status=self.status)


class BotLike:
    """Reads like his Looper (through his wrapper), records anything odd."""

    def __init__(self, inv):
        self.inv = inv
        self.exceptions = []
        self.bad_values = []
        self.max_stall = 0.0

    async def loop(self):
        while True:
            try:
                self.inv.update_state()
                soc = self.inv.battery_level()
                load = self.inv.battery_load()
                if soc not in (85, 62):
                    self.bad_values.append(("soc", soc))
                if not (300 <= load.all <= 1100):
                    self.bad_values.append(("load", load.all))
            except Exception as e:
                self.exceptions.append(repr(e))
            await asyncio.sleep(1)

    async def stall_meter(self):
        while True:
            t = time.monotonic()
            await asyncio.sleep(0.2)
            self.max_stall = max(self.max_stall, time.monotonic() - t - 0.2)


results = []


def check(name, ok, detail=""):
    results.append((name, ok))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name} {detail}", flush=True)


async def phase(title, seconds):
    print(f"\n== {title} ({seconds} s)", flush=True)
    await asyncio.sleep(seconds)


async def main():
    fake("normal")
    sink = Sink()
    app = web.Application()
    app.router.add_post("/api/ingest", sink.handle)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", SINK_PORT).start()

    inv = Inverter("127.0.0.1", "123456789")
    p = pusher_mod.Pusher(inv, {"PUSH_URL": f"http://127.0.0.1:{SINK_PORT}/api/ingest", "PUSH_KEY": "k" * 64, "PUSH_INTERVAL": "10"})
    bot = BotLike(inv)
    tasks = [asyncio.create_task(c) for c in (bot.loop(), bot.stall_meter(), p.start())]

    # A. normal
    await phase("A normal", 25)
    samples = [s for st, _, b in sink.posts if st == 200 for s in b["samples"]]
    check("A samples delivered", len(samples) >= 2, f"({len(samples)} samples, {len(sink.posts)} posts)")
    check("A 88 regs, start 588", all(len(s["regs"]) == 88 and s["start"] == 588 for s in samples))
    check("A bearer key sent", all(a == "Bearer " + "k" * 64 for _, a, _ in sink.posts))
    hb = sink.posts[-1][2]["heartbeat"]
    check("A heartbeat fields", {"pusher_version", "queue_len", "read_errors", "send_errors"} <= hb.keys(), str(hb))
    check("A bot clean", not bot.exceptions and not bot.bad_values and inv.error_count == 0)

    # B. pusher's big read hangs, bot's small reads fine
    errs0, stall0 = p._read_errors, bot.max_stall
    fake("big_only")
    await phase("B inverter hangs on the 88-register read only", 30)
    fake("normal")
    check("B pusher read errors counted", p._read_errors > errs0, f"({p._read_errors - errs0})")
    check("B bot error_count untouched", inv.error_count == 0, f"(error_count={inv.error_count})")
    check("B bot values correct", not bot.exceptions and not bot.bad_values, f"{bot.exceptions[:2]} {bot.bad_values[:2]}")
    check("B stall bounded by short read timeout", bot.max_stall < 12, f"(max stall {bot.max_stall:.1f} s)")

    # C. late reply to the pusher's read must never reach the bot
    p._next_read_mono = time.monotonic()  # skip backoff from B
    p._read_fail_streak = 0
    fake("big_late")
    await phase("C late reply (12 s) to the 88-register read", 30)
    fake("normal")
    check("C bot never got a wrong reply", not bot.exceptions and not bot.bad_values and inv.error_count == 0,
          f"{bot.exceptions[:2]} {bot.bad_values[:2]} error_count={inv.error_count}")

    # Recovery after B/C
    p._next_read_mono = time.monotonic()
    p._read_fail_streak = 0
    n0 = len(p._queue) + sum(len(b["samples"]) for st, _, b in sink.posts if st == 200)
    await phase("C' reads recover", 25)
    n1 = len(p._queue) + sum(len(b["samples"]) for st, _, b in sink.posts if st == 200)
    check("C' pusher reads again", n1 > n0, f"(+{n1 - n0})")

    # D. cloud down -> queue grows -> backlog delivered without loss
    sink.status = 500
    await phase("D cloud returns 500", 30)
    q_peak = len(p._queue)
    check("D queue grows while cloud is down", q_peak >= 2, f"(queue {q_peak})")
    sink.status = 200
    p._next_send_mono = time.monotonic()  # skip backoff to keep the test short
    await phase("D' cloud back", 15)
    check("D' backlog delivered", len(p._queue) <= 1, f"(queue {len(p._queue)})")
    got = [s for st, _, b in sink.posts if st == 200 for s in b["samples"]]
    ages_ok = all(s["age_ms"] >= 0 for s in got)
    check("D' ages non-negative", ages_ok)

    # F. cloud hangs -> aiohttp timeout, bot not blocked
    stall_before = bot.max_stall
    bot.max_stall = 0
    sink.delay = 30
    p._next_send_mono = time.monotonic()
    await phase("F cloud hangs (30 s)", 25)
    sink.delay = 0
    check("F send timed out", "Timeout" in (p._last_error or "") or p._send_errors > 0, f"({p._last_error})")
    check("F bot not blocked by a slow cloud", bot.max_stall < 1.0, f"(max stall {bot.max_stall:.2f} s)")
    bot.max_stall = max(bot.max_stall, stall_before)

    # G. 400 -> batch dropped, not stuck
    await asyncio.sleep(12)  # let a sample queue up
    sink.status = 400
    d0 = p._dropped
    p._next_send_mono = time.monotonic()
    await phase("G cloud returns 400", 5)
    sink.status = 200
    check("G bad batch dropped, not retried forever", p._dropped > d0, f"(dropped +{p._dropped - d0})")

    # E. 401 -> long backoff, no crash
    sink.status = 401
    p._next_send_mono = time.monotonic()
    await phase("E cloud returns 401", 5)
    check("E long backoff after 401", p._next_send_mono - time.monotonic() > 600, f"({p._last_error})")

    check("pusher task still running", not tasks[2].done())
    check("bot loop still running, no exceptions", not tasks[0].done() and not bot.exceptions)
    for t in tasks:
        t.cancel()
    await runner.cleanup()
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed" + (f"; FAILED: {failed}" if failed else ""))
    sys.exit(1 if failed else 0)


asyncio.run(main())
