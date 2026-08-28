"""Turn reader sections into content_chunks and classify them against what is
already stored.

Design note on stability: chunk_ref is derived from the section's heading_path,
never from its ordinal position. One section becomes one chunk. A section longer
than MAX_WORDS is split on paragraph boundaries with (a)/(b)/... suffixes. This
means inserting a paragraph early in a document changes only the hash of the
section it lands in — every other chunk_ref stays identical, so unchanged
sections are never needlessly regenerated.
"""
from __future__ import annotations

import hashlib
import re

from . import db

MIN_WORDS = 800
MAX_WORDS = 1500
CHUNK_REF_MAXLEN = 120


def _word_count(text: str) -> int:
    return len(text.split())


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _clip_ref(ref: str) -> str:
    return ref[:CHUNK_REF_MAXLEN]


def _split_oversized(section: dict) -> list[dict]:
    """Split a >MAX_WORDS section on paragraph boundaries, greedily filling
    sub-chunks up to MAX_WORDS. Suffix chunk_ref with (a), (b), ..."""
    paragraphs = [p for p in re.split(r"\n\s*\n", section["body"]) if p.strip()]
    groups: list[list[str]] = []
    current: list[str] = []
    current_words = 0
    for para in paragraphs:
        w = _word_count(para)
        if current and current_words + w > MAX_WORDS:
            groups.append(current)
            current, current_words = [], 0
        current.append(para)
        current_words += w
    if current:
        groups.append(current)

    out: list[dict] = []
    for i, group in enumerate(groups):
        suffix = f" ({chr(ord('a') + i)})"
        body = "\n\n".join(group)
        out.append(
            {
                "source_file": section["source_file"],
                "heading": section["heading"],
                "chunk_ref": _clip_ref(section["heading_path"] + suffix),
                "body": body,
            }
        )
    return out


def sections_to_chunks(sections: list[dict], subject: str) -> list[dict]:
    """Flatten sections into chunk records (no DB access)."""
    chunks: list[dict] = []
    for section in sections:
        if _word_count(section["body"]) > MAX_WORDS:
            parts = _split_oversized(section)
        else:
            parts = [
                {
                    "source_file": section["source_file"],
                    "heading": section["heading"],
                    "chunk_ref": _clip_ref(section["heading_path"]),
                    "body": section["body"],
                }
            ]
        for part in parts:
            part["content_hash"] = _sha256(part["body"])
            part["subject"] = subject
            chunks.append(part)
    return chunks


def upsert_and_classify(chunks: list[dict], dry_run: bool = False) -> dict:
    """Upsert chunks into content_chunks and classify each as new / changed /
    unchanged. Returns {'new': [...], 'changed': [...], 'unchanged': [...]}.
    Each returned chunk carries its content_chunks.id (except brand-new chunks
    under dry_run, which are not written and so have id=None)."""
    result = {"new": [], "changed": [], "unchanged": []}
    conn = db.get_connection()
    try:
        cur = conn.cursor(dictionary=True)
        for chunk in chunks:
            cur.execute(
                """SELECT id, content_hash FROM content_chunks
                    WHERE source_file = %s AND chunk_ref = %s""",
                (chunk["source_file"], chunk["chunk_ref"]),
            )
            row = cur.fetchone()
            if row is None:
                if not dry_run:
                    ins = conn.cursor()
                    ins.execute(
                        """INSERT INTO content_chunks
                             (source_file, chunk_ref, heading, body, content_hash, subject)
                           VALUES (%s, %s, %s, %s, %s, %s)""",
                        (
                            chunk["source_file"],
                            chunk["chunk_ref"],
                            chunk["heading"],
                            chunk["body"],
                            chunk["content_hash"],
                            chunk["subject"],
                        ),
                    )
                    chunk["id"] = ins.lastrowid
                    ins.close()
                else:
                    chunk["id"] = None
                result["new"].append(chunk)
            elif row["content_hash"] != chunk["content_hash"]:
                chunk["id"] = row["id"]
                if not dry_run:
                    upd = conn.cursor()
                    upd.execute(
                        """UPDATE content_chunks
                              SET heading = %s, body = %s, content_hash = %s
                            WHERE id = %s""",
                        (chunk["heading"], chunk["body"], chunk["content_hash"], row["id"]),
                    )
                    upd.close()
                result["changed"].append(chunk)
            else:
                chunk["id"] = row["id"]
                result["unchanged"].append(chunk)

        if not dry_run:
            conn.commit()
        cur.close()
    finally:
        conn.close()
    return result


def summarize(result: dict) -> str:
    n_new = len(result["new"])
    n_changed = len(result["changed"])
    n_unchanged = len(result["unchanged"])
    to_gen = n_new + n_changed
    return (
        f"{n_new} new, {n_changed} changed, {n_unchanged} unchanged "
        f"- will generate for {to_gen} chunks."
    )
