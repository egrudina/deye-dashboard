"""Pushes raw inverter registers to the cloud. Runs inside the bot's process (see push_start.py).

Rules (the bot has priority):
- Never raise into the bot: every loop iteration catches Exception.
- Never talk to Telegram. Errors go to the heartbeat and (rate-limited) to the log.
- Read on the event-loop thread, like the bot does: pysolarmanv5 has no locking, so a read from
  another thread could hand its reply to one of the bot's requests.
- Use the base PySolarmanV5.read_holding_registers, never the bot's wrapper, so the bot's
  error_count / last_error (which it reports to the debug chat) are never touched.
- After a failed read, recover the connection the same way the bot's wrapper does, so a late
  reply can't be taken as the answer to the bot's next request. Then back off.
"""

import asyncio
import logging
import queue
import time
from array import array
from collections import deque

from pysolarmanv5 import PySolarmanV5

VERSION = "0.1.0"
REG_START = 588
REG_COUNT = 88  # 588..675
MAX_QUEUE = 2880  # 24 h at 30 s
MAX_BATCH = 100
FIRST_READ_DELAY_S = 10
READ_BACKOFF_MAX_S = 600
SEND_BACKOFF_MAX_S = 600
AUTH_FAIL_BACKOFF_S = 900
# Our own read (and its recovery) uses a short timeout instead of the library's 60 s, because a hung
# read blocks the whole process, bot included. Restored right after; single-threaded, so the bot
# never sees the changed value.
READ_TIMEOUT_S = 8

log = logging.getLogger("deye.pusher")


def _uptime_s():
    try:
        with open("/proc/uptime") as f:
            return int(float(f.read().split()[0]))
    except Exception:
        return None


class Pusher:
    def __init__(self, inverter, config):
        """config: dict with PUSH_URL, PUSH_KEY, optional PUSH_INTERVAL (seconds)."""
        url = (config.get("PUSH_URL") or "").strip()
        key = (config.get("PUSH_KEY") or "").strip()
        if not url.startswith(("https://", "http://")) or not key:
            raise ValueError("PUSH_URL / PUSH_KEY missing or invalid")
        self._url = url
        self._key = key
        self._interval = min(600, max(10, int(config.get("PUSH_INTERVAL") or 30)))
        self._inverter = inverter

        self._started_mono = time.monotonic()
        self._queue = deque()  # (seq, mono, array('H')); bounded by MAX_QUEUE manually
        self._seq = 0
        self._dropped = 0

        self._read_errors = 0
        self._read_fail_streak = 0
        self._next_read_mono = self._started_mono + FIRST_READ_DELAY_S
        self._last_read_ok_mono = None

        self._send_errors = 0
        self._send_fail_streak = 0
        self._next_send_mono = self._started_mono + FIRST_READ_DELAY_S + 5

        self._last_error = None
        self._failing = {"read": False, "send": False}

    # ---------- public ----------

    async def start(self):
        """Runs forever and never raises (except on cancellation)."""
        try:
            import aiohttp  # already in the bot's venv (aiogram uses it)
        except Exception as e:  # pragma: no cover
            log.warning("pusher disabled: %r", e)
            return
        try:
            timeout = aiohttp.ClientTimeout(total=15, connect=5)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                while True:
                    try:
                        now = time.monotonic()
                        if now >= self._next_read_mono:
                            self._read_once()
                        if time.monotonic() >= self._next_send_mono:
                            await self._send_once(session, aiohttp)
                    except asyncio.CancelledError:
                        raise
                    except Exception as e:
                        self._last_error = "loop: %r" % (e,)
                    await asyncio.sleep(1)
        except asyncio.CancelledError:
            raise
        except BaseException as e:  # never take the bot down, not even with SystemExit from here
            log.warning("pusher stopped: %r", e)

    # ---------- reading ----------

    def _read_once(self):
        now = time.monotonic()
        inv = self._inverter
        saved_timeout = getattr(inv, "socket_timeout", None)
        try:
            inv.socket_timeout = min(READ_TIMEOUT_S, saved_timeout or READ_TIMEOUT_S)
            try:
                regs = PySolarmanV5.read_holding_registers(inv, REG_START, REG_COUNT)
                if len(regs) != REG_COUNT:
                    raise ValueError("got %d registers" % len(regs))
                sample = array("H", regs)  # raises on values outside 0..65535
            except Exception as e:
                failed = e
                self._recover_connection()
            else:
                failed = None
        finally:
            if saved_timeout is not None:
                inv.socket_timeout = saved_timeout

        if failed is not None:
            e = failed
            self._read_errors += 1
            self._read_fail_streak += 1
            self._last_error = "read: %s %s" % (type(e).__name__, str(e)[:150])
            self._set_failing("read", True)
            backoff = min(READ_BACKOFF_MAX_S, self._interval * (2 ** min(self._read_fail_streak - 1, 6)))
            self._next_read_mono = time.monotonic() + backoff
            return

        self._read_fail_streak = 0
        self._set_failing("read", False)
        self._last_read_ok_mono = now
        self._seq += 1
        self._queue.append((self._seq, now, sample))
        while len(self._queue) > MAX_QUEUE:
            self._queue.popleft()
            self._dropped += 1
        self._next_read_mono = now + self._interval

    def _recover_connection(self):
        """Same steps as the bot's __get_without_errors, plus dropping a stale reply from the queue."""
        inv = self._inverter
        try:
            PySolarmanV5.disconnect(inv)
        except Exception:
            pass
        try:
            inv._reconnect()
        except Exception:
            pass
        q = getattr(inv, "_data_queue", None)
        if q is not None:
            try:
                while True:
                    q.get_nowait()
            except queue.Empty:
                pass
            except Exception:
                pass

    # ---------- sending ----------

    def _heartbeat(self, now):
        return {
            "pusher_version": VERSION,
            "boot_age_s": _uptime_s(),
            "process_age_s": int(now - self._started_mono),
            "queue_len": len(self._queue),
            "dropped": self._dropped,
            "last_read_ok_age_s": None if self._last_read_ok_mono is None else int(now - self._last_read_ok_mono),
            "read_errors": self._read_errors,
            "send_errors": self._send_errors,
            "last_error": self._last_error,
        }

    async def _send_once(self, session, aiohttp):
        now = time.monotonic()
        batch = [self._queue[i] for i in range(min(MAX_BATCH, len(self._queue)))]
        body = {
            "v": 1,
            "pi_wall_ms": int(time.time() * 1000),
            "samples": [
                {"age_ms": int((now - mono) * 1000), "start": REG_START, "regs": list(regs)}
                for _, mono, regs in batch
            ],
            "heartbeat": self._heartbeat(now),
        }
        status = None
        try:
            async with session.post(
                self._url, json=body, headers={"Authorization": "Bearer " + self._key}
            ) as resp:
                status = resp.status
                await resp.read()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self._send_failed("send: %s %s" % (type(e).__name__, str(e)[:150]))
            return

        if status == 200:
            if batch:
                last_seq = batch[-1][0]
                while self._queue and self._queue[0][0] <= last_seq:
                    self._queue.popleft()
            self._send_fail_streak = 0
            self._set_failing("send", False)
            # More queued (backlog after an outage)? Send the next batch soon.
            self._next_send_mono = time.monotonic() + (2 if self._queue else self._interval)
        elif status == 400:
            # The Worker didn't accept the format: drop this batch so we never get stuck on it.
            for _ in batch:
                if self._queue:
                    self._queue.popleft()
                    self._dropped += 1
            self._send_failed("send: HTTP 400, batch dropped")
        elif status in (401, 403):
            self._send_failed("send: HTTP %d (check PUSH_KEY / Access bypass)" % status, AUTH_FAIL_BACKOFF_S)
        else:
            self._send_failed("send: HTTP %s" % status)

    def _send_failed(self, msg, backoff=None):
        self._send_errors += 1
        self._send_fail_streak += 1
        self._last_error = msg
        self._set_failing("send", True)
        if backoff is None:
            backoff = min(SEND_BACKOFF_MAX_S, self._interval * (2 ** min(self._send_fail_streak - 1, 6)))
        self._next_send_mono = time.monotonic() + backoff

    def _set_failing(self, what, failing):
        """Log only on state changes, so a long outage doesn't flood the console."""
        if self._failing[what] != failing:
            self._failing[what] = failing
            if failing:
                log.warning("pusher %s failing: %s", what, self._last_error)
            else:
                log.warning("pusher %s ok again", what)
