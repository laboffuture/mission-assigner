#!/usr/bin/env bash
# Timestamped, gzipped mysqldump of the database, written to a host path OUTSIDE
# the container. Prints the backup file path on stdout (only the path, so it can
# be captured by scripts).
#
#   BACKUP_DIR=/backups DB_NAME=mission_demo bash scripts/backup.sh
set -euo pipefail

CONTAINER="${MYSQL_CONTAINER:-mission-mysql}"
DB="${DB_NAME:-mission_demo}"
DB_USER="${DB_USER:-root}"
DB_PASS="${DB_PASS:-devpass}"
DEST="${BACKUP_DIR:-./backups}"

mkdir -p "$DEST"
TS="$(date +%Y%m%d-%H%M%S)"
FILE="${DEST}/${DB}-${TS}.sql.gz"

# --single-transaction: consistent snapshot without locking (InnoDB).
# No --databases: the dump is table DDL+data only, so it can be restored into a
# DB of any name (see restore.sh).
docker exec "$CONTAINER" sh -c \
  "exec mysqldump -u${DB_USER} -p${DB_PASS} --single-transaction --routines --triggers --no-tablespaces ${DB}" \
  | gzip > "$FILE"

# Sanity: a non-trivial gzip file.
if [ ! -s "$FILE" ]; then
  echo "backup.sh: produced an empty file ($FILE)" >&2
  exit 1
fi

echo "$FILE"
