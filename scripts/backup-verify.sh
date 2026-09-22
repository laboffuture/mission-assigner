#!/usr/bin/env bash
# An untested backup is not a backup. This proves the backup+restore pipeline
# end to end, on a deterministic fixture so it never touches live data:
#   1. build a fresh fixture DB (migrate + seed)
#   2. back it up (scripts/backup.sh)
#   3. restore it into a scratch DB (scripts/restore.sh)
#   4. row-count check EVERY table: source vs restored
#   5. run the Stage 1 acceptance suite against the RESTORED DB (temp server)
#   6. drop the scratch DBs
# Fails loudly if any step fails, and the scratch databases and temp server are
# removed on EVERY exit path — success, failure or interrupt — by the trap.
#
# No Docker needed: talks to DB_HOST/DB_PORT directly (see scripts/lib/db.sh).
set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=lib/db.sh
source scripts/lib/db.sh

SRC="mission_demo_bkpsrc"
RESTORE="mission_demo_bkprestore"
PORT="${VERIFY_PORT:-3999}"

cleanup() {
  local rc=$?
  # The temp API server, by port (works on Windows and POSIX alike; the main :3000 is untouched).
  node -e "import('./test-support/proc.mjs').then((m) => m.killTree(m.listenerPid(${PORT})))" >/dev/null 2>&1 || true
  # A cleanup that cannot drop must say so and fail — silently leaving scratch
  # databases behind is how mission_demo_bkpsrc survived the audit.
  if ! db_query "DROP DATABASE IF EXISTS \`${SRC}\`; DROP DATABASE IF EXISTS \`${RESTORE}\`;" >/dev/null; then
    echo "backup-verify: ERROR — could not drop the scratch databases \`${SRC}\` / \`${RESTORE}\`" >&2
    rc=1
  elif [ -n "$(db_query "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN ('${SRC}', '${RESTORE}')")" ]; then
    echo "backup-verify: ERROR — scratch databases still exist after cleanup" >&2
    rc=1
  fi
  db_cleanup_credentials
  exit "$rc"
}
trap cleanup EXIT INT TERM

echo "[1/6] build fixture DB \`$SRC\` (migrate + seed)"
DB_NAME="$SRC" npx tsx src/migrator.ts up >/dev/null 2>&1
DB_NAME="$SRC" npx tsx src/seed.ts >/dev/null 2>&1

echo "[2/6] back up \`$SRC\`"
FILE="$(DB_NAME="$SRC" BACKUP_DIR="${BACKUP_DIR:-./backups}" bash scripts/backup.sh)"
echo "      -> $FILE"

echo "[3/6] restore into \`$RESTORE\`"
bash scripts/restore.sh "$FILE" "$RESTORE" >/dev/null

echo "[4/6] row-count check on every table"
TABLES="$(db_query "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='${SRC}' AND TABLE_TYPE='BASE TABLE'")"
fail=0
for t in $TABLES; do
  a="$(db_query "SELECT COUNT(*) FROM \`${SRC}\`.\`${t}\`")"
  b="$(db_query "SELECT COUNT(*) FROM \`${RESTORE}\`.\`${t}\`")"
  if [ "$a" != "$b" ]; then
    echo "      MISMATCH ${t}: source=${a} restored=${b}"
    fail=1
  else
    echo "      ok ${t} (${a} rows)"
  fi
done
[ "$fail" = "0" ] || { echo "row-count check FAILED"; exit 1; }

echo "[5/6] Stage 1 suite against the restored DB (temp server on :$PORT)"
# Stage 1 was written for difficulty + interest selection; this temp server has no
# test hooks, so the mode is set by env rather than by the harness.
DB_NAME="$RESTORE" PORT="$PORT" AUTH_MODE=dev SELECTION_MODE=legacy ENABLE_TEST_HOOKS= npx tsx src/server.ts >"${TMPDIR:-/tmp}/bkpverify-server.log" 2>&1 &
for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://localhost:${PORT}/api/dev/users"; then break; fi
  sleep 1
done
rc=0
DB_NAME="$RESTORE" BASE_URL="http://localhost:${PORT}" node verify.mjs || rc=$?
[ "$rc" = "0" ] || { echo "Stage 1 suite FAILED against restored DB"; exit 1; }

echo "[6/6] cleanup (scratch databases and temp server, by the exit trap)"
echo ""
echo "==== BACKUP VERIFY PASSED — backup restores cleanly, row counts match, app runs on it ===="
