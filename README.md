# Mission Demo

A minimal, production-schema demo of an automated student-mission loop:
a student is assigned a mission from a bank, submits an answer, is auto-graded,
and their difficulty level adapts up or down based on the result.

## Stack

Node.js 20 LTS · TypeScript (strict) · MySQL 8 · mysql2 (raw SQL, no ORM) ·
Express 4 · tsx (no build step) · one static HTML file (vanilla JS).

## Setup

### 1. Start MySQL 8

```bash
docker run --name mission-mysql \
  -e MYSQL_ROOT_PASSWORD=devpass \
  -e MYSQL_DATABASE=mission_demo \
  -p 3306:3306 -d mysql:8
```

### 2. Configure environment

```bash
cp .env.example .env
```

The defaults match the Docker command above (`DB_USER=root`, `DB_PASS=devpass`).

### 3. Install dependencies

```bash
npm install
```

### 4. Create schema and seed data

```bash
npm run db:schema   # creates the database + 8 tables
npm run db:seed     # inserts 50 missions, 200 options, 50 tags, 3 students
```

### 5. Run

```bash
npm run dev
```

Open <http://localhost:3000>.

## How it works

- **Selection** (`src/selection.ts`) — pure SQL. Hard-filters missions by
  status/subject/exact difficulty/age/not-yet-assigned, then ranks by
  student-interest tag overlap (tie-break `RAND()`), `LIMIT 10`. Every
  selection is written to `selection_log` with the full candidate list.
- **Grading + ladder** (`src/grading.ts`) — a correct answer scores 100% and
  levels the student up (capped at 4). A first fail holds the level; a second
  consecutive fail drops it (floored at 0). Each change is recorded in
  `level_events`.
- **No repeats** — the `assignments` UNIQUE KEY `(student_id, mission_id)`
  guarantees a student never sees the same mission twice.

## API

| Method | Path                      | Purpose                              |
|--------|---------------------------|--------------------------------------|
| GET    | `/api/students`           | List the 3 demo students             |
| GET    | `/api/current/:studentId` | Current open mission (or select one)  |
| POST   | `/api/submit`             | `{ assignmentId, selected }` → result |
| GET    | `/api/history/:studentId` | Last 5 level events                  |

## Out of scope (by design)

No auth, no LLM/AI, no Moodle/LTI, quiz missions only, no batches, no
gamification, no Docker Compose/Redis/test framework.
