"""Write validated missions into the existing missions bank.

Everything lands as status='draft'. Only import_review promotes to 'live'.
Before inserting drafts for a chunk, any existing non-retired missions for that
source_chunk_id are RETIRED (never deleted) — this is the "changed chunk"
behaviour, and a harmless no-op for a brand-new chunk that has none.

HOW A DRAFT FINDS ITS CHUNK. By (source_file, chunk_ref), never by the chunk_id
stored in the draft. Row ids are not stable facts: the drafts for hour 1 were
made against a database whose hours were later rebuilt by a reseed, so they carry
chunk_id 505 and hour_id 133 - rows that no longer exist anywhere. Importing by
those ids would have failed on the missions.hour_id foreign key, and (worse, with
different numbers) could have attached missions to whatever row had inherited the
id. The pair (source_file, chunk_ref) is what the content IS, so it is the key;
content_hash then proves the draft was written from the text that chunk holds
now, and the hour comes from that chunk row. Ids inside a draft are ignored
entirely.
"""
from __future__ import annotations

import json

from . import db

AGE_MIN = 12
AGE_MAX = 18


def _resolve_chunk(cur, record: dict):
    """The content_chunks row a draft belongs to, by (source_file, chunk_ref).

    Returns (chunk_id, content_hash, hour_id, subject) or raises ValueError with a
    message a person can act on. Never trusts an id stored in the draft.
    """
    source_file = record.get("source_file")
    chunk_ref = record.get("chunk_ref")
    if not source_file or not chunk_ref:
        raise ValueError(
            "the draft has no source_file/chunk_ref pair to resolve by "
            f"(source_file={source_file!r}, chunk_ref={chunk_ref!r})"
        )

    cur.execute(
        "SELECT id, content_hash, hour_id, subject FROM content_chunks "
        "WHERE source_file = %s AND chunk_ref = %s",
        (source_file, chunk_ref),
    )
    rows = cur.fetchall()
    if not rows:
        raise ValueError(
            f"no chunk in this database matches source_file={source_file!r} chunk_ref={chunk_ref!r}. "
            f"Ingest that document first (python -m src.main ingest --file {source_file})"
        )
    if len(rows) > 1:
        raise ValueError(
            f"{len(rows)} chunks match source_file={source_file!r} chunk_ref={chunk_ref!r}; "
            f"the pair must be unique. Re-ingest the document."
        )
    chunk_id, stored_hash, hour_id, subject = rows[0]

    draft_hash = record.get("content_hash")
    if not draft_hash:
        raise ValueError(
            f"the draft for {chunk_ref!r} carries no content_hash, so it cannot be shown to have been "
            f"written from the text now stored for that chunk. Regenerate it."
        )
    if stored_hash and draft_hash != stored_hash:
        raise ValueError(
            f"the draft for {chunk_ref!r} was written from different text than the chunk now holds "
            f"(draft {str(draft_hash)[:12]}, chunk {str(stored_hash)[:12]}). The document changed after "
            f"the draft was made: regenerate it (generate regenerates a changed chunk by itself)."
        )
    return int(chunk_id), stored_hash or draft_hash, hour_id, subject


def mission_row(m: dict, *, subject: str, hour_id, template: dict, chunk_id, content_hash) -> dict:
    """The missions row for one validated draft. Pure, so the tagging rules are
    unit-testable: a mapped file's missions carry the chunk's hour_id and the
    track's subject; a legacy file's carry neither hour nor track subject."""
    return {
        "subject": subject,
        "title": m["title"],
        "body": m["body"],
        "mission_type": template["type"],
        "grading_mode": template["grading_mode"],
        "difficulty": int(m["difficulty"]),
        "age_min": AGE_MIN,
        "age_max": AGE_MAX,
        "time_band": template["time_band"],
        # source_quote is kept in answer_key as provenance so reviewers can verify
        # the key against the source in the review sheet.
        "answer_key": json.dumps(
            {"correct": m["correct"], "explanation": m.get("explanation", ""), "source_quote": m.get("source_quote", "")}
        ),
        "source_chunk_id": chunk_id,
        "source_chunk_hash": content_hash,
        "hour_id": hour_id,
    }


def import_validated(dry_run: bool = False) -> dict:
    """Import every staged, validated draft. Returns counts."""
    from .validator import VALIDATED_DIR

    levels = db.load_levels()
    template = db.load_active_template()

    inserted = 0
    retired = 0
    chunks_touched = 0
    skipped_noop = 0
    refused: list[dict] = []

    files = sorted(VALIDATED_DIR.glob("*.json")) if VALIDATED_DIR.exists() else []
    if not files:
        print("  No validated drafts found (run `validate` first).")
        return {"inserted": 0, "retired": 0, "chunks": 0, "skipped_noop": 0, "refused": []}

    conn = db.get_connection()
    try:
        cur = conn.cursor()
        for f in files:
            record = json.loads(f.read_text(encoding="utf-8"))
            missions = record.get("missions", [])
            if not missions:
                continue

            # By (source_file, chunk_ref), with the hash proving the draft matches
            # the text that chunk holds now. Any chunk_id/hour_id inside the draft
            # is ignored - see the module docstring.
            try:
                chunk_id, incoming_hash, hour_id, chunk_subject = _resolve_chunk(cur, record)
            except ValueError as e:
                refused.append({"draft": f.name, "reason": str(e)})
                print(f"  REFUSED {f.name}: {e}")
                continue
            subject = chunk_subject or record.get("subject") or levels["subject"]
            stale = [
                f"{k} {record.get(k)} -> {v}"
                for k, v in (("chunk_id", chunk_id), ("hour_id", hour_id))
                if record.get(k) is not None and record.get(k) != v
            ]
            if stale:
                print(f"  {f.name}: ignoring stale ids in the draft ({'; '.join(stale)}).")

            # Idempotency + changed-chunk rule: look at existing non-retired
            # missions for this chunk.
            #   - identical content already imported -> no-op (skip)
            #   - different content (or none recorded) -> retire old, insert new
            #   - no existing missions -> just insert
            cur.execute(
                "SELECT source_chunk_hash FROM missions WHERE source_chunk_id = %s AND status <> 'retired'",
                (chunk_id,),
            )
            existing = [row[0] for row in cur.fetchall()]
            if existing and incoming_hash and all(h == incoming_hash for h in existing):
                print(f"  chunk_id {chunk_id}: identical content already imported; no-op (skipped).")
                skipped_noop += 1
                continue
            if existing:
                print(f"  chunk_id {chunk_id}: retiring {len(existing)} existing mission(s) before re-import.")
                retired += len(existing)
                if not dry_run:
                    cur.execute(
                        "UPDATE missions SET status = 'retired' WHERE source_chunk_id = %s AND status <> 'retired'",
                        (chunk_id,),
                    )

            chunks_touched += 1

            for m in missions:
                row = mission_row(
                    m, subject=subject, hour_id=hour_id, template=template,
                    chunk_id=chunk_id, content_hash=incoming_hash,
                )
                if dry_run:
                    print(f"  [dry-run] would insert draft '{m['title']}' (L{m['difficulty']}) for chunk_id {chunk_id}"
                          f" hour_id {hour_id}")
                    inserted += 1
                    continue

                cur.execute(
                    """INSERT INTO missions
                         (version, subject, title, body, mission_type, grading_mode,
                          difficulty, age_min, age_max, time_band, answer_key,
                          status, source_chunk_id, source_chunk_hash, hour_id, generated_at)
                       VALUES
                         (1, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'draft', %s, %s, %s, NOW())""",
                    (
                        row["subject"], row["title"], row["body"], row["mission_type"], row["grading_mode"],
                        row["difficulty"], row["age_min"], row["age_max"], row["time_band"], row["answer_key"],
                        row["source_chunk_id"], row["source_chunk_hash"], row["hour_id"],
                    ),
                )
                mission_id = cur.lastrowid

                for opt in m["options"]:
                    cur.execute(
                        "INSERT INTO mission_options (mission_id, option_key, option_text) VALUES (%s, %s, %s)",
                        (mission_id, opt["key"], opt["text"]),
                    )
                for tag in m.get("tags", []):
                    cur.execute(
                        "INSERT INTO mission_tags (mission_id, tag) VALUES (%s, %s)",
                        (mission_id, tag),
                    )
                inserted += 1

        if not dry_run:
            conn.commit()
        cur.close()
    finally:
        conn.close()

    print(f"  Import: {inserted} draft mission(s) inserted, {retired} retired, "
          f"{skipped_noop} no-op chunk(s), across {chunks_touched} changed/new chunk(s).")
    if refused:
        print(f"  {len(refused)} draft(s) REFUSED and not imported:")
        for r in refused:
            print(f"    - {r['draft']}: {r['reason']}")
    return {
        "inserted": inserted,
        "retired": retired,
        "chunks": chunks_touched,
        "skipped_noop": skipped_noop,
        "refused": refused,
    }
