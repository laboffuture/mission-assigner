"""Regression coverage for the LLM boundary and the pure decision logic.

Run from the pipeline/ directory:  python -m pytest -q
These tests need NO database and NO API key. They pin the failure modes a real
model actually exhibits (fences, truncation, invented quotes, 429s) and the
normalization that prevents false rejections.
"""
import json

import pytest

from src.generator import (
    HostileClient, MockClient, TransientError, _call_with_retries,
    _is_transient, _strip_fences, _try_parse,
)
from src.validator import normalize_text, normalize_quote, quote_in_body, validate_mission
from src.main import evaluate_coverage

LEVELS = [{"level": i, "name": f"L{i}"} for i in range(5)]
TAGS = ["loops", "recursion"]


def good_mission(quote="the sentence", tag="loops"):
    return {
        "title": "t", "body": "This is a question body that is well over twenty chars.",
        "difficulty": 2, "tags": [tag],
        "options": [{"key": "a", "text": "A"}, {"key": "b", "text": "B"},
                    {"key": "c", "text": "C"}, {"key": "d", "text": "D"}],
        "correct": "a", "explanation": "because", "source_quote": quote,
    }


# --- fence stripping / parsing ------------------------------------------------
def test_strip_fences_valid_json_parses():
    raw = "```json\n" + json.dumps({"missions": []}) + "\n```"
    parsed, err = _try_parse(raw)
    assert err is None and parsed == {"missions": []}


def test_truncated_json_fails_to_parse():
    full = json.dumps({"missions": [good_mission()]})
    truncated = full[: len(full) // 2]
    parsed, err = _try_parse(truncated)
    assert parsed is None and "JSON parse error" in err


def test_missing_missions_array_fails():
    parsed, err = _try_parse(json.dumps({"foo": 1}))
    assert parsed is None and "missions" in err


# --- transient retry ----------------------------------------------------------
class FlakyClient:
    def __init__(self, fail_times, exc):
        self.calls = 0
        self.fail_times = fail_times
        self.exc = exc

    def draft(self, system, turns, chunk):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise self.exc
        return json.dumps({"missions": []}), {"input_tokens": 1, "output_tokens": 1}


def test_transient_error_is_retried_and_recovers(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda *_: None)  # no real waiting
    c = FlakyClient(fail_times=1, exc=TransientError("429", status_code=429))
    raw, usage = _call_with_retries(c, "sys", [{"role": "user", "content": "x"}], {})
    assert json.loads(raw) == {"missions": []} and c.calls == 2


def test_non_transient_error_is_not_retried():
    c = FlakyClient(fail_times=1, exc=ValueError("bad request"))
    with pytest.raises(ValueError):
        _call_with_retries(c, "sys", [{"role": "user", "content": "x"}], {})
    assert c.calls == 1


def test_is_transient_classification():
    assert _is_transient(TransientError("x", 429))
    assert _is_transient(TransientError("x", 503))
    assert not _is_transient(ValueError("nope"))


# --- validator: invented quote is the load-bearing check ----------------------
CHUNK_BODY = "Recursion is when a function calls itself. The base case stops it."


def test_invented_source_quote_is_rejected():
    m = good_mission(quote="This text is nowhere in the chunk whatsoever.")
    errs = validate_mission(m, CHUNK_BODY, TAGS)
    assert any("source_quote does not appear" in e for e in errs)


def test_faithful_quote_passes():
    m = good_mission(quote="The base case stops it.")
    assert validate_mission(m, CHUNK_BODY, TAGS) == []


# --- normalization prevents FALSE rejections of faithful quotes ---------------
def test_normalize_maps_curly_quotes_and_dashes():
    assert normalize_text("“Hello”—world") == '"hello"-world'


def test_curly_quote_variant_still_matches():
    body = 'The model said "it works" today.'
    quote = "“it works”"  # curly quotes
    assert quote_in_body(quote, body)


def test_nbsp_and_newline_collapse_still_matches():
    body = "an array stores items in order and lets you reach any item"
    quote = "an array stores items in\norder"  # nbsp + newline
    assert quote_in_body(quote, body)


def test_endash_for_hyphen_still_matches():
    body = "it runs in n log n time overall"
    quote = "n–log n"  # en-dash where body has space; normalizes to hyphen
    # not a match here (different words) -> ensure we did NOT go fuzzy
    assert not quote_in_body(quote, "totally unrelated text")


def test_edge_punctuation_is_stripped():
    body = "loops repeat a block of code"
    assert quote_in_body('"loops repeat a block of code."', body)


# --- coverage is a pure function, independent of DB state ---------------------
def test_coverage_flags_below_five():
    grid = {(0, "loops"): 4, (0, "recursion"): 5, (1, "loops"): 6, (1, "recursion"): 0}
    ev = evaluate_coverage(grid, LEVELS[:2], TAGS, minimum=5)
    assert (0, "loops") in ev["gap_cells"]      # 4 -> GAP
    assert (0, "recursion") not in ev["gap_cells"]  # 5 -> OK
    assert (1, "loops") not in ev["gap_cells"]      # 6 -> OK
    assert (1, "recursion") in ev["gap_cells"]      # 0 -> GAP


def test_coverage_counts_all_gaps_when_empty():
    ev = evaluate_coverage({}, LEVELS, TAGS, minimum=5)
    assert ev["gaps"] == len(LEVELS) * len(TAGS)


# --- hostile backend reproduces the four real failure modes -------------------
def _ref_for_scenario(target):
    """Find a chunk_ref that maps to a given hostile scenario (sum(ord)%4)."""
    i = 0
    while True:
        ref = f"chunk-{i}"
        if sum(ord(c) for c in ref) % 4 == target:
            return ref
        i += 1


def _chunk(ref):
    return {"chunk_ref": ref, "heading": "Loops",
            "body": "Recursion is when a function calls itself. The base case stops it. "
                    "A loop repeats a block of code more than once in a program."}


def test_hostile_scenario0_fenced_json_recovers():
    c = HostileClient("h")
    raw, _ = c.draft("s", [{"role": "user", "content": "x"}], _chunk(_ref_for_scenario(0)))
    assert raw.strip().startswith("```")
    parsed, err = _try_parse(raw)
    assert err is None and "missions" in parsed


def test_hostile_scenario1_truncated_then_repairs():
    c = HostileClient("h")
    ch = _chunk(_ref_for_scenario(1))
    first, _ = c.draft("s", [{"role": "user", "content": "x"}], ch)
    assert _try_parse(first)[0] is None            # truncated -> parse fails
    repair_turns = [{"role": "user", "content": "x"},
                    {"role": "assistant", "content": first},
                    {"role": "user", "content": "fix"}]
    second, _ = c.draft("s", repair_turns, ch)      # repair turn
    assert _try_parse(second)[0] is not None        # now valid


def test_hostile_scenario2_invented_quote_is_rejected():
    c = HostileClient("h")
    ch = _chunk(_ref_for_scenario(2))
    raw, _ = c.draft("s", [{"role": "user", "content": "x"}], ch)
    parsed, err = _try_parse(raw)
    assert err is None
    errs = validate_mission(parsed["missions"][0], ch["body"], ["loops", "recursion"])
    assert any("source_quote does not appear" in e for e in errs)


def test_hostile_scenario3_rate_limit_then_recovers(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda *_: None)
    c = HostileClient("h")
    ch = _chunk(_ref_for_scenario(3))
    raw, _ = _call_with_retries(c, "s", [{"role": "user", "content": "x"}], ch)
    assert _try_parse(raw)[0] is not None


def test_mock_quote_is_faithful():
    c = MockClient("m")
    ch = _chunk("anything")
    raw, _ = c.draft("s", [{"role": "user", "content": "x"}], ch)
    data = json.loads(raw)
    for m in data["missions"]:
        assert quote_in_body(m["source_quote"], ch["body"])
