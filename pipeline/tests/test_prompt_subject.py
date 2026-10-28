"""The prompt must name the subject the content is actually about.

The opening line said "computer-science assessment author" for every chunk,
including 25 hours of Robotics. That is a wrong fact in the prompt, not a style
preference: it tells the model the wrong thing about the material in front of it.
The subject travels on the chunk — a tracked file's chunks carry their track's
subject, a legacy file's carry levels.json's — so the prompt reads it from there.

Nothing else about the wording changes, which is what the rest of these assertions
hold down.
"""
import pytest

from src import generator

LEVELS = {
    "subject": "Computer Science",
    "levels": [{"level": 1, "name": "Starter", "description": "simple recall"}],
}
TAGS = ["loops", "sensors"]
TEMPLATE = {"type": "quiz", "instructions": "Write clear questions."}


def _chunk(subject, source_file="Project_Session_Content_Hours_0-25.docx"):
    return {
        "chunk_ref": "Project 1 > 0-1 hr: Intro & Context",
        "source_file": source_file,
        "body": "The controller boots and then reads the sensor.",
        "content_hash": "abc",
        "id": 1,
        "hour_id": 1,
        "subject": subject,
    }


def test_the_robotics_file_prompt_names_robotics():
    system, user = generator.build_prompts(_chunk("Robotics"), LEVELS, TAGS, TEMPLATE)
    assert "You are a Robotics assessment author." in system
    assert "computer-science" not in system.lower()
    assert "computer science" not in system.lower()
    assert "computer" not in user.lower(), "the subject must not leak into the user prompt either"


def test_the_legacy_sample_prompt_names_computer_science():
    system, _ = generator.build_prompts(_chunk("Computer Science", "sample-cs.md"), LEVELS, TAGS, TEMPLATE)
    assert "computer science" in system.lower()
    assert "You are a Computer Science assessment author." in system


def test_a_chunk_with_no_subject_falls_back_to_levels_json():
    """The legacy path's own default, so an untagged chunk keeps the behaviour it
    had rather than naming an empty subject."""
    chunk = _chunk("Robotics")
    del chunk["subject"]
    system, _ = generator.build_prompts(chunk, LEVELS, TAGS, TEMPLATE)
    assert "You are a Computer Science assessment author." in system


@pytest.mark.parametrize("subject", ["Robotics", "Computer Science"])
def test_everything_else_in_the_wording_is_unchanged(subject):
    system, user = generator.build_prompts(_chunk(subject), LEVELS, TAGS, TEMPLATE)
    # The rest of the system prompt, word for word.
    assert (
        "You write multiple-choice quiz questions strictly grounded in the source "
        "material you are given. You never invent facts that are not in the source. "
        "You output STRICT JSON only - no markdown, no code fences, no commentary."
    ) in system
    # ...and the parts of the user prompt that carry the rules.
    for phrase in [
        "Draft 3 to 5 multiple-choice missions from the SOURCE CHUNK below.",
        "TEMPLATE INSTRUCTIONS:",
        "DIFFICULTY LEVELS (use the integer level):",
        "ALLOWED TAGS (use ONLY these - never invent a tag):",
        "Do NOT invent facts not present in the chunk.",
        "Each question MUST STAND ALONE and test the SUBJECT",
        "Every mission MUST include a source_quote",
        "Output STRICT JSON matching exactly this schema (no markdown, no fences):",
        "SOURCE CHUNK",
    ]:
        assert phrase in user, phrase


def test_the_subject_is_the_only_difference_between_two_subjects():
    robotics, _ = generator.build_prompts(_chunk("Robotics"), LEVELS, TAGS, TEMPLATE)
    cs, _ = generator.build_prompts(_chunk("Computer Science"), LEVELS, TAGS, TEMPLATE)
    assert robotics.replace("Robotics", "SUBJECT") == cs.replace("Computer Science", "SUBJECT")
