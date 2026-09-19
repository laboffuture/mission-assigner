"""Which curriculum project each SME file represents.

config/curriculum.json maps a file name to its track, credit and project:

    {
      "session_heading_pattern": "^Session\\\\s+(\\\\d+)",
      "files": {
        "tesla-c1-p1.md": {"subject": "Robotics", "track": "Tesla's Track", "credit": "C1", "project": 1}
      },
      "legacy_files": ["sample-cs.md"]
    }

A file that is neither mapped nor listed as legacy is an error: silently importing
it untagged would produce missions that curriculum selection never serves.
The curriculum itself (tracks, credits, projects, sessions) is loaded by the Node
app (`npm run curriculum:load`); this module only looks it up.
"""
from __future__ import annotations

import os

from .chunker import DEFAULT_SESSION_PATTERN


class CurriculumError(Exception):
    """A file cannot be placed in the curriculum."""


LEGACY = "legacy"


def session_pattern(config: dict) -> str:
    return os.getenv("SESSION_HEADING_PATTERN") or config.get("session_heading_pattern") or DEFAULT_SESSION_PATTERN


def mapping_for(file_name: str, config: dict):
    """The file's mapping dict, LEGACY, or raise CurriculumError."""
    mapping = config.get("files", {}).get(file_name)
    if mapping:
        missing = [k for k in ("subject", "track", "credit", "project") if mapping.get(k) in (None, "")]
        if missing:
            raise CurriculumError(f"{file_name}: curriculum mapping is missing {', '.join(missing)}")
        return mapping
    if file_name in config.get("legacy_files", []):
        return LEGACY
    raise CurriculumError(
        f"{file_name}: not mapped to a curriculum project in curriculum.json and not listed in legacy_files. "
        f"Add it under \"files\" with subject, track, credit and project."
    )


def resolve_project(conn, mapping: dict, file_name: str) -> dict:
    """Look the mapped project up in the database. Returns
    {project_id, session_count, subject, track, credit, project, sessions: {sequence: session_id}}."""
    cur = conn.cursor(dictionary=True)
    try:
        cur.execute(
            """SELECT p.id, p.session_count, t.subject
                 FROM projects p
                 JOIN credits c ON c.id = p.credit_id
                 JOIN tracks t ON t.id = c.track_id
                WHERE t.subject = %s AND t.name = %s AND c.code = %s AND p.sequence = %s""",
            (mapping["subject"], mapping["track"], mapping["credit"], int(mapping["project"])),
        )
        row = cur.fetchone()
        if row is None:
            raise CurriculumError(
                f"{file_name}: project {mapping['subject']} / {mapping['track']} / {mapping['credit']} / "
                f"P{mapping['project']} is not in the database. Load the curriculum first "
                f"(`npm run curriculum:load -- <definition.json>` in mission-demo)."
            )
        cur.execute("SELECT id, sequence FROM sessions WHERE project_id = %s", (row["id"],))
        sessions = {int(r["sequence"]): int(r["id"]) for r in cur.fetchall()}
    finally:
        cur.close()
    if len(sessions) != int(row["session_count"]):
        raise CurriculumError(
            f"{file_name}: project has session_count {row['session_count']} but {len(sessions)} session rows; "
            f"reload the curriculum definition."
        )
    return {
        "project_id": int(row["id"]),
        "session_count": int(row["session_count"]),
        "subject": row["subject"],
        "track": mapping["track"],
        "credit": mapping["credit"],
        "project": int(mapping["project"]),
        "sessions": sessions,
    }


MIN_DIFFICULTY_VARIANTS = 3


def evaluate_session_difficulty_coverage(rows: list[dict], minimum_variants: int = MIN_DIFFICULTY_VARIANTS) -> dict:
    """Pure: rows of {track, credit, project, session, credit_sequence, variants}.
    Difficulty is only a within-session ranking, so it can only personalise when a
    session carries a spread. A session with fewer than `minimum_variants`
    distinct live difficulties is reported as thin."""
    thin = [r for r in rows if int(r["variants"]) < minimum_variants]
    return {"thin": len(thin), "thin_sessions": thin, "sessions": len(rows), "minimum_variants": minimum_variants}


def evaluate_session_coverage(rows: list[dict], minimum: int = 1) -> dict:
    """Pure: rows of {track, credit, project, session, credit_sequence, live}.
    A session with fewer than `minimum` live missions is a gap — a student who
    reaches it is served nothing new from it."""
    gaps = [r for r in rows if int(r["live"]) < minimum]
    return {"gaps": len(gaps), "gap_sessions": gaps, "sessions": len(rows)}
