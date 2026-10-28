"""Provider/model-conditional request parameters.

Newer models removed the sampling parameters entirely, so sending temperature at
any value returns a 400. These tests pin which models get the parameter and
which do not, and assert the actual kwargs each provider client sends by
substituting a recording stub for the vendor SDK client. No network, no API key.

The Anthropic cases used to assert the opposite for the Claude 4.5/4.6 line,
which accepted temperature=0 on API version 2023-06-01. anthropic 2.x sends
2026-10-21, where temperature/top_p/top_k are rejected on EVERY model and are
gone from the SDK's signatures, so those assertions described behaviour that can
no longer happen. They now assert the rule that replaced them, and keep checking
that the parameters which DO still exist are sent (max_tokens, system, messages).
  https://platform.claude.com/docs/en/api/migration-2026-10-21
"""
from __future__ import annotations

import pytest

from src.generator import (
    AnthropicClient,
    GoogleClient,
    OpenAIClient,
    accepts_temperature,
    openai_uses_max_completion_tokens,
)


# --- capability table --------------------------------------------------------

@pytest.mark.parametrize("model", [
    # The models we might actually call...
    "claude-sonnet-5-5", "claude-opus-5-5", "claude-sonnet-5", "claude-opus-5",
    "claude-opus-4-7", "claude-opus-4-8", "claude-fable-5-1", "claude-mythos-5-1",
    # ...and the 4.5/4.6 line, which accepted temperature=0 on the API version the
    # old SDK sent. On 2026-10-21 it is a 400 for these too.
    "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5",
    "claude-opus-4-5", "claude-3-5-sonnet-20241022",
    # ...and anything released after this was written.
    "claude-opus-9", "",
])
def test_no_anthropic_model_takes_a_sampling_parameter(model):
    assert accepts_temperature("anthropic", model) is False


@pytest.mark.parametrize("model,expected", [
    ("gpt-4o", True), ("gpt-4-turbo", True),
    ("o1", False), ("o3-mini", False), ("gpt-5", False),
])
def test_openai_capability(model, expected):
    assert accepts_temperature("openai", model) is expected


def test_google_keeps_temperature():
    assert accepts_temperature("google", "gemini-2.0-flash") is True


@pytest.mark.parametrize("model,expected", [
    ("gpt-4o", False), ("o3-mini", True), ("gpt-5", True),
])
def test_openai_token_cap_name(model, expected):
    assert openai_uses_max_completion_tokens(model) is expected


# --- recording stubs: assert the kwargs actually sent ------------------------

class _Recorder:
    def __init__(self):
        self.kwargs = None


def _anthropic_client(model, rec):
    c = AnthropicClient.__new__(AnthropicClient)  # bypass __init__ (no API key)
    c.model = model

    class _Messages:
        def create(self, **kw):
            rec.kwargs = kw
            class _Block:
                type = "text"
                text = '{"missions": []}'
            class _Msg:
                content = [_Block()]
                usage = type("U", (), {"input_tokens": 1, "output_tokens": 2})()
            return _Msg()

    c.client = type("C", (), {"messages": _Messages()})()
    return c


@pytest.mark.parametrize("model", ["claude-sonnet-5-5", "claude-opus-4-8", "claude-opus-4-6"])
def test_anthropic_sends_no_sampling_parameter_whatever_the_model(model):
    """Including claude-opus-4-6, which this test file used to assert got
    temperature=0. Passing it to anthropic 2.x is a TypeError, and the API
    rejects it on every model."""
    rec = _Recorder()
    _anthropic_client(model, rec).draft("sys", [{"role": "user", "content": "x"}], {})
    for gone in ("temperature", "top_p", "top_k"):
        assert gone not in rec.kwargs, f"{gone} is a 400 on API version 2026-10-21"
    # The parameters that still exist are still sent.
    assert rec.kwargs["max_tokens"] == 8192
    assert rec.kwargs["model"] == model
    assert rec.kwargs["system"] == "sys"
    assert rec.kwargs["messages"] == [{"role": "user", "content": "x"}]


def test_the_installed_anthropic_sdk_matches_the_pin():
    """A pin nobody installed is a pin that lies. 2.0.0 is where the SDK starts
    sending API version 2026-10-21, which is what the sampling rule above depends
    on - so the floor is part of the contract, not housekeeping."""
    import importlib.metadata
    import pathlib
    import re

    installed = importlib.metadata.version("anthropic")
    req = (pathlib.Path(__file__).resolve().parents[1] / "requirements.txt").read_text(encoding="utf-8")
    pinned = re.search(r"^anthropic==(\S+)$", req, re.M)
    assert pinned, "requirements.txt does not pin anthropic exactly"
    assert installed == pinned.group(1), f"installed {installed}, pinned {pinned.group(1)}"
    assert int(installed.split(".")[0]) >= 2, "below 2.0.0 the SDK sends API version 2023-06-01"


def _openai_client(model, rec):
    c = OpenAIClient.__new__(OpenAIClient)
    c.model = model

    class _Completions:
        def create(self, **kw):
            rec.kwargs = kw
            class _Msg:
                content = '{"missions": []}'
            class _Choice:
                message = _Msg()
            class _Resp:
                choices = [_Choice()]
                usage = type("U", (), {"prompt_tokens": 1, "completion_tokens": 2})()
            return _Resp()

    c.client = type("C", (), {"chat": type("Ch", (), {"completions": _Completions()})()})()
    return c


def test_openai_gpt4o_keeps_temperature_and_max_tokens():
    rec = _Recorder()
    _openai_client("gpt-4o", rec).draft("sys", [{"role": "user", "content": "x"}], {})
    assert rec.kwargs["temperature"] == 0
    assert rec.kwargs["max_tokens"] == 8192
    assert "max_completion_tokens" not in rec.kwargs


def test_openai_reasoning_model_omits_temperature_and_renames_token_cap():
    rec = _Recorder()
    _openai_client("o3-mini", rec).draft("sys", [{"role": "user", "content": "x"}], {})
    assert "temperature" not in rec.kwargs
    assert rec.kwargs["max_completion_tokens"] == 8192
    assert "max_tokens" not in rec.kwargs


def test_google_still_sends_temperature():
    rec = _Recorder()
    c = GoogleClient.__new__(GoogleClient)
    c.model = "gemini-2.0-flash"

    class _Types:
        @staticmethod
        def GenerateContentConfig(**kw):
            rec.kwargs = kw
            return kw

    class _Models:
        def generate_content(self, **kw):
            class _Resp:
                text = '{"missions": []}'
                usage_metadata = type("U", (), {"prompt_token_count": 1, "candidates_token_count": 2})()
            return _Resp()

    c._genai = type("G", (), {"types": _Types})()
    c.client = type("C", (), {"models": _Models()})()
    c.draft("sys", [{"role": "user", "content": "x"}], {})
    assert rec.kwargs["temperature"] == 0
