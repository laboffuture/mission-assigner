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

## Stack

Node.js 20 · TypeScript (strict) · MySQL 8 · mysql2 (raw parameterised SQL, no
ORM) · Express 4 · tsx (no build step) · one static HTML file (vanilla JS).

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

### 4. Create schema, apply the Stage 3 migration, and seed

```bash
npm run db:schema    # base tables (Stage 1)
npm run db:migrate   # ADDITIVE Stage 3 migration: new tables + students columns
npm run db:seed      # 75 missions, 3 segments, week template, xp rules, 3 students
```

`db:migrate` is additive and idempotent — it only ever adds tables/columns and
is safe to run repeatedly against live data. Run it after `db:schema` and before
`db:seed`.

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
| `COLD_START_STRATEGY` | how a brand-new student is placed — see below |

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

## Commands

| command | purpose |
|---------|---------|
| `npm run db:schema` | (re)create base tables (Stage 1) |
| `npm run db:migrate` | additive Stage 3 migration (tables + students columns) |
| `npm run db:seed` | seed missions, segments, week template, xp rules, students |
| `npm run publish -- <studentId\|all> [YYYY-MM-DD]` | publish a week (idempotent; runs on a schedule in production) |
| `npm run dev` | start the server |
| `npm run verify` | Stage 1 acceptance harness |
| `npm run verify:stage3` | Stage 3 acceptance harness (14 criteria) |

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
  submitted, opens and fills the next locked non-weekly slot, or completes the
  week.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/students` | list students (with level + total_xp) |
| GET  | `/api/current/:studentId` | Stage 1 free-play mission |
| GET  | `/api/week/:studentId` | the week with all slots; **locked slots never include question text** |
| POST | `/api/slot/:slotId/open` | award `attempt` XP (once), return the mission |
| POST | `/api/submit` | grade, award `submit`/`correct` XP, unlock the next slot |
| GET  | `/api/xp/:studentId` | total XP + last 20 events |
| GET  | `/api/segment/:studentId` | the student's segment and why they were placed |
| GET  | `/api/assistance` | open assistance events (instructor view) |
| GET  | `/api/history/:studentId` | last 5 level events |

## Safety guarantees

1. **Level never decreases** — there is no code path that reduces `current_level`.
2. **Locked-slot content is never returned** — enforced in the SQL, not the UI.
3. **XP is never double-awarded** for the same `(assignment, event_type)`.
4. **XP writes are transactional** with the total update.
5. **All SQL is parameterised.**
6. **Assistance never blocks** a student from receiving their next mission.
