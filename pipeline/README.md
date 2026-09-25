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

**Run the Node migrations first.** The pipeline does not create schema; it
checks for it. Every object it needs (`content_chunks`, and
`source_chunk_id` / `generated_at` / `review_notes` / `source_chunk_hash` plus
`idx_missions_source_chunk` on `missions`) belongs to migration
`010_adopt_pipeline_schema`, with `missions.hour_id` coming from
`009_curriculum` as reshaped by `012_hours`:

```bash
cd ../  &&  npm run db:migrate      # in mission-demo
```

If anything is missing, every pipeline command stops before doing any work and
names the missing objects:

```
FATAL: The database is missing 2 object(s) owned by the migration chain:
  - column missions.review_notes
  - index missions.idx_missions_source_chunk

Run `npm run db:migrate` in mission-demo (migrations 009_curriculum,
010_adopt_pipeline_schema and 012_hours) before running the pipeline.
```

It used to create these itself at runtime with `CREATE TABLE IF NOT EXISTS` and
`ALTER TABLE ... ADD COLUMN`. That put six objects outside the migration chain,
where `verify:migrations` could not see them — so schema drift went unnoticed
through 31 commits. The database now has exactly one owner.

### .env keys

| key | meaning |
|-----|---------|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME` | MySQL connection (same DB as the Node app) |
| `LLM_PROVIDER` | `anthropic` \| `openai` \| `google` \| `mock` \| `hostile` |
| `LLM_MODEL` | model id for the chosen provider (ignored by `mock`) |
| `ANTHROPIC_API_KEY` | required when `LLM_PROVIDER=anthropic` |
| `OPENAI_API_KEY` | required when `LLM_PROVIDER=openai` |
| `GEMINI_API_KEY` | required when `LLM_PROVIDER=google` (falls back to `GOOGLE_API_KEY`) |
| `LLM_REQUESTS_PER_MINUTE` | how fast generation may call the provider. Default **5** — the Gemini free tier's limit. See below |
| `HOUR_HEADING_PATTERN` | overrides the hour-heading regex for every file (a single file's mapping can override it for itself) |

### Pacing, and why generation waits

Generation is an offline batch job, so being slow is cheap and being refused is
not. Two rules keep a run alive:

- **`LLM_REQUESTS_PER_MINUTE` (default 5)** paces the calls. 5 is the Gemini
  free tier's per-minute limit; the free tier *also* allows only **20 requests a
  day**, which no pacing can work around — a 25-hour credit does not fit in one
  free day. On a paid tier the real ceiling is per-account and is shown on the
  [AI Studio rate-limit page](https://aistudio.google.com/rate-limit), not in the
  public docs, so pick a value you have checked rather than assuming one.
  Local fakes (`mock`, `hostile`) are never paced: they have no quota, and pacing
  them adds minutes to every test run.
- **The provider's own retry delay is honoured.** A 429 carries
  `RetryInfo.retryDelay` ("53s"); waiting 1s and 2s instead spends every retry
  inside the same closed window and recovers from nothing. Capped at 120s.

Keep both even on a paid plan: 503s happen at any tier.

### Sampling parameters are model-conditional

Newer models **removed** the sampling parameters rather than restricting them:
on Anthropic's Opus 4.7/4.8, Opus 5, Sonnet 5 and the Fable/Mythos 5 family, and
on OpenAI's reasoning models (o1/o3/o4, gpt-5), sending `temperature` at *any*
value returns a 400. Lowering it does not help — it has to be omitted.

`generator.accepts_temperature()` is therefore an **allowlist** of the older
models that take `temperature=0`; everything else omits it and prints a one-time
note. An allowlist is the safe direction: a model released after this code omits
the parameter and works, where a denylist would send it and hard-fail. OpenAI
reasoning models additionally need `max_completion_tokens` instead of
`max_tokens`, handled at the same call site.

Consequence: on an omitting model drafts are no longer bit-reproducible. That is
acceptable because correctness never depended on sampling determinism — the
validator rejects any mission whose `source_quote` is not present verbatim in
the source chunk. `tests/test_provider_params.py` pins the capability table and
asserts the exact kwargs each client sends.

**`mock` provider:** an offline, deterministic backend for testing the pipeline
without an API key. It drafts missions whose `source_quote` is a real sentence
lifted verbatim from the chunk, so validation behaves exactly as it would for a
well-behaved real model. Switch `LLM_PROVIDER` to `anthropic` (or `openai`) and
set the matching key to generate for real. If the key is missing, `generate`
fails immediately with a clear message rather than partially processing.

**`hostile` provider:** an adversarial test backend that reproduces the failure
modes a real model actually exhibits — JSON wrapped in ```` ```json ```` fences,
truncated output, an invented `source_quote`, and a 429 rate-limit — so the
pipeline's defences (fence-strip, one repair retry, transient backoff, and the
quote-in-source rejection) have permanent regression coverage without spending
tokens.

### Smoke run against the real API

Before trusting the mock, spend a few cents confirming the real model behaves:

```bash
# in pipeline/.env: LLM_PROVIDER=anthropic and a real ANTHROPIC_API_KEY
python -m src.main ingest
python -m src.main generate --limit 2   # only the first 2 chunks
```

`generate` logs input/output token counts each run, so the smoke run also gives
you the numbers to extrapolate full-subject cost before approving the key spend.

### Tests

```bash
python -m pytest -q      # 20 tests, no DB and no API key required
```

They pin the LLM-boundary behaviour (fences, truncation→repair, invented quotes,
429 retries), the quote normalization that prevents false rejections, and the
pure coverage-gap logic.

---

## Curriculum hours

The unit is the **hour**. The SME writes what is taught in hour 1, hour 2, and so
on up to the credit's total, with each hour marked by a heading matching
`^Hour\s+(\d+)` (case-insensitive; change it with `hour_heading_pattern` in
`config/curriculum.json` or `HOUR_HEADING_PATTERN`).

**One file per credit is the expected shape.** `config/curriculum.json` says which
track and credit each file belongs to, and **which hours it covers**:

```json
{
  "hour_heading_pattern": "^Hour\\s+(\\d+)",
  "files": {
    "robotics-c1.docx": { "subject": "Robotics", "track": "Tesla's Track", "credit": "C1", "hours": [1, 25] },
    "robotics-c2-a.md": { "subject": "Robotics", "track": "Tesla's Track", "credit": "C2", "hours": [1, 9] },
    "robotics-c2-b.md": { "subject": "Robotics", "track": "Tesla's Track", "credit": "C2", "hours": [10, 24] }
  },
  "legacy_files": ["sample-cs.md"]
}
```

A credit split into project-sized files is supported: each file declares the hours
it covers, as C2 does above. The declared range is the contract.

- Every chunk carries its hour, and every imported mission gets that `hour_id` and
  the track's subject.
- The hours found in a file must be exactly the range it DECLARES, in order, each
  once. Otherwise that file is **rejected** at ingest with its name, the range
  declared and the hours actually found; **nothing from it is stored**, and
  `ingest` exits non-zero after processing the other files.
- A file that is neither mapped nor in `legacy_files` is rejected too. Legacy files
  import with no hour and are never served in curriculum mode.
- Headings outside any hour (an introduction, an appendix) are reported and not
  used.
- The curriculum must be loaded into the database first (`npm run curriculum:load`
  in mission-demo) and migrations applied (`npm run db:migrate` — 009, 010 and
  012). The pipeline also re-checks that the credit's hour rows match its
  `total_hours` and refuses to tag content against a credit where they disagree.
- `coverage` lists live missions per hour. An hour with none is a **hard gap**: a
  student who reaches it gets nothing new from it.
- `coverage` also reports **hour × difficulty**: an hour carrying fewer than
  `MIN_DIFFICULTY_VARIANTS` (3) distinct difficulties is listed as thin. Difficulty
  survives as the within-hour ranking, so an hour with one difficulty serves every
  student the same question regardless of level.

### Generation must target the bands the templates require

Selection filters on `time_band` hard, and only widens it as the last step before
repeating a mission (see the curriculum section of the app README). An hour whose
missions are all one band therefore drives students straight into repeats whenever a
week template asks for another band.

So generation is responsible for band spread, not selection: for every hour,
generate missions across the bands the live week templates actually request
(`week_templates`/`week_template_slots` in mission-demo), not whatever band the
source text happens to suggest. Check the template slots before a large generation
run; `coverage` reports the gap after the fact, which is too late for a live week.

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
    db.py              connection, config loaders, schema verification (never creates)
    reader.py          .docx / .pdf / .md / .txt -> sections
    chunker.py         sections -> hashed chunks; new/changed/unchanged
    generator.py       LLM drafting (anthropic | openai | mock)
    validator.py       reject invalid or invented missions
    importer.py        write drafts; retire superseded missions
    export_review.py   drafts -> Excel review workbook
    import_review.py   apply reviewer decisions
    main.py            CLI
```
