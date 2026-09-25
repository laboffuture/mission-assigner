"""Generation must survive a bad provider day without costing us work.

Three rules, each learned from a real run against Gemini's free tier:
  1. When the provider says "retry in 53s", we wait 53 seconds — not 1 then 2,
     which spends every retry inside the same closed quota window.
  2. We pace ourselves to LLM_REQUESTS_PER_MINUTE rather than being refused.
  3. A run that fails must never leave us with less than we started with: the
     drafts of chunks it did not successfully regenerate stay exactly as they were.
"""
import json

import pytest

from src import generator
from src.generator import _call_with_retries, requests_per_minute, server_retry_delay


# --- 1. the provider's own retry delay ---------------------------------------
REAL_429 = (
    "429 RESOURCE_EXHAUSTED. {'error': {'code': 429, 'message': 'You exceeded your current quota. "
    "Please retry in 53.197717369s.', 'status': 'RESOURCE_EXHAUSTED', 'details': [{'@type': "
    "'type.googleapis.com/google.rpc.RetryInfo', 'retryDelay': '53s'}]}}"
)


def test_the_delay_comes_from_the_server_when_it_gives_one():
    assert server_retry_delay(Exception(REAL_429)) == 53.0


def test_no_delay_offered_means_none():
    assert server_retry_delay(Exception("503 UNAVAILABLE. This model is experiencing high demand.")) is None


def test_an_absurd_delay_is_capped():
    huge = "{'retryDelay': '99999s'}"
    assert server_retry_delay(Exception(huge)) == generator.MAX_SERVER_RETRY_DELAY


def test_a_structured_attribute_is_used_too():
    e = Exception("no delay in the text")
    e.retry_after = 12
    assert server_retry_delay(e) == 12.0


def test_retries_wait_for_as_long_as_the_server_asked(monkeypatch):
    """The whole point: a 1s/2s backoff against a 53s window recovers from nothing."""
    slept = []
    monkeypatch.setattr("time.sleep", lambda s: slept.append(s))

    class QuotaThenOk:
        def __init__(self):
            self.calls = 0

        def draft(self, system, turns, chunk):
            self.calls += 1
            if self.calls == 1:
                raise generator.TransientError(REAL_429, status_code=429)
            return '{"missions": []}', {"input_tokens": 1, "output_tokens": 1}

    raw, _ = _call_with_retries(QuotaThenOk(), "s", [{"role": "user", "content": "x"}], {"chunk_ref": "c"})
    assert json.loads(raw) == {"missions": []}
    assert 53.0 in slept, f"expected a 53s wait, got {slept}"


# --- 2. pacing ---------------------------------------------------------------
def test_requests_per_minute_defaults_to_the_free_tier(monkeypatch):
    monkeypatch.delenv("LLM_REQUESTS_PER_MINUTE", raising=False)
    assert requests_per_minute() == 5.0
    monkeypatch.setenv("LLM_REQUESTS_PER_MINUTE", "60")
    assert requests_per_minute() == 60.0


def test_a_nonsense_rate_is_refused(monkeypatch):
    for bad in ("0", "-1", "soon"):
        monkeypatch.setenv("LLM_REQUESTS_PER_MINUTE", bad)
        with pytest.raises(ValueError):
            requests_per_minute()


def test_calls_are_spaced_to_the_configured_rate(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "google")  # a real provider, so pacing applies
    monkeypatch.setenv("LLM_REQUESTS_PER_MINUTE", "6")  # one call every 10 seconds
    slept = []
    clock = {"t": 1000.0}
    monkeypatch.setattr("time.monotonic", lambda: clock["t"])
    monkeypatch.setattr("time.sleep", lambda s: slept.append(s))
    generator._last_call_at = 0.0

    generator._throttle()          # first call: nothing to wait for
    assert slept == []
    generator._throttle()          # immediately after: must wait the full gap
    assert slept and abs(slept[-1] - 10.0) < 0.01, slept


# --- 3. a failed run must not destroy existing drafts ------------------------
def test_a_run_that_fails_leaves_existing_drafts_intact(monkeypatch, tmp_path):
    """The bug this replaces: generate cleared the drafts directory up front, so a
    run that failed every chunk deleted the previous run's good work."""
    drafts = tmp_path / "drafts"
    drafts.mkdir(parents=True)
    kept = drafts / "Earlier_good_chunk.json"
    kept.write_text(json.dumps({"chunk_ref": "earlier", "missions": [{"title": "kept"}]}), encoding="utf-8")
    kept_before = kept.read_text(encoding="utf-8")

    monkeypatch.setattr(generator, "DRAFTS_DIR", drafts)
    monkeypatch.setattr(generator.db, "LOGS_DIR", tmp_path)
    monkeypatch.setattr("time.sleep", lambda *_: None)
    monkeypatch.setattr(generator, "_log", lambda *a, **k: None)
    monkeypatch.setattr(generator, "get_client", lambda: _AlwaysRefuses())
    monkeypatch.setattr(generator.db, "load_levels", lambda: {"subject": "Robotics", "levels": []})
    monkeypatch.setattr(generator.db, "load_tags", lambda: ["loops"])
    monkeypatch.setattr(generator.db, "load_active_template", lambda: {"type": "quiz", "instructions": "i"})

    res = generator.generate(
        [{"chunk_ref": "new-chunk", "source_file": "f.docx", "body": "Body text.", "id": 1}],
        dry_run=False,
    )

    assert res["failures"], "the run was supposed to fail"
    assert res["drafted"] == []
    assert kept.exists(), "a failed run deleted a draft it never replaced"
    assert kept.read_text(encoding="utf-8") == kept_before


class _AlwaysRefuses:
    def draft(self, system, turns, chunk):
        raise generator.TransientError(REAL_429, status_code=429)


def test_local_fakes_are_not_paced(monkeypatch):
    """Pacing exists for a provider's quota. A mock has none, and pacing it would
    add minutes to every harness run."""
    monkeypatch.setenv("LLM_REQUESTS_PER_MINUTE", "5")
    slept = []
    monkeypatch.setattr("time.sleep", lambda s: slept.append(s))
    for provider, expected in (("mock", False), ("hostile", False), ("google", True)):
        monkeypatch.setenv("LLM_PROVIDER", provider)
        assert generator.pacing_applies() is expected, provider
    # Unset means mock — the same default get_client() applies — so it is unpaced.
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    assert generator.pacing_applies() is False
    monkeypatch.setenv("LLM_PROVIDER", "mock")
    generator._last_call_at = 1.0
    generator._throttle()
    generator._throttle()
    assert slept == [], f"a mock provider was paced: {slept}"
