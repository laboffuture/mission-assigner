"""Validate generated missions before anything reaches the database.

The load-bearing check is source_quote-in-chunk: it catches a model inventing
content that is not in the source. Matching is EXACT after Unicode normalization
(never fuzzy — fuzzy is how invented quotes slip through). Normalization exists
only to stop false rejections when a real model faithfully reproduces text but
with curly quotes, en/em-dashes, non-breaking spaces, or collapsed newlines.

Every rejected source_quote is logged verbatim alongside its chunk_ref so that
threshold tuning is evidence-based rather than guesswork.
"""
from __future__ import annotations

import json
import re
import unicodedata

from . import db
from .generator import DRAFTS_DIR, safe_ref

VALIDATED_DIR = db.LOGS_DIR / "validated"
REJECTED_QUOTES_LOG = db.LOGS_DIR / "rejected_quotes.jsonl"
VALID_KEYS = ["a", "b", "c", "d"]

_CURLY = {
    "‘": "'", "’": "'", "‚": "'", "′": "'",
    "“": '"', "”": '"', "„": '"', "″": '"',
    "«": '"', "»": '"',
}
_DASHES = {ch: "-" for ch in "‐‑‒–—―−"}
_TRANSLATE = {ord(k): v for k, v in {**_CURLY, **_DASHES}.items()}
_EDGE_PUNCT = " \t\r\n\"'.,;:!?()[]{}-–—"


def normalize_text(s: str) -> str:
    """NFKC, map curly quotes/dashes to ASCII, non-breaking spaces to spaces,
    collapse all whitespace to single spaces, lowercase."""
    s = unicodedata.normalize("NFKC", s or "")
    s = s.translate(_TRANSLATE)
    s = s.replace(" ", " ").replace(" ", " ")
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s


def normalize_quote(s: str) -> str:
    """As normalize_text, but also strip leading/trailing punctuation, since a
    model often quotes a fragment ending in a stray comma or period."""
    return normalize_text(s).strip(_EDGE_PUNCT)


def quote_in_body(quote: str, body: str) -> bool:
    nq = normalize_quote(quote)
    return bool(nq) and nq in normalize_text(body)


def validate_mission(mission: dict, chunk_body: str, tags_vocab: list[str]) -> list[str]:
    """Return a list of failure reasons. Empty list == valid."""
    errors: list[str] = []

    options = mission.get("options", [])
    keys = [o.get("key") for o in options] if isinstance(options, list) else []
    if len(options) != 4 or keys != VALID_KEYS:
        errors.append(f"options must be exactly 4 with keys a,b,c,d (got {keys})")

    if mission.get("correct") not in VALID_KEYS:
        errors.append(f"correct must be one of a,b,c,d (got {mission.get('correct')!r})")

    diff = mission.get("difficulty")
    if not isinstance(diff, int) or isinstance(diff, bool) or not (0 <= diff <= 4):
        errors.append(f"difficulty must be an integer 0-4 (got {diff!r})")

    mtags = mission.get("tags", [])
    bad = [t for t in mtags if t not in tags_vocab] if isinstance(mtags, list) else ["<not a list>"]
    if bad:
        errors.append(f"tags not in vocabulary: {bad}")

    if isinstance(options, list):
        texts = [normalize_text(o.get("text", "")) for o in options]
        if len(set(texts)) != len(texts):
            errors.append("two or more options have identical text")

    body = (mission.get("body") or "").strip()
    if len(body) < 20:
        errors.append(f"body must be >= 20 chars (got {len(body)})")

    quote = (mission.get("source_quote") or "").strip()
    if not quote:
        errors.append("source_quote is missing or empty")
    elif not quote_in_body(quote, chunk_body):
        errors.append("source_quote does not appear in the chunk body (possible invention)")

    return errors


def _chunk_body(cur, chunk_id):
    if chunk_id is None:
        return None
    cur.execute("SELECT body FROM content_chunks WHERE id = %s", (chunk_id,))
    row = cur.fetchone()
    return row[0] if row else None


def _log_rejected_quote(chunk_ref: str, index: int, quote: str):
    with REJECTED_QUOTES_LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"chunk_ref": chunk_ref, "index": index, "raw_quote": quote}) + "\n")


def validate_drafts(dry_run: bool = False) -> dict:
    """Validate every staged draft. Writes passing missions to logs/validated/.
    Returns {'passed': int, 'failed': int, 'rejections': [...]}"""
    tags_vocab = db.load_tags()
    VALIDATED_DIR.mkdir(parents=True, exist_ok=True)
    if not dry_run:
        for old in VALIDATED_DIR.glob("*.json"):
            old.unlink()

    passed = failed = 0
    rejections: list[dict] = []

    conn = db.get_connection()
    try:
        cur = conn.cursor()
        draft_files = sorted(DRAFTS_DIR.glob("*.json")) if DRAFTS_DIR.exists() else []
        if not draft_files:
            print("  No staged drafts found (run `generate` first).")
        for df in draft_files:
            record = json.loads(df.read_text(encoding="utf-8"))
            body = _chunk_body(cur, record.get("chunk_id"))
            if body is None:
                print(f"  WARNING: chunk_id {record.get('chunk_id')} for {record['chunk_ref']} not found; skipping.")
                continue

            kept = []
            for i, mission in enumerate(record["missions"]):
                errs = validate_mission(mission, body, tags_vocab)
                if errs:
                    failed += 1
                    for e in errs:
                        print(f"  REJECT [{record['chunk_ref']} #{i}] {e}")
                        rejections.append({"chunk_ref": record["chunk_ref"], "index": i, "reason": e})
                        if e.startswith("source_quote does not appear"):
                            raw_q = mission.get("source_quote", "")
                            print(f"           raw source_quote: {raw_q!r}")
                            _log_rejected_quote(record["chunk_ref"], i, raw_q)
                else:
                    passed += 1
                    kept.append(mission)

            if not dry_run:
                out = dict(record)
                out["missions"] = kept
                (VALIDATED_DIR / df.name).write_text(json.dumps(out, indent=2), encoding="utf-8")
        cur.close()
    finally:
        conn.close()

    print(f"  Validation: {passed} passed, {failed} failed.")
    return {"passed": passed, "failed": failed, "rejections": rejections}
