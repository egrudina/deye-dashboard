# Deploying to the Pi (no SSH): clone the card, write files with debugfs, swap

The original card is never modified. It's the rollback: power off, put it back, power on.

Commands that touch disks need `sudo`. The user runs them with `! sudo …` in the Claude session.
**Always check the disk number with `diskutil list` before writing. Writing to the wrong disk destroys it.**
**Use `tools/card.sh`** (guards: external physical disks of 15.8–256 GB only; checks the card holds his bot at d537b04;
verifies every written file and runs `e2fsck -fn`). The manual steps below are what it does.

```sh
tools/card.sh image                               # once: ~/orangepi-raw.cdr
tools/card.sh check diskN                         # is diskN the card?
sudo tools/card.sh clone diskN --erase diskN      # dd + cmp verify + e2fsck -fy (journal replay)
sudo tools/card.sh write diskN test               # rehearsal: YOUR test bot (tools/.env), real inverter; original .env saved on the card
sudo tools/card.sh write diskN prod               # production: his .env restored byte-identical
sudo tools/card.sh show diskN                     # state of the card (no secret values)
```

Rehearsed on an attached copy of the image (`CARD_ALLOW_IMAGE=1`), 2026-11-09: repeated test/prod writes, fs clean,
.env after prod identical to the original. Lesson: debugfs `mkdir` on an existing directory leaves an orphaned inode,
so the script only creates what is missing.

The raw image is **15,770,583,040 bytes** (ends exactly at the end of the ext4 partition). The DMG reports 15,931,539,456
because it includes ~160 MB of unallocated tail, which `hdiutil convert` drops.

## 1. Make a raw image from the DMG (once)

```sh
hdiutil convert ~/git-personal2/deye_telegram_bot/orangepi.dmg -format UDTO -o ~/orangepi-raw   # → ~/orangepi-raw.cdr (~16 GB)
```

## 2. Write it to the spare 32 GB card and verify

```sh
diskutil list                          # find the card, e.g. /dev/disk7 (external, physical, ~32 GB)
diskutil unmountDisk /dev/diskN
sudo dd if=~/orangepi-raw.cdr of=/dev/rdiskN bs=4m status=progress && sync
sudo cmp -n 15770583040 ~/orangepi-raw.cdr /dev/rdiskN && echo VERIFIED   # an old card could be flaky
```

macOS will say it can't read the disk → click **Ignore**.

## 3. Check the filesystem (needed: the image has a `needs_recovery` journal flag)

```sh
sudo /opt/homebrew/opt/e2fsprogs/sbin/e2fsck -f /dev/diskNs1      # replay the journal, fix; answer yes
```

## 4. Write the pusher files with debugfs

Prepare a debugfs command file (`tools/` should generate it). Paths are inside the ext4 filesystem:

```
mkdir /home/deye/deye_telegram_bot/pusher
sif /home/deye/deye_telegram_bot/pusher uid 1000
sif /home/deye/deye_telegram_bot/pusher gid 1000
sif /home/deye/deye_telegram_bot/pusher mode 040755
cd /home/deye/deye_telegram_bot/pusher
write /local/path/pusher.py pusher.py
sif pusher.py uid 1000
sif pusher.py gid 1000
sif pusher.py mode 0100644
...same for push_start.py (0100644), run_push.sh (0100755), push.env (0100600)
mkdir /etc/systemd/system/deye_bot.service.d
write /local/path/override.conf /etc/systemd/system/deye_bot.service.d/override.conf
sif /etc/systemd/system/deye_bot.service.d/override.conf mode 0100644
```

```sh
sudo /opt/homebrew/opt/e2fsprogs/sbin/debugfs -w -f cmds.txt /dev/diskNs1
sudo /opt/homebrew/opt/e2fsprogs/sbin/e2fsck -fn /dev/diskNs1     # read-only sanity check
sudo /opt/homebrew/opt/e2fsprogs/sbin/debugfs -R 'ls -l /home/deye/deye_telegram_bot/pusher' /dev/diskNs1
diskutil eject /dev/diskN
```

Notes:
- `debugfs write` won't overwrite an existing file. To update, `rm` it first.
- Files must use **LF** line endings. `run_push.sh` needs a `#!/usr/bin/env bash` shebang.
- Check that the ownership and modes on the card match the table in architecture.md.
- Armbian may try to grow the partition to fill the 32 GB card on first boot. That's harmless.

## 5. Swap and verify

1. Unplug the Pi (no SSH means no clean shutdown; the bot/ATS already causes hard power cuts regularly), swap cards, power on.
2. His debug chat gets the usual "A am alive!" (accepted).
3. Within ~1–2 min the web app's health panel should show a heartbeat (`boot_age_s` small, `pusher_version`).
4. Ask the user to check the bot's Status button in the group: it must answer as before.
5. Compare the decoded values with the bot's Battery/Consumption answers to validate the register mapping.

## Rollback

Power off → put the original card back → power on. (Or, if the clone is fine but the pusher misbehaves: remove
`/etc/systemd/system/deye_bot.service.d/` from the clone with debugfs `rm` + `rmdir`.)

## Updating the pusher later

Same procedure on the clone card: pull it, `e2fsck`, `rm` + `write` the changed files, swap back.
That's why the Pi side should stay dumb: decoding and logic live in the Worker.
