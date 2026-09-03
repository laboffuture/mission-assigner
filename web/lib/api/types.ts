/*
 * Typed API DTOs — hand-written to mirror the Express responses EXACTLY.
 * snake_case throughout (no camelCase transform layer), matching the server so a
 * field rename on either side surfaces as a type error here.
 *
 * Sources on the server: src/authRoutes.ts, src/server.ts, src/dto.ts,
 * src/tracking.ts, src/feedback.ts.
 */

export type Role = 'student' | 'sme' | 'qc' | 'instructor' | 'admin';

/** GET /api/me */
export interface Me {
  id: number;
  role: Role;
  display_name: string | null;
}

/** Uniform list envelope for non-paginated lists. */
export interface ItemsEnvelope<T> {
  items: T[];
}

/** Cursor-paginated list envelope. */
export interface Page<T> {
  items: T[];
  next_cursor?: string | null;
  // The server currently returns `nextCursor` (camelCase) on paginated routes;
  // keep both keys tolerated until the server list shapes are fully aligned.
  nextCursor?: string | null;
}

// ---------------------------------------------------------------------------
// Week board — GET /api/week/:studentId
// ---------------------------------------------------------------------------
export interface MissionOption {
  option_key: string;
  option_text: string;
}

export interface Mission {
  mission_id: number;
  title: string;
  body: string;
  difficulty: number;
  options: MissionOption[];
}

/** The raw slot exactly as the API sends it (mission present only when filled). */
export interface RawSlot {
  slot_id: number;
  slot_index: number;
  day_label: string;
  mission_type: string;
  time_band: string;
  status: string;
  assignment_id: number | null;
  mission?: Mission | null;
}

export interface WeekResponse {
  student_week_id: number;
  week_start: string;
  status: string;
  slots: RawSlot[];
}

export interface EmptyWeek {
  empty: true;
}

export type WeekPayload = WeekResponse | EmptyWeek;

export function isEmptyWeek(w: WeekPayload): w is EmptyWeek {
  return (w as EmptyWeek).empty === true;
}

// ---------------------------------------------------------------------------
// Slot as a discriminated union (the three states the board renders).
// Derived from RawSlot by normalizeSlot() so components switch on `kind`.
// ---------------------------------------------------------------------------
interface SlotFields {
  slot_id: number;
  slot_index: number;
  day_label: string;
  mission_type: string;
  time_band: string;
  status: string;
  assignment_id: number | null;
}

export type Slot =
  | (SlotFields & { kind: 'locked' })
  | (SlotFields & { kind: 'empty'; mission: null })
  | (SlotFields & { kind: 'filled'; mission: Mission });

export function normalizeSlot(raw: RawSlot): Slot {
  const base: SlotFields = {
    slot_id: raw.slot_id,
    slot_index: raw.slot_index,
    day_label: raw.day_label,
    mission_type: raw.mission_type,
    time_band: raw.time_band,
    status: raw.status,
    assignment_id: raw.assignment_id,
  };
  if (raw.status === 'locked') return { ...base, kind: 'locked' };
  if (!raw.mission) return { ...base, kind: 'empty', mission: null };
  return { ...base, kind: 'filled', mission: raw.mission };
}

// ---------------------------------------------------------------------------
// Open a slot — POST /api/slot/:slotId/open
// ---------------------------------------------------------------------------
export interface XpAward {
  awarded: boolean;
  points: number;
  reason?: 'no_rule' | 'already_awarded';
  totalXp: number;
}

export interface OpenSlotResponse {
  assignment_id: number;
  title: string;
  body: string;
  difficulty: number;
  options: MissionOption[];
  xp: XpAward;
}

export interface OpenSlotEmpty {
  empty: true;
  message: string;
}

export type OpenSlotPayload = OpenSlotResponse | OpenSlotEmpty;

export function isOpenSlotEmpty(o: OpenSlotPayload): o is OpenSlotEmpty {
  return (o as OpenSlotEmpty).empty === true;
}

// ---------------------------------------------------------------------------
// Submit — POST /api/submit  (pinned SubmitResponse, src/dto.ts)
// ---------------------------------------------------------------------------
export type ScoreBand = 'pass_strong' | 'pass' | 'fail';

export interface UnlockResult {
  wasSlot: boolean;
  submittedSlotId: number | null;
  openedSlotId: number | null;
  weekComplete: boolean;
  gatedOnFeedback: boolean;
}

export interface SubmitResponse {
  assignment_id: number;
  correct: boolean;
  score_band: ScoreBand;
  correct_option_key: string;
  explanation: string;
  level: { from: number; to: number; reason: string };
  xp: {
    submit: XpAward;
    correct: XpAward | null;
    points_earned: number;
    total_xp: number;
  };
  unlock: UnlockResult;
  feedback: { required: boolean; status: string; gates_unlock: boolean };
  idempotent_replay?: boolean;
}

// ---------------------------------------------------------------------------
// Feedback — GET /api/feedback/questions, POST /api/feedback/:assignmentId
// ---------------------------------------------------------------------------
export type AnswerType = 'scale_1_5' | 'yes_no' | 'single_select' | 'free_text';

export interface FeedbackQuestion {
  id: number;
  question_key: string;
  prompt: string;
  answer_type: AnswerType;
  options: string[] | null;
  display_order: number;
  required: boolean;
}

export interface FeedbackAnswer {
  question_key: string;
  value: string;
}

export interface FeedbackResult {
  ok?: boolean;
  alreadyComplete?: boolean;
  status?: string;
  unlock: UnlockResult | null;
}

// ---------------------------------------------------------------------------
// Progress — GET /api/progress/:studentId  (src/tracking.ts::StudentProgress)
// ---------------------------------------------------------------------------
export interface LevelEvent {
  from_level: number;
  to_level: number;
  reason: string;
  created_at: string;
}

export interface XpEvent {
  assignment_id: number;
  event_type: string;
  difficulty: number;
  points: number;
  created_at: string;
}

export interface Progress {
  student_id: number;
  display_name: string;
  current_level: number;
  segment_name: string | null;
  total_xp: number;
  attempted: number;
  submitted: number;
  correct: number;
  current_streak: number;
  longest_streak: number;
  feedback_completion_rate: number;
  level_history: LevelEvent[];
  xp_history: XpEvent[];
}

// ---------------------------------------------------------------------------
// Segment — GET /api/segment/:studentId
// ---------------------------------------------------------------------------
export interface Segment {
  student_id: number;
  age: number;
  subject: string;
  current_level: number;
  placement_status: string;
  segment: {
    id: number;
    name: string;
    start_level: number;
    min_level: number;
    max_level: number;
    description: string | null;
  } | null;
  why: string;
  prerequisites: Array<{ course_ref: string; completed: boolean }>;
}

// ---------------------------------------------------------------------------
// Submission log — GET /api/submissions/:studentId (cursor-paginated)
// ---------------------------------------------------------------------------
export interface SubmissionRow {
  assignment_id: number;
  id: number;
  title: string;
  difficulty: number;
  submitted_at: string;
  score_band: ScoreBand;
  time_to_submit_seconds: number | null;
  feedback_status: string;
}

/** GET /api/dev/users (dev roster) */
export interface DevUser {
  id: number;
  display_name: string;
  role: Role;
}
