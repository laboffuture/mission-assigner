"""LLM drafting stage.

One logical draft per new/changed chunk. Provider is swappable via LLM_PROVIDER
(anthropic | openai | google | mock | hostile). Real providers fail immediately if their
API key is missing.

Robustness (this is the production-critical boundary):
  - transient API errors (429 / timeout / 5xx) are retried with backoff, then the
    chunk fails cleanly rather than crashing the run;
  - model output is defended: fences are stripped, and on a JSON parse failure we
    retry ONCE with the parser error fed back to the model, then fail the chunk
    and record it in a failures list;
  - input/output token usage is captured for every call for cost modelling.

Every request and response (including repair attempts) is written to logs/ keyed
by chunk_ref. Parsed drafts are staged to logs/drafts/ for the validate/import
stages.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timezone

from . import db

DRAFTS_DIR = db.LOGS_DIR / "drafts"
MAX_TRANSIENT_RETRIES = 3

# Output cap per call. 3 to 5 missions measured ~1,100 output tokens on Gemini,
# so 2,200 is twice what the work needs: enough headroom for a long chunk,
# little enough that a runaway cannot burn the credit. A response cut off by this
# cap is REPORTED, never retried with a bigger one - silently raising the cap is
# how a cost control becomes decoration.
#
# It applies to every provider because the job is the same size everywhere. With
# thinking off (below) nothing but the reply counts against it.
def max_output_tokens() -> int:
    raw = (os.getenv("LLM_MAX_OUTPUT_TOKENS") or "2200").strip()
    try:
        n = int(raw)
    except ValueError:
        raise ValueError(f"LLM_MAX_OUTPUT_TOKENS must be a whole number (got {raw!r})") from None
    if n <= 0:
        raise ValueError(f"LLM_MAX_OUTPUT_TOKENS must be greater than 0 (got {n})")
    return n


# Kept as a module attribute so the existing call sites and tests keep working;
# the function above is the source of truth.
MAX_TOKENS = max_output_tokens()


# --- thinking and effort (Anthropic) -----------------------------------------
# Extraction from a supplied chunk needs no reasoning, so thinking is OFF and
# effort is the lowest the docs allow with it.
#
# On claude-sonnet-5-5, thinking: {"type": "disabled"} is a 400. The documented
# off-switch is {"type": "between_tools"} - "the lowest thinking setting on this
# model" - accepted at effort `high` or BELOW, with no other field inside
# `thinking`. So: effort "low" + between_tools.
#   https://platform.claude.com/docs/en/api/migration-2026-10-21
#   model-migration guide, "Migrating to Claude Sonnet 5.5", breaking change 1
#
# between_tools is Claude Sonnet 5.5 only - every other model 400s on it - which
# is why this is configuration rather than a model allowlist: LLM_THINKING=adaptive
# drops the field and lets the model think, the documented alternative (adaptive
# at low effort) if the drafts come back weaker than Gemini's.
_EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max")


def anthropic_effort() -> str:
    level = (os.getenv("LLM_EFFORT") or "low").strip().lower()
    if level not in _EFFORT_LEVELS:
        raise ValueError(f"LLM_EFFORT must be one of {', '.join(_EFFORT_LEVELS)} (got {level!r})")
    return level


def anthropic_thinking_off() -> bool:
    mode = (os.getenv("LLM_THINKING") or "off").strip().lower()
    if mode not in ("off", "adaptive"):
        raise ValueError(f"LLM_THINKING must be 'off' or 'adaptive' (got {mode!r})")
    return mode == "off"


def anthropic_request_extras() -> dict:
    """The thinking/effort half of an Anthropic request, reported before the run."""
    extras: dict = {"output_config": {"effort": anthropic_effort()}}
    if anthropic_thinking_off():
        # No other key inside `thinking`: display/budget_tokens alongside
        # between_tools is a 400.
        extras["thinking"] = {"type": "between_tools"}
    return extras

# A provider that refuses us tells us how long to wait. Waiting less is a wasted
# call: the free Gemini tier allows 5 requests a minute and answers a 429 with
# "retryDelay: 53s", so a 1s/2s backoff spends every retry inside the same closed
# window and recovers from nothing. Cap it so a pathological value cannot hang a
# batch for ever.
MAX_SERVER_RETRY_DELAY = 120.0

# Requests per minute we allow ourselves. Default 5 = the Gemini free tier.
# Raising it when the plan changes is a config change, not a code change.
def requests_per_minute() -> float:
    raw = (os.getenv("LLM_REQUESTS_PER_MINUTE") or "5").strip()
    try:
        rpm = float(raw)
    except ValueError:
        raise ValueError(f"LLM_REQUESTS_PER_MINUTE must be a number (got {raw!r})") from None
    if rpm <= 0:
        raise ValueError(f"LLM_REQUESTS_PER_MINUTE must be greater than 0 (got {rpm})")
    return rpm


_last_call_at = 0.0


# Local fakes have no quota to exceed, and pacing them would add minutes to every
# harness run for nothing (it added 12 seconds to a single unit test before this).
UNPACED_PROVIDERS = ("mock", "hostile")


def pacing_applies() -> bool:
    # The same default get_client() uses: an unset provider IS the mock, so it
    # must not be paced either.
    return (os.getenv("LLM_PROVIDER") or "mock").strip().lower() not in UNPACED_PROVIDERS


def _throttle() -> None:
    """Hold the batch to LLM_REQUESTS_PER_MINUTE. This is an offline batch job:
    waiting is always cheaper than being refused."""
    global _last_call_at
    if not pacing_applies():
        return
    gap = 60.0 / requests_per_minute()
    wait = gap - (time.monotonic() - _last_call_at)
    if _last_call_at and wait > 0:
        print(f"    pacing: waiting {wait:.0f}s (LLM_REQUESTS_PER_MINUTE={requests_per_minute():g})")
        time.sleep(wait)
    _last_call_at = time.monotonic()


_RETRY_DELAY_PATTERNS = (
    # google-genai puts the structured RetryInfo in the stringified error.
    re.compile(r"['\"]retryDelay['\"]\s*:\s*['\"]([0-9.]+)s['\"]"),
    # ...and the human-readable message repeats it.
    re.compile(r"retry in ([0-9.]+)\s*s", re.I),
    # Anthropic/OpenAI style header echoed into the message.
    re.compile(r"retry-after[\"':\s]+([0-9.]+)", re.I),
)


def server_retry_delay(e: Exception):
    """The delay the PROVIDER asked for, in seconds, or None if it did not say."""
    for attr in ("retry_after", "retry_delay"):
        v = getattr(e, attr, None)
        if isinstance(v, (int, float)) and v > 0:
            return min(float(v), MAX_SERVER_RETRY_DELAY)
    text = str(e)
    for rx in _RETRY_DELAY_PATTERNS:
        m = rx.search(text)
        if m:
            try:
                return min(float(m.group(1)), MAX_SERVER_RETRY_DELAY)
            except ValueError:  # pragma: no cover - the pattern guarantees a number
                continue
    return None


# --- helpers -----------------------------------------------------------------
def safe_ref(chunk_ref: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", chunk_ref).strip("_") or "chunk"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _now_iso() -> str:
    """Readable UTC timestamp for a draft's provenance (the compact _now() form is
    for file names, where colons are not allowed)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _strip_fences(text: str) -> str:
    """Remove ```json fences if a model adds them despite instructions."""
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\n?", "", t)
        t = re.sub(r"\n?```$", "", t)
    return t.strip()


def _try_parse(raw: str):
    """Return (parsed, None) or (None, error_message)."""
    try:
        parsed = json.loads(_strip_fences(raw))
    except json.JSONDecodeError as e:
        return None, f"JSON parse error: {e}"
    if not isinstance(parsed, dict) or not isinstance(parsed.get("missions"), list):
        return None, "missing top-level 'missions' array"
    return parsed, None


def _is_transient(e: Exception) -> bool:
    name = type(e).__name__.lower()
    if any(k in name for k in ("ratelimit", "timeout", "connection", "internalserver",
                                "serviceunavailable", "apistatus", "overloaded")):
        return True
    code = getattr(e, "status_code", None) or getattr(e, "code", None)
    return code in (429, 500, 502, 503, 504)


class OutputTruncated(Exception):
    """The reply hit max_tokens. Reported, never retried with a bigger cap."""


class ModelMismatch(Exception):
    """The API answered as a different model than the one we asked for.

    This aborts the whole run rather than failing one chunk. A silent
    substitution would put missions of unknown provenance into the bank, and the
    point of recording which model wrote what is that it is true.
    """


class TransientError(Exception):
    """Raised by the mock/hostile backends to simulate a retryable API failure."""
    def __init__(self, message, status_code=429):
        super().__init__(message)
        self.status_code = status_code


def _call_with_retries(client, system, turns, chunk):
    """Call the client, retrying transient failures.

    The wait is the provider's own if it gave one (429s carry a retryDelay),
    otherwise exponential backoff. Every call — including a repair turn — goes
    through the pacer, because every call spends quota.

    Returns (raw_text, usage). Raises on non-transient or exhausted retries."""
    delay = 1.0
    last = None
    for attempt in range(1, MAX_TRANSIENT_RETRIES + 1):
        try:
            _throttle()
            return client.draft(system, turns, chunk)
        except Exception as e:  # noqa: BLE001 - we re-raise below
            last = e
            if not _is_transient(e) or attempt == MAX_TRANSIENT_RETRIES:
                raise
            asked = server_retry_delay(e)
            wait = asked if asked is not None else delay
            source = "server asked for" if asked is not None else "backoff"
            print(
                f"    transient error ({type(e).__name__}); retry {attempt}/{MAX_TRANSIENT_RETRIES} "
                f"after {wait:.0f}s ({source})"
            )
            time.sleep(wait)
            delay *= 2
    raise last  # pragma: no cover


# --- provider sampling capability --------------------------------------------
# Newer models do not merely reject temperature=0 — they removed the sampling
# parameters (temperature/top_p/top_k) altogether, so *any* value returns a 400.
# Lowering the value does not help; the parameter has to be omitted.
#
# ANTHROPIC: no model, ever. The SDK pin is anthropic 2.3.0, and from 2.0.0 the
# SDK sends API version 2026-10-21, under which a Messages request carrying
# temperature, top_p or top_k returns a 400 on EVERY model, default value
# included — and the parameters are gone from the SDK's own signatures, so
# passing one is a TypeError before any request is made. There used to be an
# allowlist here for the Claude 4.5/4.6 line, which that API version made wrong;
# what it cost is temperature=0 on models this pipeline does not use.
#   https://platform.claude.com/docs/en/api/migration-2026-10-21
#
# OpenAI's reasoning models (o1/o3/o4, gpt-5) reject it; the gpt-4 family takes
# it. Gemini takes it on every current model, which is where the determinism
# below still applies.
#
# Determinism note: on an omitting model the request runs at the provider's
# default temperature, so drafts are no longer bit-reproducible. The validator
# is what guarantees correctness (every source_quote must appear verbatim in the
# source), not sampling determinism — see validator.py.

# OpenAI reasoning models reject temperature; the gpt-4 family accepts it.
_OPENAI_SAMPLING_REJECT_PREFIXES = ("o1", "o3", "o4", "gpt-5")


def accepts_temperature(provider: str, model: str) -> bool:
    """Whether this provider/model pair accepts a temperature parameter."""
    m = (model or "").lower()
    if provider == "anthropic":
        return False  # removed from the API version this SDK sends; see above
    if provider == "openai":
        return not m.startswith(_OPENAI_SAMPLING_REJECT_PREFIXES)
    if provider == "google":
        # Gemini still takes temperature on every current model.
        return True
    return True


def openai_uses_max_completion_tokens(model: str) -> bool:
    """OpenAI reasoning models replaced max_tokens with max_completion_tokens
    and 400 on the old name. Same class of removed-parameter break as
    temperature, at the same call site, so it is handled here too."""
    return (model or "").lower().startswith(_OPENAI_SAMPLING_REJECT_PREFIXES)


_warned: set[str] = set()


def _sampling_kwargs(provider: str, model: str) -> dict:
    """{'temperature': 0} when the model supports it, {} when it does not."""
    if accepts_temperature(provider, model):
        return {"temperature": 0}
    key = f"{provider}:{model}"
    if key not in _warned:
        _warned.add(key)
        print(
            f"    NOTE: {model} does not accept a temperature parameter; omitting it. "
            "Drafts are not bit-reproducible on this model; the validator still "
            "enforces verbatim source quotes."
        )
    return {}


# --- provider clients --------------------------------------------------------
# Each client implements draft(system: str, turns: list[dict], chunk: dict)
#   -> (raw_text: str, usage: {"input_tokens": int, "output_tokens": int})

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
        self.reported_model = None
        self.last_rate_limits: dict = {}
        self.client = Anthropic(api_key=key)

    def draft(self, system, turns, chunk):
        cap = max_output_tokens()
        kwargs = dict(
            model=self.model,
            max_tokens=cap,
            system=system,
            messages=turns,
            **anthropic_request_extras(),
            **_sampling_kwargs("anthropic", self.model),
        )
        # Through with_raw_response, so the anthropic-ratelimit-* headers can be
        # read: the pace this pipeline runs at should come from the limits the
        # account actually has, not from a number somebody guessed. The parsed
        # message is identical either way. A stub without with_raw_response (the
        # unit tests) falls back to the plain call.
        raw = getattr(self.client.messages, "with_raw_response", None)
        if raw is not None:
            response = raw.create(**kwargs)
            self.last_rate_limits = {
                k: v for k, v in dict(getattr(response, "headers", {}) or {}).items()
                if k.lower().startswith("anthropic-ratelimit")
            }
            msg = response.parse()
        else:
            msg = self.client.messages.create(**kwargs)
        # What answered, not what we asked for. Recorded in every draft, and a
        # mismatch stops the run.
        self.reported_model = getattr(msg, "model", None)
        if self.reported_model and self.reported_model != self.model:
            raise ModelMismatch(
                f"requested model {self.model!r} but the API answered as {self.reported_model!r}. "
                f"Nothing further has been generated."
            )
        text = "".join(b.text for b in msg.content if getattr(b, "type", None) == "text")
        usage = {
            "input_tokens": getattr(msg.usage, "input_tokens", 0),
            "output_tokens": getattr(msg.usage, "output_tokens", 0),
        }
        if getattr(msg, "stop_reason", None) == "max_tokens":
            raise OutputTruncated(
                f"the reply hit the {cap}-token cap (LLM_MAX_OUTPUT_TOKENS) and is incomplete. "
                f"Raise the cap deliberately if the chunk really needs more; it is not retried."
            )
        return text, usage


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

    def draft(self, system, turns, chunk):
        messages = [{"role": "system", "content": system}] + turns
        token_cap = (
            {"max_completion_tokens": MAX_TOKENS}
            if openai_uses_max_completion_tokens(self.model)
            else {"max_tokens": MAX_TOKENS}
        )
        resp = self.client.chat.completions.create(
            model=self.model,
            response_format={"type": "json_object"},
            messages=messages,
            **token_cap,
            **_sampling_kwargs("openai", self.model),
        )
        text = resp.choices[0].message.content or ""
        u = resp.usage
        usage = {
            "input_tokens": getattr(u, "prompt_tokens", 0),
            "output_tokens": getattr(u, "completion_tokens", 0),
        }
        return text, usage


class GoogleClient:
    """Google Gemini backend. Added to the swappable layer alongside
    Anthropic/OpenAI; selected with LLM_PROVIDER=google. Fails immediately if the
    key is missing. Reads GEMINI_API_KEY (falls back to GOOGLE_API_KEY)."""

    def __init__(self, model: str):
        key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
        if not key:
            sys.exit(
                "FATAL: LLM_PROVIDER=google but GEMINI_API_KEY is not set. "
                "Set it in pipeline/.env before running generate."
            )
        from google import genai

        self.model = model
        self._genai = genai
        self.client = genai.Client(api_key=key)

    def draft(self, system, turns, chunk):
        # Gemini uses role "model" for assistant turns; map our turns across.
        contents = [
            {"role": ("model" if t["role"] == "assistant" else "user"),
             "parts": [{"text": t["content"]}]}
            for t in turns
        ]
        resp = self.client.models.generate_content(
            model=self.model,
            contents=contents,
            config=self._genai.types.GenerateContentConfig(
                system_instruction=system,
                max_output_tokens=MAX_TOKENS,
                response_mime_type="application/json",
                **_sampling_kwargs("google", self.model),
            ),
        )
        text = resp.text or ""
        um = getattr(resp, "usage_metadata", None)
        usage = {
            "input_tokens": getattr(um, "prompt_token_count", 0) or 0,
            "output_tokens": getattr(um, "candidates_token_count", 0) or 0,
        }
        return text, usage


def _mock_missions(chunk: dict) -> list[dict]:
    """Build well-formed missions whose source_quote is a real sentence lifted
    verbatim from the chunk. Shared by the mock and hostile backends."""
    body = chunk["body"]
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", body) if len(s.strip()) >= 25]
    if not sentences:
        sentences = [body.strip()[:200]]
    # Same rule as generate() and the validator: the chunk's subject, else
    # levels.json's. A chunk that names no subject is the legacy path, and this
    # fake's tag choice is cosmetic either way.
    tags_vocab = db.load_tags(chunk.get("subject") or db.load_levels().get("subject"))
    lower = (chunk["heading"] + " " + body).lower()
    matched = [t for t in tags_vocab if t.replace("-", " ") in lower or t in lower]
    tag = matched[0] if matched else tags_vocab[0]
    heading = chunk["heading"]
    missions = []
    for i, lvl in enumerate([1, 2, 3]):
        quote = sentences[i % len(sentences)]
        missions.append({
            "title": f"{heading} - check {i + 1}",
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
        })
    return missions


def _est_usage(text: str) -> dict:
    return {"input_tokens": 0, "output_tokens": max(1, len(text) // 4)}


class MockClient:
    """Offline, deterministic client for testing WITHOUT an API key. Always
    returns well-formed JSON with real source_quotes. TEST USE ONLY."""

    def __init__(self, model: str):
        self.model = model

    def draft(self, system, turns, chunk):
        return json.dumps({"missions": _mock_missions(chunk)}), _est_usage("x" * 400)


class HostileClient:
    """Adversarial test backend that reproduces the failure modes a real model
    actually exhibits, so the pipeline's defences have permanent regression
    coverage without spending tokens. Behaviour is chosen deterministically per
    chunk_ref, and it RECOVERS on the repair/retry turn where appropriate:

      scenario 0: valid JSON wrapped in ```json fences   -> fence-strip recovers
      scenario 1: truncated JSON on first turn           -> repair turn recovers
      scenario 2: valid JSON but an INVENTED source_quote -> validator rejects
      scenario 3: a 429 on the first attempt             -> transient retry recovers
    """

    def __init__(self, model: str):
        self.model = model
        self._attempts: dict[str, int] = {}

    def draft(self, system, turns, chunk):
        ref = chunk["chunk_ref"]
        scenario = sum(ord(c) for c in ref) % 4
        is_repair = len(turns) > 1
        self._attempts[ref] = self._attempts.get(ref, 0) + 1
        attempt = self._attempts[ref]
        good = {"missions": _mock_missions(chunk)}

        if scenario == 0:
            return "```json\n" + json.dumps(good) + "\n```", _est_usage("x" * 400)

        if scenario == 1:
            if is_repair:
                return json.dumps(good), _est_usage("x" * 400)
            truncated = json.dumps(good)[: len(json.dumps(good)) // 2]  # cut mid-object
            return truncated, _est_usage(truncated)

        if scenario == 2:
            bad = {"missions": _mock_missions(chunk)}
            bad["missions"][0]["source_quote"] = "A sentence that never appears in the source at all."
            return json.dumps(bad), _est_usage("x" * 400)

        # scenario 3: fail the first attempt with a 429, succeed on retry
        if attempt == 1 and not is_repair:
            raise TransientError("simulated rate limit", status_code=429)
        return json.dumps(good), _est_usage("x" * 400)


# Real providers cost money and their model line-ups change. A built-in default
# is a guess about which model exists today, written when the code was written -
# this file shipped `claude-opus-4-8`, `gpt-4o` and `gemini-2.0-flash`, and a
# retired Gemini default has already cost us a run. So a real provider with no
# LLM_MODEL stops, naming the variable. The local fakes keep their defaults:
# nothing is spent and no model line-up is involved.
_PAID_PROVIDERS = ("anthropic", "openai", "google")


def _require_model(provider: str, model: str) -> str:
    if model.strip():
        return model.strip()
    sys.exit(
        f"FATAL: LLM_PROVIDER={provider} but LLM_MODEL is not set. Set it in pipeline/.env to the "
        f"exact model id you intend to pay for - this pipeline does not guess a default for a paid "
        f"provider, because a guessed id is either a model that no longer exists or one you did not "
        f"choose. Nothing has been generated."
    )


def get_client():
    provider = os.getenv("LLM_PROVIDER", "mock").lower()
    model = os.getenv("LLM_MODEL", "")
    if provider in _PAID_PROVIDERS:
        model = _require_model(provider, model)
    if provider == "anthropic":
        return AnthropicClient(model)
    if provider == "openai":
        return OpenAIClient(model)
    if provider == "google":
        return GoogleClient(model)
    if provider == "mock":
        print("  NOTE: LLM_PROVIDER=mock - deterministic test missions, no API calls.")
        return MockClient(model or "mock-1")
    if provider == "hostile":
        print("  NOTE: LLM_PROVIDER=hostile - adversarial test backend, no API calls.")
        return HostileClient(model or "hostile-1")
    sys.exit(f"FATAL: unknown LLM_PROVIDER '{provider}'. Use anthropic | openai | google | mock | hostile.")


# --- prompt ------------------------------------------------------------------
def build_prompts(chunk, levels, tags, template):
    # The subject comes from the CURRICULUM, through the chunk: a tracked file's
    # chunks carry their track's subject (Robotics here), and a legacy file's
    # carry levels.json's (Computer Science). It used to say "computer-science"
    # for everything, which was simply a wrong fact in the prompt for every
    # Robotics chunk. Nothing else about the wording changes.
    subject = (chunk.get("subject") or levels.get("subject") or "").strip()
    system = (
        f"You are a {subject} assessment author. You write multiple-choice "
        "quiz questions strictly grounded in the source material you are given. "
        "You never invent facts that are not in the source. You output STRICT JSON "
        "only - no markdown, no code fences, no commentary."
    )
    level_lines = "\n".join(
        f"  level {l['level']} ({l['name']}): {l['description']}" for l in levels["levels"]
    )
    schema = {
        "missions": [{
            "title": "short title", "body": "the question text", "difficulty": 2,
            "tags": ["loops"],
            "options": [{"key": "a", "text": "..."}, {"key": "b", "text": "..."},
                        {"key": "c", "text": "..."}, {"key": "d", "text": "..."}],
            "correct": "c", "explanation": "why c is correct, one or two sentences",
            "source_quote": "the sentence(s) from the chunk this is based on",
        }]
    }
    user = f"""Draft 3 to 5 multiple-choice missions from the SOURCE CHUNK below.

TEMPLATE INSTRUCTIONS:
{template['instructions']}

DIFFICULTY LEVELS (use the integer level):
{level_lines}

ALLOWED TAGS (use ONLY these - never invent a tag):
{', '.join(tags)}

RULES:
- Spread the missions across whatever levels the content genuinely supports.
- Do NOT invent facts not present in the chunk. If the chunk cannot support a
  question at some level, produce fewer missions rather than padding.
- Each question MUST STAND ALONE and test the SUBJECT, not recall of this
  document. A learner who understands the concept must be able to answer it
  without the document in front of them. Never write "According to the text",
  "Based on the passage above", "As the description states", or any other phrase
  that refers to the source. Ask about the robot, the circuit or the idea - not
  about what the document says.
- Every mission MUST include a source_quote: text copied verbatim from the chunk
  that justifies the correct answer. The quote grounds the ANSWER KEY; it is not
  part of the question and the learner never sees it.
- Output STRICT JSON matching exactly this schema (no markdown, no fences):
{json.dumps(schema, indent=2)}

SOURCE CHUNK - "{chunk['chunk_ref']}" from {chunk['source_file']}:
\"\"\"
{chunk['body']}
\"\"\"
"""
    return system, user


# --- main entry --------------------------------------------------------------
def _log(name: str, content: str):
    (db.LOGS_DIR / name).write_text(content, encoding="utf-8")


def _existing_draft(sref: str):
    """The staged draft for this chunk_ref, or None if there is not a usable one.

    A draft that cannot be read, or has no content_hash to compare, counts as not
    usable: regenerating costs money, but shipping a mission nobody can trace back
    to the text it came from costs more.
    """
    path = DRAFTS_DIR / f"{sref}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def generate(chunks_to_generate, dry_run: bool = False, regenerate: bool = False, token_ceiling: int | None = None):
    """Generate drafts. Returns {'drafted': [...], 'skipped': [...], 'failures': [...], 'usage': {...}}.

    A chunk whose draft is already on disk AND was made from the same content hash
    is skipped: hour 1's three drafts were reviewed by hand, and a re-run must not
    quietly replace them with different questions. The hash is the condition that
    makes this safe - if the SME edits that hour, the chunk's hash changes and the
    draft is regenerated whether anyone remembers to ask for it or not.
    `regenerate=True` replaces everything.

    `token_ceiling` is a whole-run budget in tokens (input + output). It is
    checked between chunks: when the next chunk would be the one to cross it, the
    run stops CLEANLY - every draft already written stays, and the chunks not
    attempted are reported. A ceiling is set from the smoke run's measured average
    rather than guessed, which is why it is a parameter and not a constant.
    """
    levels = db.load_levels()
    template = db.load_active_template()

    if dry_run:
        for c in chunks_to_generate:
            print(f"  [dry-run] would call LLM for chunk '{c['chunk_ref']}'")
        return {"drafted": [c["chunk_ref"] for c in chunks_to_generate], "failures": [], "usage": {}}

    client = get_client()
    # Provenance. Two providers will have drafted this curriculum by the time the
    # SME reviews it, and comparing their approval rates needs to know which made
    # which. The model comes from the client, so it is the id actually used rather
    # than whatever the environment said afterwards.
    provider = (os.getenv("LLM_PROVIDER") or "mock").strip().lower()
    model = getattr(client, "model", None)
    # Before the first call, so a run that is about to spend money on the wrong
    # model is obvious in the first line of output rather than in the bill.
    print(f"  provider {provider}, model {model}")
    db.LOGS_DIR.mkdir(parents=True, exist_ok=True)
    DRAFTS_DIR.mkdir(parents=True, exist_ok=True)
    # NOTHING is deleted up front. This used to clear the whole directory so the
    # following stages saw only this run's work — until a run that failed 24 of 25
    # chunks destroyed the one good draft we had before producing anything. A run
    # must never leave us with less than we started with, so each chunk replaces
    # only its OWN draft, on success, and a failed chunk keeps whatever it had.
    pre_existing = {f.name for f in DRAFTS_DIR.glob("*.json")}

    drafted, failures, skipped = [], [], []
    not_attempted: list[str] = []
    reported_limits = False
    total_in = total_out = 0
    if token_ceiling:
        print(f"  Run ceiling: {token_ceiling:,} tokens (input + output). The run stops cleanly at it.")

    for chunk in chunks_to_generate:
        ref = chunk["chunk_ref"]
        sref = safe_ref(ref)

        # Checked between chunks, so a stop never lands mid-draft.
        if token_ceiling and (total_in + total_out) >= token_ceiling:
            not_attempted = [c["chunk_ref"] for c in chunks_to_generate[chunks_to_generate.index(chunk):]]
            print(
                f"  STOPPING: {total_in + total_out:,} tokens used of the {token_ceiling:,} ceiling. "
                f"{len(not_attempted)} chunk(s) not attempted. Drafts already written are kept."
            )
            break

        if not regenerate:
            prev = _existing_draft(sref)
            prev_hash = (prev or {}).get("content_hash")
            if prev is not None and prev_hash and prev_hash == chunk.get("content_hash"):
                skipped.append(ref)
                n = len(prev.get("missions") or [])
                print(
                    f"  chunk '{ref}': SKIPPED — {n} draft mission(s) already on disk from this exact "
                    f"content (hash {str(prev_hash)[:12]}). --regenerate to replace them."
                )
                continue
            if prev is not None and prev_hash and prev_hash != chunk.get("content_hash"):
                print(f"  chunk '{ref}': the content changed since its draft was made — regenerating.")
            elif prev is not None:
                print(f"  chunk '{ref}': existing draft has no usable content hash — regenerating.")

        stamp = _now()
        # Per chunk: a run can hold two subjects, and each chunk's missions must
        # be offered its own subject's vocabulary.
        try:
            tags = db.load_tags(chunk.get("subject") or levels.get("subject"))
        except db.UnknownSubjectTags as e:
            failures.append({"chunk_ref": ref, "error": str(e)})
            print(f"  chunk '{ref}': FAILED (no tag vocabulary). Skipped.")
            continue
        system, user = build_prompts(chunk, levels, tags, template)
        turns = [{"role": "user", "content": user}]
        _log(f"{sref}.{stamp}.request.json",
             json.dumps({"chunk_ref": ref, "provider": provider, "model": model,
                         "system": system, "turns": turns}, indent=2))

        # 1. call with transient-error retries
        try:
            raw, usage = _call_with_retries(client, system, turns, chunk)
        except ModelMismatch:
            # Not a chunk failure: stop, keeping the drafts already written.
            print(f"  chunk '{ref}': ABORTING THE RUN — the API answered as a different model.")
            raise
        except OutputTruncated as e:
            # A cost control that quietly retries at a bigger cap is not a cost
            # control. The chunk fails, named, and the run carries on.
            failures.append({"chunk_ref": ref, "error": f"output truncated: {e}"})
            print(f"  chunk '{ref}': FAILED (reply cut off by the output cap). Not retried.")
            continue
        except Exception as e:  # noqa: BLE001
            failures.append({"chunk_ref": ref, "error": f"api error: {type(e).__name__}: {e}"})
            print(f"  chunk '{ref}': FAILED (api error: {type(e).__name__}). Skipped.")
            continue
        _log(f"{sref}.{stamp}.response.attempt1.txt", raw)
        total_in += usage.get("input_tokens", 0)
        total_out += usage.get("output_tokens", 0)
        if not reported_limits and getattr(client, "last_rate_limits", None):
            reported_limits = True
            print("  Rate limits this account actually has (from the first response):")
            for k in sorted(client.last_rate_limits):
                print(f"    {k}: {client.last_rate_limits[k]}")

        # 2. parse, with ONE repair attempt feeding the error back
        parsed, err = _try_parse(raw)
        if parsed is None:
            print(f"  chunk '{ref}': parse failed ({err}); attempting one repair.")
            repair_turns = turns + [
                {"role": "assistant", "content": raw},
                {"role": "user", "content":
                    f"Your previous reply could not be parsed ({err}). "
                    f"Return ONLY the JSON object described in the schema - no markdown, "
                    f"no code fences, no commentary, and ensure it is complete."},
            ]
            try:
                raw2, usage2 = _call_with_retries(client, system, repair_turns, chunk)
                _log(f"{sref}.{stamp}.response.attempt2.txt", raw2)
                total_in += usage2.get("input_tokens", 0)
                total_out += usage2.get("output_tokens", 0)
                parsed, err = _try_parse(raw2)
            except Exception as e:  # noqa: BLE001
                err = f"api error on repair: {type(e).__name__}: {e}"

        if parsed is None:
            failures.append({"chunk_ref": ref, "error": err})
            print(f"  chunk '{ref}': SKIPPED after repair attempt ({err}).")
            continue

        # 3. stage the parsed draft
        (DRAFTS_DIR / f"{sref}.json").write_text(json.dumps({
            "chunk_id": chunk.get("id"),
            "chunk_ref": ref,
            "source_file": chunk["source_file"],
            "content_hash": chunk.get("content_hash"),
            "subject": chunk.get("subject"),
            "hour_id": chunk.get("hour_id"),
            # Who made it, with what, and when. content_hash above says from WHAT
            # text; together that is the whole provenance of a mission.
            "provider": provider,
            "model": model,
            # What the API said it was. Equal to `model` on a healthy run; the run
            # aborts if they differ, so a draft can never carry a mismatch.
            "model_reported": getattr(client, "reported_model", None),
            "generated_at": _now_iso(),
            "missions": parsed["missions"],
        }, indent=2), encoding="utf-8")
        drafted.append(ref)
        print(f"  chunk '{ref}': drafted {len(parsed['missions'])} missions.")

    # Say plainly what the next stage will act on: this run's drafts plus any
    # kept from earlier runs.
    now_present = {f.name for f in DRAFTS_DIR.glob("*.json")}
    kept = len(now_present & pre_existing - {safe_ref(r) + ".json" for r in drafted})
    print(f"  Drafts staged: {len(now_present)} ({len(drafted)} from this run, {kept} kept from earlier runs).")
    if skipped:
        print(f"  Skipped {len(skipped)} chunk(s) whose drafts already match their content:")
        for ref in skipped:
            print(f"    - {ref}")

    usage = {"input_tokens": total_in, "output_tokens": total_out}
    if total_out:
        per_chunk = (total_in + total_out) / max(len(drafted), 1)
        print(
            f"  Token usage this run: {total_in} in, {total_out} out "
            f"({total_in + total_out:,} total, {per_chunk:,.0f} per drafted chunk)."
        )
    if not_attempted:
        print(f"  Not attempted ({len(not_attempted)}):")
        for ref in not_attempted:
            print(f"    - {ref}")
    return {
        "drafted": drafted,
        "skipped": skipped,
        "failures": failures,
        "not_attempted": not_attempted,
        "usage": usage,
    }
