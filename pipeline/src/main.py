"""Stage 2 pipeline CLI.

  python -m src.main ingest [--dry-run]
  python -m src.main generate [--dry-run]
  python -m src.main validate [--dry-run]
  python -m src.main import [--dry-run]
  python -m src.main run [--dry-run]
  python -m src.main export-review [--out FILE] [--dry-run]
  python -m src.main import-review FILE [--dry-run]
  python -m src.main coverage [--dry-run]

ingest computes the new/changed/unchanged delta and writes the new+changed
chunks to a working queue (logs/pending_generation.json). generate consumes that
queue, so the stages can be run independently.
"""
from __future__ import annotations

import argparse
import json
import sys

from . import db, reader, chunker, generator, validator, importer, export_review, import_review, curriculum

QUEUE_FILE = db.LOGS_DIR / "pending_generation.json"
COVERAGE_MIN = 5


class IngestFailed(Exception):
    """One or more files were rejected at ingest. Raised after the good files are
    processed, so the command exits non-zero and `run` stops before generating."""


def _check_schema():
    """Verify the schema the migration chain owns, and stop clearly if it is
    missing. The pipeline no longer creates schema (see db.py) — a missing
    object means migrations have not been run, which is an operator action, not
    something to paper over at runtime."""
    try:
        checked = db.verify_schema()
    except db.SchemaOutOfDate as e:
        sys.exit(f"FATAL: {e}")
    # Individually noisy and identical on every run; one line is enough.
    print(f"  [schema] {len(checked)} required objects present")


# Kept so the older name still resolves at the call sites below.
_ensure_schema = _check_schema


def _group_by_file(sections: list[dict]) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = {}
    for s in sections:
        grouped.setdefault(s["source_file"], []).append(s)
    return grouped


def chunks_for_file(file_name: str, sections: list[dict], config: dict, conn, legacy_subject: str) -> list[dict]:
    """Hour-tag one file's sections and turn them into chunks. Raises
    CurriculumError / HourBoundaryError when the file cannot be placed safely —
    in which case nothing from the file is stored."""
    mapping = curriculum.mapping_for(file_name, config)
    if mapping == curriculum.LEGACY:
        print(f"  WARNING: {file_name} is a legacy file — its missions carry no hour and are "
              f"never served in curriculum selection mode.")
        return chunker.sections_to_chunks(sections, subject=legacy_subject)

    credit = curriculum.resolve_credit(conn, mapping, file_name)
    tagged, untagged = chunker.assign_hours(
        sections,
        credit["first_hour"],
        credit["last_hour"],
        curriculum.hour_pattern(config, mapping),
        file_name,
    )
    for s in tagged:
        s["hour_id"] = credit["hours"][s["hour_number"]]
    if untagged:
        headings = ", ".join(repr(s["heading"]) for s in untagged)
        print(f"  NOTE: {file_name}: {len(untagged)} section(s) outside any hour, not used: {headings}")
    print(f"  {file_name}: hours {credit['first_hour']}..{credit['last_hour']} of {credit['total_hours']} -> "
          f"{credit['track']} / {credit['credit']}")
    return chunker.sections_to_chunks(tagged, subject=credit["subject"])


# --- commands ----------------------------------------------------------------
def cmd_ingest(args) -> list[dict]:
    _ensure_schema()
    levels = db.load_levels()
    config = db.load_curriculum_config()
    print(f"Ingesting documents from {db.INPUT_DIR} ...")
    sections = reader.read_input_dir(db.INPUT_DIR)

    chunks: list[dict] = []
    failures: list[tuple[str, str]] = []
    conn = db.get_connection()
    try:
        for file_name, file_sections in _group_by_file(sections).items():
            try:
                chunks.extend(chunks_for_file(file_name, file_sections, config, conn, levels["subject"]))
            except (curriculum.CurriculumError, chunker.HourBoundaryError) as e:
                failures.append((file_name, str(e)))
                print(f"  FAILED {e}")
    finally:
        conn.close()

    result = chunker.upsert_and_classify(chunks, dry_run=args.dry_run)
    print("  " + chunker.summarize(result))

    queue = result["new"] + result["changed"]
    if not args.dry_run:
        db.LOGS_DIR.mkdir(parents=True, exist_ok=True)
        QUEUE_FILE.write_text(json.dumps(queue, indent=2, default=str), encoding="utf-8")
        print(f"  Wrote generation queue: {len(queue)} chunk(s) -> {QUEUE_FILE.name}")
    else:
        print(f"  [dry-run] would queue {len(queue)} chunk(s) for generation")

    if failures:
        names = ", ".join(f for f, _ in failures)
        raise IngestFailed(f"{len(failures)} file(s) rejected at ingest and not queued: {names}")
    return queue


def _load_queue() -> list[dict]:
    if not QUEUE_FILE.exists():
        print("  No generation queue found. Run `ingest` first.")
        return []
    return json.loads(QUEUE_FILE.read_text(encoding="utf-8"))


def cmd_generate(args, queue: list[dict] | None = None):
    if queue is None:
        queue = _load_queue()
    limit = getattr(args, "limit", None)
    if limit and limit > 0:
        queue = queue[:limit]
        print(f"  --limit {limit}: generating for the first {len(queue)} queued chunk(s) only (smoke run).")
    if not queue:
        print("  Nothing to generate.")
        return {"drafted": [], "failures": []}
    print(f"Generating drafts for {len(queue)} chunk(s) ...")
    res = generator.generate(queue, dry_run=args.dry_run)
    if res["failures"]:
        print(f"  {len(res['failures'])} chunk(s) FAILED generation:")
        for f in res["failures"]:
            print(f"    - {f['chunk_ref']}: {f['error']}")
    return res


def cmd_validate(args):
    print("Validating staged drafts ...")
    return validator.validate_drafts(dry_run=args.dry_run)


def cmd_import(args):
    _ensure_schema()
    print("Importing validated drafts into the mission bank ...")
    return importer.import_validated(dry_run=args.dry_run)


def cmd_run(args):
    print("=== run: ingest -> generate -> validate -> import ===")
    queue = cmd_ingest(args)
    cmd_generate(args, queue=queue)
    cmd_validate(args)
    cmd_import(args)
    print("=== run complete ===")


def cmd_export_review(args):
    _ensure_schema()
    print("Exporting draft missions to a review workbook ...")
    return export_review.export_review(out_path=args.out, dry_run=args.dry_run)


def cmd_import_review(args):
    _ensure_schema()
    print(f"Applying review decisions from {args.file} ...")
    return import_review.import_review(args.file, dry_run=args.dry_run)


def evaluate_coverage(grid: dict, levels: list[dict], tags: list[str], minimum: int = COVERAGE_MIN) -> dict:
    """Pure function: given a {(level, tag): count} grid, return which cells are
    gaps (count < minimum). No database access, so it is unit-testable in
    isolation from DB state. Returns {'gaps': int, 'gap_cells': [(level, tag)],
    'cells': {(level, tag): count}}."""
    cells, gap_cells = {}, []
    for lvl in levels:
        for tag in tags:
            c = int(grid.get((lvl["level"], tag), 0))
            cells[(lvl["level"], tag)] = c
            if c < minimum:
                gap_cells.append((lvl["level"], tag))
    return {"gaps": len(gap_cells), "gap_cells": gap_cells, "cells": cells}


def cmd_coverage(args):
    _ensure_schema()
    levels = db.load_levels()["levels"]
    tags = db.load_tags()

    conn = db.get_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT m.difficulty, mt.tag, COUNT(*)
                 FROM missions m JOIN mission_tags mt ON mt.mission_id = m.id
                WHERE m.status = 'live'
                GROUP BY m.difficulty, mt.tag"""
        )
        grid = {(int(diff), tag): int(count) for diff, tag, count in cur.fetchall()}
        cur.close()
    finally:
        conn.close()

    evln = evaluate_coverage(grid, levels, tags)
    print(f"\nLive mission coverage (cells with < {COVERAGE_MIN} flagged as GAP):\n")
    header = "level \\ tag".ljust(14) + "".join(t[:11].ljust(12) for t in tags)
    print(header)
    print("-" * len(header))
    for lvl in levels:
        row = f"{lvl['level']} {lvl['name'][:9]}".ljust(14)
        for tag in tags:
            c = evln["cells"][(lvl["level"], tag)]
            cell = f"{c}*GAP" if (lvl["level"], tag) in evln["gap_cells"] else f"{c}"
            row += cell.ljust(12)
        print(row)
    print("-" * len(header))
    print(f"\n{evln['gaps']} gap cell(s) with fewer than {COVERAGE_MIN} live missions.")

    hour_gaps = print_hour_coverage()
    thin = print_hour_difficulty_coverage()
    return {"gaps": evln["gaps"], "hour_gaps": hour_gaps, "thin_hours": thin}


def print_hour_coverage() -> int:
    """Live missions per curriculum HOUR. An hour with none is a HARD gap:
    curriculum selection never serves content from a later hour, so a student who
    reaches it gets nothing new from it."""
    conn = db.get_connection()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(
            """SELECT t.name AS track, c.code AS credit, h.hour_number AS hour,
                      c.total_hours, COUNT(m.id) AS live
                 FROM hours h
                 JOIN credits c ON c.id = h.credit_id
                 JOIN tracks t ON t.id = c.track_id AND t.active = TRUE
                 LEFT JOIN missions m ON m.hour_id = h.id AND m.status = 'live'
                GROUP BY t.id, t.name, c.id, c.code, c.sequence, c.total_hours, h.id, h.hour_number
                ORDER BY t.id, c.sequence, h.hour_number"""
        )
        rows = cur.fetchall()
        cur.close()
    finally:
        conn.close()

    evln = curriculum.evaluate_hour_coverage(rows)
    print("\nLive missions per curriculum hour (GAP = none; students reaching it get nothing new):\n")
    last = None
    for r in rows:
        key = (r["track"], r["credit"])
        if key != last:
            print(f"  {r['track']} / {r['credit']} ({r['total_hours']} hours)")
            last = key
        mark = "  GAP" if int(r["live"]) == 0 else ""
        print(f"    Hour {r['hour']}: {r['live']}{mark}")
    print(f"\n{evln['gaps']} of {evln['hours']} hour(s) have no live missions.")
    return evln["gaps"]


def print_hour_difficulty_coverage() -> int:
    """Distinct live difficulties per hour. Selection ranks difficulty WITHIN an
    hour, so an hour with only one variant cannot adapt to the student's level at
    all."""
    conn = db.get_connection()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(
            """SELECT t.name AS track, c.code AS credit, h.hour_number AS hour,
                      COUNT(DISTINCT m.difficulty) AS variants
                 FROM hours h
                 JOIN credits c ON c.id = h.credit_id
                 JOIN tracks t ON t.id = c.track_id AND t.active = TRUE
                 LEFT JOIN missions m ON m.hour_id = h.id AND m.status = 'live'
                GROUP BY t.id, t.name, c.id, c.code, c.sequence, h.id, h.hour_number
                ORDER BY t.id, c.sequence, h.hour_number"""
        )
        rows = cur.fetchall()
        cur.close()
    finally:
        conn.close()

    evln = curriculum.evaluate_hour_difficulty_coverage(rows)
    print(
        f"\nDistinct live difficulties per hour "
        f"(THIN = fewer than {evln['minimum_variants']}; difficulty cannot adapt):\n"
    )
    for r in evln["thin_hours"]:
        print(f"    {r['track']} / {r['credit']} Hour {r['hour']}: {r['variants']} variant(s)  THIN")
    if not evln["thin_hours"]:
        print("    none — every hour carries a difficulty spread.")
    print(f"\n{evln['thin']} of {evln['hours']} hour(s) carry fewer than "
          f"{evln['minimum_variants']} difficulty variants.")
    return evln["thin"]


# --- arg parsing -------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="src.main", description="Stage 2 mission generation pipeline")
    sub = p.add_subparsers(dest="command", required=True)

    def add(name, help_):
        sp = sub.add_parser(name, help=help_)
        sp.add_argument("--dry-run", action="store_true", help="print actions without writing")
        return sp

    add("ingest", "read input/, chunk, hash, report the delta")
    gen = add("generate", "LLM-draft missions for queued chunks")
    gen.add_argument("--limit", type=int, default=None,
                     help="only generate for the first N queued chunks (cheap smoke run)")
    add("validate", "run validation, report pass/fail counts")
    add("import", "write validated drafts to the database")
    add("run", "ingest + generate + validate + import")
    ex = add("export-review", "produce the Excel review file")
    ex.add_argument("--out", default=None, help="output .xlsx path")
    ir = add("import-review", "apply the reviewed Excel back")
    ir.add_argument("file", help="path to the reviewed .xlsx")
    add("coverage", "coverage report of live missions per level x tag")
    return p


DISPATCH = {
    "ingest": cmd_ingest,
    "generate": cmd_generate,
    "validate": cmd_validate,
    "import": cmd_import,
    "run": cmd_run,
    "export-review": cmd_export_review,
    "import-review": cmd_import_review,
    "coverage": cmd_coverage,
}


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        DISPATCH[args.command](args)
    except SystemExit:
        raise
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
