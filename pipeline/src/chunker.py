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

# A session boundary is a heading matching this (case-insensitive); group 1 is the
# session number. Overridable per curriculum.json or SESSION_HEADING_PATTERN.
DEFAULT_SESSION_PATTERN = r"^Session\s+(\d+)"


class SessionBoundaryError(Exception):
    """A project file's detected sessions do not match its definition. Mis-detected
    boundaries would mis-tag every mission generated from the file, so the file is
    rejected outright — never partially imported."""


def compile_session_pattern(pattern: str | None = None) -> re.Pattern:
    rx = re.compile(pattern or DEFAULT_SESSION_PATTERN, re.IGNORECASE)
    if rx.groups < 1:
        raise ValueError(f"session heading pattern {rx.pattern!r} needs a capture group for the session number")
    return rx


def _session_in_path(heading_path: str, rx: re.Pattern) -> int | None:
    """The deepest heading in the breadcrumb that names a session, if any."""
    found = None
    for part in heading_path.split(" > "):
        m = rx.match(part.strip())
        if m:
            found = int(m.group(1))
    return found


def assign_sessions(sections: list[dict], expected_count: int, pattern: str | None, source_file: str):
    """Tag each section of ONE project file with the session it belongs to.

    Structured documents (real headings): a section belongs to the session named
    in its heading breadcrumb, so sub-headings inherit their session and content
    outside any session (a project intro, an appendix) is left untagged.
    Unstructured documents (blank-line fallback): a block that starts with a
    session heading opens that session and following blocks inherit it.

    The sessions found must be exactly 1..expected_count, each in one contiguous
    run, in order. Anything else raises SessionBoundaryError naming the file, the
    sessions found and the count expected.

    Returns (tagged_sections, untagged_sections); tagged ones carry session_number.
    """
    rx = compile_session_pattern(pattern)
    tagged, untagged = [], []
    runs: list[int] = []  # session numbers in document order, one entry per contiguous run
    current = None
    for section in sections:
        n = _session_in_path(section["heading_path"], rx)
        if n is None and not section.get("structured", True):
            n = current
        if n is None:
            untagged.append(section)
            continue
        current = n
        if not runs or runs[-1] != n:
            runs.append(n)
        tagged.append({**section, "session_number": n})

    distinct = sorted(set(runs))
    found = ", ".join(str(n) for n in runs) or "none"
    where = f"(session headings are detected with {rx.pattern!r}, case-insensitive)"
    if len(distinct) != expected_count:
        raise SessionBoundaryError(
            f"{source_file}: expected {expected_count} sessions, found {len(distinct)} [{found}] {where}. "
            f"No missions were generated from this file."
        )
    if runs != list(range(1, expected_count + 1)):
        raise SessionBoundaryError(
            f"{source_file}: expected sessions 1..{expected_count} in order, each once, but found [{found}] {where}. "
            f"No missions were generated from this file."
        )
    return tagged, untagged


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
            # Carried through when the section was session-tagged (assign_sessions).
            part["session_number"] = section.get("session_number")
            part["session_id"] = section.get("session_id")
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
            chunk.setdefault("session_id", None)
            cur.execute(
                """SELECT id, content_hash, session_id FROM content_chunks
                    WHERE source_file = %s AND chunk_ref = %s""",
                (chunk["source_file"], chunk["chunk_ref"]),
            )
            row = cur.fetchone()
            if row is None:
                if not dry_run:
                    ins = conn.cursor()
                    ins.execute(
                        """INSERT INTO content_chunks
                             (source_file, chunk_ref, heading, body, content_hash, subject, session_id)
                           VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                        (
                            chunk["source_file"],
                            chunk["chunk_ref"],
                            chunk["heading"],
                            chunk["body"],
                            chunk["content_hash"],
                            chunk["subject"],
                            chunk["session_id"],
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
                              SET heading = %s, body = %s, content_hash = %s, session_id = %s
                            WHERE id = %s""",
                        (chunk["heading"], chunk["body"], chunk["content_hash"], chunk["session_id"], row["id"]),
                    )
                    upd.close()
                result["changed"].append(chunk)
            else:
                chunk["id"] = row["id"]
                if row["session_id"] != chunk["session_id"]:
                    # Same text, different session (the curriculum mapping changed).
                    # Re-tag the chunk and its existing missions rather than
                    # regenerating identical content.
                    print(
                        f"  chunk '{chunk['chunk_ref']}': session_id {row['session_id']} -> {chunk['session_id']}; "
                        f"re-tagging its missions."
                    )
                    if not dry_run:
                        upd = conn.cursor()
                        upd.execute("UPDATE content_chunks SET session_id = %s WHERE id = %s", (chunk["session_id"], row["id"]))
                        upd.execute(
                            "UPDATE missions SET session_id = %s WHERE source_chunk_id = %s AND status <> 'retired'",
                            (chunk["session_id"], row["id"]),
                        )
                        upd.close()
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
