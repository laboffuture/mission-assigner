# Stage 2 — Mission Generation Pipeline

An **offline batch pipeline** that turns a subject-matter expert's (SME) content
documents into draft quiz missions in the same MySQL database the Node web app
uses. It is run manually from the command line, per content drop. It is **not**
part of the web application and is never called from a request handler.

```
SME docs (input/) ─▶ ingest ─▶ generate ─▶ validate ─▶ import ─▶ missions(status='draft')
                                                                         │
                                             export-review ◀────────────┘
                                                    │  (SME fills the sheet)
                                             import-review ─▶ missions(status='live' | 'retired')
```

Nothing is ever written as `live` by the pipeline. Only human review, applied
through `import-review`, promotes a mission to `live`.

---

## Setup

Requires **Python 3.11+** and a running MySQL 8 (the same instance the Node app
uses — by default `mission-mysql` on `127.0.0.1:3306`).

```bash
cd mission-demo/pipeline

# 1. create an isolated virtual environment (does not touch the Node app)
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

# 2. install dependencies
pip install -r requirements.txt

# 3. configure
cp .env.example .env      # then edit .env
```

The first command you run applies the additive schema changes automatically
(creates `content_chunks`, adds `source_chunk_id` / `generated_at` /
`review_notes` to `missions`). This migration is safe to run against live data —
it only adds, never drops.

### .env keys

| key | meaning |
|-----|---------|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME` | MySQL connection (same DB as the Node app) |
| `LLM_PROVIDER` | `anthropic` \| `openai` \| `mock` |
| `LLM_MODEL` | model id for the chosen provider (ignored by `mock`) |
| `ANTHROPIC_API_KEY` | required when `LLM_PROVIDER=anthropic` |
| `OPENAI_API_KEY` | required when `LLM_PROVIDER=openai` |

**`mock` provider:** an offline, deterministic backend for testing the pipeline
without an API key. It drafts missions whose `source_quote` is a real sentence
lifted verbatim from the chunk, so validation behaves exactly as it would for a
well-behaved real model. Switch `LLM_PROVIDER` to `anthropic` (or `openai`) and
set the matching key to generate for real. If the key is missing, `generate`
fails immediately with a clear message rather than partially processing.

---

## Commands

Every command accepts `--dry-run` to print what it would do without writing.

| command | what it does |
|---------|--------------|
| `python -m src.main ingest` | read `input/`, split into chunks, hash them, report `new / changed / unchanged`, and queue new+changed chunks for generation |
| `python -m src.main generate` | make one LLM call per queued chunk, log every request/response to `logs/`, stage drafts |
| `python -m src.main validate` | run all validation checks, report pass/fail with reasons |
| `python -m src.main import` | write validated drafts as `status='draft'` |
| `python -m src.main run` | ingest + generate + validate + import in one go |
| `python -m src.main export-review [--out FILE]` | export all `draft` missions to an Excel review workbook |
| `python -m src.main import-review FILE` | apply the reviewer's decisions from the returned workbook |
| `python -m src.main coverage` | grid of live mission counts per (level × tag); flags cells with `< 5` as `GAP` |

---

## The review workflow

1. **Generate drafts.** `python -m src.main run` (with a real provider). Missions
   land as `draft`.
2. **Export.** `python -m src.main export-review` produces `review_<timestamp>.xlsx`.
   One row per mission, header frozen, with three reviewer columns tinted yellow:
   - **APPROVE** — a dropdown of `YES` / `NO` / `EDIT`
   - **CORRECTED_ANSWER** — set the correct option (a/b/c/d) when using `EDIT`
   - **REVIEW_NOTES** — free-text reason, stored on the mission
3. **SME/QC reviews** the sheet, using the `source_quote` column to verify each
   answer key against the source without reading the whole document.
4. **Import back.** `python -m src.main import-review review_<timestamp>.xlsx`:
   - `YES` → mission goes `live`
   - `NO` → mission is `retired`, notes stored
   - `EDIT` → `CORRECTED_ANSWER` applied to the answer key, mission goes `live`
   - blank → left as `draft`, reported as unreviewed
5. **Check coverage.** `python -m src.main coverage` shows which (level × tag)
   cells have fewer than 5 live missions and still need content.

---

## Safety guarantees

- Nothing generated is ever written as `live`. Only `import-review` promotes.
- Missions are never deleted — superseded ones are `retired`. Historical
  assignments still reference them.
- Every LLM request and response is logged to `logs/`, keyed by `chunk_ref`.
- All SQL uses parameterised queries.
- `input/`, `logs/`, and `.env` are gitignored.
- Chunk identity (`chunk_ref`) is derived from the heading path, not document
  position, so editing one section marks only that section as `changed`.

---

## Folder layout

```
pipeline/
  .env.example         config template
  requirements.txt
  README.md
  config/
    templates.json     mission-type templates (only `quiz` active)
    levels.json        difficulty scale 0–4
    tags.json          controlled tag vocabulary
  input/               SME documents dropped here (gitignored)
  logs/                LLM request/response logs + working state (gitignored)
  src/
    db.py              connection, config loaders, additive schema migration
    reader.py          .docx / .pdf / .md / .txt -> sections
    chunker.py         sections -> hashed chunks; new/changed/unchanged
    generator.py       LLM drafting (anthropic | openai | mock)
    validator.py       reject invalid or invented missions
    importer.py        write drafts; retire superseded missions
    export_review.py   drafts -> Excel review workbook
    import_review.py   apply reviewer decisions
    main.py            CLI
```
