# Database backup & recovery

This is the runbook for backing up and restoring the mission database. It is
written to be followed by someone who did **not** write it, under pressure.

The database lives in a MySQL 8 container named `mission-mysql`. Backups are
gzipped `mysqldump` files. Restores load a dump into a database of any name.

> **An untested backup is not a backup.** `npm run backup:verify` proves the whole
> pipeline (backup → restore → row-count check → the app runs on the restored
> data). Run it regularly; a green run is your assurance the backups are usable.

---

## Take a backup

```bash
BACKUP_DIR=/secure/backups npm run backup
```

- Writes `mission_demo-YYYYMMDD-HHMMSS.sql.gz` to `BACKUP_DIR` (default `./backups`).
- Uses `--single-transaction` (a consistent snapshot, no table locks).
- The command prints the exact file path it wrote — capture it.

Environment variables (all optional; defaults in parentheses):
`MYSQL_CONTAINER` (`mission-mysql`), `DB_NAME` (`mission_demo`), `DB_USER`
(`root`), `DB_PASS` (`devpass`), `BACKUP_DIR` (`./backups`).

## Restore a backup

**Restoring is destructive to the target database — it is dropped and recreated.**
Restore into a *scratch* database first and inspect it before touching production.

```bash
# 1. Restore into a scratch DB and look at it.
bash scripts/restore.sh /secure/backups/mission_demo-20260101-020000.sql.gz mission_demo_check

# 2. Sanity-check it (row counts, latest rows, etc.), e.g.:
docker exec mission-mysql mysql -uroot -pdevpass -e \
  "SELECT COUNT(*) FROM mission_demo_check.students;"

# 3. Only when satisfied, restore over production.
bash scripts/restore.sh /secure/backups/mission_demo-20260101-020000.sql.gz mission_demo
```

After restoring over production, restart the app so it reconnects:

```bash
npm run dev
```

## Full disaster recovery (empty MySQL)

If the database server is brand new / empty:

1. Start MySQL 8 (see the README "Start MySQL 8" step) — container `mission-mysql`.
2. Restore the most recent good backup into `mission_demo`:
   ```bash
   bash scripts/restore.sh <latest-backup.sql.gz> mission_demo
   ```
   The dump recreates every table (schema + data), including `schema_migrations`,
   so the database is immediately at the correct schema version.
3. If you have **no** usable backup, rebuild an empty schema instead:
   ```bash
   npm run db:migrate   # recreate the schema from versioned migrations
   npm run db:seed      # demo data (NOT production data)
   ```
4. Start the app: `npm run dev`.

## Verify the backups (do this on a schedule)

```bash
npm run backup:verify
```

It builds a throwaway fixture, backs it up, restores it into a scratch database,
checks the row count of **every** table against the source, then starts a
temporary server against the restored database and runs the Stage 1 acceptance
suite on it. It cleans up its scratch databases and **fails loudly** if any step
fails. It never touches the live `mission_demo` database.

---

## Retention

- **Daily** backups, kept for **7 days**.
- **Weekly** backups, kept for **4 weeks**.
- Store backups **off the machine running the database** (a different host or
  object storage). A backup on the same disk as the database does not survive the
  failure it exists to protect against.
- Verify with `npm run backup:verify` at least weekly, and always after changing
  the backup scripts or the MySQL version.

A cron example (daily at 02:00, prune older than 7 days; weekly copy kept 4 weeks):

```cron
0 2 * * *   BACKUP_DIR=/secure/backups/daily  /path/to/repo/scripts/backup.sh && find /secure/backups/daily -name '*.sql.gz' -mtime +7 -delete
0 3 * * 0   BACKUP_DIR=/secure/backups/weekly /path/to/repo/scripts/backup.sh && find /secure/backups/weekly -name '*.sql.gz' -mtime +28 -delete
```
