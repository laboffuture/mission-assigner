# Shared MySQL access for the backup scripts. Source it; do not execute it.
#
# Talks to MySQL DIRECTLY with the mysql / mysqldump clients against DB_HOST /
# DB_PORT — Docker is optional, not required. Set MYSQL_CONTAINER to run the
# clients inside a container instead (the old behaviour).
#
# Client binaries: MYSQL / MYSQLDUMP if set, else next to MYSQLDUMP, else PATH.
# Values come from the environment first, then the project .env (never
# overriding the environment), matching how the Node side reads its config.

__db_sh_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Load KEY=VALUE lines from .env for any variable not already set. No eval, no
# expansion: values are taken literally.
if [ -f "$__db_sh_root/.env" ]; then
  while IFS='=' read -r __k __v; do
    case "$__k" in '' | \#*) continue ;; esac
    __k="$(printf '%s' "$__k" | tr -d '[:space:]')"
    [[ "$__k" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    [ -n "${!__k+x}" ] && continue
    __v="${__v%$'\r'}"
    export "$__k=$__v"
  done < "$__db_sh_root/.env"
fi

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-root}"
DB_PASS="${DB_PASS:-devpass}"

if [ -z "${MYSQL:-}" ] && [ -n "${MYSQLDUMP:-}" ]; then
  __dir="$(dirname "$MYSQLDUMP")"
  for __cand in "$__dir/mysql.exe" "$__dir/mysql"; do
    [ -x "$__cand" ] && MYSQL="$__cand" && break
  done
fi
MYSQL="${MYSQL:-mysql}"
MYSQLDUMP="${MYSQLDUMP:-mysqldump}"

# Credentials go in a private options file, not on the command line (where they
# show in the process list and trigger the "password on the command line"
# warning). Removed by db_cleanup_credentials, which callers put in their trap.
DB_CNF="$(mktemp "${TMPDIR:-/tmp}/mh-db-XXXXXX.cnf")"
chmod 600 "$DB_CNF"
printf '[client]\nuser=%s\npassword=%s\nhost=%s\nport=%s\n' "$DB_USER" "$DB_PASS" "$DB_HOST" "$DB_PORT" > "$DB_CNF"
db_cleanup_credentials() { rm -f "$DB_CNF"; }

# The options file must come first on the command line.
db_mysql() {
  if [ -n "${MYSQL_CONTAINER:-}" ]; then
    docker exec -i "$MYSQL_CONTAINER" mysql -u"$DB_USER" -p"$DB_PASS" "$@"
  else
    "$MYSQL" --defaults-extra-file="$DB_CNF" "$@"
  fi
}
db_mysqldump() {
  if [ -n "${MYSQL_CONTAINER:-}" ]; then
    docker exec "$MYSQL_CONTAINER" mysqldump -u"$DB_USER" -p"$DB_PASS" "$@"
  else
    "$MYSQLDUMP" --defaults-extra-file="$DB_CNF" "$@"
  fi
}
# Windows mysql.exe ends lines with \r\n; strip the \r so values and table names
# are clean (a stray \r made every table name invalid). pipefail keeps the exit
# status of the mysql call.
db_query() { db_mysql -N -e "$1" | tr -d '\r'; }

# A backup is valid only if it is a readable gzip whose SQL defines at least one
# table and ends with mysqldump's own completion marker (written last, so a dump
# cut short never has it). Prints the reason and returns 1 otherwise.
backup_is_valid() {
  local f="$1"
  if [ ! -s "$f" ]; then echo "backup file is missing or empty: $f" >&2; return 1; fi
  if ! gzip -t "$f" 2>/dev/null; then echo "backup is not a valid gzip: $f" >&2; return 1; fi
  local tables
  tables="$(gunzip -c "$f" | grep -c '^CREATE TABLE' || true)"
  if [ "${tables:-0}" -lt 1 ]; then echo "backup contains no CREATE TABLE statements: $f" >&2; return 1; fi
  if ! gunzip -c "$f" | tail -n 5 | grep -q -- '-- Dump completed'; then
    echo "backup is incomplete (no mysqldump completion marker): $f" >&2
    return 1
  fi
  return 0
}
