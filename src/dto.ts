/**
 * Pinned response DTOs — the stable contract the frontend (and any API client)
 * depends on. Keep these deliberate: handlers build these shapes explicitly
 * instead of spreading internal service results, so a change to an internal type
 * (e.g. GradeResult gaining a field) never silently leaks into the API.
 *
 * Convention: snake_case field names throughout (mirrors the DB and avoids any
 * camelCase transform layer on the client).
 */
import type { XpAward } from './xp.js';
import type { ScoreBand } from './grading.js';
import type { UnlockResult } from './slotUnlock.js';

/**
 * POST /api/submit response. Includes post-grade review data
 * (`correct_option_key` + `explanation`): the platform builds ability rather
 * than measuring it, so a student who answers wrong is always shown the correct
 * option and why.
 */
export interface SubmitResponse {
  assignment_id: number;
  correct: boolean;
  score_band: ScoreBand;
  /** The key of the correct option (e.g. "a"). Always present. */
  correct_option_key: string;
  /** Why that option is correct. Empty string if the mission carries none. */
  explanation: string;
  /** Progression outcome for this submission (no-demotion ladder). */
  level: { from: number; to: number; reason: string };
  xp: {
    submit: XpAward;
    correct: XpAward | null;
    points_earned: number;
    total_xp: number;
  };
  unlock: UnlockResult;
  feedback: { required: boolean; status: string; gates_unlock: boolean };
  /** Present and true only when an Idempotency-Key replay returned a cached result. */
  idempotent_replay?: boolean;
}
