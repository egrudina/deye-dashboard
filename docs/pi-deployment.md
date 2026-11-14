# Deploying to the Pi (no SSH): clone the card, write files with debugfs, swap

> **Author's own setup.** This page is about one specific install: the pusher runs inside an existing Telegram bot's
> process on an Orange Pi with no SSH access. For a normal install (standalone pusher) see the README.

The original card is never modified. It's the rollback: power off, put it back, power on.

Commands that touch disks need `sudo`. The user runs them with `! sudo …` in the Claude session.
**Always check the disk number with `diskutil list` before writing. Writing to the wrong disk destroys it.**
**Use `tools/card.sh`** (guards: external physical disks of 15.8–256 GB only; checks the card holds his bot at d537b04;
verifies every written file and runs `e2fsck -fn`). The manual steps below are what it does.

```sh
tools/card.sh image                               # once: backup/orangepi-full.img = DMG partition + original bootloader
sudo tools/card.sh bootarea diskN                 # only if backup/orig-boot-4m.bin is lost: read it from the ORIGINAL card
tools/card.sh check diskN                         # is diskN the card?
sudo tools/card.sh clone diskN --erase diskN      # dd + cmp verify + e2fsck -fy (journal replay)
sudo tools/card.sh write diskN test               # rehearsal: YOUR test bot (tools/.env), real inverter; original .env saved on the card
sudo tools/card.sh write diskN prod               # production: his .env restored byte-identical
sudo tools/card.sh show diskN                     # state of the card: files, journal, bootloader (no secret values)
```

**Status (2026-11-12): done.** The clone card runs in the Pi in PROD mode (his bot and group, pusher sending to the
cloud). The original card is in the drawer as the rollback. Everything to rebuild a card is in `backup/` (see its README).

## Pitfalls we hit on 2026-11-12 (all fixed in `card.sh`)

1. **The image had no bootloader → the Pi shows nothing (blank HDMI).** The DMG only holds the MBR and the ext4
   partition. The Orange Pi One boots from U-Boot SPL at 8 KiB, before the partition (which starts at 4 MiB), and
   sectors 1..8191 of the converted image were zeros. Fix: copy sectors 0..8191 from the original card
   (`orig-boot-4m.bin`, `eGON.BT0` at 8 KiB + 4). `card.sh image` now builds the full image, `clone` refuses one
   without the bootloader, `show` reports it.
2. **Writing with debugfs to a card that was booted since the last `e2fsck -fy` corrupts it.** After a boot the card
   has an unreplayed journal (we cut the power by hand). `debugfs -w` bypasses the journal; on the next boot the Pi
   replays stale metadata over our changes: cross-linked block between `.env` and `pusher/.env.original`, and
   `override.conf` lost (the dir entry pointed to a deleted inode). `e2fsck -fn` returns 0 in that state, so it
   is no guard. `write` now refuses when `needs_recovery` is set. Recovery: `e2fsck -fy`, then `write` again
   (it only creates what is missing).
   **Rule: after every boot of the clone card, run `e2fsck -fy` on the Mac before the next `write`.**
3. **macOS mounts the ext4 partition by itself** if a third-party driver is installed (ExtendFS, found in
   `~/Downloads/ExtendFS.app`: a FSKit extension with no Dock icon, locked toggle in System Settings). It remounts
   right after `diskutil unmountDisk`, and e2fsck/debugfs refuse ("is mounted"). Never answer `y` to that prompt.
   Remove the app (move it to the Trash), kill its helper (`pkill -9 -f "ExtendFS Extension"`), eject, replug.
   `clone`/`write` now stop with a hint while the volume is mounted.
4. `dd of=~/file` fails in zsh (`~` is not expanded after `of=`): use `$HOME`.
5. After eject/replug the disk number can change. `diskutil list external physical` first, every time: the original
   card is 15.9 GB, the clone is 31.1 GB.

Rehearsed on an attached copy of the image (`CARD_ALLOW_IMAGE=1`), 2026-11-09: repeated test/prod writes, fs clean,
.env after prod identical to the original. Lesson: debugfs `mkdir` on an existing directory leaves an orphaned inode,
so the script only creates what is missing.

The raw image is **15,770,583,040 bytes** (ends exactly at the end of the ext4 partition). The DMG reports 15,931,539,456
because it includes ~160 MB of unallocated tail, which `hdiutil convert` drops.

## 1. Make the full image (once; it is already in `backup/`)

`tools/card.sh image` = `hdiutil convert backup/orangepi.dmg -format UDTO` (partition only, no bootloader) **plus**
`dd if=backup/orig-boot-4m.bin of=<image> bs=512 count=8192 conv=notrunc` (the original MBR + bootloader).

## 2. Write it to the spare 32 GB card and verify

```sh
diskutil list external physical        # find the card, e.g. /dev/disk7 (external, physical, ~32 GB)
diskutil unmountDisk /dev/diskN
sudo dd if=backup/orangepi-full.img of=/dev/rdiskN bs=4m status=progress && sync
sudo cmp -n 15770583040 backup/orangepi-full.img /dev/rdiskN && echo VERIFIED   # an old card could be flaky
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
