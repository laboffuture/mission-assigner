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

from . import db, reader, chunker, generator, validator, importer, export_review, import_review

QUEUE_FILE = db.LOGS_DIR / "pending_generation.json"
COVERAGE_MIN = 5


def _ensure_schema():
    actions = db.ensure_schema(dry_run=False)
    for a in actions:
        print(f"  [schema] {a}")


# --- commands ----------------------------------------------------------------
def cmd_ingest(args) -> list[dict]:
    _ensure_schema()
    levels = db.load_levels()
    print("Ingesting documents from input/ ...")
    sections = reader.read_input_dir(db.INPUT_DIR)
    chunks = chunker.sections_to_chunks(sections, subject=levels["subject"])
    result = chunker.upsert_and_classify(chunks, dry_run=args.dry_run)
    print("  " + chunker.summarize(result))

    queue = result["new"] + result["changed"]
    if not args.dry_run:
        db.LOGS_DIR.mkdir(parents=True, exist_ok=True)
        QUEUE_FILE.write_text(json.dumps(queue, indent=2), encoding="utf-8")
        print(f"  Wrote generation queue: {len(queue)} chunk(s) -> {QUEUE_FILE.name}")
    else:
        print(f"  [dry-run] would queue {len(queue)} chunk(s) for generation")
    return queue


def _load_queue() -> list[dict]:
    if not QUEUE_FILE.exists():
        print("  No generation queue found. Run `ingest` first.")
        return []
    return json.loads(QUEUE_FILE.read_text(encoding="utf-8"))


def cmd_generate(args, queue: list[dict] | None = None):
    if queue is None:
        queue = _load_queue()
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
        grid = {}
        for diff, tag, count in cur.fetchall():
            grid[(int(diff), tag)] = int(count)
        cur.close()
    finally:
        conn.close()

    print(f"\nLive mission coverage (cells with < {COVERAGE_MIN} flagged as GAP):\n")
    header = "level \\ tag".ljust(14) + "".join(t[:11].ljust(12) for t in tags)
    print(header)
    print("-" * len(header))
    gaps = 0
    for lvl in levels:
        row = f"{lvl['level']} {lvl['name'][:9]}".ljust(14)
        for tag in tags:
            c = grid.get((lvl["level"], tag), 0)
            cell = f"{c}"
            if c < COVERAGE_MIN:
                cell = f"{c}*GAP"
                gaps += 1
            row += cell.ljust(12)
        print(row)
    print("-" * len(header))
    print(f"\n{gaps} gap cell(s) with fewer than {COVERAGE_MIN} live missions.")
    return {"gaps": gaps}


# --- arg parsing -------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="src.main", description="Stage 2 mission generation pipeline")
    sub = p.add_subparsers(dest="command", required=True)

    def add(name, help_):
        sp = sub.add_parser(name, help=help_)
        sp.add_argument("--dry-run", action="store_true", help="print actions without writing")
        return sp

    add("ingest", "read input/, chunk, hash, report the delta")
    add("generate", "LLM-draft missions for queued chunks")
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
