"""Keep the unit tests hermetic.

`src.db` loads pipeline/.env at import, so a developer's real settings reach every
test. That is how a unit test about retry classification came to sleep for twelve
seconds: the .env named a real provider (LLM_PROVIDER=google), so the request
pacer held the call to the free tier's 5-per-minute.

These tests exercise pure logic and local fakes. They must not inherit a
developer's provider, model, key or rate limit — and a test that wants one sets
it explicitly with monkeypatch.
"""
import pytest

from src import generator

LEAKY = ("LLM_PROVIDER", "LLM_MODEL", "LLM_REQUESTS_PER_MINUTE", "HOUR_HEADING_PATTERN")


@pytest.fixture(autouse=True)
def hermetic_env(monkeypatch):
    for name in LEAKY:
        monkeypatch.delenv(name, raising=False)
    # The pacer's "when did we last call" is module state; without this, one
    # test's call makes the next one wait.
    monkeypatch.setattr(generator, "_last_call_at", 0.0, raising=False)
    yield
