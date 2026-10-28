"""Spending controls: the cheapest documented settings, a hard output cap, and a
whole-run ceiling.

Extraction from a supplied chunk needs no reasoning, so thinking is off and
effort is the lowest the docs allow with it. On claude-sonnet-5-5
`thinking: {"type": "disabled"}` is a 400; the documented off-switch is
`{"type": "between_tools"}`, accepted at effort `high` or below with no other
field inside `thinking`.
"""
import json

import pytest

from src import generator

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


def _chunk(ref="chunk"):
    return {
        "chunk_ref": ref,
        "source_file": "doc.docx",
        "body": "Intro body text.",
        "content_hash": f"hash-{ref}",
        "id": 1,
        "hour_id": 1,
        "subject": "Robotics",
    }


class _FakeAnthropic:
    def __init__(self, stop_reason="end_turn", out_tokens=300):
        self.stop_reason = stop_reason
        self.out_tokens = out_tokens
        self.calls = []
        outer = self

        class _Messages:
            def create(self, **kw):
                outer.calls.append(kw)

                class _Block:
                    type = "text"
                    text = MISSION_JSON

                class _Msg:
                    model = "claude-sonnet-5-5"
                    stop_reason = outer.stop_reason
                    content = [_Block()]
                    usage = type("U", (), {"input_tokens": 700, "output_tokens": outer.out_tokens})()

                return _Msg()

        self.messages = _Messages()


def _client(fake, model="claude-sonnet-5-5"):
    c = generator.AnthropicClient.__new__(generator.AnthropicClient)
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


# --- the parameters we send --------------------------------------------------

def test_defaults_are_thinking_off_at_the_lowest_allowed_effort():
    extras = generator.anthropic_request_extras()
    assert extras == {"output_config": {"effort": "low"}, "thinking": {"type": "between_tools"}}


def test_thinking_carries_no_other_field():
    """display, budget_tokens or block_binding alongside between_tools is a 400."""
    assert list(generator.anthropic_request_extras()["thinking"].keys()) == ["type"]


def test_adaptive_drops_the_thinking_field_entirely(monkeypatch):
    """The documented alternative: adaptive thinking at low effort. Omitting
    `thinking` is how adaptive is requested, not {"type": "enabled"}."""
    monkeypatch.setenv("LLM_THINKING", "adaptive")
    extras = generator.anthropic_request_extras()
    assert "thinking" not in extras
    assert extras["output_config"] == {"effort": "low"}


@pytest.mark.parametrize("bad", ["disabled", "enabled", "none", "LOW "])
def test_a_nonsense_thinking_mode_is_refused(monkeypatch, bad):
    monkeypatch.setenv("LLM_THINKING", bad)
    with pytest.raises(ValueError):
        generator.anthropic_request_extras()


@pytest.mark.parametrize("bad", ["cheap", "lowest", "0"])
def test_a_nonsense_effort_level_is_refused(monkeypatch, bad):
    monkeypatch.setenv("LLM_EFFORT", bad)
    with pytest.raises(ValueError):
        generator.anthropic_effort()


@pytest.mark.parametrize("var", ["LLM_THINKING", "LLM_EFFORT", "LLM_MAX_OUTPUT_TOKENS"])
def test_a_blank_value_means_unset(monkeypatch, var):
    """A .env line with no value is the same as no line - the convention this
    module has used since requests_per_minute. Blank takes the default; it does
    not raise, and it does not send an empty parameter."""
    monkeypatch.setenv(var, "")
    assert generator.anthropic_request_extras() == {
        "output_config": {"effort": "low"},
        "thinking": {"type": "between_tools"},
    }
    assert generator.max_output_tokens() == 2200


def test_the_request_actually_carries_them(staged, monkeypatch):
    fake = _FakeAnthropic()
    monkeypatch.setattr(generator, "get_client", lambda: _client(fake))

    generator.generate([_chunk()], dry_run=False)

    sent = fake.calls[0]
    assert sent["output_config"] == {"effort": "low"}
    assert sent["thinking"] == {"type": "between_tools"}
    assert sent["max_tokens"] == 2200
    assert "temperature" not in sent


# --- the output cap ----------------------------------------------------------

def test_the_cap_is_twice_the_measured_output():
    assert generator.max_output_tokens() == 2200


def test_the_cap_is_configurable(monkeypatch):
    monkeypatch.setenv("LLM_MAX_OUTPUT_TOKENS", "5000")
    assert generator.max_output_tokens() == 5000


@pytest.mark.parametrize("bad", ["0", "-1", "lots"])
def test_a_nonsense_cap_is_refused(monkeypatch, bad):
    monkeypatch.setenv("LLM_MAX_OUTPUT_TOKENS", bad)
    with pytest.raises(ValueError):
        generator.max_output_tokens()


def test_a_truncated_reply_fails_the_chunk_and_is_not_retried(staged, monkeypatch, capsys):
    fake = _FakeAnthropic(stop_reason="max_tokens")
    monkeypatch.setattr(generator, "get_client", lambda: _client(fake))

    res = generator.generate([_chunk()], dry_run=False)

    assert res["drafted"] == []
    assert len(res["failures"]) == 1
    assert "truncated" in res["failures"][0]["error"]
    assert "2200-token cap" in res["failures"][0]["error"]
    assert len(fake.calls) == 1, "a truncated reply was retried"
    assert "Not retried" in capsys.readouterr().out
    assert list(staged.glob("*.json")) == [], "an incomplete draft was staged"


# --- the whole-run ceiling ---------------------------------------------------

def test_the_run_stops_cleanly_at_the_ceiling(staged, monkeypatch, capsys):
    """1,000 tokens a chunk against a 2,500 ceiling: three chunks are attempted
    (the third starts at 2,000), the fourth is not."""
    fake = _FakeAnthropic(out_tokens=300)
    monkeypatch.setattr(generator, "get_client", lambda: _client(fake))

    res = generator.generate([_chunk(f"c{i}") for i in range(5)], dry_run=False, token_ceiling=2500)

    assert len(res["drafted"]) == 3, res["drafted"]
    assert res["not_attempted"] == ["c3", "c4"]
    assert len(fake.calls) == 3, "a call was made after the ceiling was reached"
    out = capsys.readouterr().out
    assert "STOPPING" in out and "2,500 ceiling" in out
    assert "Drafts already written are kept" in out
    assert len(list(staged.glob("*.json"))) == 3


def test_no_ceiling_means_no_limit(staged, monkeypatch):
    fake = _FakeAnthropic()
    monkeypatch.setattr(generator, "get_client", lambda: _client(fake))

    res = generator.generate([_chunk(f"c{i}") for i in range(4)], dry_run=False)

    assert len(res["drafted"]) == 4
    assert res["not_attempted"] == []
