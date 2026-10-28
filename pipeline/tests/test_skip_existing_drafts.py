"""A reviewed draft must not be replaced by accident — and must be replaced when
the content it came from changes.

Hour 1 of the SME document has three drafts that were read and approved by hand.
generate writes `drafts/<safe_ref>.json` per chunk, so a re-run overwrote them
with different questions. Skipping on the file's existence alone would be worse:
the SME edits a document, the chunk's hash changes, and the stale draft would sit
there looking current. So the condition is the CONTENT HASH, not the file.
"""
import json

import pytest

from src import generator


class _Client:
    """Returns one well-formed mission, and counts how often it was asked."""

    def __init__(self):
        self.calls = 0

    def draft(self, system, turns, chunk):
        self.calls += 1
        body = json.dumps(
            {
                "missions": [
                    {
                        "title": f"Fresh mission {self.calls}",
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
        return body, {"input_tokens": 10, "output_tokens": 20}


@pytest.fixture
def staged(monkeypatch, tmp_path):
    """generate() wired to a temp drafts directory and a counting client."""
    drafts = tmp_path / "drafts"
    drafts.mkdir(parents=True)
    client = _Client()
    monkeypatch.setattr(generator, "DRAFTS_DIR", drafts)
    monkeypatch.setattr(generator.db, "LOGS_DIR", tmp_path)
    monkeypatch.setattr(generator, "_log", lambda *a, **k: None)
    monkeypatch.setattr(generator, "get_client", lambda: client)
    monkeypatch.setattr(generator.db, "load_levels", lambda: {"subject": "Robotics", "levels": []})
    monkeypatch.setattr(generator.db, "load_tags", lambda subject=None: ["loops"])
    monkeypatch.setattr(generator.db, "load_active_template", lambda: {"type": "quiz", "instructions": "i"})
    return drafts, client


def _chunk(content_hash="hash-one"):
    return {
        "chunk_ref": "Project 1 > 0-1 hr: Intro & Context",
        "source_file": "doc.docx",
        "body": "Intro body text.",
        "content_hash": content_hash,
        "id": 1,
        "hour_id": 1,
        "subject": "Robotics",
    }


def _reviewed_draft(path, content_hash="hash-one"):
    path.write_text(
        json.dumps(
            {
                "chunk_ref": "Project 1 > 0-1 hr: Intro & Context",
                "content_hash": content_hash,
                "missions": [{"title": "Reviewed by the SME"}, {"title": "Second"}, {"title": "Third"}],
            }
        ),
        encoding="utf-8",
    )
    return path.read_text(encoding="utf-8")


def test_a_draft_from_the_same_content_is_skipped(staged, capsys):
    drafts, client = staged
    path = drafts / f"{generator.safe_ref(_chunk()['chunk_ref'])}.json"
    before = _reviewed_draft(path)

    res = generator.generate([_chunk()], dry_run=False)

    assert client.calls == 0, "the provider was called for a chunk that did not need it"
    assert res["skipped"] == [_chunk()["chunk_ref"]]
    assert res["drafted"] == []
    assert path.read_text(encoding="utf-8") == before, "the reviewed draft was replaced"
    out = capsys.readouterr().out
    assert "SKIPPED" in out and "3 draft mission(s)" in out
    assert "--regenerate" in out, "the skip must say how to override it"


def test_a_changed_chunk_regenerates_without_being_asked(staged):
    drafts, client = staged
    path = drafts / f"{generator.safe_ref(_chunk()['chunk_ref'])}.json"
    _reviewed_draft(path, content_hash="hash-one")

    # Same chunk_ref, new content: the SME edited that hour.
    res = generator.generate([_chunk(content_hash="hash-TWO")], dry_run=False)

    assert client.calls == 1
    assert res["drafted"] == [_chunk()["chunk_ref"]]
    assert res["skipped"] == []
    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["content_hash"] == "hash-TWO"
    assert [m["title"] for m in written["missions"]] == ["Fresh mission 1"]


def test_regenerate_replaces_a_matching_draft(staged):
    drafts, client = staged
    path = drafts / f"{generator.safe_ref(_chunk()['chunk_ref'])}.json"
    _reviewed_draft(path)

    res = generator.generate([_chunk()], dry_run=False, regenerate=True)

    assert client.calls == 1
    assert res["skipped"] == []
    assert res["drafted"] == [_chunk()["chunk_ref"]]
    assert json.loads(path.read_text(encoding="utf-8"))["missions"][0]["title"] == "Fresh mission 1"


def test_an_unreadable_draft_is_regenerated_not_trusted(staged):
    drafts, client = staged
    path = drafts / f"{generator.safe_ref(_chunk()['chunk_ref'])}.json"
    path.write_text("{ this is not json", encoding="utf-8")

    res = generator.generate([_chunk()], dry_run=False)

    assert client.calls == 1, "a draft nobody can read is not a draft"
    assert res["drafted"] == [_chunk()["chunk_ref"]]


def test_a_draft_with_no_hash_is_regenerated(staged, capsys):
    """Provenance is the point: a draft that cannot be traced to the text it came
    from is replaced by one that can."""
    drafts, client = staged
    path = drafts / f"{generator.safe_ref(_chunk()['chunk_ref'])}.json"
    path.write_text(json.dumps({"chunk_ref": "x", "missions": [{"title": "old"}]}), encoding="utf-8")

    res = generator.generate([_chunk()], dry_run=False)

    assert client.calls == 1
    assert res["drafted"] == [_chunk()["chunk_ref"]]
    assert "no usable content hash" in capsys.readouterr().out
