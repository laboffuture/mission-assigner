/**
 * Stage 5 configuration flags, resolved in ONE place so the behaviour is never
 * scattered through the code.
 *
 * Values are read through functions (never at import time) and are backed by a
 * mutable settings object, so tests can inject an override without touching
 * process.env or restarting the server. Precedence:
 *   explicit override (setFeedbackGatesUnlock) > env var > built-in default.
 */

export type SelectionMode = 'legacy' | 'curriculum';
export type PercentScope = 'credit' | 'project' | 'track';

const SELECTION_MODES: readonly SelectionMode[] = ['legacy', 'curriculum'];
const PERCENT_SCOPES: readonly PercentScope[] = ['credit', 'project', 'track'];

interface Settings {
  /** null = no override; fall back to the env var / default. */
  feedbackGatesUnlock: boolean | null;
  selectionMode: SelectionMode | null;
  poolLookbackSessions: number | null;
  percentScope: PercentScope | null;
  revisionMixPercent: number | null;
}

const settings: Settings = {
  feedbackGatesUnlock: null,
  selectionMode: null,
  poolLookbackSessions: null,
  percentScope: null,
  revisionMixPercent: null,
};

function envFeedbackGatesUnlock(): boolean {
  const raw = (process.env.FEEDBACK_GATES_UNLOCK ?? 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

/**
 * FEEDBACK_GATES_UNLOCK (default TRUE).
 *
 * When TRUE, the next slot does not unlock after grading until the student has
 * submitted feedback for the graded mission. When FALSE, the next slot unlocks
 * immediately (Stage 3 behaviour) and feedback is optional.
 *
 * Rationale (do not remove): without gating, feedback completion sits around
 * 30% and the aggregate quality signal becomes worthless. The whole point of
 * the feedback system is the mission-quality report, which needs data.
 */
export function feedbackGatesUnlock(): boolean {
  return settings.feedbackGatesUnlock ?? envFeedbackGatesUnlock();
}

/**
 * Override the flag at runtime. Pass a boolean to force a value, or null to
 * clear the override and fall back to the env var / default. Used by the test
 * harnesses (in-process, and via the guarded /api/test/feedback-gating hook) so
 * the whole suite runs green in one pass without editing config.
 */
export function setFeedbackGatesUnlock(value: boolean | null): void {
  settings.feedbackGatesUnlock = value;
}

// ---------------------------------------------------------------------------
// Curriculum selection. Unlike the feedback flag, a malformed value THROWS rather
// than falling back: silently selecting in the wrong mode would serve students
// content outside their curriculum position. (The server also rejects bad values
// at boot via env.ts; this covers scripts that import modules directly.)
// ---------------------------------------------------------------------------

/**
 * SELECTION_MODE (default 'legacy').
 *   curriculum — missions are scoped to the student's curriculum position.
 *   legacy     — the pre-curriculum difficulty + interest selection, unchanged.
 *
 * Default stays 'legacy' until Robotics positions are backfilled: in curriculum
 * mode a student with no position is served NOTHING (by design — a legacy
 * fallback would quietly hand out content from sessions they have not reached).
 */
export function selectionMode(): SelectionMode {
  if (settings.selectionMode) return settings.selectionMode;
  const raw = (process.env.SELECTION_MODE ?? 'legacy').trim().toLowerCase();
  if (!(SELECTION_MODES as readonly string[]).includes(raw)) {
    throw new Error(`SELECTION_MODE must be one of ${SELECTION_MODES.join(' | ')} (got "${raw}")`);
  }
  return raw as SelectionMode;
}

export function setSelectionMode(value: SelectionMode | null): void {
  if (value !== null && !SELECTION_MODES.includes(value)) throw new Error(`invalid selection mode "${value}"`);
  settings.selectionMode = value;
}

/**
 * POOL_LOOKBACK_SESSIONS (default 0). How many sessions before the current one
 * are in a student's base pool. 0 = every previous session in the current credit.
 */
export function poolLookbackSessions(): number {
  if (settings.poolLookbackSessions !== null) return settings.poolLookbackSessions;
  const raw = (process.env.POOL_LOOKBACK_SESSIONS ?? '0').trim() || '0';
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`POOL_LOOKBACK_SESSIONS must be a non-negative integer (got "${raw}")`);
  }
  return n;
}

export function setPoolLookbackSessions(value: number | null): void {
  if (value !== null && (!Number.isInteger(value) || value < 0)) throw new Error(`invalid lookback ${value}`);
  settings.poolLookbackSessions = value;
}

/**
 * PERCENT_SCOPE (default 'credit'). What an LMS completion percentage is a
 * percentage OF, when a student's position must be derived from it. Unconfirmed
 * with the LMS, hence configurable — and every derivation is logged.
 */
export function percentScope(): PercentScope {
  if (settings.percentScope) return settings.percentScope;
  const raw = (process.env.PERCENT_SCOPE ?? 'credit').trim().toLowerCase();
  if (!(PERCENT_SCOPES as readonly string[]).includes(raw)) {
    throw new Error(`PERCENT_SCOPE must be one of ${PERCENT_SCOPES.join(' | ')} (got "${raw}")`);
  }
  return raw as PercentScope;
}

export function setPercentScope(value: PercentScope | null): void {
  if (value !== null && !PERCENT_SCOPES.includes(value)) throw new Error(`invalid percent scope "${value}"`);
  settings.percentScope = value;
}

/**
 * REVISION_MIX_PERCENT (default 20). The chance that a selection is drawn from an
 * EARLIER session even though the current session still has unseen missions —
 * spaced repetition, rather than all-new-content-then-nothing. 0 disables the mix
 * (strict current-session-first); 100 always revises when earlier content exists.
 */
export function revisionMixPercent(): number {
  if (settings.revisionMixPercent !== null) return settings.revisionMixPercent;
  const raw = (process.env.REVISION_MIX_PERCENT ?? '20').trim() || '20';
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 100) {
    throw new Error(`REVISION_MIX_PERCENT must be an integer between 0 and 100 (got "${raw}")`);
  }
  return n;
}

export function setRevisionMixPercent(value: number | null): void {
  if (value !== null && (!Number.isInteger(value) || value < 0 || value > 100)) {
    throw new Error(`invalid revision mix percent ${value}`);
  }
  settings.revisionMixPercent = value;
}
