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
export type PercentScope = 'credit' | 'track';
export type TimeBand = 'short' | 'medium' | 'long' | 'heavy';
export type TimeBandMinutes = Record<TimeBand, number>;

const SELECTION_MODES: readonly SelectionMode[] = ['legacy', 'curriculum'];
const PERCENT_SCOPES: readonly PercentScope[] = ['credit', 'track'];

interface Settings {
  /** null = no override; fall back to the env var / default. */
  feedbackGatesUnlock: boolean | null;
  selectionMode: SelectionMode | null;
  poolLookbackHours: number | null;
  percentScope: PercentScope | null;
  revisionMixPercent: number | null;
  reportWeeks: number | null;
  timeBandMinutes: TimeBandMinutes | null;
}

const settings: Settings = {
  feedbackGatesUnlock: null,
  selectionMode: null,
  poolLookbackHours: null,
  percentScope: null,
  revisionMixPercent: null,
  reportWeeks: null,
  timeBandMinutes: null,
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
 * fallback would quietly hand out content from hours they have not reached).
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
 * POOL_LOOKBACK_HOURS (default 0). How many hours before the current one are in a
 * student's base pool. 0 = every previous hour in the current credit.
 */
export function poolLookbackHours(): number {
  if (settings.poolLookbackHours !== null) return settings.poolLookbackHours;
  const raw = (process.env.POOL_LOOKBACK_HOURS ?? '0').trim() || '0';
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`POOL_LOOKBACK_HOURS must be a non-negative integer (got "${raw}")`);
  }
  return n;
}

export function setPoolLookbackHours(value: number | null): void {
  if (value !== null && (!Number.isInteger(value) || value < 0)) throw new Error(`invalid lookback ${value}`);
  settings.poolLookbackHours = value;
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
 * EARLIER hour even though the current hour still has unseen missions —
 * spaced repetition, rather than all-new-content-then-nothing. 0 disables the mix
 * (strict current-hour-first); 100 always revises when earlier content exists.
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

// ---------------------------------------------------------------------------
// The weekly pilot report (src/pilotReport.ts)
// ---------------------------------------------------------------------------

/**
 * REPORT_WEEKS (default 8). How far back the weekly report looks. Eight weeks is
 * long enough that a single quiet week does not dominate, short enough that a
 * change made in week 2 is still visible.
 */
export function reportWeeks(): number {
  if (settings.reportWeeks !== null) return settings.reportWeeks;
  const raw = (process.env.REPORT_WEEKS ?? '8').trim() || '8';
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 104) {
    throw new Error(`REPORT_WEEKS must be an integer between 1 and 104 (got "${raw}")`);
  }
  return n;
}

export function setReportWeeks(value: number | null): void {
  if (value !== null && (!Number.isInteger(value) || value < 1 || value > 104)) {
    throw new Error(`invalid report weeks ${value}`);
  }
  settings.reportWeeks = value;
}

/**
 * REPORT_TIMEZONE (default Asia/Kolkata). The zone the report's weeks are cut in.
 * A cohort-wide report needs ONE zone — otherwise a Monday means different things
 * in different rows — so this is deliberately not the per-student timezone that
 * streaks use. The named zone must be loaded in MySQL (`npm run db:timezones`),
 * or CONVERT_TZ returns NULL; the report fails loudly rather than reporting an
 * empty window.
 */
export function reportTimezone(): string {
  const raw = (process.env.REPORT_TIMEZONE ?? 'Asia/Kolkata').trim();
  if (!raw) throw new Error('REPORT_TIMEZONE must not be empty');
  return raw;
}

/**
 * TIME_BAND_MINUTES (default short=10,medium=25,long=45,heavy=90). The UPPER bound
 * in minutes of each mission time band, which is what the report compares real
 * submit times against.
 *
 * These numbers are an ASSUMPTION, not a measurement: nothing in the product
 * defined a band in minutes before this, the SME has not confirmed them, and the
 * report says so where it uses them. They are configuration precisely so a
 * confirmed set of figures needs no code change. A band's lower bound is the
 * previous band's upper bound, so the four values must increase.
 */
export function timeBandMinutes(): TimeBandMinutes {
  if (settings.timeBandMinutes) return settings.timeBandMinutes;
  const raw = (process.env.TIME_BAND_MINUTES ?? '').trim();
  const bands: TimeBandMinutes = { short: 10, medium: 25, long: 45, heavy: 90 };
  if (raw) {
    for (const part of raw.split(',')) {
      const [key, value] = part.split('=').map((x) => x.trim());
      if (!(key in bands)) {
        throw new Error(`TIME_BAND_MINUTES: unknown band "${key}" (expected short, medium, long or heavy)`);
      }
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`TIME_BAND_MINUTES: "${key}" must be a positive number of minutes (got "${value}")`);
      }
      bands[key as TimeBand] = n;
    }
  }
  assertIncreasing(bands, raw ? `TIME_BAND_MINUTES ("${raw}")` : 'TIME_BAND_MINUTES defaults');
  return bands;
}

function assertIncreasing(bands: TimeBandMinutes, label: string): void {
  const order: TimeBand[] = ['short', 'medium', 'long', 'heavy'];
  for (let i = 1; i < order.length; i++) {
    if (bands[order[i]] <= bands[order[i - 1]]) {
      throw new Error(
        `${label} must increase: ${order[i]} (${bands[order[i]]}) is not longer than ` +
          `${order[i - 1]} (${bands[order[i - 1]]})`
      );
    }
  }
}

export function setTimeBandMinutes(value: TimeBandMinutes | null): void {
  if (value !== null) assertIncreasing(value, 'time band minutes');
  settings.timeBandMinutes = value;
}
