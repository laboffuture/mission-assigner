"""Every draft must say who made it, with what, when, and from which text.

Two providers will have drafted this curriculum by the time the SME reviews it —
hour 1 came from Gemini before the Claude credit arrived — and comparing their
approval rates blind is only possible if each mission can be traced to the model
that wrote it. The drafts that already existed could not be: neither the draft nor
the request log recorded a provider or a model.
"""
import json

import pytest

from src import generator


class _Client:
    model = "test-model-9"

    def draft(self, system, turns, chunk):
        body = json.dumps(
            {
                "missions": [
                    {
                        "title": "A mission",
                        "body": "What does the controller do first?",
                        "options": {"a": "Boot", "b": "Sleep", "c": "Stop", "d": "Reset"},
                        "correct": "a",
                        "explanation": "It boots first.",
                        "difficulty": 1,
                        "tags": ["loops"],
                        "source_quote": "the controller boots",
                    }
                ]
            }
        )
        return body, {"input_tokens": 11, "output_tokens": 22}


@pytest.fixture
def staged(monkeypatch, tmp_path):
    drafts = tmp_path / "drafts"
    drafts.mkdir(parents=True)
    logged = {}
    monkeypatch.setattr(generator, "DRAFTS_DIR", drafts)
    monkeypatch.setattr(generator.db, "LOGS_DIR", tmp_path)
    monkeypatch.setattr(generator, "_log", lambda name, text: logged.__setitem__(name, text))
    monkeypatch.setattr(generator, "get_client", lambda: _Client())
    monkeypatch.setattr(generator.db, "load_levels", lambda: {"subject": "Robotics", "levels": []})
    monkeypatch.setattr(generator.db, "load_tags", lambda: ["loops"])
    monkeypatch.setattr(generator.db, "load_active_template", lambda: {"type": "quiz", "instructions": "i"})
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    return drafts, logged


CHUNK = {
    "chunk_ref": "Project 1 > 0-1 hr: Intro",
    "source_file": "doc.docx",
    "body": "Intro body text.",
    "content_hash": "abc123",
    "id": 7,
    "hour_id": 1,
    "subject": "Robotics",
}


def test_a_draft_records_who_made_it(staged):
    drafts, _ = staged
    generator.generate([dict(CHUNK)], dry_run=False)

    written = json.loads((drafts / f"{generator.safe_ref(CHUNK['chunk_ref'])}.json").read_text(encoding="utf-8"))
    assert written["provider"] == "anthropic"
    assert written["model"] == "test-model-9", "the model must come from the client, not the environment"
    assert written["content_hash"] == "abc123", "which text it was made from"
    # ISO-8601 UTC, not the compact filename stamp.
    assert written["generated_at"].endswith("Z") and "T" in written["generated_at"]
    assert len(written["generated_at"]) == 20, written["generated_at"]


def test_the_request_log_records_it_too(staged):
    """So a draft's provenance can be checked against the call that produced it.
    For the drafts made before this, it cannot: the log held chunk_ref, system and
    turns only."""
    _, logged = staged
    generator.generate([dict(CHUNK)], dry_run=False)

    requests = [json.loads(v) for k, v in logged.items() if k.endswith("request.json")]
    assert requests, "no request was logged"
    assert requests[0]["provider"] == "anthropic"
    assert requests[0]["model"] == "test-model-9"


def test_the_model_is_whatever_the_client_used(staged, monkeypatch):
    """Not LLM_MODEL: the environment can disagree with the client (an unset model
    means the client's own default), and the draft must name what was really
    called."""
    drafts, _ = staged
    monkeypatch.setenv("LLM_MODEL", "something-else-entirely")
    generator.generate([dict(CHUNK)], dry_run=False)

    written = json.loads((drafts / f"{generator.safe_ref(CHUNK['chunk_ref'])}.json").read_text(encoding="utf-8"))
    assert written["model"] == "test-model-9"


def test_the_backfilled_gemini_draft_is_marked_as_such():
    """Hour 1's reviewed draft is on disk from the Gemini run. Its provider and
    model were backfilled by hand because nothing recorded them at the time, and
    it says so: `provenance: backfilled` means inferred, not observed."""
    drafts = generator.DRAFTS_DIR
    existing = sorted(drafts.glob("*.json")) if drafts.exists() else []
    if not existing:
        pytest.skip("no staged drafts on this machine")
    for f in existing:
        d = json.loads(f.read_text(encoding="utf-8"))
        assert d.get("provider"), f"{f.name} has no provider"
        assert d.get("model"), f"{f.name} has no model"
        assert d.get("generated_at"), f"{f.name} has no generated_at"
        if d.get("provenance") == "backfilled":
            assert d.get("provenance_note"), f"{f.name} is backfilled but does not say on what basis"
