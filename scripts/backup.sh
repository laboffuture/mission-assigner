#!/usr/bin/env bash
# Timestamped, gzipped mysqldump of the database. Prints the backup file path on
# stdout (only the path, so it can be captured by scripts).
#
#   BACKUP_DIR=/backups DB_NAME=mission_demo bash scripts/backup.sh
#
# A FAILED BACKUP LEAVES NO FILE. The dump is written to a hidden temporary file
# next to the destination and only renamed into place after it has been
# verified (valid gzip, CREATE TABLE present, mysqldump's completion marker).
# Any failure — the dump erroring, a truncated dump that exits 0, a failed
# verification — removes the temporary file. A backup file that exists is a
# backup that verified. (Previously a failed dump left a 20-byte empty gzip
# named exactly like a real backup.)
#
# No Docker needed: talks to DB_HOST/DB_PORT directly (see scripts/lib/db.sh).
set -euo pipefail

# shellcheck source=lib/db.sh
source "$(dirname "$0")/lib/db.sh"

DB="${DB_NAME:-mission_demo}"
DEST="${BACKUP_DIR:-./backups}"
mkdir -p "$DEST"
TS="$(date +%Y%m%d-%H%M%S)"
FILE="${DEST}/${DB}-${TS}.sql.gz"
TMP="$(mktemp "${DEST}/.${DB}-${TS}.XXXXXX.partial")"

cleanup() {
  rm -f "$TMP"
  db_cleanup_credentials
}
trap cleanup EXIT

# --single-transaction: consistent snapshot without locking (InnoDB).
# No --databases: the dump is table DDL+data only, so it can be restored into a
# DB of any name (see restore.sh). Comments are kept: the final one is the
# "-- Dump completed" marker the verification relies on.
db_mysqldump --single-transaction --routines --triggers --no-tablespaces "$DB" | gzip > "$TMP"

if ! backup_is_valid "$TMP"; then
  echo "backup.sh: backup of \`$DB\` failed verification — no backup written" >&2
  exit 1
fi

mv "$TMP" "$FILE"
echo "$FILE"
