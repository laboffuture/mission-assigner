"""A mission is offered its own subject's tags, and judged by the same list.

config/tags.json held ONE global list of computer-science tags — loops,
recursion, sorting — and the prompt told the model to use only those, for 25
hours of Robotics content about an ESP32, a pulse sensor and a breadboard. The
validator rejects a tag outside the list, so the model had no legal tag that
described its own material.

The vocabulary is per subject now, read from one place by both the prompt and the
validator. A subject with no vocabulary refuses: a fallback is exactly how one
subject's missions end up wearing another subject's tags.
"""
import json

import pytest

from src import db, generator, validator

CS = "Computer Science"
ROBOTICS = "Robotics"

LEVELS = {"subject": CS, "levels": [{"level": 1, "name": "Starter", "description": "simple recall"}]}
TEMPLATE = {"type": "quiz", "instructions": "Write clear questions."}


def _chunk(subject, source_file="Project_Session_Content_Hours_0-25.docx"):
    return {
        "chunk_ref": "Project 1 > 1-2 hr: Preflight",
        "heading": "1-2 hr: Preflight",
        "source_file": source_file,
        "body": "The ESP32 reads the sensor through its pins. The resistor protects the LED.",
        "content_hash": "abc",
        "id": 1,
        "hour_id": 2,
        "subject": subject,
    }


# --- the vocabulary itself ---------------------------------------------------

def test_robotics_has_its_own_vocabulary():
    tags = db.load_tags(ROBOTICS)
    assert "sensors" in tags and "microcontroller" in tags and "circuits" in tags
    for cs_only in ("loops", "recursion", "sorting", "complexity"):
        assert cs_only not in tags, f"{cs_only} is a computer-science tag"
    assert len(tags) <= 15, f"{len(tags)} tags is more than the agreed maximum"
    assert all(t == t.lower() and " " not in t for t in tags), tags


def test_computer_science_is_unchanged():
    assert db.load_tags(CS) == [
        "loops",
        "recursion",
        "sorting",
        "strings",
        "data-structures",
        "algorithms",
        "functions",
        "variables",
        "conditionals",
        "complexity",
    ]


def test_the_robotics_list_is_marked_provisional_and_traceable():
    """The SME owns the final vocabulary, and every tag must trace to their text."""
    cfg = json.loads((db.CONFIG_DIR / "tags.json").read_text(encoding="utf-8"))
    entry = cfg["subjects"][ROBOTICS]
    assert entry.get("provisional") is True
    evidence = entry["evidence"]
    for tag in entry["tags"]:
        assert tag in evidence, f"{tag} has no evidence in the SME document"
        assert evidence[tag]["term"] and isinstance(evidence[tag]["hour"], int)


def test_a_subject_with_no_vocabulary_refuses_by_name():
    with pytest.raises(db.UnknownSubjectTags) as excinfo:
        db.load_tags("Underwater Basket Weaving")
    message = str(excinfo.value)
    assert "Underwater Basket Weaving" in message
    assert ROBOTICS in message and CS in message, "the message should say what IS defined"
    assert "loops" not in message, "it must not offer a computer-science fallback"


def test_coverage_spans_every_subject():
    everything = db.all_tags()
    assert "loops" in everything and "sensors" in everything
    assert len(everything) == len(set(everything)), "duplicated tags across subjects"


# --- the prompt --------------------------------------------------------------

def test_the_robotics_prompt_lists_robotics_tags_and_no_cs_ones():
    _, user = generator.build_prompts(_chunk(ROBOTICS), LEVELS, db.load_tags(ROBOTICS), TEMPLATE)
    allowed = next(l for l in user.splitlines() if l and not l.startswith("ALLOWED") and "sensors" in l)
    for tag in db.load_tags(ROBOTICS):
        assert tag in allowed, tag
    for cs_only in ("loops", "recursion", "sorting", "complexity", "data-structures"):
        assert cs_only not in allowed, f"{cs_only} was offered to a Robotics mission"


def test_the_legacy_sample_prompt_still_lists_the_cs_tags():
    _, user = generator.build_prompts(_chunk(CS, "sample-cs.md"), LEVELS, db.load_tags(CS), TEMPLATE)
    assert "loops, recursion, sorting" in user


# --- the validator -----------------------------------------------------------

def _mission(tags):
    return {
        "title": "A mission",
        "body": "Which part reads the heartbeat signal?",
        "options": [
            {"key": "a", "text": "The sensor"},
            {"key": "b", "text": "The resistor"},
            {"key": "c", "text": "The buzzer"},
            {"key": "d", "text": "The breadboard"},
        ],
        "correct": "a",
        "explanation": "The sensor reads it.",
        "difficulty": 1,
        "tags": tags,
        "source_quote": "The ESP32 reads the sensor through its pins.",
    }


BODY = "The ESP32 reads the sensor through its pins. The resistor protects the LED."


def test_the_validator_accepts_a_robotics_tag_on_a_robotics_mission():
    errs = validator.validate_mission(_mission(["sensors"]), BODY, db.load_tags(ROBOTICS))
    assert errs == [], errs


def test_the_validator_rejects_a_cs_tag_on_a_robotics_mission():
    errs = validator.validate_mission(_mission(["loops"]), BODY, db.load_tags(ROBOTICS))
    assert any("tags not in vocabulary" in e and "loops" in e for e in errs), errs


def test_the_validator_still_accepts_a_cs_tag_on_a_cs_mission():
    errs = validator.validate_mission(_mission(["loops"]), BODY, db.load_tags(CS))
    assert errs == [], errs


def test_the_prompt_and_the_validator_read_the_same_list():
    """The one that matters: a tag the prompt offered can never be rejected."""
    for subject in (ROBOTICS, CS):
        vocab = db.load_tags(subject)
        _, user = generator.build_prompts(_chunk(subject), LEVELS, vocab, TEMPLATE)
        for tag in vocab:
            assert tag in user, f"{subject}: {tag} not offered by the prompt"
            assert validator.validate_mission(_mission([tag]), BODY, vocab) == [], f"{subject}: {tag} rejected"
