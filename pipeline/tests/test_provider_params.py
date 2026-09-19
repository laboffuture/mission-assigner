"""Provider/model-conditional request parameters.

Newer models removed the sampling parameters entirely, so sending temperature at
any value returns a 400. These tests pin which models get the parameter and
which do not, and assert the actual kwargs each provider client sends by
substituting a recording stub for the vendor SDK client. No network, no API key.
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
    "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5",
    "claude-sonnet-5", "claude-fable-5-1", "claude-mythos-5-1",
])
def test_anthropic_new_models_reject_temperature(model):
    assert accepts_temperature("anthropic", model) is False


@pytest.mark.parametrize("model", [
    "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5",
    "claude-opus-4-5", "claude-3-5-sonnet-20241022",
])
def test_anthropic_older_models_accept_temperature(model):
    assert accepts_temperature("anthropic", model) is True


def test_unknown_future_anthropic_model_omits_rather_than_400s():
    # An allowlist means a model released after this code omits the parameter
    # and still works, instead of hard-failing with a 400.
    assert accepts_temperature("anthropic", "claude-opus-9") is False


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


def test_anthropic_omits_temperature_on_opus_4_8():
    rec = _Recorder()
    _anthropic_client("claude-opus-4-8", rec).draft("sys", [{"role": "user", "content": "x"}], {})
    assert "temperature" not in rec.kwargs
    assert rec.kwargs["max_tokens"] == 8192


def test_anthropic_sends_temperature_zero_on_opus_4_6():
    rec = _Recorder()
    _anthropic_client("claude-opus-4-6", rec).draft("sys", [{"role": "user", "content": "x"}], {})
    assert rec.kwargs["temperature"] == 0


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
