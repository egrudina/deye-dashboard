# backup/: everything needed to rebuild the Pi's SD card from scratch

Only this README is tracked by git. The other files contain secrets (bot token in `.env`, a GitHub PAT) and are
gitignored. **Never commit, share or upload them.** Copy the folder to an encrypted place if you want an off-Mac backup.

| File | What it is |
|---|---|
| `orangepi.dmg` | The original SD card image as received (UDIF lzfse, 705 MB). Has the MBR and the ext4 partition, **no bootloader**. |
| `orig-boot-4m.bin` | First 4 MiB of the ORIGINAL card: MBR + U-Boot SPL (`eGON.BT0` at 8 KiB). Read from the original card on 2026-11-12. |
| `orangepi-full.img` | 15,770,583,040 bytes: the DMG's raw partition image with `orig-boot-4m.bin` overlaid on sectors 0..8191. This is a complete, bootable copy of the original card (what `card.sh clone` writes). |
| `SHA256SUMS` | Checksums of the three files. Check with `cd backup && shasum -a 256 -c SHA256SUMS`. |

## Why the bootloader file exists

The Orange Pi One (Allwinner H3) boots from U-Boot stored in raw sectors *before* the ext4 partition. The DMG only
captured the partition, so sectors 1..8191 of a raw image made from it are zeros. A card cloned from that image has a
valid partition table and filesystem but **does not boot**: blank HDMI, no bot (seen on 2026-11-12).
`card.sh clone` now refuses an image without the bootloader.

## Restore / rebuild

```sh
tools/card.sh image                                  # rebuild orangepi-full.img from the DMG + boot dump (if missing)
diskutil list external physical                      # find the card; check the size!
sudo tools/card.sh clone diskN --erase diskN         # exact copy of the original card (his bot, no pusher)
sudo /opt/homebrew/opt/e2fsprogs/sbin/e2fsck -fy /dev/diskNs1   # if clone could not (see docs/pi-deployment.md)
sudo tools/card.sh write diskN prod                  # add the pusher, keep his .env
```

If `orig-boot-4m.bin` is lost but the original card still exists: `sudo tools/card.sh bootarea diskN` (read-only).
If both are lost, the bootloader can be rebuilt from Armbian's u-boot for the Orange Pi One
(`dd if=u-boot-sunxi-with-spl.bin of=/dev/rdiskN bs=1024 seek=8`), but the original is safer.

The original card in the drawer remains the first-choice rollback. This folder is the second.
