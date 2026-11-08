#!/usr/bin/env bash
# Prepares the CLONE SD card for the Pi (no SSH): clone the image, write the pusher files with debugfs.
# The original card is never touched; it is the rollback.
#
#   tools/card.sh image                      make ~/orangepi-raw.cdr from orangepi.dmg (once, no sudo)
#   tools/card.sh check diskN                show what diskN is and whether it passes the guards (no sudo)
#   sudo tools/card.sh clone diskN --erase diskN    write the raw image to the card, verify, fix the journal
#   sudo tools/card.sh write diskN test      pusher + override; .env uses YOUR test bot (tools/.env),
#                                            keeps the real INVERTER_IP/SERIAL; original .env saved on the card
#   sudo tools/card.sh write diskN prod      pusher + override; .env restored to the original (his bot)
#   sudo tools/card.sh show diskN            what is on the card now (no secret values printed)
#
# Guards: only external, physical disks of 15.9-256 GB. A disk image (hdiutil attach) is allowed only with
# CARD_ALLOW_IMAGE=1, for rehearsals on the Mac. Secrets are never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
USER_HOME="$(eval echo "~${SUDO_USER:-$USER}")"
HIS_REPO="${HIS_REPO:-$(cd "$ROOT/.." && pwd)/deye_telegram_bot}"
HIS_COMMIT=d537b04
DMG="${DMG:-$HIS_REPO/orangepi.dmg}"
IMG="${IMG:-$USER_HOME/orangepi-raw.cdr}"
IMG_SIZE=15770583040  # raw image = end of the ext4 partition (the DMG adds ~160 MB of unallocated tail)
MAX_SIZE=$((256 * 1000 * 1000 * 1000))
E2=/opt/homebrew/opt/e2fsprogs/sbin
BOT=/home/deye/deye_telegram_bot
DROPIN=/etc/systemd/system/deye_bot.service.d
PUSH_URL=https://deye.grudina.info/api/ingest

die() { echo "ERROR: $*" >&2; exit 1; }
need_root() { [ "$(id -u)" -eq 0 ] || [ "${CARD_ALLOW_IMAGE:-}" = "1" ] || die "run with sudo: sudo $0 $*"; }

# ---------- disk guards ----------

plist_get() { plutil -extract "$2" raw -o - - <<<"$1" 2>/dev/null || true; }

guard_disk() {  # $1 = diskN; prints a summary, dies if the disk is not acceptable
  local d="$1" info internal vp bus size whole
  [[ "$d" =~ ^disk[0-9]+$ ]] || die "give a whole disk like disk7, not '$d'"
  info="$(diskutil info -plist "/dev/$d" 2>/dev/null)" || die "/dev/$d not found (diskutil list)"
  internal="$(plist_get "$info" Internal)"
  vp="$(plist_get "$info" VirtualOrPhysical)"
  bus="$(plist_get "$info" BusProtocol)"
  size="$(plist_get "$info" Size)"
  whole="$(plist_get "$info" WholeDisk)"
  echo "/dev/$d: $(plist_get "$info" MediaName) | bus=$bus | $vp | internal=$internal | size=$size bytes"
  [ "$whole" = "true" ] || die "$d is not a whole disk"
  if [ "$bus" = "Disk Image" ]; then
    [ "${CARD_ALLOW_IMAGE:-}" = "1" ] || die "$d is a disk image; set CARD_ALLOW_IMAGE=1 for a rehearsal"
  else
    [ "$internal" = "false" ] || die "$d is an INTERNAL disk. Refusing."
    [ "$vp" = "Physical" ] || die "$d is not a physical disk. Refusing."
  fi
  [ -n "$size" ] && [ "$size" -ge "$IMG_SIZE" ] || die "$d is smaller than the image ($IMG_SIZE bytes)"
  [ "$size" -le "$MAX_SIZE" ] || die "$d is larger than 256 GB; that's not the SD card. Refusing."
}

part_of() { echo "/dev/${1}s1"; }

dbg() { "$E2/debugfs" -R "$1" "$2" 2>/dev/null; }  # read-only query

# The card must hold his bot at the deployed commit (protects against writing to some other ext4 disk).
guard_card_content() {  # $1 = partition, $2 = tmp dir
  local p="$1" t="$2" f
  for f in start.py inverter.py looper.py deye_bot.py; do
    dbg "dump $BOT/$f $t/card_$f" "$p" >/dev/null
    [ -s "$t/card_$f" ] || die "$BOT/$f not found on $p: is this the Pi card?"
    git -c safe.directory='*' -C "$HIS_REPO" show "$HIS_COMMIT:$f" > "$t/repo_$f"
    cmp -s "$t/card_$f" "$t/repo_$f" || die "$f on the card differs from his commit $HIS_COMMIT. Stopping."
  done
  echo "card content: his bot at $HIS_COMMIT (start.py, inverter.py, looper.py, deye_bot.py match)"
}

# ---------- .env helpers (values never printed) ----------

env_get() {  # $1 file, $2 key -> raw value
  /usr/bin/python3 -I - "$1" "$2" <<'PY'
import re, sys
for line in open(sys.argv[1], encoding="utf-8"):
    m = re.match(r'^\s*(?:export\s+)?' + re.escape(sys.argv[2]) + r'\s*=(.*)$', line.rstrip("\n"))
    if m:
        print(m.group(1).strip()); break
PY
}

env_merge() {  # $1 original .env, $2 test .env, $3 out: original with BOT_TOKEN/GROUP_ID/DEBUG_ID from test
  /usr/bin/python3 -I - "$1" "$2" "$3" <<'PY'
import re, sys
orig, test, out = sys.argv[1:4]
keys = ("BOT_TOKEN", "GROUP_ID", "DEBUG_ID")
def parse(path):
    d = {}
    for line in open(path, encoding="utf-8"):
        m = re.match(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$', line.rstrip("\n"))
        if m: d[m.group(1)] = m.group(2).strip()
    return d
t = parse(test)
for k in keys:
    if not t.get(k) or t[k] in ("...", '""'):
        sys.exit(f"tools/.env: {k} is empty")
lines, seen = [], set()
for line in open(orig, encoding="utf-8").read().splitlines():
    m = re.match(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=', line)
    if m and m.group(1) in keys:
        line = f"{m.group(1)}={t[m.group(1)]}"; seen.add(m.group(1))
    lines.append(line)
for k in keys:
    if k not in seen: lines.append(f"{k}={t[k]}")
open(out, "w", encoding="utf-8").write("\n".join(lines) + "\n")
PY
}

token_of() { env_get "$1" BOT_TOKEN | tr -d "\"' \r"; }

# ---------- commands ----------

cmd_image() {
  [ -f "$IMG" ] && { echo "already there: $IMG"; ls -l "$IMG"; return; }
  [ -f "$DMG" ] || die "DMG not found: $DMG (set DMG=...)"
  hdiutil convert "$DMG" -format UDTO -o "${IMG%.cdr}"
  ls -l "$IMG"
}

cmd_check() {
  guard_disk "$1"
  diskutil list "/dev/$1"
  echo "OK: $1 passes the guards."
}

cmd_clone() {
  local d="$1"; need_root clone "$d"
  [ "${2:-}" = "--erase" ] && [ "${3:-}" = "$d" ] || die "to confirm, run: sudo $0 clone $d --erase $d"
  guard_disk "$d"
  [ -f "$IMG" ] || die "raw image not found: $IMG (run: $0 image)"
  [ "$(stat -f %z "$IMG")" = "$IMG_SIZE" ] || die "$IMG has an unexpected size"
  echo ">> ERASING /dev/$d and writing $IMG (about 10-20 min)"
  diskutil unmountDisk "/dev/$d"
  dd if="$IMG" of="/dev/r$d" bs=4m status=progress
  sync
  echo ">> verifying (reads the card back, about 10 min)"
  cmp -n "$IMG_SIZE" "$IMG" "/dev/r$d" || die "verification FAILED: the card is unreliable, use another one"
  echo "VERIFIED"
  diskutil unmountDisk "/dev/$d" >/dev/null 2>&1 || true
  local p; p="$(part_of "$d")"
  [ -e "$p" ] || die "$p not visible yet: unplug and replug the card, then run: sudo $E2/e2fsck -fy $p"
  echo ">> replaying the journal / fixing the filesystem"
  set +e; "$E2/e2fsck" -fy "$p"; local rc=$?; set -e
  [ "$rc" -lt 4 ] || die "e2fsck failed ($rc)"
  echo "Clone ready. Next: sudo $0 write $d test   (or prod)"
}

cmd_write() {
  local d="$1" mode="${2:-}"; need_root write "$d" "$mode"
  [ "$mode" = "test" ] || [ "$mode" = "prod" ] || die "mode must be 'test' or 'prod'"
  guard_disk "$d"
  local p; p="$(part_of "$d")"
  [ -e "$p" ] || die "$p not found"
  set +e; "$E2/e2fsck" -fn "$p" >/dev/null 2>&1; local rc=$?; set -e
  [ "$rc" -eq 0 ] || die "filesystem not clean (e2fsck -fn = $rc). Run: sudo $E2/e2fsck -fy $p"

  T="$(mktemp -d)"; chmod 700 "$T"; trap 'rm -rf "${T:-}"' EXIT
  guard_card_content "$p" "$T"

  # Original .env: the saved copy if a previous 'test' run made one, else the card's .env.
  local orig="$T/env.original" has_saved=0
  dbg "dump $BOT/pusher/.env.original $orig" "$p" >/dev/null
  if [ -s "$orig" ]; then has_saved=1; else dbg "dump $BOT/.env $orig" "$p" >/dev/null; fi
  [ -s "$orig" ] || die "can't read $BOT/.env from the card"
  [ -n "$(env_get "$orig" INVERTER_IP)" ] && [ -n "$(token_of "$orig")" ] || die "original .env looks wrong"
  local env_stat env_mode env_uid env_gid
  env_stat="$(dbg "stat $BOT/.env" "$p")"
  env_mode="$(sed -nE 's/.*Mode: +([0-7]+).*/\1/p' <<<"$env_stat" | head -1)"
  env_uid="$(sed -nE 's/^User: +([0-9]+) +Group: +([0-9]+).*/\1/p' <<<"$env_stat" | head -1)"
  env_gid="$(sed -nE 's/^User: +([0-9]+) +Group: +([0-9]+).*/\2/p' <<<"$env_stat" | head -1)"
  [ -n "$env_mode" ] && [ -n "$env_uid" ] || die "can't stat $BOT/.env"

  local test_env="$ROOT/tools/.env"
  if [ "$mode" = "test" ]; then
    [ -f "$test_env" ] || die "tools/.env (your test bot) not found"
    [ "$(token_of "$test_env")" != "$(token_of "$orig")" ] \
      || die "the 'original' .env already has your test token and no saved original. Re-clone the card."
    env_merge "$orig" "$test_env" "$T/env.new"
  else
    [ -f "$test_env" ] && [ "$(token_of "$test_env")" = "$(token_of "$orig")" ] \
      && die "the 'original' .env has your test token. Re-clone the card."
    cp "$orig" "$T/env.new"
  fi

  # Staged files.
  cp "$ROOT"/pi/pusher/{pusher.py,push_start.py,run_push.sh,override.conf} "$T/"
  local key; key="$(env_get "$ROOT/cloud/.env.local" PUSH_KEY | tr -d "\"' \r")"
  [ ${#key} -ge 32 ] || die "PUSH_KEY missing in cloud/.env.local"
  printf 'PUSH_URL=%s\nPUSH_KEY=%s\nPUSH_INTERVAL=30\n' "$PUSH_URL" "$key" > "$T/push.env"
  if grep -l $'\r' "$T"/{pusher.py,push_start.py,run_push.sh,override.conf,push.env,env.new} 2>/dev/null; then
    die "CRLF line endings in the files above"
  fi

  # debugfs commands. Only mkdir what is missing and rm what exists: debugfs 'mkdir' on an existing name
  # leaves an orphaned inode behind, so the commands must match the card's current state exactly.
  kind() {  # $1 path on the card -> "dir", "file", "other" or "" (missing)
    local s; s="$(dbg "stat $1" "$p")"
    grep -q 'Type: directory' <<<"$s" && { echo dir; return; }
    grep -q 'Type: regular' <<<"$s" && { echo file; return; }
    grep -q 'Inode:' <<<"$s" && { echo other; return; }
    echo ""
  }
  ensure_dir() {  # $1 path, $2 uid
    case "$(kind "$1")" in
      dir) ;; "") echo "mkdir $1" ;; *) die "$1 exists and is not a directory" ;;
    esac
    echo "sif $1 uid $2"; echo "sif $1 gid $2"; echo "sif $1 mode 040755"
  }
  put() {  # $1 local file, $2 card path, $3 uid, $4 gid, $5 mode (e.g. 0100644)
    case "$(kind "$2")" in
      file) echo "rm $2" ;; "") ;; *) die "$2 exists and is not a regular file" ;;
    esac
    echo "cd ${2%/*}"; echo "write $1 ${2##*/}"
    echo "sif $2 uid $3"; echo "sif $2 gid $4"; echo "sif $2 mode $5"
  }
  local C="$T/cmds" f m
  {
    ensure_dir "$BOT/pusher" 1000
    for f in pusher.py:0100644 push_start.py:0100644 run_push.sh:0100755 push.env:0100600; do
      m="${f#*:}"; f="${f%%:*}"
      put "$T/$f" "$BOT/pusher/$f" 1000 1000 "$m"
    done
    if [ "$mode" = "test" ]; then
      put "$orig" "$BOT/pusher/.env.original" 1000 1000 0100600
    elif [ "$has_saved" = "1" ]; then
      echo "rm $BOT/pusher/.env.original"
    fi
    put "$T/env.new" "$BOT/.env" "$env_uid" "$env_gid" "$(printf '0100%03o' $((8#$env_mode & 8#777)))"
    ensure_dir "$DROPIN" 0
    put "$T/override.conf" "$DROPIN/override.conf" 0 0 0100644
  } > "$C"

  echo ">> writing to $p ($mode)"
  "$E2/debugfs" -w -f "$C" "$p" > "$T/debugfs.log" 2>&1 || die "debugfs failed"
  # With -f, debugfs echoes each command as "debugfs: ..."; anything else is an error message.
  if grep -vE '^(debugfs( |:)|Allocated inode: [0-9]+$|$)' "$T/debugfs.log" | grep -q .; then
    grep -vE '^(debugfs( |:)|Allocated inode: [0-9]+$|$)' "$T/debugfs.log" >&2
    die "debugfs reported errors (above). Run: $E2/e2fsck -fn $p"
  fi

  # Verify: every file reads back identical, with the right owner and mode.
  verify() {  # $1 card path, $2 local file, $3 uid, $4 mode (4 octal digits)
    rm -f "$T/rb"; dbg "dump $1 $T/rb" "$p" >/dev/null
    cmp -s "$T/rb" "$2" || die "verify: $1 content differs"
    local s; s="$(dbg "stat $1" "$p")"
    grep -qE "Mode: +$4" <<<"$s" || die "verify: $1 mode is not $4"
    grep -qE "^User: +$3 +Group: +$3" <<<"$s" || die "verify: $1 owner is not $3:$3"
    echo "  ok  $4 uid=$3  $1"
  }
  echo ">> verifying"
  verify "$BOT/pusher/pusher.py" "$T/pusher.py" 1000 0644
  verify "$BOT/pusher/push_start.py" "$T/push_start.py" 1000 0644
  verify "$BOT/pusher/run_push.sh" "$T/run_push.sh" 1000 0755
  verify "$BOT/pusher/push.env" "$T/push.env" 1000 0600
  verify "$BOT/.env" "$T/env.new" "$env_uid" "$env_mode"
  verify "$DROPIN/override.conf" "$T/override.conf" 0 0644
  if [ "$mode" = "test" ]; then
    verify "$BOT/pusher/.env.original" "$orig" 1000 0600
  else
    rm -f "$T/rb"; dbg "dump $BOT/pusher/.env.original $T/rb" "$p" >/dev/null
    [ ! -s "$T/rb" ] || die "verify: .env.original still on the card"
  fi
  set +e; "$E2/e2fsck" -fn "$p" >/dev/null 2>&1; rc=$?; set -e
  [ "$rc" -eq 0 ] || die "e2fsck -fn after writing = $rc"
  echo "  ok  e2fsck clean"

  if [ "$mode" = "test" ]; then
    echo "Card ready: TEST bot (from tools/.env), real inverter, pushes to $PUSH_URL."
    echo "Before the final swap run: sudo $0 write $d prod"
  else
    echo "Card ready: PRODUCTION (his bot, his group), pushes to $PUSH_URL."
  fi
  echo "Eject: diskutil eject /dev/$d"
}

cmd_show() {
  local d="$1"; need_root show "$d"
  guard_disk "$d" >/dev/null
  local p; p="$(part_of "$d")"
  T="$(mktemp -d)"; chmod 700 "$T"; trap 'rm -rf "${T:-}"' EXIT
  echo "== $BOT/pusher"; dbg "ls -l $BOT/pusher" "$p" || true
  echo "== $DROPIN"; dbg "ls -l $DROPIN" "$p" || true
  dbg "dump $DROPIN/override.conf $T/o" "$p" >/dev/null; [ -s "$T/o" ] && sed 's/^/   /' "$T/o"
  dbg "dump $BOT/.env $T/e" "$p" >/dev/null
  if [ -s "$T/e" ]; then
    echo "== .env keys: $(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' "$T/e" | tr '\n' ' ')"
    if [ -f "$ROOT/tools/.env" ] && [ "$(token_of "$ROOT/tools/.env")" = "$(token_of "$T/e")" ]; then
      echo "   BOT_TOKEN: YOUR TEST BOT"; else echo "   BOT_TOKEN: original (his bot)"; fi
  fi
  dbg "dump $BOT/pusher/.env.original $T/s" "$p" >/dev/null
  [ -s "$T/s" ] && echo "   saved original .env: yes (pusher/.env.original)" || echo "   saved original .env: no"
}

case "${1:-}" in
  image) cmd_image ;;
  check) [ $# -ge 2 ] || die "usage: $0 check diskN"; cmd_check "$2" ;;
  clone) [ $# -ge 2 ] || die "usage: sudo $0 clone diskN --erase diskN"; cmd_clone "$2" "${3:-}" "${4:-}" ;;
  write) [ $# -ge 3 ] || die "usage: sudo $0 write diskN test|prod"; cmd_write "$2" "$3" ;;
  show)  [ $# -ge 2 ] || die "usage: sudo $0 show diskN"; cmd_show "$2" ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
