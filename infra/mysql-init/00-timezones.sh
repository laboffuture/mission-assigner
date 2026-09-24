#!/bin/bash
# Load MySQL's named-timezone tables when the database is first created.
#
# Streaks are per-student local days: the SQL uses
# CONVERT_TZ(..., 'Asia/Kolkata', '+00:00'), and CONVERT_TZ returns NULL for a
# NAMED zone unless mysql.time_zone* is populated. Empty tables therefore do not
# fail loudly — every streak just silently computes as nothing. Loading them
# here makes it part of creating the database rather than a step someone has to
# remember (the app also checks this at boot and refuses to start without it).
#
# The entrypoint SOURCES this file, so it runs in the entrypoint's own shell and
# any `set` here is the entrypoint's for the rest of its life. `set -u` killed it
# on its next unset variable ("MYSQL_ONETIME_PASSWORD: unbound variable") and the
# container crash-looped before it was ever healthy. The work therefore happens in
# a subshell, whose options die with it; only the exit status comes back.
(
  set -e
  set -o pipefail

  if [ ! -d /usr/share/zoneinfo ]; then
    echo "timezone init: /usr/share/zoneinfo is missing — named timezones would not work" >&2
    exit 1
  fi

  mysql_tzinfo_to_sql /usr/share/zoneinfo 2>/dev/null |
    mysql --protocol=socket -uroot -p"${MYSQL_ROOT_PASSWORD}" mysql
  echo "timezone tables loaded"
)
tz_rc=$?

# Still fail closed: a database whose named zones do not resolve computes every
# streak as nothing, so refuse to finish creating it. This exit is deliberate —
# it ends the entrypoint, which is the only way to stop that database existing.
if [ "$tz_rc" -ne 0 ]; then
  echo "timezone init: FAILED — refusing to create a database whose streaks cannot work" >&2
  exit 1
fi
