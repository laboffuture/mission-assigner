"""Which curriculum HOURS each SME file covers.

config/curriculum.json maps a file name to its track, credit and hour range:

    {
      "hour_heading_pattern": "^Hour\\\\s+(\\\\d+)",
      "files": {
        "tesla-c1.md":    {"subject": "Robotics", "track": "Tesla's Track", "credit": "C1", "hours": [1, 24]},
        "tesla-c2-p1.md": {"subject": "Robotics", "track": "Tesla's Track", "credit": "C2", "hours": [1, 9]}
      },
      "legacy_files": ["sample-cs.md"]
    }

One file per credit is the expected shape — "hours": [1, total_hours]. A credit
split into project-sized files is supported too: each file declares the hours it
covers. The range is the contract: a file whose detected hour headings do not
match it is rejected whole, because mis-detected boundaries would mis-tag every
mission generated from the file.

A file that is neither mapped nor listed as legacy is an error: silently importing
it untagged would produce missions that curriculum selection never serves.
The curriculum itself (tracks, credits, hours) is loaded by the Node app
(`npm run curriculum:load`); this module only looks it up.
"""
from __future__ import annotations

import os

from .chunker import DEFAULT_HOUR_PATTERN


class CurriculumError(Exception):
    """A file cannot be placed in the curriculum."""


LEGACY = "legacy"


def hour_pattern(config: dict) -> str:
    return os.getenv("HOUR_HEADING_PATTERN") or config.get("hour_heading_pattern") or DEFAULT_HOUR_PATTERN


def parse_hours(value, file_name: str) -> tuple[int, int]:
    """The declared [first, last] hour range for a file."""
    if isinstance(value, dict):
        first, last = value.get("from"), value.get("to")
    elif isinstance(value, (list, tuple)) and len(value) == 2:
        first, last = value
    else:
        raise CurriculumError(
            f'{file_name}: "hours" must be [first, last] or {{"from": n, "to": n}} (got {value!r})'
        )
    try:
        first, last = int(first), int(last)
    except (TypeError, ValueError):
        raise CurriculumError(f'{file_name}: "hours" must be two whole numbers (got {value!r})') from None
    if first < 1 or last < first:
        raise CurriculumError(f"{file_name}: hour range {first}..{last} is not a valid range starting at 1 or more")
    return first, last


def mapping_for(file_name: str, config: dict):
    """The file's mapping dict, LEGACY, or raise CurriculumError."""
    mapping = config.get("files", {}).get(file_name)
    if mapping:
        missing = [k for k in ("subject", "track", "credit", "hours") if mapping.get(k) in (None, "")]
        if missing:
            raise CurriculumError(f"{file_name}: curriculum mapping is missing {', '.join(missing)}")
        parse_hours(mapping["hours"], file_name)
        return mapping
    if file_name in config.get("legacy_files", []):
        return LEGACY
    raise CurriculumError(
        f"{file_name}: not mapped to a curriculum credit in curriculum.json and not listed in legacy_files. "
        f'Add it under "files" with subject, track, credit and hours.'
    )


def resolve_credit(conn, mapping: dict, file_name: str) -> dict:
    """Look the mapped credit up in the database. Returns
    {credit_id, total_hours, first_hour, last_hour, subject, track, credit, hours: {hour_number: hour_id}}."""
    first, last = parse_hours(mapping["hours"], file_name)
    cur = conn.cursor(dictionary=True)
    try:
        cur.execute(
            """SELECT c.id, c.total_hours, t.subject
                 FROM credits c
                 JOIN tracks t ON t.id = c.track_id
                WHERE t.subject = %s AND t.name = %s AND c.code = %s""",
            (mapping["subject"], mapping["track"], mapping["credit"]),
        )
        row = cur.fetchone()
        if row is None:
            raise CurriculumError(
                f"{file_name}: credit {mapping['subject']} / {mapping['track']} / {mapping['credit']} "
                f"is not in the database. Load the curriculum first "
                f"(`npm run curriculum:load -- <definition.json>` in mission-demo)."
            )
        cur.execute("SELECT id, hour_number FROM hours WHERE credit_id = %s", (row["id"],))
        hours = {int(r["hour_number"]): int(r["id"]) for r in cur.fetchall()}
    finally:
        cur.close()

    total = int(row["total_hours"])
    # The same rule the loader enforces, checked again here: the pipeline must not
    # tag content against a credit whose rows and total disagree.
    if len(hours) != total:
        raise CurriculumError(
            f"{file_name}: credit {mapping['credit']} declares total_hours {total} but has {len(hours)} hour row(s); "
            f"reload the curriculum definition."
        )
    if last > total:
        raise CurriculumError(
            f"{file_name}: declares hours {first}..{last} but credit {mapping['credit']} has only {total} hour(s)."
        )
    missing = [n for n in range(first, last + 1) if n not in hours]
    if missing:
        raise CurriculumError(
            f"{file_name}: credit {mapping['credit']} has no hour row(s) {', '.join(str(n) for n in missing)}."
        )
    return {
        "credit_id": int(row["id"]),
        "total_hours": total,
        "first_hour": first,
        "last_hour": last,
        "subject": row["subject"],
        "track": mapping["track"],
        "credit": mapping["credit"],
        "hours": hours,
    }


MIN_DIFFICULTY_VARIANTS = 3


def evaluate_hour_difficulty_coverage(rows: list[dict], minimum_variants: int = MIN_DIFFICULTY_VARIANTS) -> dict:
    """Pure: rows of {track, credit, hour, variants}. Difficulty is only a
    within-hour ranking, so it can only personalise when an hour carries a spread.
    An hour with fewer than `minimum_variants` distinct live difficulties is
    reported as thin."""
    thin = [r for r in rows if int(r["variants"]) < minimum_variants]
    return {"thin": len(thin), "thin_hours": thin, "hours": len(rows), "minimum_variants": minimum_variants}


def evaluate_hour_coverage(rows: list[dict], minimum: int = 1) -> dict:
    """Pure: rows of {track, credit, hour, live}. An hour with fewer than
    `minimum` live missions is a gap — a student who reaches it is served nothing
    new from it."""
    gaps = [r for r in rows if int(r["live"]) < minimum]
    return {"gaps": len(gaps), "gap_hours": gaps, "hours": len(rows)}
