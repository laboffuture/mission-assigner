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
MAX_TOKENS = 8192
MAX_TRANSIENT_RETRIES = 3

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
# That covers Anthropic's Opus 4.7/4.8, Opus 5, Sonnet 5 and the Fable/Mythos 5
# family, and OpenAI's reasoning models (o1/o3/o4, gpt-5). Lowering the value
# does not help; the parameter has to be omitted.
#
# So this is an allowlist of the older models that both accept temperature and
# need it for deterministic drafting, and anything else omits it. An allowlist
# is the safe direction: a model released after this code was written omits the
# parameter and works, where a denylist would send it and hard-fail with a 400.
#
# Determinism note: on an omitting model the request runs at the provider's
# default temperature, so drafts are no longer bit-reproducible. The validator
# is what guarantees correctness (every source_quote must appear verbatim in the
# source), not sampling determinism — see validator.py.

_ANTHROPIC_SAMPLING_OK = (
    "claude-opus-4-6", "claude-opus-4-5",
    "claude-sonnet-4-6", "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-3", "claude-2",
)

# OpenAI reasoning models reject temperature; the gpt-4 family accepts it.
_OPENAI_SAMPLING_REJECT_PREFIXES = ("o1", "o3", "o4", "gpt-5")


def accepts_temperature(provider: str, model: str) -> bool:
    """Whether this provider/model pair accepts a temperature parameter."""
    m = (model or "").lower()
    if provider == "anthropic":
        return m.startswith(_ANTHROPIC_SAMPLING_OK)
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
        self.client = Anthropic(api_key=key)

    def draft(self, system, turns, chunk):
        msg = self.client.messages.create(
            model=self.model,
            max_tokens=MAX_TOKENS,
            system=system,
            messages=turns,
            **_sampling_kwargs("anthropic", self.model),
        )
        text = "".join(b.text for b in msg.content if getattr(b, "type", None) == "text")
        usage = {
            "input_tokens": getattr(msg.usage, "input_tokens", 0),
            "output_tokens": getattr(msg.usage, "output_tokens", 0),
        }
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
    tags_vocab = db.load_tags()
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


def get_client():
    provider = os.getenv("LLM_PROVIDER", "mock").lower()
    model = os.getenv("LLM_MODEL", "")
    if provider == "anthropic":
        return AnthropicClient(model or "claude-opus-4-8")
    if provider == "openai":
        return OpenAIClient(model or "gpt-4o")
    if provider == "google":
        return GoogleClient(model or "gemini-2.0-flash")
    if provider == "mock":
        print("  NOTE: LLM_PROVIDER=mock - deterministic test missions, no API calls.")
        return MockClient(model or "mock-1")
    if provider == "hostile":
        print("  NOTE: LLM_PROVIDER=hostile - adversarial test backend, no API calls.")
        return HostileClient(model or "hostile-1")
    sys.exit(f"FATAL: unknown LLM_PROVIDER '{provider}'. Use anthropic | openai | google | mock | hostile.")


# --- prompt ------------------------------------------------------------------
def build_prompts(chunk, levels, tags, template):
    system = (
        "You are a computer-science assessment author. You write multiple-choice "
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


def generate(chunks_to_generate, dry_run: bool = False):
    """Generate drafts. Returns {'drafted': [...], 'failures': [...], 'usage': {...}}."""
    levels = db.load_levels()
    tags = db.load_tags()
    template = db.load_active_template()

    if dry_run:
        for c in chunks_to_generate:
            print(f"  [dry-run] would call LLM for chunk '{c['chunk_ref']}'")
        return {"drafted": [c["chunk_ref"] for c in chunks_to_generate], "failures": [], "usage": {}}

    client = get_client()
    db.LOGS_DIR.mkdir(parents=True, exist_ok=True)
    DRAFTS_DIR.mkdir(parents=True, exist_ok=True)
    # NOTHING is deleted up front. This used to clear the whole directory so the
    # following stages saw only this run's work — until a run that failed 24 of 25
    # chunks destroyed the one good draft we had before producing anything. A run
    # must never leave us with less than we started with, so each chunk replaces
    # only its OWN draft, on success, and a failed chunk keeps whatever it had.
    pre_existing = {f.name for f in DRAFTS_DIR.glob("*.json")}

    drafted, failures = [], []
    total_in = total_out = 0

    for chunk in chunks_to_generate:
        ref = chunk["chunk_ref"]
        sref = safe_ref(ref)
        stamp = _now()
        system, user = build_prompts(chunk, levels, tags, template)
        turns = [{"role": "user", "content": user}]
        _log(f"{sref}.{stamp}.request.json",
             json.dumps({"chunk_ref": ref, "system": system, "turns": turns}, indent=2))

        # 1. call with transient-error retries
        try:
            raw, usage = _call_with_retries(client, system, turns, chunk)
        except Exception as e:  # noqa: BLE001
            failures.append({"chunk_ref": ref, "error": f"api error: {type(e).__name__}: {e}"})
            print(f"  chunk '{ref}': FAILED (api error: {type(e).__name__}). Skipped.")
            continue
        _log(f"{sref}.{stamp}.response.attempt1.txt", raw)
        total_in += usage.get("input_tokens", 0)
        total_out += usage.get("output_tokens", 0)

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
            "missions": parsed["missions"],
        }, indent=2), encoding="utf-8")
        drafted.append(ref)
        print(f"  chunk '{ref}': drafted {len(parsed['missions'])} missions.")

    # Say plainly what the next stage will act on: this run's drafts plus any
    # kept from earlier runs.
    now_present = {f.name for f in DRAFTS_DIR.glob("*.json")}
    kept = len(now_present & pre_existing - {safe_ref(r) + ".json" for r in drafted})
    print(f"  Drafts staged: {len(now_present)} ({len(drafted)} from this run, {kept} kept from earlier runs).")

    usage = {"input_tokens": total_in, "output_tokens": total_out}
    if total_out:
        print(f"  Token usage this run: {total_in} in, {total_out} out.")
    return {"drafted": drafted, "failures": failures, "usage": usage}
