"""Write validated missions into the existing missions bank.

Everything lands as status='draft'. Only import_review promotes to 'live'.
Before inserting drafts for a chunk, any existing non-retired missions for that
source_chunk_id are RETIRED (never deleted) — this is the "changed chunk"
behaviour, and a harmless no-op for a brand-new chunk that has none.
"""
from __future__ import annotations

import json

from . import db

AGE_MIN = 12
AGE_MAX = 18


def import_validated(dry_run: bool = False) -> dict:
    """Import every staged, validated draft. Returns counts."""
    from .validator import VALIDATED_DIR

    levels = db.load_levels()
    subject = levels["subject"]
    template = db.load_active_template()
    mission_type = template["type"]
    grading_mode = template["grading_mode"]
    time_band = template["time_band"]

    inserted = 0
    retired = 0
    chunks_touched = 0
    skipped_noop = 0

    files = sorted(VALIDATED_DIR.glob("*.json")) if VALIDATED_DIR.exists() else []
    if not files:
        print("  No validated drafts found (run `validate` first).")
        return {"inserted": 0, "retired": 0, "chunks": 0, "skipped_noop": 0}

    conn = db.get_connection()
    try:
        cur = conn.cursor()
        for f in files:
            record = json.loads(f.read_text(encoding="utf-8"))
            chunk_id = record.get("chunk_id")
            missions = record.get("missions", [])
            if not missions:
                continue

            # Incoming content version. Prefer the hash staged with the draft;
            # fall back to the chunk's current hash in the DB.
            incoming_hash = record.get("content_hash")
            if chunk_id is not None and not incoming_hash:
                cur.execute("SELECT content_hash FROM content_chunks WHERE id = %s", (chunk_id,))
                r = cur.fetchone()
                incoming_hash = r[0] if r else None

            # Idempotency + changed-chunk rule: look at existing non-retired
            # missions for this chunk.
            #   - identical content already imported -> no-op (skip)
            #   - different content (or none recorded) -> retire old, insert new
            #   - no existing missions -> just insert
            if chunk_id is not None:
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
                # source_quote is kept in answer_key as provenance so reviewers
                # can verify the key against the source in the review sheet.
                answer_key = json.dumps(
                    {
                        "correct": m["correct"],
                        "explanation": m.get("explanation", ""),
                        "source_quote": m.get("source_quote", ""),
                    }
                )
                if dry_run:
                    print(f"  [dry-run] would insert draft '{m['title']}' (L{m['difficulty']}) for chunk_id {chunk_id}")
                    inserted += 1
                    continue

                cur.execute(
                    """INSERT INTO missions
                         (version, subject, title, body, mission_type, grading_mode,
                          difficulty, age_min, age_max, time_band, answer_key,
                          status, source_chunk_id, source_chunk_hash, generated_at)
                       VALUES
                         (1, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'draft', %s, %s, NOW())""",
                    (
                        subject,
                        m["title"],
                        m["body"],
                        mission_type,
                        grading_mode,
                        int(m["difficulty"]),
                        AGE_MIN,
                        AGE_MAX,
                        time_band,
                        answer_key,
                        chunk_id,
                        incoming_hash,
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
    return {"inserted": inserted, "retired": retired, "chunks": chunks_touched, "skipped_noop": skipped_noop}
