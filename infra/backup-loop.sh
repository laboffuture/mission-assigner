#!/usr/bin/env bash
# Scheduled backups, in the composition rather than in someone's crontab.
#
# Why a loop instead of cron: this container's only job is backups, the schedule
# is one variable, and the output goes to stdout where `docker compose logs`
# already collects it. A host crontab would be a second place to look and a
# second thing to forget when the server is rebuilt.
#
#   BACKUP_AT_HOUR   hour (UTC, 0-23) to run at; default 2
#   BACKUP_ON_START  "true" to take one immediately at boot (default false)
#
# Retention and the offsite upload live in scripts/backup.sh, so a manual run
# behaves identically to a scheduled one.
set -euo pipefail

HOUR="${BACKUP_AT_HOUR:-2}"
echo "backup-loop: scheduled daily at ${HOUR}:00 UTC, writing to ${BACKUP_DIR:-/backups}"

run_backup() {
  local started
  started="$(date -u +%FT%TZ)"
  echo "backup-loop: starting backup at ${started}"
  if bash scripts/backup.sh; then
    echo "backup-loop: backup completed at $(date -u +%FT%TZ)"
  else
    # Exit 3 is "the local backup is fine but it never left the machine", which
    # is still a failed backup. Anything non-zero is loud: the runtime collects
    # stdout, so this line is what an alert should watch for.
    echo "backup-loop: BACKUP FAILED (exit $?) at $(date -u +%FT%TZ) — a backup that did not run is a backup you do not have" >&2
  fi
}

if [ "${BACKUP_ON_START:-false}" = "true" ]; then
  run_backup
fi

while true; do
  now_h="$(date -u +%-H)"
  now_m="$(date -u +%-M)"
  # Seconds until the next occurrence of HOUR:00 UTC.
  secs=$(((((HOUR - now_h + 24) % 24) * 60 - now_m) * 60))
  [ "$secs" -le 0 ] && secs=$((secs + 86400))
  echo "backup-loop: next run in $((secs / 3600))h $(((secs % 3600) / 60))m"
  sleep "$secs"
  run_backup
done
