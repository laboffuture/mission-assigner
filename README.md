# Mission Hub

An automated student-mission platform. Students reach it through **Moodle SSO**
(LTI launch — no separate login); **staff** (SME, QC, admin) sign in directly at
`/login` with a username and password. It has three stages, all sharing one
MySQL database:

- **Stage 1** — the adaptive mission loop: a student is assigned a mission,
  submits, is auto-graded, and their level moves. **A level never decreases** —
  a correct answer moves up, a wrong answer holds the same level and retries.
  This is a *learning* platform, not an assessment platform.
- **Stage 2** — an offline Python pipeline that generates missions from SME
  content into the mission bank (see `pipeline/README.md`).
- **Stage 3** — the structure around the loop: **segments**, a **weekly mission
  template** with sequential slot unlocking, **XP**, **cold start**, and a basic
  **assistance** path for students who stall.
- **Stage 5** — **feedback capture and tracking**: five (configurable) questions
  after every mission, XP for feedback, an audit trail (`attempt_logs`), student
  and instructor tracking views, and an aggregated **mission-quality report** for
  the SME. Feedback can (optionally) **gate** the next slot's unlock.

## Stack

Node.js 20 · TypeScript (strict) · MySQL 8 · mysql2 (raw parameterised SQL, no
ORM) · Express 4 · tsx (no build step) · one static HTML file (vanilla JS).

## CI

`.github/workflows/ci.yml` runs on every push and pull request as **four
independent jobs**, so each part reports its own result and one failure never
hides another. Every job fails on any failure — nothing is advisory.

| Job | Covers |
|---|---|
| `api` | root tree: `typecheck`, `lint`, `format:check`, `check:tokens`, `db:migrate`, then **all** suites via `npm run verify:all` (Node harnesses + Stage 2 pytest) against a MySQL 8 service container |
| `web-static` | web tree: `typecheck`, `lint` (`next lint --max-warnings 0`), `format:check`, `check:tokens`, `next build` |
| `e2e` | the full Playwright suite — every student journey across ids of every length, and the axe accessibility specs. `npx playwright install` runs on **every** run: after a machine move the pinned browser was missing and the suite was silently unrunnable |
| `audit` | the 62-case audit harness (`npm run verify:audit`); cases 43/44 stop and restart the MySQL service container |

`check:tokens` lives in `web/` because it scans the web components; the root
`npm run check:tokens` delegates to it so every gate can be run from the root.
ESLint lints `src/**/*.ts` (flat config, `typescript-eslint`) and the web tree
(`next/core-web-vitals`). Prettier enforces formatting in both trees;
`web/styles/lof-lms-tokens.css` is excluded because it is the LMS team's file
and must stay byte-identical to what they sent.

## Setup

### 1. Start MySQL 8

```bash
docker run --name mission-mysql \
  -e MYSQL_ROOT_PASSWORD=devpass \
  -e MYSQL_DATABASE=mission_demo \
  -p 3306:3306 -d --restart unless-stopped mysql:8
```

### 2. Configure environment

```bash
cp .env.example .env
```

### 3. Install dependencies

```bash
npm install
```

### 4. Migrate and seed

```bash
npm run db:migrate    # bring the database to current (runs all pending migrations)
npm run db:timezones  # load MySQL's named-timezone tables (once per SERVER, not per database)
npm run db:seed       # 75 missions, 3 segments, week template, xp rules, 5 feedback questions, 3 students + 4 staff
```

`db:timezones` is not optional. A fresh MySQL ships `mysql.time_zone*` empty and
`CONVERT_TZ` with a named zone then returns NULL, so every streak silently
computes as nothing. The api refuses to start in that state and names this
command; the command is safe to re-run and says when there is nothing to do. The
compose stack in `infra/` does it when the database is created.

`db:migrate` runs the versioned migrations in `src/migrations/` and is a no-op
when the database is already current. `db:migrate:status` shows applied/pending;
`db:migrate:down` reverts the last migration.

### Migrations (Item 4)

Schema changes are **versioned migrations** run by [umzug](https://github.com/sequelize/umzug),
recorded in a `schema_migrations` table:

| migration | contents |
|-----------|----------|
| `001_initial_schema` | Stage 1: students, missions, assignments, events |
| `002_stage3_segments_weeks_xp` | Stage 3: segments, weekly templates/slots, XP, cold start |
| `003_stage5_feedback_tracking` | Stage 5: feedback questions/responses, attempt log |
| `004_auth_roles` | `students.role` |
| `005_student_timezone` | `students.timezone` |
| `006_idempotency_keys` | `idempotency_keys` |
| `007_staff_credentials` | staff username/password login |
| `008_assistance_workflow` | `assistance_events` |
| `009_curriculum` | tracks/credits/projects/sessions, `student_positions`, `missions.session_id`, `assignments.revision_seq` |
| `010_adopt_pipeline_schema` | `content_chunks`, and the Stage 2 pipeline's four columns + index on `missions` |

**Why umzug (not db-migrate):** umzug is a thin, framework-agnostic migration
runner — it imposes no ORM and no DB driver of its own, so every migration is
plain `mysql2/promise` raw SQL (matching the stack). The only custom piece is a
~20-line storage adapter that records applied migrations via mysql2. Each
migration has an `up` and a `down`. `npm run verify:migrations` proves a fresh
migrated database is schema-identical to the current one, that re-running is a
no-op, and that `down` reverses cleanly.

### Timezones (Item 7)

**Convention: everything is UTC.** Timestamps are stored UTC; every connection
sets `time_zone = '+00:00'` explicitly (never relies on the container default)
and mysql2 uses `timezone: 'Z'`. **All time arithmetic is done in SQL**
(`TIMESTAMPDIFF`, `CONVERT_TZ`) — never in JavaScript against a driver-returned
`Date`, which would silently shift by the Node process's local zone (that bug is
what motivated this rule).

Streaks are bucketed by the **student's local day**, not the server's: each
student has a `timezone` (IANA name, default `Asia/Kolkata`) and the streak
converts UTC timestamps to that zone with `CONVERT_TZ` before taking the date.
This needs MySQL's named-timezone tables loaded once per server:

```bash
npm run db:timezones
```

It loads them from the host's zoneinfo where that exists, falls back to the
fixed-offset zones this project uses where it does not (a Windows development
machine), and verifies the zones resolve before reporting success. Empty tables
are not a failure anyone notices on their own — `CONVERT_TZ` simply returns NULL
— so the api checks the zones actually in use at boot and refuses to serve a
database where one does not resolve (`src/timezoneCheck.ts`). An unreachable
database is a different thing and does not stop the api starting.

### 5. Run

```bash
npm run dev
```

Open <http://localhost:3000>. Pick a student to see their week: the open slot is
expanded with its question, locked slots are greyed with a lock (question hidden),
XP is in the header, and the student's segment is shown.

## Configuration

| env var | meaning |
|---------|---------|
| `DB_HOST`/`DB_USER`/`DB_PASS`/`DB_NAME`/`PORT` | connection + server port |
| `AUTH_MODE` | `dev` (header identity, insecure) or `lti` (student launch token, stub) — see Authentication |
| `NODE_ENV` | `development` (default) / `test` / `production`. In production `SESSION_SECRET` is required and the session cookie is `Secure`. |
| `SESSION_SECRET` | signs the staff session cookie. Optional locally (a dev key is used, with a warning); **required, 32+ chars, in production**. |
| `STAFF_DEFAULT_PASSWORD` | password the seed gives staff accounts (default `changeme`). Change per account with `npm run set-password`. |
| `SESSION_SAMESITE` | session-cookie SameSite: `lax` (default) / `strict` / `none`. Use `none` (forces `Secure`/HTTPS) for the LTI launch — see Session cookie. |
| `CSRF_ENFORCED` | `false` (default) / `true`. Enforce the double-submit CSRF token on mutations. Flip to `true` together with `SESSION_SAMESITE=none` — see CSRF. |
| `COLD_START_STRATEGY` | how a brand-new student is placed — see below |
| `FEEDBACK_GATES_UNLOCK` | whether feedback is required before the next slot unlocks — see below |

## Authentication & authorisation

There are two ways identity is established, resolved in this order by
`requireAuth` (`src/auth.ts`):

1. **Signed session cookie** (`mh_session`) — the primary path for the hosted
   app. It is minted two ways:
   - **Staff login.** SME/QC/admin/instructor sign in at **`/login`** with a
     username + password (`POST /api/login`). Passwords are **bcrypt**-hashed in
     `students.password_hash`; the session stores only the user id and is signed
     with `SESSION_SECRET`. `POST /api/logout` clears it; `GET /api/me` returns
     the current user (401 when signed out, so the UI can redirect to `/login`).
   - **Student Moodle SSO** *(scaffold)*. Students never have a local password —
     they arrive via an **LTI 1.3 launch** from Moodle, which will validate the
     launch token and mint the same session cookie server-side. The provider is
     currently a **stub** (`LtiAuthProvider`); the session mechanism it will use
     is already in place.
2. **Fallback provider**, selected by `AUTH_MODE`, when there is no session:
   - **`dev`** (default) — `DevAuthProvider` reads an **`X-User-Id`** header and
     loads the user's role/subject. Trusts a client-set header, so it is
     **INSECURE** and for local dev + the test harnesses only (loud boot
     warning). The dev roster (`GET /api/dev/users`) exists only in this mode and
     powers the local "preview as student" switcher on the student page.
     `POST /api/dev/login-as { studentId }` (dev only) mints a real session
     cookie for a chosen user without a password — the **same session path the
     LTI launch will use** — so the student UI can be built and tested end-to-end
     before Moodle SSO exists.
   - **`lti`** — the student SSO stub above; throws until wired to Moodle.

**Staff accounts.** `npm run db:seed` creates one account per staff role with
usernames `sme` / `qc` / `instructor` / `admin` and the `STAFF_DEFAULT_PASSWORD`
(default `changeme`). Change one with:

```
npm run set-password -- <username> <newpassword>
```

**Roles** live on `students.role`: `student`, `sme`, `qc`, `instructor`,
`admin`. `requireAuth` populates `req.auth`; `requireRole(...)` gates endpoints.
Every `/api` route requires authentication (401 otherwise). **Ownership** is
enforced with the authenticated id in the SQL `WHERE` clause: a student may only
read their own progress/submissions/XP/attempts/etc. (a cross-student read is a
**403**, never an empty 200). Student actions (open/submit/feedback) are
`student`-only. The **mission-quality** report (`/api/mission-quality*`, the data
behind `/quality`) is **SME/QC/admin only**; `/api/students` (the full roster) is
staff-only.

**Login rate limit.** `POST /api/login` allows **5 failed attempts per username
per 15 minutes**; the next attempt gets a generic **429** (`Retry-After` set).
The check runs before the DB lookup and is keyed on the submitted username, so
it behaves identically for real and non-existent usernames — a 429 never reveals
whether an account exists. A successful login clears the window. The counter is
in-process (correct for one instance); a scaled deployment needs a shared store
(`src/rateLimit.ts` is the swap point).

**Production password guard.** In `NODE_ENV=production` the server refuses to
boot if any staff account still has the seed default password, printing a FATAL
message that names the accounts (`src/securityChecks.ts`). No-op in dev/test.

### Session cookie

The staff session is a **signed** (not encrypted) cookie named `mh_session`
carrying only `{ uid, iat }`, signed with `SESSION_SECRET`.

**Expiry is enforced by the server.** `iat` is the issue time (epoch seconds),
written by `issueSession()` — the only way a session is created. On every request
`enforceSessionAge()` drops a session with no `iat`, an `iat` in the future, or
one older than `SESSION_MAX_AGE` (default 12h), so the request is unauthenticated
(401). The cookie's own Max-Age is only a browser hint: a copied cookie replayed
later carries no expiry of its own, which is why the age lives inside the signed
payload. Confirmed by `npm run verify:fail-closed`.

Flags are computed in one place — `cookieFlags()` in `src/session.ts`:

| Flag | Value | Why |
|------|-------|-----|
| **HttpOnly** | **always on** | the cookie is never readable by page JavaScript (XSS can't steal it). |
| **SameSite** | **`lax`** (default; `SESSION_SAMESITE`) | fine for the current top-level staff login. |
| **Secure** | **on in production**, and **forced on whenever `SameSite=none`** | a `SameSite=None` cookie MUST be `Secure` or the browser drops it; production is HTTPS-only. |

**The SameSite decision for LTI — decided now, not later.** Today it is **`lax`**,
which is correct while only staff log in over a top-level page. **The Moodle LTI
launch will require changing it to `none`** (`SESSION_SAMESITE=none`, which forces
`Secure`, i.e. **HTTPS is mandatory**), for two independent reasons:

1. The LTI 1.3 launch returns the `id_token` via a **cross-site POST** to our
   `/lti/launch`. `SameSite=Lax` cookies are **not** sent on cross-site POSTs, so
   the OIDC state/nonce cookie set during `/lti/login` would be missing at launch
   and the flow would fail.
2. Moodle typically **embeds the tool in an iframe**, so our app runs in a
   third-party context; `Lax`/`Strict` cookies are not sent there at all, which
   would break every in-app request after launch.

So the plan is explicit: keep `lax` for the staff-only phase; flip
`SESSION_SAMESITE=none` (over HTTPS) when the LTI launch is wired up. Because it
is a single env var read through `cookieFlags()`, this is a **configuration
change, not a code change**. Confirmed by `npm run verify:cookie-flags`.

### Production fails closed

With `NODE_ENV=production` every insecure fallback is a **refusal**, not a warning:

| Configuration | Result |
|---|---|
| `AUTH_MODE` unset | refuses to boot — unset means dev auth, which trusts a client-set `X-User-Id` |
| `AUTH_MODE=dev` | refuses to boot |
| `ENABLE_TEST_HOOKS` set | refuses to boot; `/api/test/*` is not registered in production at all |
| `SESSION_SECRET` missing or < 32 chars | refuses to boot |
| a staff account on the default password | refuses to boot (`npm run set-password`) |

Each refusal names the variable and the reason. Behind the env check there is a
second, independent line: `getAuthProvider()` will not construct the dev provider
and `testHooksEnabled()` returns false under production, so neither can be
reached even if the env check were bypassed.

Commands that destroy data — `npm run db:seed` (truncates every table),
`migrate down` / `down:all`, `scripts/restore.sh` and `demo-reset.sh` (both drop a
database) — exit non-zero **before touching the database** under production,
unless run with the deliberately long flag
`--i-understand-this-destroys-production-data`. All of this is tested by
`npm run verify:fail-closed`.

### CSRF (double-submit)

`src/csrf.ts` issues a **readable** (not HttpOnly) `mh_csrf` cookie to every
client; the client echoes its value in the **`X-CSRF-Token`** header on each
mutation, and the server rejects any mutation whose header ≠ cookie. A
cross-site attacker can trigger a request carrying the victim's cookies but
**cannot read** the cookie to set the matching header (same-origin policy), so
the request fails.

Enforcement is gated by **`CSRF_ENFORCED` (default `false`)**. Today the session
cookie is `SameSite=Lax`, which already blocks cross-site POSTs, so CSRF is not
yet exploitable and the token is only *issued*, never *required*. **When the LTI
launch forces `SESSION_SAMESITE=none`** that protection disappears — so flip
**`CSRF_ENFORCED=true` in the same change**. The client layer already sends the
header, so this is a config flip, not a call-site change. Safe methods
(`GET`/`HEAD`/`OPTIONS`) and the dev-only `/api/test/*` hooks are never gated.
Confirmed by `npm run verify:csrf`.

### `COLD_START_STRATEGY`

Chosen in exactly one place (`src/coldstart.ts::resolveStrategy`), never
scattered through the code.

- **`SEGMENT_START`** (default) — a new student's `current_level` is set to their
  segment's `start_level` and `placement_status` is `complete`. The level then
  moves normally.
- **`PLACEMENT`** (implemented, not enabled by default) — `placement_status`
  starts `in_progress`; for the first 5 missions a correct answer moves up one
  level immediately and the first wrong answer ends placement at the current
  level. Placement also ends after 5 missions. Level still never decreases; XP is
  awarded normally throughout.

### `FEEDBACK_GATES_UNLOCK`

Resolved in exactly one place (`src/config.ts::feedbackGatesUnlock`).

- **`TRUE`** (default) — after a mission is graded, the next slot stays **locked**
  until the student submits feedback for it; it unlocks the moment feedback is
  saved. This keeps feedback-completion high — which the mission-quality report
  depends on. Without gating, completion sits around 30% and the aggregate quality
  signal becomes worthless.
- **`FALSE`** — the next slot unlocks immediately (Stage 3 behaviour) and feedback
  is optional.

The **weekly slot is never gated** either way, and never gates anything itself.

## Commands

| command | purpose |
|---------|---------|
| `npm run db:migrate` | run all pending migrations (no-op if current) |
| `npm run db:timezones` | load MySQL's named-timezone tables (idempotent; once per server) |
| `npm run db:migrate:status` | show applied / pending migrations |
| `npm run db:migrate:down` | revert the last migration |
| `npm run db:seed` | seed missions, segments, week template, xp rules, feedback questions, students |
| `npm run publish -- <studentId\|all> [YYYY-MM-DD]` | publish a week (idempotent; runs on a schedule in production) |
| `npm run dev` | start the server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` / `lint:fix` | ESLint (TypeScript) |
| `npm run format` / `format:check` | Prettier |
| `npm run backup` / `restore` / `backup:verify` | database backup, restore, and tested-restore (see **Backups** below) |
| `npm run verify` | Stage 1 acceptance harness |
| `npm run verify:stage3` | Stage 3 acceptance harness |
| `npm run verify:stage5` | Stage 5 acceptance harness |
| `npm run verify:auth` | auth acceptance harness (role + ownership) |
| `npm run verify:logging` | logging + error-shape harness |
| `npm run verify:validation` | input-validation harness |
| `npm run verify:migrations` | migrations harness (fresh == current, idempotent, reversible — every down also run on a seeded database) |
| `npm run verify:backups` | backup harness (failed dump leaves no file, restore refuses bad backups, backup:verify end to end) |
| `npm run verify:all` | run **all** suites in one pass |

### Backups

`scripts/backup.sh`, `restore.sh` and `backup-verify.sh` talk to MySQL directly
(`DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASS`, from the environment or `.env`) with the
`mysql`/`mysqldump` clients — **no Docker**. Clients come from `MYSQL`/`MYSQLDUMP`
if set, else `mysql` next to `MYSQLDUMP`, else `PATH`. Set `MYSQL_CONTAINER` only if
you want them run inside a container instead.

- **A failed backup leaves no file.** The dump goes to a hidden `.partial` file and
  is renamed into place only after it verifies: non-empty, valid gzip, at least
  one `CREATE TABLE`, and mysqldump's `-- Dump completed` trailer. Any failure
  removes the partial. A `*.sql.gz` in `backups/` is a backup that verified.
- **restore.sh verifies the backup before it drops the target**; an invalid file
  is refused and the target is untouched.
- **backup:verify** drops its scratch databases and stops its temp server on every
  exit path (an `EXIT`/`INT`/`TERM` trap), and fails if it cannot.
- **Rolling back migration 009** refuses while curriculum revision assignments
  exist (the older schema allows one assignment per student and mission).
  Nothing changes; back up, decide, remove those rows, re-run.

> **Feedback gating is injectable per test.** `FEEDBACK_GATES_UNLOCK` is read
> through `src/config.ts::feedbackGatesUnlock()` (never at import time) and backed
> by a settings object. Each harness sets its own value — Stage 3 turns gating
> **off** (its slots must unlock immediately on submit), Stage 5 turns it **on** —
> both in-process and, for HTTP-driven checks, on the server via the guarded
> `POST /api/test/feedback-gating` hook. So `npm run verify:all` runs the entire
> suite green in a single pass with no env change or restart. The hook only works
> when the server is started with `ENABLE_TEST_HOOKS=1`, so it is never exposed in
> production.

### Test hooks (`ENABLE_TEST_HOOKS=1`)

Nine routes exist only when the server is started with `ENABLE_TEST_HOOKS=1`. They are
registered inside a single `if` — in production they are **not routes at all**, and
production refuses to boot if the variable is set (`src/env.ts`, proved by
`verify-fail-closed` [3]). Adding a tenth belongs in this list.

| Hook | What it does |
|---|---|
| `POST /api/test/feedback-gating` | turn slot-unlock gating on or off at runtime (`{ enabled }`) |
| `POST /api/test/selection-mode` | switch `legacy` / `curriculum` selection without a restart |
| `POST /api/test/curriculum-config` | set `poolLookbackSessions` / `percentScope` for one test |
| `POST /api/test/fail-next-submit` | arm the next grading attempt(s) to fail as a busy database does (`{ times, code }`), so the retry in `src/retry.ts` can be tested without racing two real transactions for the same row. **Inert unless armed** — one integer comparison per submit — and `times: 0` disarms |
| `POST /api/test/reset-rate-limit` | clear the login buckets and the per-student write caps |
| `POST /api/test/clear-feedback-cache` | drop the in-process feedback-question cache |
| `POST /api/test/shutdown` | run the SIGTERM path (Windows cannot deliver a signal to another process) |
| `GET /api/test/logs` | read back captured log lines, optionally by `requestId` |
| `GET /api/test/boom` | throw, to exercise the error handler |

Two guarantees hold for every one of them, and for anything added later:

- **Inert unless used.** A hook that changes behaviour stays off until something turns it on,
  so a server with hooks enabled still behaves normally until a test asks otherwise.
- **Unreachable in production.** `NODE_ENV=production` with `ENABLE_TEST_HOOKS` set is a
  refusal to boot that names the variable — not a warning, and not a 404 at request time.

### Known warnings

**`[DEP0060] The util._extend API is deprecated`, once, on the first request that hits the
`/api/*` rewrite.** Traced (`node --trace-deprecation`) to:

```
at ProxyServer.<anonymous> (next/dist/compiled/http-proxy/index.js)
at proxyRequest (next/dist/server/lib/router-utils/proxy-request.js)
at handleRequest (next/dist/server/lib/router-server.js)
```

It is Next's own **bundled** copy of `http-proxy` (an unmaintained package that still calls
`util._extend`), used by Next to proxy the rewrite in `next.config.js` to the API on :3000. It
is not our code and not a dependency we declare, so we cannot fix it without patching Next's
compiled output. `util._extend` is deprecated, not removed, so the warning is cosmetic: one line
per server start, no effect on behaviour.

**It does not occur in production.** The deployed stack routes `/api/*` at Caddy, straight to
the api container, and `web/next.config.mjs` disables its own rewrite when `NODE_ENV=production`
— so Next never proxies anything there and the warning has nothing to raise it. It remains in
local development, where the rewrite is what lets the whole app run on one port, and it is
cosmetic. It would disappear entirely if Next replaced that bundled dependency.

## Curriculum-scoped selection (migration 009)

Missions are scoped to where a student is in the curriculum, so nobody is served
content they have not been taught yet.

```
Subject → Track ("Tesla's Track") → Credit (C1..C5) → Project (ordered) → Session (ordered)
```

A project usually has 8 sessions and the first project of a credit 9, so a credit
with 3 projects has 25. Each session has a `credit_sequence`, its running position
across the credit's projects (C1/P2/S1 is 10). A student's position is one session
per track (`student_positions`); a mission belongs to one session (`missions.session_id`).

- **Load a curriculum** — `npm run curriculum:load -- curriculum/teslas-track.json`.
  Idempotent; additive only (it refuses to remove credits, projects or sessions).
- **Pool** (`src/curriculum.ts::getSessionPool`) — the current session plus earlier
  sessions of the current credit (`POOL_LOOKBACK_SESSIONS`, 0 = all of them).
- **Selection** (`src/selection.ts::chooseCurriculumMission`, used by `slotFiller`
  and free-play) — hard filters: session in pool, live, slot type/band, not seen.
  Ranking: current session, then later sessions before earlier ones, then difficulty
  closest to the student's level, then interest overlap, then random. Difficulty only
  chooses *within* the session scope: a struggling student gets an easier question on
  the same content, not an older session.
- **Never ahead, enforced in SQL** — every candidate query also joins the student's
  position and excludes sessions after it and later credits, independent of the pool.
- **Exhaustion** (each step logged, and recorded in `selection_log`): widen to the
  whole credit (if lookback limited it) → earlier credits → widen the time band
  upward → repeat the completed mission seen longest ago as revision
  (`assignments.revision_seq`) → empty. The time band stays a hard filter for
  normal selection; it only widens here, one step before repeating, so a student
  is never handed a repeat while unseen content of a different length exists.
- **Deliberate revision** — `REVISION_MIX_PERCENT` (default 20) of selections are
  drawn from an earlier session even when the current session still has unseen
  missions, so earlier content keeps coming back. The roll happens once per
  selection and falls through to the current session when nothing earlier
  qualifies; the pick is logged and recorded as `revision_mix`, distinct from an
  exhaustion `repeat_oldest`.
- **Revision XP** — a revision repeat of a mission awards `attempt` and `submit`
  XP but never `correct`: the student was already paid for getting it right the
  first time (`assignments.is_revision`, guarded in `src/server.ts`).
- **Position from the LMS** — explicit positions win. When only a completion
  percentage exists, `resolvePosition` derives one under `PERCENT_SCOPE`
  (credit | project | track), rounding **down** (39% of 25 sessions is session 9),
  and stores the inputs in `source_detail`.
- **Modes** — `SELECTION_MODE=legacy` (default) or `curriculum`. Legacy is the
  default until every live student has a backfilled position; flip it once the
  Robotics positions are in. In curriculum mode a student with no position is
  served **nothing** and an alert is logged
  (`alert=missing_curriculum_position`) — there is deliberately no silent
  fallback to legacy, because a fallback would quietly serve unseen content.
  Suites written for difficulty + interest selection set `legacy` for their own
  run through `POST /api/test/selection-mode`; the curriculum suites set
  `curriculum`.
- **Segments are demoted** — they now seed the cold-start level only. In
  curriculum mode the target level clamps to the global 0–4 ladder, not a
  segment's min/max, and the session pool (not the segment) decides what content
  is eligible. New subjects need a curriculum, not segments.

Seed data adds Tesla's Track (Robotics) with missions on C1 sessions 1–24 and C2/S1,
and two students: *Ananya Rao* at C1/P1/S4 and *Kabir Mehta* at C1/P3/S2. Tests:
`npm run verify:curriculum` and `npm run verify:curriculum-pipeline`.

## Deployment

The pilot runs as one `docker compose` stack — Caddy, the Next web app, the Express API, MySQL
and a backup sidecar — on a single small VM. Everything needed to provision it is in
[`infra/`](infra/README.md): both Dockerfiles, the compose file, the Caddy configuration, a
production environment template, and a guide written for whoever administers the server.

The API is compiled ahead of time for production (`npm run build` → `dist/`, run as
`node dist/server.js`); `tsx` stays a development dependency and never reaches the image.
The whole composition is brought up and exercised on every push by the `stack` CI job, since it
cannot run on a Windows machine without Docker.

## The web app in the LMS (LTI)

The student UI (`web/`, Next.js on :3001) is built to be **embedded in the LOF LMS via an
iframe**, so it deliberately does not look like a site of its own.

**No header bar of our own.** The LMS page provides the header. In-app navigation lives inside
the page content (`components/PageNav.tsx`) as tabs, so a student still moves between the week
board and their progress without one. Covered by `web/e2e/navigation.spec.ts`.

**Theme.** The LMS tells us which theme the learner uses. `middleware.ts` accepts
`?theme=nebula|horizon` on any URL, stores it in the `lof_theme` cookie, and `app/layout.tsx`
renders `<html data-lof-theme>` on the SERVER — so the first paint is already correct and there
is no flash of the wrong theme. Nebula (their default) when nothing is given. `?theme=horizon`
is also how the tests and a reviewer switch themes by hand.

**Iframe height.** `components/FrameHeightReporter.tsx` posts the document height to the parent
on mount, on resize and after each route change, so the LMS can size the iframe instead of us
producing an inner scrollbar. It stays silent when the app is not framed.

> **The message format is NOT confirmed.** We post
> `{ subject: 'lti.frameResize', height: <px> }` to `window.parent`, which is the shape common
> LTI players use. **This has to be agreed with the LMS team** — both the field names and
> whether they want a `targetOrigin` other than `*`. If they specify something else, change
> `FRAME_RESIZE_SUBJECT` and the payload in that one component; nothing else depends on it.

**Their tokens are never edited.** `web/styles/lof-lms-tokens.css` is byte-identical to the file
they sent. Our `web/styles/tokens.css` only aliases their variables — it defines no colour of
its own — and `tailwind.config.ts` replaces Tailwind's palette, spacing, type scale,
letter-spacing and shadows with those variables, so Tailwind emits nothing of its own.
`npm --prefix web run check:tokens` fails the build on a raw hex, an rgb()/hsl(), a font-family
or a Tailwind default-palette class in the components.

The one exception is their render-blocking `@import` of Google Fonts. Since their file cannot be
edited, `npm --prefix web run gen:tokens` writes `web/styles/generated/lof-lms-tokens.css` —
their file with that single line removed — and the app imports that; the same three families are
self-hosted by `next/font`. The generator refuses to run if that line is not exactly what it
expects, and `check:tokens` fails if the generated copy is stale. It runs automatically before
`dev` and `build`.

**Contrast.** `npm --prefix web run report:contrast` measures every colour pair the app renders,
in both themes, straight from their token file — including text on gradients, which axe cannot
evaluate at all. Failures caused by our own usage are fixed in our components; failures that
belong to the LMS palette are written up in `docs/lms-contrast-findings.md` for the LMS team and
are **not** worked around by overriding their tokens.

## How Stage 3 works

- **Segmentation** (`src/segmentation.ts`) — pure rules, no AI. Matches active
  segments by subject, age range and completed-course prerequisites; picks the
  highest `start_level` the student qualifies for, or falls back to the lowest
  segment for the subject (with a warning). Segments are configured by
  management/SME in the `segments` table, never hardcoded.
- **Cold start** (`src/coldstart.ts`) — one function decides the strategy (above).
- **Week publishing** (`src/weekPublisher.ts`) — materialises a week from the
  active template (segment-specific wins over subject-wide). Creates 8 slots;
  slot 1 and any weekly slot open, the rest lock. **Idempotent**: re-publishing
  the same week is a no-op.
- **Slot filling** (`src/slotFiller.ts`) — when a slot opens, selects a mission
  at `current_level + level_offset` (clamped to the segment) with the slot's
  `mission_type` and `time_band`. If nothing matches it relaxes in a fixed,
  logged order — (a) widen difficulty ±1, (b) drop tag ranking, (c) widen
  time_band up — but **never** relaxes `mission_type` and **never** re-serves a
  mission. If still nothing, the slot stays open with no mission and a coverage
  gap is logged.
- **XP** (`src/xp.ts`) — point values live in `xp_rules` (SME/management-owned,
  never hardcoded). Every award is an `xp_events` row plus a `total_xp` increment
  in one transaction; a `(assignment, event_type)` guard prevents double awards.
  Points are awarded on **attempt** (first view), **submit**, and **correct**.
- **Progression** (`src/progression.ts`) — the no-demotion ladder. Correct →
  `min(level+1, segment.max_level)`; wrong → same level, `stall_count++`. At
  `stall_count == 3` it raises **one** `assistance_events` row (with the last 3
  failures) and resets the counter; the student still gets their next mission.
- **Slot unlock** (`src/slotUnlock.ts`) — after grading, marks the slot
  submitted, then (unless feedback gates it) opens and fills the next locked
  non-weekly slot, or completes the week.

## How Stage 5 works

- **Feedback questions** (`feedback_questions` table, `src/feedback.ts`) — the
  five post-mission questions are **data**, configured in the DB and editable
  live; nothing is hardcoded in the app or HTML. Seeded as clearly-marked
  PLACEHOLDERS for the SME/management to replace. `getQuestions()` returns the
  active set (cached for the process lifetime; a restart picks up edits).
- **Feedback capture** (`src/feedback.ts::submitFeedback`) — only after the
  mission is graded; validates every answer by type; requires all `required`
  questions; commits **all responses in one transaction** (never partial);
  marks the assignment complete; awards `feedback` XP **once** (guarded).
  Historical responses keep a **denormalised `question_key`** so they stay
  interpretable after a question is edited or retired.
- **Tracking** (`src/tracking.ts`) — `logAttempt` writes the audit trail
  (`attempt_logs`: opened / viewed / submitted / graded / feedback_submitted);
  `getStudentProgress`, `getSubmissionLog`, and the SME `getMissionQuality`
  report read from it.
- **Streaks** (`src/streaks.ts`) — consecutive submission days, **computed** from
  `attempt_logs` (never stored as a mutable counter). Today counts only if the
  student has submitted today; otherwise the count starts from yesterday so an
  in-progress day doesn't break a streak.
- **Mission-quality report** (`src/tracking.ts::getMissionQuality`) — for each
  mission with ≥5 graded attempts: pass rate, **observed difficulty** (derived
  from pass rate), median perceived difficulty and time-to-submit from feedback,
  and a **MISMATCH** flag when observed vs tagged difficulty differ by ≥2. This
  is what tells the SME which missions are mis-tagged. View it at **`/quality`**.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/students` | list students (with level + total_xp). `{ items }` |
| GET  | `/api/current/:studentId` | **⚠ deprecated** (Stage 1 free-play). The week board supersedes it; retained only for the Stage 1 harness — do not build new UI against it. |
| GET  | `/api/week/:studentId` | the week with all slots; **locked slots never include question text** |
| POST | `/api/slot/:slotId/open` | award `attempt` XP (once), return the mission |
| POST | `/api/submit` | grade, award `submit`/`correct` XP, unlock the next slot. Returns the **pinned `SubmitResponse` DTO** (`src/dto.ts`) including post-grade review — `correct_option_key` + `explanation` — because the platform builds ability, so a wrong answer is always shown the right one and why. Accepts an optional `Idempotency-Key` header — a retried submit returns the original result instead of re-grading. Concurrency-safe (grading takes a row-level `FOR UPDATE`, so only one of two simultaneous submits grades). |
| GET  | `/api/xp/:studentId` | total XP + last 20 events |
| GET  | `/api/segment/:studentId` | the student's segment and why they were placed |
| GET  | `/api/assistance` | open assistance events (instructor view). `{ items }` |
| GET  | `/api/history/:studentId` | last 5 level events. `{ items }` |
| GET  | `/api/feedback/questions` | active feedback questions (type + options). `{ items }` |
| POST | `/api/feedback/:assignmentId` | submit answers; returns XP; releases the gated next slot |
| GET  | `/api/progress/:studentId` | student progress panel (own data only) |
| GET  | `/api/submissions/:studentId` | paginated submission log (own data only) |
| GET  | `/api/missions` | mission-bank listing (SME/QC/admin), cursor-paginated |
| GET  | `/api/mission-quality` | SME report across all qualifying missions |
| GET  | `/api/mission-quality/:missionId` | single mission detail |
| GET  | `/api/attempts/:assignmentId` | attempt-log audit trail for one assignment |
| GET  | `/quality` | the SME mission-quality view (internal, not for students) |

A student may only read their **own** progress and submissions: the caller
identity comes from an `X-Student-Id` header (the LTI launch token later), and a
mismatch with the path student is refused with `403`.

**Pagination (Item 9).** Every list endpoint (submissions, XP history, attempt
log, mission bank, mission-quality) is **cursor-paginated**, keyed on
`(created_at, id)` — not offset, which shifts as rows are inserted. Response
shape is `{ items: [...], nextCursor: string | null }`; pass `?cursor=` back (with
optional `?limit=`, max 100) to fetch the next page.

**Uniform list envelope.** Non-paginated list endpoints (`/api/students`,
`/api/assistance`, `/api/history/:id`, `/api/feedback/questions`,
`/api/dev/users`) also return **`{ items: [...] }`** — no bare arrays — so a
single client data layer handles every list the same way. Confirmed by
`npm run verify:api-shape`.

## Safety guarantees

1. **Level never decreases** — there is no code path that reduces `current_level`.
2. **Locked-slot content is never returned** — enforced in the SQL, not the UI.
3. **XP is never double-awarded** for the same `(assignment, event_type)` —
   including `feedback` XP.
4. **XP writes are transactional** with the total update.
5. **All SQL is parameterised.**
6. **Assistance never blocks** a student from receiving their next mission.
7. **Feedback question text is never hardcoded** — it lives in `feedback_questions`
   and the UI renders from the API.
8. **Partial feedback is never saved** — all answers commit together or none do.
9. **Historical feedback stays interpretable** after a question is edited or
   retired, via the denormalised `question_key`.
10. **Streaks are computed, never stored** as a mutable counter.
11. **A student can only access their own** progress and submissions.
