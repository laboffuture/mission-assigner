#!/usr/bin/env bash
# infra/mysql-init/00-timezones.sh is SOURCED by the MySQL entrypoint, not run.
# That makes its shell options the entrypoint's: `set -euo pipefail` in it killed
# the entrypoint on its own next unset variable
#   /usr/local/bin/docker-entrypoint.sh: line 341: MYSQL_ONETIME_PASSWORD: unbound variable
# and the container crash-looped, which only ever showed up as a bring-up
# timeout. This reproduces the sourcing without Docker and asserts both halves:
#   1. a normal load leaves the sourcing shell alive and unpolluted
#   2. a load that cannot work still fails closed (no database with dead streaks)
set -euo pipefail

cd "$(dirname "$0")/../.."
SCRIPT="infra/mysql-init/00-timezones.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Stand-ins for the client tools the init script calls inside the image.
printf '#!/bin/sh\necho "-- tz sql"\n' > "$TMP/mysql_tzinfo_to_sql"
printf '#!/bin/sh\ncat > /dev/null\n' > "$TMP/mysql"
chmod +x "$TMP/mysql_tzinfo_to_sql" "$TMP/mysql"

# What the entrypoint does: source the file, then keep using variables of its
# own that nothing has set.
cat > "$TMP/entrypoint-sim.sh" <<'SIM'
#!/bin/bash
export MYSQL_ROOT_PASSWORD=devpass
export PATH="$FAKEBIN:$PATH"
. "$1" > /dev/null
echo "line 341 equivalent: ${MYSQL_ONETIME_PASSWORD}" > /dev/null
case $- in
  *u*) echo "POLLUTED: the entrypoint shell was left with -u"; exit 1 ;;
esac
case $- in
  *e*) echo "POLLUTED: the entrypoint shell was left with -e"; exit 1 ;;
esac
echo "ENTRYPOINT SURVIVED"
SIM
chmod +x "$TMP/entrypoint-sim.sh"

fail() {
  echo "::error title=Timezone init::$1"
  echo "tz-init-sourcing-test: FAILED — $1" >&2
  exit 1
}

[ -d /usr/share/zoneinfo ] || fail "/usr/share/zoneinfo is missing on this machine, so the test cannot run"

echo "[1/2] sourcing the init script must leave the entrypoint alive"
out="$(FAKEBIN="$TMP" bash "$TMP/entrypoint-sim.sh" "$SCRIPT" 2>&1)" || true
echo "$out" | sed 's/^/      /'
case "$out" in
  *"ENTRYPOINT SURVIVED"*) echo "      ok" ;;
  *) fail "sourcing the init script killed the entrypoint shell: ${out//$'\n'/ }" ;;
esac

echo "[2/2] an init that cannot work must still fail closed"
HIDE="$TMP/zoneinfo-hidden"
mkdir -p "$HIDE"
# Same script, asked to look at an empty PATH for its tools: the load fails.
rc=0
out2="$(FAKEBIN="$HIDE" bash "$TMP/entrypoint-sim.sh" "$SCRIPT" 2>&1)" || rc=$?
echo "$out2" | sed 's/^/      /'
[ "$rc" -ne 0 ] || fail "a failed timezone load was reported as success"
echo "      ok (exit $rc)"

echo ""
echo "==== TZ INIT SOURCING TEST PASSED ===="
