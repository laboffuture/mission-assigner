"""Hour-aware chunking, tagging and coverage (acceptance criteria 12–14).

No database and no API key: these pin the pure rules. The end-to-end path
(ingest → import against MySQL) is covered by verify-curriculum-pipeline.mjs.

The unit is the HOUR: the SME writes what is taught in hour 1, hour 2, and so on
up to the credit's total. A file declares the hours it covers in curriculum.json,
and that declaration is the contract these tests enforce.
"""
import pytest

from src.chunker import HourBoundaryError, assign_hours, sections_to_chunks
from src.curriculum import (
    CurriculumError,
    LEGACY,
    evaluate_hour_coverage,
    evaluate_hour_difficulty_coverage,
    mapping_for,
    parse_hours,
)
from src.importer import mission_row
from src.reader import _split_markdown, _split_plaintext_blocks

TEMPLATE = {"type": "quiz", "grading_mode": "auto", "time_band": "short"}


def credit_md(hours, preamble=True, appendix=False):
    parts = ["# C1: Foundations of Robotics"]
    if preamble:
        parts.append("This credit introduces the robot chassis and the tools used throughout.")
    for n in hours:
        parts.append(f"## Hour {n}: Topic {n}")
        parts.append(f"Hour {n} explains an idea in enough words to be a real paragraph of content.")
        parts.append(f"### Practice {n}")
        parts.append(f"The practice for hour {n} applies the idea to the line follower robot.")
    if appendix:
        parts.append("## Appendix")
        parts.append("A glossary of terms used across every hour of the credit.")
    return "\n\n".join(parts)


def by_heading(sections):
    return {s["heading"]: s.get("hour_number") for s in sections}


# --- detection and tagging (criterion 12) ---------------------------------------
def test_hours_detected_and_subsections_inherit():
    sections = _split_markdown(credit_md([1, 2, 3]), "c1.md")
    tagged, untagged = assign_hours(sections, 1, 3, None, "c1.md")
    tags = by_heading(tagged)
    assert tags["Hour 1: Topic 1"] == 1
    assert tags["Practice 2"] == 2  # a sub-heading belongs to its hour
    assert tags["Practice 3"] == 3
    assert [s["heading"] for s in untagged] == ["C1: Foundations of Robotics"]  # the preamble


def test_content_after_the_last_hour_is_not_silently_attached_to_it():
    sections = _split_markdown(credit_md([1, 2], appendix=True), "c1.md")
    tagged, untagged = assign_hours(sections, 1, 2, None, "c1.md")
    assert "Appendix" not in by_heading(tagged)
    assert "Appendix" in [s["heading"] for s in untagged]


def test_default_pattern_is_case_insensitive():
    text = "## HOUR 1\n\nBody one is here.\n\n## hour 2\n\nBody two is here."
    tagged, _ = assign_hours(_split_markdown(text, "c1.md"), 1, 2, None, "c1.md")
    assert [s["hour_number"] for s in tagged] == [1, 2]


def test_custom_pattern():
    text = "## Lesson 1\n\nBody one is here.\n\n## Lesson 2\n\nBody two is here."
    tagged, _ = assign_hours(_split_markdown(text, "c1.md"), 1, 2, r"^Lesson\s+(\d+)", "c1.md")
    assert [s["hour_number"] for s in tagged] == [1, 2]


def test_pattern_without_capture_group_is_rejected():
    with pytest.raises(ValueError):
        assign_hours(_split_markdown(credit_md([1]), "c1.md"), 1, 1, r"^Hour\s+\d+", "c1.md")


def test_unstructured_document_blocks_inherit_the_open_hour():
    text = "Intro block before anything.\n\nHour 1\nFirst body.\n\nMore about one.\n\nHour 2\nSecond body."
    sections = _split_plaintext_blocks(text, "c1.txt")
    tagged, untagged = assign_hours(sections, 1, 2, None, "c1.txt")
    assert [s["hour_number"] for s in tagged] == [1, 1, 2]
    assert len(untagged) == 1


def test_chunks_carry_the_hour():
    tagged, _ = assign_hours(_split_markdown(credit_md([1, 2]), "c1.md"), 1, 2, None, "c1.md")
    for s in tagged:
        s["hour_id"] = 100 + s["hour_number"]
    chunks = sections_to_chunks(tagged, subject="Robotics")
    assert chunks and all(c["hour_id"] == 100 + c["hour_number"] for c in chunks)
    assert all(c["subject"] == "Robotics" for c in chunks)


# --- a file that does not match its DECLARED range fails loudly (criterion 13) ----
def test_fewer_hours_than_declared_fails_naming_both():
    sections = _split_markdown(credit_md([1, 2, 3, 4, 5, 6, 7]), "tesla-c1.md")
    with pytest.raises(HourBoundaryError) as err:
        assign_hours(sections, 1, 8, None, "tesla-c1.md")
    msg = str(err.value)
    assert "tesla-c1.md" in msg
    assert "hours 1..8" in msg
    assert "7 were found" in msg
    assert "[1, 2, 3, 4, 5, 6, 7]" in msg
    assert "No missions were generated" in msg


def test_more_hours_than_declared_fails():
    with pytest.raises(HourBoundaryError, match=r"hours 1\.\.8"):
        assign_hours(_split_markdown(credit_md(range(1, 10)), "c1.md"), 1, 8, None, "c1.md")


def test_duplicate_or_out_of_order_hours_fail():
    with pytest.raises(HourBoundaryError, match=r"in order, each once"):
        assign_hours(_split_markdown(credit_md([1, 3, 2]), "c1.md"), 1, 3, None, "c1.md")
    with pytest.raises(HourBoundaryError):
        assign_hours(_split_markdown(credit_md([1, 2, 1, 3]), "c1.md"), 1, 3, None, "c1.md")
    with pytest.raises(HourBoundaryError):
        assign_hours(_split_markdown(credit_md([1, 2, 4]), "c1.md"), 1, 3, None, "c1.md")


def test_file_with_no_hour_headings_fails():
    with pytest.raises(HourBoundaryError, match="0 were found"):
        assign_hours(_split_markdown("# C1\n\nJust prose, no hours at all.", "c1.md"), 1, 9, None, "c1.md")


def test_a_mid_credit_file_must_match_ITS_range_not_start_at_one():
    """A credit split into project-sized files: the second file covers hours
    10..24, so hours numbered from 1 are the wrong content in the wrong place."""
    sections = _split_markdown(credit_md(range(10, 25)), "tesla-c2-p2.md")
    tagged, _ = assign_hours(sections, 10, 24, None, "tesla-c2-p2.md")
    assert [s["hour_number"] for s in tagged][:2] == [10, 10]

    restarted = _split_markdown(credit_md(range(1, 16)), "tesla-c2-p2.md")
    with pytest.raises(HourBoundaryError) as err:
        assign_hours(restarted, 10, 24, None, "tesla-c2-p2.md")
    assert "hours 10..24" in str(err.value)


# --- mapping and import tagging ---------------------------------------------------
def test_unmapped_file_is_an_error_not_silently_legacy():
    config = {"files": {}, "legacy_files": ["sample-cs.md"]}
    assert mapping_for("sample-cs.md", config) == LEGACY
    with pytest.raises(CurriculumError, match="not mapped"):
        mapping_for("tesla-c9.md", config)


def test_mapping_without_an_hour_range_is_refused():
    config = {"files": {"tesla-c1.md": {"subject": "Robotics", "track": "T", "credit": "C1"}}}
    with pytest.raises(CurriculumError, match="hours"):
        mapping_for("tesla-c1.md", config)


def test_hour_range_shapes():
    assert parse_hours([1, 24], "f.md") == (1, 24)
    assert parse_hours({"from": 10, "to": 24}, "f.md") == (10, 24)
    with pytest.raises(CurriculumError):
        parse_hours([24, 1], "f.md")
    with pytest.raises(CurriculumError):
        parse_hours([0, 5], "f.md")
    with pytest.raises(CurriculumError):
        parse_hours("1-24", "f.md")


def test_imported_mission_carries_hour_and_track_subject():
    m = {"title": "t", "body": "b" * 30, "difficulty": 2, "correct": "a", "explanation": "e", "source_quote": "q"}
    row = mission_row(m, subject="Robotics", hour_id=42, template=TEMPLATE, chunk_id=7, content_hash="h")
    assert row["hour_id"] == 42 and row["subject"] == "Robotics"
    legacy = mission_row(m, subject="Computer Science", hour_id=None, template=TEMPLATE, chunk_id=8, content_hash="h")
    assert legacy["hour_id"] is None


# --- coverage (criterion 14) --------------------------------------------------------
def test_hour_with_no_live_missions_is_a_gap():
    rows = [
        {"track": "T", "credit": "C1", "hour": 1, "live": 5},
        {"track": "T", "credit": "C1", "hour": 2, "live": 0},
        {"track": "T", "credit": "C1", "hour": 3, "live": 1},
    ]
    ev = evaluate_hour_coverage(rows)
    assert ev["gaps"] == 1
    assert ev["gap_hours"][0]["hour"] == 2


# --- hour x difficulty coverage (difficulty is a within-hour ranking) --------------
def test_hour_with_too_few_difficulty_variants_is_thin():
    rows = [
        {"track": "T", "credit": "C1", "hour": 1, "variants": 5},
        {"track": "T", "credit": "C1", "hour": 2, "variants": 3},
        {"track": "T", "credit": "C1", "hour": 3, "variants": 1},
        {"track": "T", "credit": "C1", "hour": 4, "variants": 0},
    ]
    ev = evaluate_hour_difficulty_coverage(rows)
    assert ev["minimum_variants"] == 3
    assert ev["thin"] == 2
    assert [r["hour"] for r in ev["thin_hours"]] == [3, 4]
    # Exactly three variants is enough to rank a low, mid and high level.
    assert 2 not in [r["hour"] for r in ev["thin_hours"]]
