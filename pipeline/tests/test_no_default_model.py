"""A paid provider never gets a guessed model id.

The defaults in this file were `claude-opus-4-8`, `gpt-4o` and
`gemini-2.0-flash` - guesses about which models existed when the code was
written. A retired Gemini default has already cost a run. So an unset LLM_MODEL
stops a real provider, naming the variable; the local fakes keep their defaults,
because nothing is spent and no model line-up is involved.
"""
import pytest

from src import generator


@pytest.mark.parametrize("provider", ["anthropic", "openai", "google"])
@pytest.mark.parametrize("unset", ["", "   ", None])
def test_a_paid_provider_with_no_model_stops_the_run(monkeypatch, capsys, provider, unset):
    monkeypatch.setenv("LLM_PROVIDER", provider)
    if unset is None:
        monkeypatch.delenv("LLM_MODEL", raising=False)
    else:
        monkeypatch.setenv("LLM_MODEL", unset)
    # Prove it stops BEFORE constructing a client: a key would otherwise be
    # required, and the error would be about the key rather than the model.
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)

    with pytest.raises(SystemExit) as exit_info:
        generator.get_client()

    message = str(exit_info.value)
    assert "LLM_MODEL" in message, message
    assert provider in message, message
    assert "does not guess" in message
    assert "Nothing has been generated" in message


@pytest.mark.parametrize("provider,expected_default", [("mock", "mock-1"), ("hostile", "hostile-1")])
def test_the_local_fakes_keep_their_defaults(monkeypatch, provider, expected_default):
    monkeypatch.setenv("LLM_PROVIDER", provider)
    monkeypatch.delenv("LLM_MODEL", raising=False)

    client = generator.get_client()

    assert client.model == expected_default


def test_a_fake_still_honours_an_explicit_model(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "mock")
    monkeypatch.setenv("LLM_MODEL", "mock-9")
    assert generator.get_client().model == "mock-9"


def test_an_explicit_model_reaches_a_paid_client(monkeypatch):
    """The stop is about an ABSENT id, not about paid providers in general."""
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("LLM_MODEL", "  claude-sonnet-5-5  ")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-not-real")

    client = generator.get_client()

    assert client.model == "claude-sonnet-5-5", "the id should be used as given, trimmed"


def test_an_unknown_provider_still_fails_loudly(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "notaprovider")
    monkeypatch.setenv("LLM_MODEL", "x")
    with pytest.raises(SystemExit) as exit_info:
        generator.get_client()
    assert "unknown LLM_PROVIDER" in str(exit_info.value)
