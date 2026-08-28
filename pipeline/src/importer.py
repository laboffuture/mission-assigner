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

    files = sorted(VALIDATED_DIR.glob("*.json")) if VALIDATED_DIR.exists() else []
    if not files:
        print("  No validated drafts found (run `validate` first).")
        return {"inserted": 0, "retired": 0, "chunks": 0}

    conn = db.get_connection()
    try:
        cur = conn.cursor()
        for f in files:
            record = json.loads(f.read_text(encoding="utf-8"))
            chunk_id = record.get("chunk_id")
            missions = record.get("missions", [])
            if not missions:
                continue
            chunks_touched += 1

            # Retire existing non-retired missions for this chunk (changed-chunk rule).
            if chunk_id is not None:
                cur.execute(
                    "SELECT COUNT(*) FROM missions WHERE source_chunk_id = %s AND status <> 'retired'",
                    (chunk_id,),
                )
                to_retire = cur.fetchone()[0]
                if to_retire:
                    print(f"  chunk_id {chunk_id}: retiring {to_retire} existing mission(s) before re-import.")
                    retired += to_retire
                    if not dry_run:
                        cur.execute(
                            "UPDATE missions SET status = 'retired' WHERE source_chunk_id = %s AND status <> 'retired'",
                            (chunk_id,),
                        )

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
                          status, source_chunk_id, generated_at)
                       VALUES
                         (1, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'draft', %s, NOW())""",
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

    print(f"  Import: {inserted} draft mission(s) inserted, {retired} retired, across {chunks_touched} chunk(s).")
    return {"inserted": inserted, "retired": retired, "chunks": chunks_touched}
