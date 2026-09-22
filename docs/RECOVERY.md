# Database backup & recovery

This is the runbook for backing up and restoring the mission database. It is
written to be followed by someone who did **not** write it, under pressure.

The database is MySQL 8, reached at `DB_HOST`/`DB_PORT`. The scripts use the
`mysql`/`mysqldump` clients directly — **no Docker needed**. Backups are gzipped
`mysqldump` files. Restores load a dump into a database of any name.

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
- **A failed backup leaves no file and exits non-zero.** The dump is written to a
  hidden `.partial` file and renamed into place only after it verifies: non-empty,
  a valid gzip, at least one `CREATE TABLE`, and mysqldump's `-- Dump completed`
  trailer. So any `*.sql.gz` the script wrote is a backup that verified.

Environment variables (all optional; the environment wins, then `.env`, then the
default in parentheses): `DB_HOST` (`127.0.0.1`), `DB_PORT` (`3306`), `DB_NAME`
(`mission_demo`), `DB_USER` (`root`), `DB_PASS` (`devpass`), `BACKUP_DIR`
(`./backups`), `MYSQLDUMP` / `MYSQL` (client binaries; default: on `PATH`, and
`mysql` is looked for next to `MYSQLDUMP`). `MYSQL_CONTAINER` is optional: set it
only to run the clients inside a container instead.

## Restore a backup

**Restoring is destructive to the target database — it is dropped and recreated.**
Restore into a *scratch* database first and inspect it before touching production.

`restore.sh` verifies the backup file **before** it drops anything: an empty,
truncated or corrupt file is refused and the target is left exactly as it was.
Under `NODE_ENV=production` it also refuses unless you pass
`--i-understand-this-destroys-production-data`.

```bash
# 1. Restore into a scratch DB and look at it.
bash scripts/restore.sh /secure/backups/mission_demo-20260101-020000.sql.gz mission_demo_check

# 2. Sanity-check it (row counts, latest rows, etc.), e.g.:
mysql -h127.0.0.1 -uroot -p -e "SELECT COUNT(*) FROM mission_demo_check.students;"

# 3. Only when satisfied, restore over production.
bash scripts/restore.sh /secure/backups/mission_demo-20260101-020000.sql.gz mission_demo
```

After restoring over production, restart the app so it reconnects:

```bash
npm run dev
```

## Full disaster recovery (empty MySQL)

If the database server is brand new / empty:

1. Start MySQL 8 (see the README "Start MySQL 8" step).
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
suite on it. It **fails loudly** if any step fails, and its scratch databases
(`mission_demo_bkpsrc`, `mission_demo_bkprestore`) and temporary server are removed
on every exit path — success, failure or Ctrl-C. If they cannot be removed, it
says so and exits non-zero. It never touches the live `mission_demo` database.

---

## Roll back a migration

```bash
npm run db:migrate:status     # what is applied
npm run db:migrate:down       # revert the most recent migration
```

**Take (and keep) a backup first** — a down migration removes schema, and with it
the data in that schema. Under `NODE_ENV=production` the down commands refuse
unless `--i-understand-this-destroys-production-data` is passed.

Every down migration is tested against a **seeded** database, not only an empty
one (`npm run verify:migrations`).

### Rolling back `009_curriculum` when revision assignments exist

Curriculum mode can give a student the same mission again as a *revision*
(`assignments.revision_seq > 0`). The schema before 009 allows only one
assignment per student and mission, so it cannot hold those rows. The 009 down
migration therefore **refuses** while any exist, and changes nothing:

```
009_curriculum down refused: N revision assignment(s) exist (revision_seq > 0) ...
Nothing has been changed.
```

It does **not** delete them for you — they are student work, and removing them is
a deliberate, manual decision. The sequence:

1. **Back up**, and keep the file somewhere safe:
   ```bash
   BACKUP_DIR=/secure/backups npm run backup
   ```
2. **Look at what will be removed** (export it if you need to keep a record):
   ```sql
   SELECT id, student_id, mission_id, revision_seq, status, submitted_at
     FROM assignments WHERE revision_seq > 0 ORDER BY student_id, mission_id;
   ```
3. **Remove the revision assignments explicitly**, in one transaction.
   `attempt_logs`, `feedback_responses` and `idempotency_keys` rows cascade
   with them. `week_slots`, `xp_events` and `level_events` also hold an
   `assignment_id` but have **no** foreign key, so handle them yourself:
   un-link the week slots (otherwise they point at rows that no longer exist);
   the XP and level history can stay as history — decide.
   ```sql
   START TRANSACTION;
   UPDATE week_slots SET assignment_id = NULL
    WHERE assignment_id IN (SELECT id FROM assignments WHERE revision_seq > 0);
   DELETE FROM assignments WHERE revision_seq > 0;
   COMMIT;
   ```
4. **Roll back:**
   ```bash
   npm run db:migrate:down      # repeat until 009 is reverted (010 goes first if applied)
   npm run db:migrate:status    # confirm
   ```

If step 4 still refuses, step 3 did not remove every revision row. The refused
attempt changed nothing, so re-check and repeat.

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
