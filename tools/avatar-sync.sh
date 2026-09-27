#!/usr/bin/env bash
# Mirror the Lumiere avatar directory to Google Drive with rclone.
#
# There is no FUSE on this host, so avatars are written as ordinary local files
# and this script is what keeps Google Drive in step with them. It is meant to
# be run from AlwaysData's Services panel (or a cron entry) every 10 minutes.
#
# Direction is one-way: local -> Drive. `rclone sync` makes the destination
# match the source exactly, so a file deleted locally is deleted from Drive as
# well. That is deliberate — the profile screen is the only thing that ever
# writes here, and a removal there should not leave the photo behind on Drive.
#
# Every value below can be overridden with an environment variable, which is
# how the AlwaysData panel passes them in:
#
#   AVATAR_DIR            local avatar directory  (default /home/lumiere/lumiere/avatars)
#   RCLONE_REMOTE         Drive destination       (default gdrive:avatars)
#   RCLONE_BIN            path to rclone          (default: rclone from PATH)
#   AVATAR_SYNC_LOG       log file                (default <parent of AVATAR_DIR>/avatar-sync.log)
#   AVATAR_SYNC_LOCK      lock directory          (default /tmp/lumiere-avatar-sync.lock)
#   AVATAR_SYNC_MAX_LOG_BYTES  rotate the log past this size (default 1 MiB)
#
# Exit codes are rclone's own, so a monitor can tell success (0) from failure.

set -u

AVATAR_DIR="${AVATAR_DIR:-/home/lumiere/lumiere/avatars}"
RCLONE_REMOTE="${RCLONE_REMOTE:-gdrive:avatars}"
RCLONE_BIN="${RCLONE_BIN:-rclone}"
LOG_FILE="${AVATAR_SYNC_LOG:-$(dirname "$AVATAR_DIR")/avatar-sync.log}"
LOCK_DIR="${AVATAR_SYNC_LOCK:-/tmp/lumiere-avatar-sync.lock}"
MAX_LOG_BYTES="${AVATAR_SYNC_MAX_LOG_BYTES:-1048576}"

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$LOG_FILE" 2>/dev/null || true; }

# Keep the log from growing without bound where nobody rotates it.
if [ -f "$LOG_FILE" ]; then
  size=$(wc -c <"$LOG_FILE" 2>/dev/null || echo 0)
  if [ "${size:-0}" -gt "$MAX_LOG_BYTES" ]; then
    tail -c $((MAX_LOG_BYTES / 2)) "$LOG_FILE" >"$LOG_FILE.tmp" 2>/dev/null \
      && mv "$LOG_FILE.tmp" "$LOG_FILE" 2>/dev/null || true
  fi
fi

# A previous run that is still going must not overlap this one. mkdir is atomic,
# so it works as a lock without flock (which is not always present).
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  # Break a lock left behind by a run that died (older than 30 minutes).
  if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "another sync is already running (lock $LOCK_DIR) — skipping this run"
    exit 0
  fi
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

if ! command -v "$RCLONE_BIN" >/dev/null 2>&1; then
  log "rclone not found (RCLONE_BIN=$RCLONE_BIN) — nothing synced"
  exit 127
fi

mkdir -p "$AVATAR_DIR" 2>/dev/null || true

# --create-empty-src-dirs keeps an empty avatars/ folder present on Drive, so
# the destination exists even before the first photo is uploaded.
"$RCLONE_BIN" sync "$AVATAR_DIR" "$RCLONE_REMOTE" \
  --create-empty-src-dirs \
  --transfers 4 \
  --checkers 8 \
  --retries 3 \
  --log-level INFO \
  --log-file "$LOG_FILE" \
  --stats 0
status=$?

case "$status" in
  0) log "sync ok: $AVATAR_DIR -> $RCLONE_REMOTE" ;;
  9) log "sync finished with errors (rclone exit 9): $AVATAR_DIR -> $RCLONE_REMOTE" ;;
  *) log "sync FAILED (rclone exit $status): $AVATAR_DIR -> $RCLONE_REMOTE" ;;
esac

exit "$status"
