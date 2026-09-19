# Mission Hub — Complete Project Overview

_An adaptive student-mission learning platform. This document is a pin-to-pin record of
everything built so far: architecture, every endpoint, every source file, the database
schema history, theming and security discipline, the full test suite, git history, how to
run it, and what remains before a real pilot._

Last updated: 2026-09-09

---

## 1. What Mission Hub is

Mission Hub delivers short, adaptive learning "missions" to students. A student sees a
**week board** of slots; each slot holds a mission (a question with multiple-choice
options). Answering a mission grades it, awards XP, adjusts the student's difficulty
**segment/level**, tracks a daily **streak**, and — after every mission — asks a short
**feedback** question. Staff (instructors/admins) get an **assistance queue** that surfaces
students who are stalling so a human can step in for a ~5-minute intervention.

Two surfaces, one identity system:

- **Students** — week board → mission → teaching result → feedback → progress.
- **Staff** — an assistance queue to triage and resolve students who need help.

---

## 2. Architecture at a glance

```
Browser ──▶ Next.js (web, :3001)  ──rewrites /api/*──▶  Express API (:3000)  ──▶  MySQL 8 (Docker)
            App Router, React 18                        TypeScript, mysql2          mission-mysql
            same-origin UI                              raw parameterised SQL       container
```

- **Same-origin** deployment. The browser only ever talks to `:3001`. `next.config.mjs`
  rewrites `/api/*` to the Express origin (`API_ORIGIN`, default `http://localhost:3000`),
  so cookies are first-party and there is no CORS surface.
- **Express is the sole identity authority.** Next.js **never decodes the session cookie**.
  It forwards the incoming `Cookie` header to `GET /api/me` and trusts that answer. This keeps
  one source of truth for auth and avoids session logic drifting between two codebases.
- **No ORM.** All database access is hand-written parameterised SQL via `mysql2`. Role and
  ownership checks are enforced **in SQL**, not just in the application layer.
- **No build step for the API in dev** — `tsx watch` runs TypeScript directly.

### Tech stack

| Layer        | Choice                                                              |
|--------------|---------------------------------------------------------------------|
| API runtime  | Node 20/22, TypeScript (strict), Express 4, `tsx` (dev: `tsx watch`)|
| Database     | MySQL 8 in Docker (container `mission-mysql`), `mysql2` driver      |
| Validation   | `zod` at the HTTP boundary (`validate()` middleware)                |
| Web          | Next.js 14 (App Router), React 18                                   |
| Styling      | Tailwind mapped to CSS custom properties (design tokens)            |
| Server tests | Node scripts (`verify-*.mjs`) hitting a live server + DB            |
| E2E tests    | Playwright (chromium) + `@axe-core/playwright` for accessibility    |

---

## 3. API endpoints (complete surface)

From `src/server.ts` plus the auth routes in `src/authRoutes.ts`.

### Identity & auth
| Method & path            | Auth            | Purpose |
|--------------------------|-----------------|---------|
| `POST /api/login`        | public          | Staff username/password → signed session cookie |
| `POST /api/logout`       | session         | Clears the session cookie |
| `GET  /api/me`           | session         | Returns the current identity `{ id, role, ... }` — the **only** place the session is decoded |

### Dev convenience (guarded)
| Method & path             | Auth | Purpose |
|---------------------------|------|---------|
| `GET  /api/dev/users`     | dev  | Roster for the login page's "log in as" picker |
| `POST /api/dev/login-as`  | dev  | Sets a real session cookie for a chosen student — lets the UI be developed against the real authenticated API without LTI |

### Student surface
| Method & path                     | Auth              | Purpose |
|-----------------------------------|-------------------|---------|
| `GET  /api/week/:studentId`       | session           | The week board: slots with status `locked`/`empty`/`filled`, plus `is_weekly` |
| `POST /api/submit`                | student           | Submit an answer. Idempotent (`Idempotency-Key`). Returns grade **plus** the correct option key and the explanation from the answer key (the teaching moment) |
| `GET  /api/segment/:studentId`    | session           | The student's current segment/level (plain-language placement) |
| `GET  /api/history/:studentId`    | session           | Submission history |
| `GET  /api/progress/:studentId`   | session           | Progress panel data: level, streak, XP, cursor-paginated log |
| `GET  /api/feedback/questions`    | session           | The active feedback question(s) — the feedback form renders entirely from this; no question is ever hardcoded |
| `GET  /api/assignment/:id/review` | session (owner)   | **Piece 2** — read-only review of the student's own completed assignment. Ownership enforced in SQL |

### Staff surface — assistance queue (instructor/admin only, enforced in SQL)
| Method & path                          | Purpose |
|----------------------------------------|---------|
| `GET  /api/assistance`                 | **Piece 1** — open items, **oldest first**, cursor-paginated |
| `GET  /api/assistance/:id`             | Detail for a 5-minute intervention (failed missions expanded, level history) |
| `POST /api/assistance/:id/acknowledge` | Mark as acknowledged (409 if already resolved) |
| `POST /api/assistance/:id/resolve`     | Resolve with a **required** note (400 if blank/too long) |

### Staff / admin (existing)
| Method & path         | Auth        | Purpose |
|-----------------------|-------------|---------|
| `GET  /api/students`  | staff roles | Student roster for staff |

### Test hooks (only when `ENABLE_TEST_HOOKS=1`)
`POST /api/test/feedback-gating`, `GET /api/test/boom`, `GET /api/test/logs`,
`POST /api/test/reset-rate-limit`, `POST /api/test/clear-feedback-cache`. These let the
verifier scripts flip config and inspect behaviour without restarting the server. They 403
when the flag is off.

> **Deprecated:** `GET /api/current/:studentId` is deprecated in code + README but kept for
> the Stage 1 test harness.

---

## 4. Database schema — migration history

Migrations are run by `umzug` via `src/migrator.ts` (`npm run db:migrate`). They are numbered
and reversible; `verify-migrations.mjs` diffs a fresh scratch DB against the current schema to
guarantee they match and are idempotent.

| #   | File                                  | What it adds |
|-----|---------------------------------------|--------------|
| 001 | `001_initial_schema.ts`               | Core tables: students, missions, options, assignments, responses |
| 002 | `002_stage3_segments_weeks_xp.ts`     | Segments/levels, week templates, XP |
| 003 | `003_stage5_feedback_tracking.ts`     | Feedback questions/answers, tracking, `assistance_events` |
| 004 | `004_auth_roles.ts`                   | Roles (student/instructor/admin/sme/qc) |
| 005 | `005_student_timezone.ts`             | Per-student timezone (for correct streak boundaries) |
| 006 | `006_idempotency_keys.ts`             | Idempotency key storage for safe submit retries |
| 007 | `007_staff_credentials.ts`            | Staff username/password credentials |
| 008 | `008_assistance_workflow.ts`          | Assistance workflow columns: `acknowledged_at/by`, `resolved_at/by`, `resolution_note` (additive + reversible) |

### `assistance_events` (the escalation record)
Raised in `src/progression.ts` when a student crosses `STALL_THRESHOLD = 3` wrong answers.
Columns: `id`, `student_id`, `trigger_reason`, `level_at_trigger`, `context` (JSON:
`{ failed_assignments: [{assignment_id, mission_id, selected, tags}], tags_involved: [] }`),
`status` enum(`open`/`acknowledged`/`resolved`), plus the 008 workflow columns.

---

## 5. API source files (`mission-demo/src/`)

| File               | Responsibility |
|--------------------|----------------|
| `server.ts`        | Express app: wires every route, middleware, validation, and test hooks |
| `authRoutes.ts`    | `/api/login`, `/api/logout`, `/api/me` |
| `auth.ts`          | `requireAuth`, `requireRole`, role constants |
| `session.ts`       | Signed session cookie issue/verify (the only place sessions are decoded) |
| `csrf.ts`          | Double-submit CSRF token; enforced only when `CSRF_ENFORCED=true` |
| `rateLimit.ts`     | Login rate limiting (5 failures/username/15 min → 429; no account-existence leak) |
| `db.ts`            | MySQL pool |
| `schemas.ts`       | `zod` schemas for params/bodies (`studentIdParams`, `submitBody`, `idParams`, `resolveAssistanceBody`, pagination query, …) |
| `validate.ts`      | `validate({params,body,query})` middleware → unified 400 error shape |
| `pagination.ts`    | Keyset cursor pagination helper → `{ items, nextCursor }`; opaque base64url cursor; `DEFAULT_LIMIT=20`, `MAX_LIMIT=100` |
| `assistance.ts`    | **Piece 1 logic:** `listOpenAssistance` (oldest-first), `getAssistanceDetail`, `acknowledgeAssistance`, `resolveAssistance`, `AssistanceError` |
| `tracking.ts`      | **Piece 2 logic:** `getAssignmentReview(assignmentId, requesterStudentId)` returning `ok`/`not_found`/`forbidden`/`not_graded`; plus submission tracking |
| `grading.ts`       | Grades a submitted answer against the answer key |
| `progression.ts`   | Segment/level progression; raises assistance events on stall |
| `segmentation.ts`  | Segment/level model and lookups |
| `selection.ts`     | Mission selection logic |
| `slotFiller.ts`    | Lazy-fills a slot's mission on first open |
| `slotUnlock.ts`    | Unlock rules between slots |
| `weekPublisher.ts` / `publish.ts` | Builds/publishes week templates |
| `feedback.ts`      | Feedback question serving + cache |
| `streaks.ts`       | Daily streak computation (timezone-aware) |
| `xp.ts`            | XP awards |
| `coldstart.ts`     | Cold-start placement for new students |
| `dto.ts`           | Response DTOs (snake_case, mirror the DB; no auto-camelCasing) |
| `config.ts` / `env.ts` | Config loading + validation (refuses to boot on bad env) |
| `securityChecks.ts`| Production guard (refuses to boot in prod with default staff passwords) |
| `logger.ts` / `sentry.ts` | Structured logging (request id, redaction) + error reporting |
| `httpError.ts`     | Typed HTTP errors → consistent JSON error shape |
| `migrator.ts`      | umzug migration runner |
| `seed.ts`          | Deterministic demo seed data |
| `setPassword.ts`   | CLI to set a staff password |

---

## 6. Web source files (`mission-demo/web/`)

### App routes (`web/app/`) — App Router
Every route has its own themed `error.tsx` + `loading.tsx` boundary (no unstyled Next
defaults). Cookie-using routes are dynamic.

| Route                                   | Purpose |
|-----------------------------------------|---------|
| `app/page.tsx` / `app/week/page.tsx`    | Week board (primary student screen) |
| `app/mission/[slotId]/page.tsx`         | Mission view — dispatches to runner (open), review (submitted), or notice (locked) |
| `app/feedback/[assignmentId]/page.tsx`  | Post-mission feedback form |
| `app/progress/page.tsx`                 | Progress panel |
| `app/login/page.tsx`                     | Student dev roster **and** staff username/password sign-in |
| `app/staff/assistance/page.tsx`         | Instructor assistance queue |
| `app/staff/assistance/[id]/page.tsx`    | Assistance detail (triage + ack/resolve) |
| `app/layout.tsx`, `app/globals.css`     | Root layout; global CSS (`:focus-visible` ring, `.sr-only`, reduced-motion) |

### Components (`web/components/`)
- **UI primitives:** `ui.tsx` (PageShell, Card, Button, Badge, Muted…), `Header.tsx`,
  `SignOutButton.tsx`, `states.tsx` (LoadingCard/ErrorState/Spinner), `RadioGroup.tsx`
  (native radios, visible focus ring, non-colour ✓ marker).
- **Week:** `week/WeekBoard.tsx`, `week/SlotTile.tsx`, `week/WeeklyCard.tsx`.
- **Mission:** `mission/MissionRunner.tsx` (client; opens slot once, double-tap-safe submit),
  `mission/ResultView.tsx` (teaching result), `mission/ReviewView.tsx` (read-only review).
- **Feedback:** `feedback/FeedbackForm.tsx` (data-driven from the API, client-validated).
- **Progress:** `progress/Hero.tsx` (level + streak), `progress/PlacementCard.tsx`,
  `progress/SubmissionLog.tsx` (cursor-paginated "Load more").
- **Staff:** `staff/AssistanceQueue.tsx`, `staff/AssistanceActions.tsx`,
  `staff/AccessDenied.tsx`.

### Lib (`web/lib/`)
| File              | Purpose |
|-------------------|---------|
| `api/server.ts`   | RSC fetch client — forwards the `Cookie` header, `cache: no-store`, never decodes the session |
| `api/client.ts`   | Browser fetch client — relative URLs, echoes the `mh_csrf` cookie as `X-CSRF-Token` on mutations, **401 interceptor → `/login`** |
| `api/types.ts`    | Pinned DTOs mirroring the server exactly (snake_case), incl. the slot discriminated union via `normalizeSlot()`, and the assistance/review types |
| `api/error.ts`    | Client error typing |
| `session.ts`      | `getMe()` helper used by server components to gate routes |
| `week.ts`         | Slot state → symbol mapping (`✓ ▶ 🔒`) and helpers |
| `time.ts`         | `formatWaiting`, `waitingUrgency`, `formatDateTime` for the queue |

---

## 7. Theming discipline (design tokens)

- `web/styles/tokens.css` is the **single source of raw values** (colours, fonts). These are
  placeholders until the real LMS theme values land.
- `tailwind.config.ts` maps **semantic names** (e.g. `success`, `danger`, `border`,
  `surface`, `text-muted`, `focus`) to those CSS variables.
- `scripts/check-no-raw-values.mjs` (`npm run check:tokens`) **fails the build** if any
  hex/rgb/hsl colour or `font-family` appears in `app/` or `components/`. Components may only
  use semantic token classes. This keeps the whole UI re-themeable by editing one file.

---

## 8. Security & correctness properties

- **Role/ownership enforced in SQL.** Assistance endpoints are instructor/admin only; the
  review endpoint checks the assignment belongs to the requesting student — both in the query,
  not just the handler.
- **CSRF:** double-submit token (`mh_csrf` cookie ↔ `X-CSRF-Token` header) behind
  `CSRF_ENFORCED` (default off; flip on with `SESSION_SAMESITE=none` for an LTI iframe).
- **Idempotent submit:** `POST /api/submit` takes an `Idempotency-Key`; a retry after a
  network drop reuses the **same** key and returns the original grade — never double-grades,
  double-awards XP, or double-unlocks.
- **Login rate limit:** 5 failures/username/15 min → 429, with no account-existence leak.
- **Session cookie flags:** HttpOnly / SameSite / Secure policy varies correctly by env.
- **Boot guards:** refuses to start on invalid env, or in production while any staff account
  still has the default `changeme` password.
- **Secrets:** the Gemini API key lives only in gitignored `pipeline/.env` and must never be
  committed (and should be rotated). `.env` and `pipeline/.env` are gitignored. The local
  MySQL password `devpass` is local-dev only.

---

## 9. Test suite (all green)

### Server verifiers (Node scripts against a live server + DB)
Run individually (`npm run verify:<name>`) or all at once with `npm run verify:all`
(`run-all.mjs` reseeds between suites and flips feedback-gating per suite):

`verify` (Stage 1), `verify:stage3`, `verify:stage5`, `verify:auth`, `verify:staff-auth`,
`verify:api-shape`, **`verify:assistance` (Piece 1)**, **`verify:review` (Piece 2)**,
`verify:csrf`, `verify:login-ratelimit`, `verify:cookie-flags`, `verify:logging`,
`verify:validation`, `verify:migrations`, `verify:config`, `verify:prod-guard`,
`verify:timezone`, `verify:concurrency`, `verify:pagination`.

Highlights:
- **verify:assistance** — role gating (401 unauth / 403 student / 403 sme / 200 instructor),
  oldest-first ordering with metadata, pagination `limit=1`, detail expansion, acknowledge
  (drops from open list), resolve (400 no/blank note, 200 with note, stored, 409 re-resolve).
- **verify:review** — owner 200 with every field, `correct=true` for a right answer,
  cross-student 403, unauth 401, unknown 404, ungraded 409.

### Playwright e2e (`web/e2e/`)
`a11y.spec.ts`, `keyboard.spec.ts`, `student-flow.spec.ts`, `empty-states.spec.ts`,
`submit-resilience.spec.ts`, `mission-review.spec.ts`, `staff-assistance.spec.ts`, plus
`helpers.ts` and `fixtures/make-assistance-event.mjs`. Covers the full student journey
(week → mission → result → feedback → progress), empty states, a simulated network failure on
submit, the staff queue (login → queue → detail → acknowledge → resolve, plus sme refused),
and mission review. `@axe-core/playwright` runs WCAG 2.1 A/AA checks including colour contrast.

### Accessibility (built in, not bolted on)
Feedback pills and the 1–5 scale are proper **radiogroups** with endpoint labels; full
keyboard navigation; visible focus states; SR labels on options, slot states, and progress
numbers; **never colour alone** — done/open/coming and correct/incorrect each carry a glyph +
word signal (≈1 in 12 boys has a colour-vision deficiency). Locked slots are **announced as
locked** to screen readers, not merely greyed. Contrast was verified against the placeholder
tokens; the real check happens when the LMS theme values arrive.

---

## 10. Git history

31 commits on `master`. Most recent feature work:

```
10642b2  Piece 2: mission review — a completed slot opens a read-only review
03f2e55  Piece 1: instructor assistance queue (API + Next staff UI)
c0f41ae  Accessibility pass on the student surface (item 4)
21dad2f  Playwright e2e for the student surface (item 3)
8547f23  Graceful failure & session expiry (item 2)
89fe7f9  Progress panel (e): motivating numbers, plain-language placement, paginated log
9c106a4  Feedback form (d): data-driven, client-validated, rewarding
9d888c1  Mission view (c): answer flow, teaching result, safe submit
b55d785  Week board (b): primary student screen + surface is_weekly on /api/week
b420d7a  Student web scaffold (a): Next.js app, tokens, typed API client, session
2dbb06f  API adjustments before the UI scaffold: DTO, lists, CSRF, dev login, review data
```

Both final pieces are committed and pushed.

> A **project-end history rewrite** is planned: strip the `Co-Authored-By: Claude` trailers
> and normalize author emails in one pass, then force-push. Not done yet.

---

## 11. How to run it locally

Prerequisites: Docker Desktop running with the `mission-mysql` container up, Node installed.

```bash
# 1. API (port 3000) — test hooks on so the verifier suite can run
cd "mission-demo"
ENABLE_TEST_HOOKS=1 npm run dev

# 2. Web (port 3001) — in a second terminal
cd "mission-demo/web"
npm run dev

# 3. Open the UI (same-origin; you never hit :3000 directly)
#    http://localhost:3001/login
```

- **Student login:** pick a name from the dev roster on `/login` (uses `/api/dev/login-as`).
  Lands on the week board.
- **Staff login:** use the username/password form on `/login` (instructor/admin →
  `/staff/assistance`).

Run the whole server test suite: `npm run verify:all` (requires the API up with
`ENABLE_TEST_HOOKS=1`). Run e2e: `cd web && npm run e2e`.

---

## 12. Outstanding / parked work

| Item | Status |
|------|--------|
| **LTI 1.3 real student auth** | **The pre-pilot blocker.** Currently stubbed. Deliberately held — a mock only proves we can parse our own tokens; real failure modes need a live Moodle/LMS. |
| Content richness | Waiting on the SME's actual mission content. |
| Next.js major upgrade | Deferred until after the pilot (not during active feature work). |
| Git history rewrite | Planned for project end (strip Claude co-author trailers, normalize emails, force-push). |

---

_End of overview._
