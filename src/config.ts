/**
 * Stage 5 configuration flags, resolved in ONE place so the behaviour is never
 * scattered through the code.
 *
 * Values are read through functions (never at import time) and are backed by a
 * mutable settings object, so tests can inject an override without touching
 * process.env or restarting the server. Precedence:
 *   explicit override (setFeedbackGatesUnlock) > env var > built-in default.
 */

interface Settings {
  /** null = no override; fall back to the env var / default. */
  feedbackGatesUnlock: boolean | null;
}

const settings: Settings = {
  feedbackGatesUnlock: null,
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
