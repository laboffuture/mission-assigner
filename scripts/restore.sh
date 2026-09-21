#!/usr/bin/env bash
# Restore a gzipped mysqldump (from backup.sh) into a named database. The target
# database is DROPPED and recreated, so never point this at a database you want
# to keep unless that is your intent.
#
#   bash scripts/restore.sh <backup-file.sql.gz> [target_db=mission_demo_restore]
set -euo pipefail

# Refuse under NODE_ENV=production unless the explicit override flag is given
# (the same flag and rule as src/destructiveGuard.ts). This script DROPS and recreates its target database.
OVERRIDE_FLAG="--i-understand-this-destroys-production-data"
ARGS=()
OVERRIDDEN=0
for a in "$@"; do
  if [ "$a" = "$OVERRIDE_FLAG" ]; then OVERRIDDEN=1; else ARGS+=("$a"); fi
done
set -- ${ARGS[@]+"${ARGS[@]}"}
if [ "${NODE_ENV:-}" = "production" ] && [ "$OVERRIDDEN" != "1" ]; then
  echo "FATAL: refusing to restore (it drops and recreates the target database): NODE_ENV=production and this destroys data." >&2
  echo "Nothing has been changed. If you really intend it, re-run with $OVERRIDE_FLAG" >&2
  exit 2
fi

FILE="${1:?usage: restore.sh <backup-file.sql.gz> [target_db]}"
TARGET="${2:-mission_demo_restore}"
CONTAINER="${MYSQL_CONTAINER:-mission-mysql}"
DB_USER="${DB_USER:-root}"
DB_PASS="${DB_PASS:-devpass}"

if [ ! -s "$FILE" ]; then
  echo "restore.sh: backup file not found or empty: $FILE" >&2
  exit 1
fi

echo "restore.sh: recreating database \`$TARGET\`"
docker exec "$CONTAINER" mysql -u"${DB_USER}" -p"${DB_PASS}" -e \
  "DROP DATABASE IF EXISTS \`${TARGET}\`; CREATE DATABASE \`${TARGET}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"

echo "restore.sh: loading $FILE -> \`$TARGET\`"
gunzip -c "$FILE" | docker exec -i "$CONTAINER" mysql -u"${DB_USER}" -p"${DB_PASS}" "${TARGET}"

echo "restore.sh: restored $FILE into \`$TARGET\`"
