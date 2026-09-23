#!/bin/bash
# Load MySQL's named-timezone tables when the database is first created.
#
# Streaks are per-student local days: the SQL uses
# CONVERT_TZ(..., 'Asia/Kolkata', '+00:00'), and CONVERT_TZ returns NULL for a
# NAMED zone unless mysql.time_zone* is populated. Empty tables therefore do not
# fail loudly — every streak just silently computes as nothing. Loading them
# here makes it part of creating the database rather than a step someone has to
# remember (the app also checks this at boot and refuses to start without it).
set -euo pipefail

if [ -d /usr/share/zoneinfo ]; then
  mysql_tzinfo_to_sql /usr/share/zoneinfo 2>/dev/null | mysql --protocol=socket -uroot -p"${MYSQL_ROOT_PASSWORD}" mysql
  echo "timezone tables loaded"
else
  echo "WARNING: /usr/share/zoneinfo missing — named timezones will not work" >&2
  exit 1
fi
