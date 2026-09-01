# Mission Demo

A production-schema demo of an automated student-mission platform. It has three
stages, all sharing one MySQL database:

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

`.github/workflows/ci.yml` runs on every push and pull request against a MySQL 8
service container: `npm ci`, `typecheck`, `lint`, `format:check`, `db:migrate`,
then **all** suites via `npm run verify:all` (Node harnesses + the Stage 2
pytest). The build fails if any step fails. ESLint (flat config,
`typescript-eslint`) lints `src/**/*.ts`; Prettier enforces formatting.

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
npm run db:migrate   # bring the database to current (runs all pending migrations)
npm run db:seed      # 75 missions, 3 segments, week template, xp rules, 5 feedback questions, 3 students + 4 staff
```

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
docker exec mission-mysql sh -c \
  "mysql_tzinfo_to_sql /usr/share/zoneinfo | mysql -uroot -pdevpass mysql"
```

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
| `AUTH_MODE` | `dev` (header identity, insecure) or `lti` (launch token, stub) — see Authentication |
| `COLD_START_STRATEGY` | how a brand-new student is placed — see below |
| `FEEDBACK_GATES_UNLOCK` | whether feedback is required before the next slot unlocks — see below |

## Authentication & authorisation (Item 1)

Identity is resolved by a pluggable provider (`src/auth.ts`) selected by
`AUTH_MODE`:

- **`dev`** (default) — `DevAuthProvider` reads an **`X-User-Id`** header
  (`X-Student-Id` accepted as an alias) and loads the user's role/subject from
  the DB. This trusts a client-set header and is **INSECURE**; the server logs a
  loud warning at boot. The dev login roster (`GET /api/dev/users`) exists only
  in this mode and is the one unauthenticated API route (logging in is
  inherently pre-auth). The UI's dropdown is that login.
- **`lti`** — `LtiAuthProvider` will read the LTI 1.3 launch token. It is a
  **stub** that throws until we have LTI access, so selecting it fails loudly
  rather than allowing access.

**Roles** live on `students.role`: `student`, `sme`, `qc`, `instructor`,
`admin`. `requireAuth` populates `req.auth`; `requireRole(...)` gates endpoints.
Every `/api` route requires authentication (401 otherwise). **Ownership** is
enforced with the authenticated id in the SQL `WHERE` clause: a student may only
read their own progress/submissions/XP/attempts/etc. (a cross-student read is a
**403**, never an empty 200). Student actions (open/submit/feedback) are
`student`-only. The **mission-quality** report (`/api/mission-quality*`, the data
behind `/quality`) is **SME/QC/admin only**; `/api/students` (the full roster) is
staff-only.

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
| `npm run db:migrate:status` | show applied / pending migrations |
| `npm run db:migrate:down` | revert the last migration |
| `npm run db:seed` | seed missions, segments, week template, xp rules, feedback questions, students |
| `npm run publish -- <studentId\|all> [YYYY-MM-DD]` | publish a week (idempotent; runs on a schedule in production) |
| `npm run dev` | start the server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` / `lint:fix` | ESLint (TypeScript) |
| `npm run format` / `format:check` | Prettier |
| `npm run backup` / `restore` / `backup:verify` | database backup, restore, and tested-restore |
| `npm run verify` | Stage 1 acceptance harness |
| `npm run verify:stage3` | Stage 3 acceptance harness |
| `npm run verify:stage5` | Stage 5 acceptance harness |
| `npm run verify:auth` | auth acceptance harness (role + ownership) |
| `npm run verify:logging` | logging + error-shape harness |
| `npm run verify:validation` | input-validation harness |
| `npm run verify:migrations` | migrations harness (fresh == current, idempotent, reversible) |
| `npm run verify:all` | run **all** suites in one pass |

> **Feedback gating is injectable per test.** `FEEDBACK_GATES_UNLOCK` is read
> through `src/config.ts::feedbackGatesUnlock()` (never at import time) and backed
> by a settings object. Each harness sets its own value — Stage 3 turns gating
> **off** (its slots must unlock immediately on submit), Stage 5 turns it **on** —
> both in-process and, for HTTP-driven checks, on the server via the guarded
> `POST /api/test/feedback-gating` hook. So `npm run verify:all` runs the entire
> suite green in a single pass with no env change or restart. The hook only works
> when the server is started with `ENABLE_TEST_HOOKS=1`, so it is never exposed in
> production.

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
| GET  | `/api/students` | list students (with level + total_xp) |
| GET  | `/api/current/:studentId` | Stage 1 free-play mission |
| GET  | `/api/week/:studentId` | the week with all slots; **locked slots never include question text** |
| POST | `/api/slot/:slotId/open` | award `attempt` XP (once), return the mission |
| POST | `/api/submit` | grade, award `submit`/`correct` XP, unlock the next slot. Accepts an optional `Idempotency-Key` header — a retried submit returns the original result instead of re-grading. Concurrency-safe (grading takes a row-level `FOR UPDATE`, so only one of two simultaneous submits grades). |
| GET  | `/api/xp/:studentId` | total XP + last 20 events |
| GET  | `/api/segment/:studentId` | the student's segment and why they were placed |
| GET  | `/api/assistance` | open assistance events (instructor view) |
| GET  | `/api/history/:studentId` | last 5 level events |
| GET  | `/api/feedback/questions` | active feedback questions (type + options) |
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
