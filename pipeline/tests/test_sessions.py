"""Session-aware chunking, tagging and coverage (acceptance criteria 11–13).

No database and no API key: these pin the pure rules. The end-to-end path
(ingest → import against MySQL) is covered by verify-curriculum-pipeline.mjs.
"""
import pytest

from src.chunker import SessionBoundaryError, assign_sessions, sections_to_chunks
from src.curriculum import (
    CurriculumError,
    LEGACY,
    evaluate_session_coverage,
    evaluate_session_difficulty_coverage,
    mapping_for,
)
from src.importer import mission_row
from src.reader import _split_markdown, _split_plaintext_blocks

TEMPLATE = {"type": "quiz", "grading_mode": "auto", "time_band": "short"}


def project_md(sessions, preamble=True, appendix=False):
    parts = ["# Project 1: Build a line follower"]
    if preamble:
        parts.append("This project introduces the robot chassis and the tools used throughout.")
    for n in sessions:
        parts.append(f"## Session {n}: Topic {n}")
        parts.append(f"Session {n} explains an idea in enough words to be a real paragraph of content.")
        parts.append(f"### Practice {n}")
        parts.append(f"The practice for session {n} applies the idea to the line follower robot.")
    if appendix:
        parts.append("## Appendix")
        parts.append("A glossary of terms used across every session of the project.")
    return "\n\n".join(parts)


def by_heading(sections):
    return {s["heading"]: s.get("session_number") for s in sections}


# --- detection and tagging (criterion 11) ---------------------------------------
def test_sessions_detected_and_subsections_inherit():
    sections = _split_markdown(project_md([1, 2, 3]), "p.md")
    tagged, untagged = assign_sessions(sections, 3, None, "p.md")
    tags = by_heading(tagged)
    assert tags["Session 1: Topic 1"] == 1
    assert tags["Practice 2"] == 2          # a sub-heading belongs to its session
    assert tags["Practice 3"] == 3
    assert [s["heading"] for s in untagged] == ["Project 1: Build a line follower"]  # the preamble


def test_content_after_the_last_session_is_not_silently_attached_to_it():
    sections = _split_markdown(project_md([1, 2], appendix=True), "p.md")
    tagged, untagged = assign_sessions(sections, 2, None, "p.md")
    assert "Appendix" not in by_heading(tagged)
    assert "Appendix" in [s["heading"] for s in untagged]


def test_default_pattern_is_case_insensitive():
    text = "## SESSION 1\n\nBody one is here.\n\n## session 2\n\nBody two is here."
    tagged, _ = assign_sessions(_split_markdown(text, "p.md"), 2, None, "p.md")
    assert [s["session_number"] for s in tagged] == [1, 2]


def test_custom_pattern():
    text = "## Lesson 1\n\nBody one is here.\n\n## Lesson 2\n\nBody two is here."
    tagged, _ = assign_sessions(_split_markdown(text, "p.md"), 2, r"^Lesson\s+(\d+)", "p.md")
    assert [s["session_number"] for s in tagged] == [1, 2]


def test_pattern_without_capture_group_is_rejected():
    with pytest.raises(ValueError):
        assign_sessions(_split_markdown(project_md([1]), "p.md"), 1, r"^Session\s+\d+", "p.md")


def test_unstructured_document_blocks_inherit_the_open_session():
    text = "Intro block before anything.\n\nSession 1\nFirst body.\n\nMore about one.\n\nSession 2\nSecond body."
    sections = _split_plaintext_blocks(text, "p.txt")
    tagged, untagged = assign_sessions(sections, 2, None, "p.txt")
    assert [s["session_number"] for s in tagged] == [1, 1, 2]
    assert len(untagged) == 1


def test_chunks_carry_the_session():
    tagged, _ = assign_sessions(_split_markdown(project_md([1, 2]), "p.md"), 2, None, "p.md")
    for s in tagged:
        s["session_id"] = 100 + s["session_number"]
    chunks = sections_to_chunks(tagged, subject="Robotics")
    assert chunks and all(c["session_id"] == 100 + c["session_number"] for c in chunks)
    assert all(c["subject"] == "Robotics" for c in chunks)


# --- mismatch fails loudly (criterion 12) -----------------------------------------
def test_fewer_sessions_than_defined_fails_naming_both_numbers():
    sections = _split_markdown(project_md([1, 2, 3, 4, 5, 6, 7]), "tesla-c1-p2.md")
    with pytest.raises(SessionBoundaryError) as err:
        assign_sessions(sections, 8, None, "tesla-c1-p2.md")
    msg = str(err.value)
    assert "tesla-c1-p2.md" in msg
    assert "expected 8" in msg
    assert "found 7" in msg
    assert "[1, 2, 3, 4, 5, 6, 7]" in msg


def test_more_sessions_than_defined_fails():
    with pytest.raises(SessionBoundaryError, match="expected 8 sessions, found 9"):
        assign_sessions(_split_markdown(project_md(range(1, 10)), "p.md"), 8, None, "p.md")


def test_duplicate_or_out_of_order_sessions_fail():
    with pytest.raises(SessionBoundaryError, match=r"in order, each once"):
        assign_sessions(_split_markdown(project_md([1, 3, 2]), "p.md"), 3, None, "p.md")
    with pytest.raises(SessionBoundaryError):
        assign_sessions(_split_markdown(project_md([1, 2, 1, 3]), "p.md"), 3, None, "p.md")
    with pytest.raises(SessionBoundaryError):
        assign_sessions(_split_markdown(project_md([1, 2, 4]), "p.md"), 3, None, "p.md")


def test_file_with_no_session_headings_fails():
    with pytest.raises(SessionBoundaryError, match="found 0"):
        assign_sessions(_split_markdown("# Project\n\nJust prose, no sessions at all.", "p.md"), 9, None, "p.md")


# --- mapping and import tagging ---------------------------------------------------
def test_unmapped_file_is_an_error_not_silently_legacy():
    config = {"files": {}, "legacy_files": ["sample-cs.md"]}
    assert mapping_for("sample-cs.md", config) == LEGACY
    with pytest.raises(CurriculumError, match="not mapped"):
        mapping_for("tesla-c9-p1.md", config)


def test_imported_mission_carries_session_and_track_subject():
    m = {"title": "t", "body": "b" * 30, "difficulty": 2, "correct": "a", "explanation": "e", "source_quote": "q"}
    row = mission_row(m, subject="Robotics", session_id=42, template=TEMPLATE, chunk_id=7, content_hash="h")
    assert row["session_id"] == 42 and row["subject"] == "Robotics"
    legacy = mission_row(m, subject="Computer Science", session_id=None, template=TEMPLATE, chunk_id=8, content_hash="h")
    assert legacy["session_id"] is None


# --- coverage (criterion 13) --------------------------------------------------------
def test_session_with_no_live_missions_is_a_gap():
    rows = [
        {"track": "T", "credit": "C1", "project": 1, "session": 1, "credit_sequence": 1, "live": 5},
        {"track": "T", "credit": "C1", "project": 1, "session": 2, "credit_sequence": 2, "live": 0},
        {"track": "T", "credit": "C1", "project": 1, "session": 3, "credit_sequence": 3, "live": 1},
    ]
    ev = evaluate_session_coverage(rows)
    assert ev["gaps"] == 1
    assert ev["gap_sessions"][0]["session"] == 2


# --- session x difficulty coverage (difficulty is a within-session ranking) --------
def test_session_with_too_few_difficulty_variants_is_thin():
    rows = [
        {"track": "T", "credit": "C1", "project": 1, "session": 1, "credit_sequence": 1, "variants": 5},
        {"track": "T", "credit": "C1", "project": 1, "session": 2, "credit_sequence": 2, "variants": 3},
        {"track": "T", "credit": "C1", "project": 1, "session": 3, "credit_sequence": 3, "variants": 1},
        {"track": "T", "credit": "C1", "project": 1, "session": 4, "credit_sequence": 4, "variants": 0},
    ]
    ev = evaluate_session_difficulty_coverage(rows)
    assert ev["minimum_variants"] == 3
    assert ev["thin"] == 2
    assert [r["session"] for r in ev["thin_sessions"]] == [3, 4]
    # Exactly three variants is enough to rank a low, mid and high level.
    assert 2 not in [r["session"] for r in ev["thin_sessions"]]
