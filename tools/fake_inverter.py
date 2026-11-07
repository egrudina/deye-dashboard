"""Fake Deye inverter: a Solarman V5 TCP server (port 8899) for local tests with the unmodified bot code.

Control (HTTP, port 8898):
  curl localhost:8898/mode/normal     grid on, normal replies
  curl localhost:8898/mode/grid_off   grid off (reg 607 = 0), battery discharging
  curl localhost:8898/mode/hang       accept requests, never reply (pysolarmanv5 times out after 60 s)
  curl localhost:8898/mode/slow       reply after SLOW_S seconds
  curl localhost:8898/mode/close      close the connection on every request
  curl localhost:8898/mode/garbage    reply with a broken V5 frame (V5FrameError)
  curl localhost:8898/mode/big_only   hang only on the pusher's 88-register read; small reads still work
  curl localhost:8898/mode/big_late   answer the 88-register read only after SLOW_S seconds (a late reply)
  curl localhost:8898/stats           request counts per (start, count)

Usage: python3 fake_inverter.py [--slow 20]   (stdlib only)
"""

import argparse
import asyncio
import math
import struct
import time
from collections import Counter

V5_PORT, CTRL_PORT = 8899, 8898
MODES = {"normal", "grid_off", "hang", "slow", "close", "garbage", "big_only", "big_late"}
state = {"mode": "normal", "slow_s": 20}
stats = Counter()


def crc16(data: bytes) -> bytes:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return struct.pack("<H", crc)


def v5_checksum(frame: bytes) -> int:
    return sum(frame[1:-2]) & 0xFF


def registers() -> dict:
    t = time.time()
    hour = time.localtime(t).tm_hour + time.localtime(t).tm_min / 60
    grid_on = state["mode"] != "grid_off"
    sun = max(0.0, math.sin((hour - 6) / 13 * math.pi))
    load = int(700 + 300 * math.sin(t / 600))
    pv = int(sun * 6000)
    batt = -min(3000, pv) if grid_on else load - pv
    r = {
        588: 85 if grid_on else 62,
        590: batt & 0xFFFF,
        598: 2301 if grid_on else 0, 599: 2298 if grid_on else 0, 600: 2310 if grid_on else 0,
        607: max(1, load - pv // 3) if grid_on else 0,
        609: 5001 if grid_on else 0,
        619: 250 if grid_on else 0,
        625: load if grid_on else 0,
        650: int(load * 0.3), 651: int(load * 0.3), 652: load - 2 * int(load * 0.3), 653: load,
        672: int(pv * 0.6), 673: pv - int(pv * 0.6),
    }
    return r


def build_reply(req: bytes):
    """Returns the V5 reply for a V5 request frame, or None if the request is not understood."""
    if len(req) < 26 + 8 or req[0] != 0xA5 or req[-1] != 0x15:
        return None
    seq = req[5:7]
    logger_serial = req[7:11]
    mb = req[26:-2]
    slave, func, start, count = mb[0], mb[1], *struct.unpack(">HH", mb[2:6])
    stats[f"{func}:{start}+{count}"] += 1
    if func != 3:
        return None
    regs = registers()
    data = b"".join(struct.pack(">H", regs.get(start + i, 0)) for i in range(count))
    mb_resp = bytes([slave, func, len(data)]) + data
    mb_resp += crc16(mb_resp)
    payload = bytes([0x02, 0x01]) + b"\x00" * 12 + mb_resp
    frame = bytearray(b"\xA5" + struct.pack("<H", len(payload)) + struct.pack("<H", 0x1510) + seq + logger_serial
                      + payload + b"\x00\x15")
    frame[-2] = v5_checksum(frame)
    return bytes(frame), (start, count)


async def handle_v5(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    peer = writer.get_extra_info("peername")
    print(f"[v5] connect {peer}", flush=True)
    try:
        while True:
            req = await reader.read(1024)
            if not req:
                break
            mode = state["mode"]
            built = build_reply(req)
            if built is None:
                continue
            reply, (start, count) = built
            if mode == "big_only" and count > 10:
                mode = "hang"
            elif mode == "big_late":
                mode = "slow" if count > 10 else "normal"
            if mode == "hang":
                print(f"[v5] {start}+{count}: hanging", flush=True)
                continue
            if mode == "close":
                print(f"[v5] {start}+{count}: closing", flush=True)
                break
            if mode == "garbage":
                reply = reply[:20] + b"\x00" * (len(reply) - 20)
            if mode == "slow":
                print(f"[v5] {start}+{count}: replying in {state['slow_s']} s", flush=True)
                await asyncio.sleep(state["slow_s"])
            writer.write(reply)
            await writer.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        print(f"[v5] disconnect {peer}", flush=True)
        writer.close()


async def handle_ctrl(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    line = (await reader.readline()).decode(errors="replace")
    path = line.split(" ")[1] if " " in line else "/"
    if path.startswith("/mode/") and path[6:] in MODES:
        state["mode"] = path[6:]
        body = f"mode={state['mode']}\n"
        print(f"[ctrl] {body.strip()}", flush=True)
    elif path == "/stats":
        body = "".join(f"{k} {v}\n" for k, v in sorted(stats.items())) + f"mode={state['mode']}\n"
    else:
        body = "modes: " + " ".join(sorted(MODES)) + "\n"
    writer.write(f"HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {len(body)}\r\n\r\n{body}".encode())
    await writer.drain()
    writer.close()


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slow", type=int, default=20)
    ap.add_argument("--mode", default="normal", choices=sorted(MODES))
    a = ap.parse_args()
    state["slow_s"], state["mode"] = a.slow, a.mode
    v5 = await asyncio.start_server(handle_v5, "127.0.0.1", V5_PORT)
    ctrl = await asyncio.start_server(handle_ctrl, "127.0.0.1", CTRL_PORT)
    print(f"fake inverter on 127.0.0.1:{V5_PORT}, control on :{CTRL_PORT}, mode={state['mode']}", flush=True)
    async with v5, ctrl:
        await asyncio.gather(v5.serve_forever(), ctrl.serve_forever())


if __name__ == "__main__":
    asyncio.run(main())
