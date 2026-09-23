# Deploying Mission Hub

From a fresh Linux VM to a running, backed-up pilot in under 30 minutes. Written for whoever
administers the server, not for the person who wrote the app. Every command is meant to be
pasted as-is.

The whole stack is one `docker compose` file on one machine:

```
                    ┌─────────── caddy ───────────┐   :80/:443, TLS, the only public port
   browser ────────▶│  /api/*  ──▶ api   (:3000)  │
   (in the LMS      │  /quality ─▶ api            │
    iframe)         │  everything else ─▶ web     │
                    └──────────────┬──────────────┘
                                   │ (compose network, nothing published)
                        api ──▶ mysql ◀── backup (scheduled, pushes offsite)
```

---

## 1. What to provision

| | Minimum | Why |
|---|---|---|
| RAM | **4 GB** | see below |
| Disk | **40 GB** | see below |
| CPU | 2 vCPU | fine for a pilot cohort |
| OS | Debian 12 / Ubuntu 22.04+ | anything with Docker Engine 24+ |
| Ports open | 80, 443 | Caddy needs 80 to obtain certificates |
| DNS | an A record for the site name | LTI requires HTTPS on a real hostname |

**Why 4 GB and not 2.** Measured on the development machine: the full test suite peaks at
**2.0 GB** across the Node and MySQL processes (MySQL alone 509 MB, the largest Node process
328 MB). Steady-state serving is much smaller, but a backup with its restore-verification runs
the database, a temporary server and a dump at the same time — and that is exactly when you do
not want the kernel choosing what to kill. On 2 GB the margin disappears during backups; on
4 GB it does not. For reference, the development machine has 16 GB and MySQL was still killed
three times under memory pressure while other work ran.

**Why 40 GB.** Measured growth: **16 KB of database per student per completed week** (a week
is 8 missions, and that figure includes indexes; the row counts behind it are 8 assignments,
40 attempt logs, 32 XP events, 32 feedback responses, 8 level events, 8 selection-log rows).
A compressed backup is about **1.4%** of the database size (21 KB for 1.52 MB).

| | Estimate |
|---|---|
| 300 students × 40 weeks of data | ~190 MB |
| 11 retained local backups (7 daily + 4 weekly) at that size | ~35 MB |
| MySQL overhead, binlogs, InnoDB headroom | ~2 GB |
| Docker images and build cache (mysql, node ×2, caddy, ours) | ~6 GB |
| OS and Docker engine | ~6 GB |
| Room for a restore-verify copy of the database | ~2 GB |
| Container logs (rotate them — see §7) | ~1 GB |
| **Total** | **~17 GB in use** |

40 GB is the usual smallest VM disk and leaves the pilot years of headroom. Do not go below
20 GB.

---

## 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # log out and back in
docker compose version            # expect v2.x
```

## 3. Get the code

```bash
sudo mkdir -p /srv && sudo chown "$USER" /srv
git clone <this-repo> /srv/mission-hub
cd /srv/mission-hub/infra
```

## 4. Secrets

Secrets are set **on the host** and never committed. The template holds placeholders only,
and the app **refuses to boot in production if a secret still holds a placeholder value** and
names the variable (`src/env.ts`; proved by `npm run verify:ops`, case 4).

```bash
cp .env.production.example .env.production
chmod 600 .env.production            # only this user can read it

# Generate the two that must be random:
echo "DB_PASS=$(openssl rand -hex 16)"       >> .env.production
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env.production
$EDITOR .env.production               # fill in SITE_ADDRESS, ACME_EMAIL, LMS_ORIGIN, BACKUP_S3_*
```

Then delete the placeholder lines you replaced, so each variable appears once.

| Secret | Where it comes from | If it leaks |
|---|---|---|
| `SESSION_SECRET` | `openssl rand -hex 32` | anyone can forge any student's session — rotate immediately, which signs everyone out |
| `DB_PASS` | `openssl rand -hex 16` | full database access from inside the network |
| `BACKUP_S3_ACCESS_KEY` / `_SECRET_KEY` | your object-storage provider; use a key scoped to the backup bucket only | someone can read or delete your backups |

Rules that matter more than the mechanism:

- Never paste a secret into chat, a ticket, a commit or a screen share. Generate it on the
  server.
- `.env.production` is the only copy. Back **it** up separately from the database — the
  database backups are useless without `SESSION_SECRET` only in the sense that sessions break;
  they restore fine, but you will be re-issuing logins.
- Rotating a secret means editing `.env.production` and `docker compose up -d`, nothing else.

## 5. Start it

```bash
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production ps
```

What happens, in order: MySQL starts and becomes healthy (on first boot it also loads the
named-timezone tables — see §8); `migrate` runs the migrations once and exits 0; the api starts
only after that succeeded; web starts once the api is healthy; Caddy starts last and obtains a
certificate.

Check it:

```bash
curl -sf https://YOUR-SITE/healthz    # {"status":"ok"} — the process is up
curl -sf https://YOUR-SITE/readyz     # {"status":"ready"} — database reachable, schema current
```

`/readyz` returning 503 with `{"reason":"schema"}` means the code expects migrations the
database does not have — `docker compose --env-file .env.production up -d migrate` and look at
its logs. `{"reason":"database"}` means MySQL is not answering.

## 6. Upgrading

```bash
cd /srv/mission-hub && git pull
cd infra && docker compose --env-file .env.production up -d --build
```

Migrations run automatically as the one-shot `migrate` service before the new api starts.
The api drains on SIGTERM: in-flight submissions finish (up to `SHUTDOWN_TIMEOUT_MS`, default
20 s) before the process exits, so a student mid-submission is not cut off.

**Roll back** by checking out the previous tag and repeating. Down migrations are deliberately
NOT automatic — see `docs/RECOVERY.md`.

## 7. Day-to-day

```bash
# Logs (the containers log to stdout; the runtime collects them)
docker compose --env-file .env.production logs -f api
docker compose --env-file .env.production logs --since 1h caddy

# Restart one service
docker compose --env-file .env.production restart api
```

Cap the log files so they cannot fill the disk — `/etc/docker/daemon.json`:

```json
{ "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "5" } }
```

then `sudo systemctl restart docker`.

## 8. Backups

The `backup` service takes one every day at `BACKUP_AT_HOUR` (UTC, default 02:00): it dumps,
**verifies** the dump (valid gzip, contains `CREATE TABLE`, ends with mysqldump's completion
marker), uploads it to object storage, then applies retention — 7 daily and 4 weekly, locally
**and** remotely.

A backup that cannot be uploaded is a **failed** backup: in production the script exits 3 and
says so, rather than quietly keeping only a local copy. Watch for `BACKUP FAILED` in
`docker compose logs backup`.

```bash
# Take one now
docker compose --env-file .env.production run --rm backup bash scripts/backup.sh

# Prove the OFFSITE copy restores and the app runs on it (not just the local file)
VERIFY_SOURCE=remote npm run backup:verify
```

Restoring is in `docs/RECOVERY.md`. Restore into a scratch database and look at it before you
touch the live one.

**Timezone tables.** `infra/mysql-init/00-timezones.sh` loads MySQL's named-timezone tables
when the volume is first created. Streaks are computed per student local day with
`CONVERT_TZ(..., 'Asia/Kolkata', ...)`, which returns NULL — silently — if those tables are
empty. If you ever rebuild the volume by hand, run that script again.

## 9. Things that are deliberate

**Caddy routes `/api/*` to the api container directly.** The Next app also knows how to proxy
`/api` (it does so in local development), but in production that would mean
Caddy → Next → Express for every API call: one extra hop for nothing. Routing it at the proxy
keeps the browser on a single origin, so the session cookie is still first-party and CSRF is
unaffected — exactly as in development. It also avoids Next's bundled `http-proxy`, which is
where the `DEP0060 util._extend` warning comes from (see "Known warnings" in the root README).

**One instance.** The login rate limiter and the feedback-question cache live in the api
process. A second api container would keep its own copy of both and the two would disagree —
so the pilot runs exactly one. `INSTANCE_COUNT` is in `.env.production` to make that a
deliberate setting rather than an assumption; the startup guard that enforces it lands with
the next batch of work.

**The seed cannot run here.** `npm run db:seed` refuses under `NODE_ENV=production`, and no
service in this composition runs it. Demo data never appears on the pilot server by accident.

**Nothing but Caddy publishes a port.** MySQL and the api are reachable only from inside the
compose network. To inspect the database, go through the host:

```bash
docker compose --env-file .env.production exec mysql mysql -uroot -p mission_demo
```

## 10. Verified in CI, not by hand

This directory is exercised on every push by the `stack` job in
`.github/workflows/ci.yml`: it builds both images, brings the whole composition up, waits for
`/readyz` through Caddy, checks that the production shape refuses what it should (no dev login,
anonymous `/quality` redirected, unauthenticated API 401), runs a **real student journey**
through the proxy — sign in, open a mission, answer it, give feedback, view progress — and then
does the backup round-trip against MinIO, including a restore **from the remote copy**. It also
proves that an unreachable bucket fails the backup.

If you change anything here, that job is the thing to watch.
