#!/usr/bin/env bash
# An untested backup is not a backup. This proves the backup+restore pipeline
# end to end, on a deterministic fixture so it never touches live data:
#   1. build a fresh fixture DB (migrate + seed)
#   2. back it up (scripts/backup.sh)
#   3. restore it into a scratch DB (scripts/restore.sh)
#   4. row-count check EVERY table: source vs restored
#   5. run the Stage 1 acceptance suite against the RESTORED DB (temp server)
#   6. drop the scratch DBs
# Fails loudly if any step fails.
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER="${MYSQL_CONTAINER:-mission-mysql}"
DB_USER="${DB_USER:-root}"
DB_PASS="${DB_PASS:-devpass}"
SRC="mission_demo_bkpsrc"
RESTORE="mission_demo_bkprestore"
PORT="${VERIFY_PORT:-3999}"
SRV=""

mysql_exec() { docker exec "$CONTAINER" mysql -u"${DB_USER}" -p"${DB_PASS}" -N -e "$1"; }

cleanup() {
  [ -n "$SRV" ] && kill "$SRV" 2>/dev/null || true
  # Kill whatever still listens on the temp port (leaves the main :3000 alone).
  powershell.exe -NoProfile -Command \
    "Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }" \
    >/dev/null 2>&1 || true
  mysql_exec "DROP DATABASE IF EXISTS \`${SRC}\`; DROP DATABASE IF EXISTS \`${RESTORE}\`;" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[1/6] build fixture DB \`$SRC\` (migrate + seed)"
DB_NAME="$SRC" npx tsx src/migrator.ts up >/dev/null 2>&1
DB_NAME="$SRC" npx tsx src/seed.ts >/dev/null 2>&1

echo "[2/6] back up \`$SRC\`"
FILE="$(DB_NAME="$SRC" BACKUP_DIR="${BACKUP_DIR:-./backups}" bash scripts/backup.sh)"
echo "      -> $FILE"

echo "[3/6] restore into \`$RESTORE\`"
bash scripts/restore.sh "$FILE" "$RESTORE" >/dev/null

echo "[4/6] row-count check on every table"
TABLES="$(mysql_exec "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='${SRC}' AND TABLE_TYPE='BASE TABLE'")"
fail=0
for t in $TABLES; do
  a="$(mysql_exec "SELECT COUNT(*) FROM \`${SRC}\`.\`${t}\`")"
  b="$(mysql_exec "SELECT COUNT(*) FROM \`${RESTORE}\`.\`${t}\`")"
  if [ "$a" != "$b" ]; then
    echo "      MISMATCH ${t}: source=${a} restored=${b}"
    fail=1
  else
    echo "      ok ${t} (${a} rows)"
  fi
done
[ "$fail" = "0" ] || { echo "row-count check FAILED"; exit 1; }

echo "[5/6] Stage 1 suite against the restored DB (temp server on :$PORT)"
DB_NAME="$RESTORE" PORT="$PORT" AUTH_MODE=dev npx tsx src/server.ts >/tmp/bkpverify-server.log 2>&1 &
SRV="$!"
for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://localhost:${PORT}/api/dev/users"; then break; fi
  sleep 1
done
rc=0
DB_NAME="$RESTORE" BASE_URL="http://localhost:${PORT}" node verify.mjs || rc=$?
[ "$rc" = "0" ] || { echo "Stage 1 suite FAILED against restored DB"; exit 1; }

echo "[6/6] cleanup"
# handled by trap

echo ""
echo "==== BACKUP VERIFY PASSED — backup restores cleanly, row counts match, app runs on it ===="
