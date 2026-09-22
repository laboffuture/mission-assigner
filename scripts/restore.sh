#!/usr/bin/env bash
# Restore a gzipped mysqldump (from backup.sh) into a named database. The target
# database is DROPPED and recreated, so never point this at a database you want
# to keep unless that is your intent.
#
#   bash scripts/restore.sh <backup-file.sql.gz> [target_db=mission_demo_restore]
#
# The backup is VERIFIED BEFORE the target is dropped: an empty, truncated or
# corrupt file is refused and the target is left exactly as it was. Restoring an
# invalid backup used to mean dropping a database and replacing it with nothing.
#
# No Docker needed: talks to DB_HOST/DB_PORT directly (see scripts/lib/db.sh).
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

# shellcheck source=lib/db.sh
source "$(dirname "$0")/lib/db.sh"
trap db_cleanup_credentials EXIT

if ! backup_is_valid "$FILE"; then
  echo "restore.sh: refusing to restore — \`$TARGET\` has NOT been touched" >&2
  exit 1
fi

echo "restore.sh: recreating database \`$TARGET\`"
db_query "DROP DATABASE IF EXISTS \`${TARGET}\`; CREATE DATABASE \`${TARGET}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"

echo "restore.sh: loading $FILE -> \`$TARGET\`"
gunzip -c "$FILE" | db_mysql "${TARGET}"

echo "restore.sh: restored $FILE into \`$TARGET\`"
