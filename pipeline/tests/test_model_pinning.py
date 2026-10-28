"""The model that answered must be the model we asked for.

The run is pinned to one model. A silent substitution would put missions of
unknown provenance into the bank, which defeats the point of recording which
model wrote what — so a mismatch aborts the whole run instead of failing one
chunk, and every draft records the name the API reported.
"""
import json

import pytest

from src import generator


def _chunk(ref="Project 1 > 0-1 hr: Intro"):
    return {
        "chunk_ref": ref,
        "source_file": "doc.docx",
        "body": "Intro body text.",
        "content_hash": f"hash-{ref}",
        "id": 1,
        "hour_id": 1,
        "subject": "Robotics",
    }


MISSION_JSON = json.dumps(
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


class _FakeAnthropic:
    """Stands in for the vendor SDK client: records the request, returns a
    response whose `model` field is whatever the test wants."""

    def __init__(self, reports_model, stop_reason="end_turn"):
        self.reports_model = reports_model
        self.stop_reason = stop_reason
        self.calls = []
        outer = self

        class _Messages:
            def create(self, **kw):
                outer.calls.append(kw)

                class _Block:
                    type = "text"
                    text = MISSION_JSON

                class _Msg:
                    model = outer.reports_model
                    stop_reason = outer.stop_reason
                    content = [_Block()]
                    usage = type("U", (), {"input_tokens": 120, "output_tokens": 300})()

                return _Msg()

        self.messages = _Messages()


def _client(model, fake):
    c = generator.AnthropicClient.__new__(generator.AnthropicClient)  # no API key needed
    c.model = model
    c.reported_model = None
    c.client = fake
    return c


@pytest.fixture
def staged(monkeypatch, tmp_path):
    drafts = tmp_path / "drafts"
    drafts.mkdir(parents=True)
    monkeypatch.setattr(generator, "DRAFTS_DIR", drafts)
    monkeypatch.setattr(generator.db, "LOGS_DIR", tmp_path)
    monkeypatch.setattr(generator, "_log", lambda *a, **k: None)
    monkeypatch.setattr(generator.db, "load_levels", lambda: {"subject": "Robotics", "levels": []})
    monkeypatch.setattr(generator.db, "load_tags", lambda subject=None: ["loops"])
    monkeypatch.setattr(generator.db, "load_active_template", lambda: {"type": "quiz", "instructions": "i"})
    monkeypatch.setattr("time.sleep", lambda *_: None)
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    return drafts


def test_the_requested_model_is_announced_before_the_first_call(staged, capsys, monkeypatch):
    fake = _FakeAnthropic(reports_model="claude-sonnet-5-5")
    monkeypatch.setattr(generator, "get_client", lambda: _client("claude-sonnet-5-5", fake))

    generator.generate([_chunk()], dry_run=False)

    assert "provider anthropic, model claude-sonnet-5-5" in capsys.readouterr().out


def test_the_reported_model_is_recorded_in_the_draft(staged, monkeypatch):
    fake = _FakeAnthropic(reports_model="claude-sonnet-5-5")
    monkeypatch.setattr(generator, "get_client", lambda: _client("claude-sonnet-5-5", fake))

    generator.generate([_chunk()], dry_run=False)

    written = json.loads((staged / f"{generator.safe_ref(_chunk()['chunk_ref'])}.json").read_text(encoding="utf-8"))
    assert written["model"] == "claude-sonnet-5-5"
    assert written["model_reported"] == "claude-sonnet-5-5"


def test_a_different_model_in_the_response_aborts_the_whole_run(staged, monkeypatch):
    """Not a chunk failure. The second chunk must never be attempted."""
    fake = _FakeAnthropic(reports_model="claude-haiku-5-5")
    monkeypatch.setattr(generator, "get_client", lambda: _client("claude-sonnet-5-5", fake))

    with pytest.raises(generator.ModelMismatch) as excinfo:
        generator.generate([_chunk("a"), _chunk("b")], dry_run=False)

    assert "claude-sonnet-5-5" in str(excinfo.value) and "claude-haiku-5-5" in str(excinfo.value)
    assert len(fake.calls) == 1, "the run carried on after a mismatch"
    assert list(staged.glob("*.json")) == [], "a draft of unknown provenance was staged"


def test_an_abort_keeps_the_drafts_already_written(staged, monkeypatch):
    """The first chunk succeeds, the second answers as another model: the first
    draft stays on disk."""
    fake = _FakeAnthropic(reports_model="claude-sonnet-5-5")
    monkeypatch.setattr(generator, "get_client", lambda: _client("claude-sonnet-5-5", fake))
    generator.generate([_chunk("first")], dry_run=False)
    first = staged / f"{generator.safe_ref('first')}.json"
    before = first.read_text(encoding="utf-8")

    fake.reports_model = "claude-opus-5-5"
    with pytest.raises(generator.ModelMismatch):
        generator.generate([_chunk("second")], dry_run=False)

    assert first.read_text(encoding="utf-8") == before
    assert not (staged / f"{generator.safe_ref('second')}.json").exists()


def test_a_response_with_no_model_field_is_not_treated_as_a_mismatch(staged, monkeypatch):
    """A provider that does not report one is not evidence of substitution; the
    draft records None rather than inventing a name."""
    fake = _FakeAnthropic(reports_model=None)
    monkeypatch.setattr(generator, "get_client", lambda: _client("claude-sonnet-5-5", fake))

    res = generator.generate([_chunk()], dry_run=False)

    assert res["drafted"], res
    written = json.loads((staged / f"{generator.safe_ref(_chunk()['chunk_ref'])}.json").read_text(encoding="utf-8"))
    assert written["model_reported"] is None
