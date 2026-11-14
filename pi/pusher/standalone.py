"""Standalone pusher: talks to the Solarman logger stick itself and sends raw registers to the cloud.

This is the normal way to run the pusher on a Raspberry Pi / Orange Pi / any small Linux box in the same
network as the inverter's Wi-Fi logger stick. Settings come from push.env next to this file (or $PUSH_ENV):

  PUSH_URL, PUSH_KEY, PUSH_INTERVAL   where and how often to send (see push.env.example)
  INVERTER_IP, INVERTER_SERIAL        the logger stick: LAN IP and its serial number (on the stick's label)
  INVERTER_PORT                       optional, default 8899

Run: .venv/bin/python -u standalone.py   (systemd unit: deye-pusher.service)
"""

import asyncio
import logging
import os
import sys
import time

from dotenv import dotenv_values
from pysolarmanv5 import PySolarmanV5

from pusher import Pusher

HERE = os.path.dirname(os.path.abspath(__file__))
CONNECT_RETRY_S = 30
SOCKET_TIMEOUT_S = 15

log = logging.getLogger("deye.pusher")


def load_config():
    path = os.environ.get("PUSH_ENV") or os.path.join(HERE, "push.env")
    if not os.path.isfile(path):
        sys.exit("push.env not found at %s (copy push.env.example and fill it in)" % path)
    config = dotenv_values(path)
    missing = [k for k in ("PUSH_URL", "PUSH_KEY", "INVERTER_IP", "INVERTER_SERIAL") if not (config.get(k) or "").strip()]
    if missing:
        sys.exit("push.env: missing %s" % ", ".join(missing))
    return config


def connect(config):
    """Opens the V5 connection to the logger stick, retrying until it works (the stick may boot later than we do)."""
    ip = config["INVERTER_IP"].strip()
    serial = int(config["INVERTER_SERIAL"].strip())
    port = int((config.get("INVERTER_PORT") or "8899").strip())
    while True:
        try:
            inverter = PySolarmanV5(
                ip, serial, port=port, mb_slave_id=1, auto_reconnect=True, socket_timeout=SOCKET_TIMEOUT_S
            )
            log.warning("connected to the logger at %s:%d", ip, port)
            return inverter
        except Exception as e:
            log.warning("cannot connect to the logger at %s:%d: %r; retrying in %d s", ip, port, e, CONNECT_RETRY_S)
            time.sleep(CONNECT_RETRY_S)


async def main():
    logging.basicConfig(level=logging.WARNING, stream=sys.stdout, format="%(asctime)s %(message)s")
    config = load_config()
    pusher_config = {k: config.get(k) for k in ("PUSH_URL", "PUSH_KEY", "PUSH_INTERVAL")}
    pusher = Pusher(connect(config), pusher_config)  # raises on a bad PUSH_URL / PUSH_KEY
    log.warning("pusher started, sending to %s", pusher_config["PUSH_URL"])
    await pusher.start()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
