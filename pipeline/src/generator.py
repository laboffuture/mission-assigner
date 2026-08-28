"""LLM drafting stage.

One LLM call per new/changed chunk. Provider is swappable via LLM_PROVIDER
(anthropic | openai | mock). Real providers fail immediately if their API key
is missing. Every request and response is written to logs/ keyed by chunk_ref.
Parsed drafts are staged to logs/drafts/ so `validate` and `import` can run as
separate CLI invocations.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import db

DRAFTS_DIR = db.LOGS_DIR / "drafts"
MAX_JSON_RETRIES = 3


# --- helpers -----------------------------------------------------------------
def safe_ref(chunk_ref: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", chunk_ref).strip("_") or "chunk"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _strip_fences(text: str) -> str:
    """Defensively remove ```json fences if a model adds them despite instructions."""
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\n?", "", t)
        t = re.sub(r"\n?```$", "", t)
    return t.strip()


# --- provider clients --------------------------------------------------------
class AnthropicClient:
    def __init__(self, model: str):
        key = os.getenv("ANTHROPIC_API_KEY")
        if not key:
            sys.exit(
                "FATAL: LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set. "
                "Set it in pipeline/.env before running generate."
            )
        from anthropic import Anthropic

        self.model = model
        self.client = Anthropic(api_key=key)

    def draft(self, system: str, user: str, chunk: dict) -> str:
        msg = self.client.messages.create(
            model=self.model,
            max_tokens=4096,
            temperature=0,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return "".join(block.text for block in msg.content if block.type == "text")


class OpenAIClient:
    def __init__(self, model: str):
        key = os.getenv("OPENAI_API_KEY")
        if not key:
            sys.exit(
                "FATAL: LLM_PROVIDER=openai but OPENAI_API_KEY is not set. "
                "Set it in pipeline/.env before running generate."
            )
        from openai import OpenAI

        self.model = model
        self.client = OpenAI(api_key=key)

    def draft(self, system: str, user: str, chunk: dict) -> str:
        resp = self.client.chat.completions.create(
            model=self.model,
            temperature=0,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        return resp.choices[0].message.content or ""


class MockClient:
    """Offline, deterministic client for testing the pipeline WITHOUT an API key.
    It drafts plausible-shaped missions whose source_quote is a REAL sentence
    lifted verbatim from the chunk, so the validator's substring check passes
    exactly as it would for a well-behaved real model. TEST USE ONLY."""

    def __init__(self, model: str):
        self.model = model

    def draft(self, system: str, user: str, chunk: dict) -> str:
        body = chunk["body"]
        # real sentences from the body — these become source_quotes
        sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", body) if len(s.strip()) >= 25]
        if not sentences:
            sentences = [body.strip()[:200]]

        tags_vocab = db.load_tags()
        lower = (chunk["heading"] + " " + body).lower()
        matched = [t for t in tags_vocab if t.replace("-", " ") in lower or t in lower]
        tag = matched[0] if matched else tags_vocab[0]

        heading = chunk["heading"]
        levels = [1, 2, 3]  # a modest spread; mock is not trying to be clever
        missions = []
        for i, lvl in enumerate(levels):
            quote = sentences[i % len(sentences)]
            missions.append(
                {
                    "title": f"{heading} — check {i + 1}",
                    "body": f"Based on the material on {heading}, which statement is correct?",
                    "difficulty": lvl,
                    "tags": [tag],
                    "options": [
                        {"key": "a", "text": f"{quote[:180]}"},
                        {"key": "b", "text": "A related idea that the material does not actually claim."},
                        {"key": "c", "text": "A common misconception about this topic."},
                        {"key": "d", "text": "An unrelated concept from a different section."},
                    ],
                    "correct": "a",
                    "explanation": "Option a restates the point made in the source material.",
                    "source_quote": quote,
                }
            )
        return json.dumps({"missions": missions})


def get_client():
    provider = os.getenv("LLM_PROVIDER", "mock").lower()
    model = os.getenv("LLM_MODEL", "")
    if provider == "anthropic":
        return AnthropicClient(model or "claude-opus-4-8")
    if provider == "openai":
        return OpenAIClient(model or "gpt-4o")
    if provider == "mock":
        print("  NOTE: LLM_PROVIDER=mock — generating deterministic test missions, no API calls.")
        return MockClient(model or "mock-1")
    sys.exit(f"FATAL: unknown LLM_PROVIDER '{provider}'. Use anthropic | openai | mock.")


# --- prompt ------------------------------------------------------------------
def build_prompts(chunk: dict, levels: dict, tags: list[str], template: dict) -> tuple[str, str]:
    system = (
        "You are a computer-science assessment author. You write multiple-choice "
        "quiz questions strictly grounded in the source material you are given. "
        "You never invent facts that are not in the source. You output STRICT JSON "
        "only — no markdown, no code fences, no commentary."
    )
    level_lines = "\n".join(
        f"  level {l['level']} ({l['name']}): {l['description']}" for l in levels["levels"]
    )
    schema = {
        "missions": [
            {
                "title": "short title",
                "body": "the question text",
                "difficulty": 2,
                "tags": ["loops"],
                "options": [
                    {"key": "a", "text": "..."},
                    {"key": "b", "text": "..."},
                    {"key": "c", "text": "..."},
                    {"key": "d", "text": "..."},
                ],
                "correct": "c",
                "explanation": "why c is correct, one or two sentences",
                "source_quote": "the sentence(s) from the chunk this is based on",
            }
        ]
    }
    user = f"""Draft 3 to 5 multiple-choice missions from the SOURCE CHUNK below.

TEMPLATE INSTRUCTIONS:
{template['instructions']}

DIFFICULTY LEVELS (use the integer level):
{level_lines}

ALLOWED TAGS (use ONLY these — never invent a tag):
{', '.join(tags)}

RULES:
- Spread the missions across whatever levels the content genuinely supports.
- Do NOT invent facts not present in the chunk. If the chunk cannot support a
  question at some level, produce fewer missions rather than padding.
- Every mission MUST include a source_quote: text copied verbatim from the chunk
  that justifies the correct answer.
- Output STRICT JSON matching exactly this schema (no markdown, no fences):
{json.dumps(schema, indent=2)}

SOURCE CHUNK — "{chunk['chunk_ref']}" from {chunk['source_file']}:
\"\"\"
{chunk['body']}
\"\"\"
"""
    return system, user


# --- main entry --------------------------------------------------------------
def generate(chunks_to_generate: list[dict], dry_run: bool = False) -> dict:
    """Generate drafts for the given chunks. Returns
    {'drafted': [chunk_ref...], 'failures': [{chunk_ref, error}...]}."""
    levels = db.load_levels()
    tags = db.load_tags()
    template = db.load_active_template()

    if dry_run:
        for c in chunks_to_generate:
            print(f"  [dry-run] would call LLM for chunk '{c['chunk_ref']}'")
        return {"drafted": [c["chunk_ref"] for c in chunks_to_generate], "failures": []}

    client = get_client()
    db.LOGS_DIR.mkdir(parents=True, exist_ok=True)
    DRAFTS_DIR.mkdir(parents=True, exist_ok=True)

    # Each generate batch is self-contained: clear stale drafts so the following
    # validate/import stages act only on the chunks generated in THIS run.
    for old in DRAFTS_DIR.glob("*.json"):
        old.unlink()

    drafted: list[str] = []
    failures: list[dict] = []

    for chunk in chunks_to_generate:
        ref = chunk["chunk_ref"]
        sref = safe_ref(ref)
        system, user = build_prompts(chunk, levels, tags, template)

        # log the request
        stamp = _now()
        (db.LOGS_DIR / f"{sref}.{stamp}.request.json").write_text(
            json.dumps({"chunk_ref": ref, "system": system, "user": user}, indent=2),
            encoding="utf-8",
        )

        parsed = None
        last_err = ""
        for attempt in range(1, MAX_JSON_RETRIES + 1):
            raw = client.draft(system, user, chunk)
            (db.LOGS_DIR / f"{sref}.{stamp}.response.attempt{attempt}.txt").write_text(
                raw, encoding="utf-8"
            )
            try:
                parsed = json.loads(_strip_fences(raw))
                if "missions" not in parsed or not isinstance(parsed["missions"], list):
                    raise ValueError("missing 'missions' array")
                break
            except (json.JSONDecodeError, ValueError) as e:
                last_err = str(e)
                print(f"  chunk '{ref}': JSON parse failed (attempt {attempt}/{MAX_JSON_RETRIES}): {e}")

        if parsed is None:
            failures.append({"chunk_ref": ref, "error": last_err})
            print(f"  chunk '{ref}': SKIPPED after {MAX_JSON_RETRIES} failed attempts.")
            continue

        # stage the parsed draft for the validate/import stages
        draft_record = {
            "chunk_id": chunk.get("id"),
            "chunk_ref": ref,
            "source_file": chunk["source_file"],
            "missions": parsed["missions"],
        }
        (DRAFTS_DIR / f"{sref}.json").write_text(
            json.dumps(draft_record, indent=2), encoding="utf-8"
        )
        drafted.append(ref)
        print(f"  chunk '{ref}': drafted {len(parsed['missions'])} missions.")

    return {"drafted": drafted, "failures": failures}
