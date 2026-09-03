import { pool } from './db.js';
import { type Page, clampLimit, decodeCursor, encodeCursor, buildPage } from './pagination.js';

/**
 * Instructor assistance queue.
 *
 * assistance_events rows are raised automatically when a student stalls
 * (progression.ts::raiseAssistance). This module surfaces them for staff: a list
 * of OPEN events oldest-first (the longest-waiting student is the most urgent),
 * a detail view with enough context for a quick intervention, and the
 * acknowledge / resolve transitions.
 *
 * All reads/writes here are staff-only; the route layer gates by role, and these
 * queries never key on a student id (staff see across students by design).
 */

export interface AssistanceListItem {
  id: number;
  student_id: number;
  student_name: string;
  current_level: number;
  segment_name: string | null;
  trigger_reason: string;
  level_at_trigger: number;
  tags_involved: string[];
  status: string;
  created_at: string;
  waiting_seconds: number;
}

/** Parse a JSON column that mysql2 may hand back as a string or an object. */
function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

interface StoredContext {
  failed_assignments?: Array<{ assignment_id: number; mission_id: number; selected: string | null; tags: string[] }>;
  tags_involved?: string[];
}

/**
 * Open events, OLDEST first, cursor-paginated. Keyset on (created_at, id) ASC so
 * the student who has waited longest is at the top and paging is stable.
 */
export async function listOpenAssistance(
  opts: { limit?: number; cursor?: string } = {}
): Promise<Page<AssistanceListItem>> {
  const lim = clampLimit(opts.limit);
  const dec = decodeCursor(opts.cursor);
  const params: any[] = [];
  let cursorClause = '';
  if (dec) {
    cursorClause = 'AND (ae.created_at > ? OR (ae.created_at = ? AND ae.id > ?))';
    params.push(dec.sortValue, dec.sortValue, dec.id);
  }
  const [rows] = await pool.query<any[]>(
    `SELECT ae.id, ae.student_id, s.display_name AS student_name, s.current_level,
            seg.name AS segment_name, ae.trigger_reason, ae.level_at_trigger,
            ae.context, ae.status, ae.created_at,
            TIMESTAMPDIFF(SECOND, ae.created_at, UTC_TIMESTAMP()) AS waiting_seconds
       FROM assistance_events ae
       JOIN students s ON s.id = ae.student_id
       LEFT JOIN segments seg ON seg.id = s.segment_id
      WHERE ae.status = 'open' ${cursorClause}
      ORDER BY ae.created_at ASC, ae.id ASC
      LIMIT ?`,
    [...params, lim + 1]
  );

  const items: AssistanceListItem[] = rows.map((r) => {
    const ctx = parseJson<StoredContext>(r.context, {});
    return {
      id: Number(r.id),
      student_id: Number(r.student_id),
      student_name: r.student_name,
      current_level: Number(r.current_level),
      segment_name: r.segment_name ?? null,
      trigger_reason: r.trigger_reason,
      level_at_trigger: Number(r.level_at_trigger),
      tags_involved: ctx.tags_involved ?? [],
      status: r.status,
      created_at: r.created_at,
      waiting_seconds: Math.max(0, Number(r.waiting_seconds ?? 0)),
    };
  });

  return buildPage(items, lim, (r) => encodeCursor(r.created_at, r.id));
}

export interface AssistanceFailedMission {
  assignment_id: number;
  mission_id: number;
  title: string;
  body: string;
  options: Array<{ option_key: string; option_text: string }>;
  selected_key: string | null;
  selected_text: string | null;
  correct_key: string;
  correct_text: string | null;
  explanation: string;
  score_band: string | null;
  submitted_at: string | null;
  tags: string[];
}

export interface AssistanceDetail extends AssistanceListItem {
  acknowledged_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  failed_missions: AssistanceFailedMission[];
  level_history: Array<{ from_level: number; to_level: number; reason: string; created_at: string }>;
}

/** Full detail for a single event — enough context for a 5-minute intervention. */
export async function getAssistanceDetail(id: number): Promise<AssistanceDetail | null> {
  const [[row]] = await pool.query<any[]>(
    `SELECT ae.id, ae.student_id, s.display_name AS student_name, s.current_level,
            seg.name AS segment_name, ae.trigger_reason, ae.level_at_trigger,
            ae.context, ae.status, ae.created_at,
            ae.acknowledged_at, ae.resolved_at, ae.resolution_note,
            TIMESTAMPDIFF(SECOND, ae.created_at, UTC_TIMESTAMP()) AS waiting_seconds
       FROM assistance_events ae
       JOIN students s ON s.id = ae.student_id
       LEFT JOIN segments seg ON seg.id = s.segment_id
      WHERE ae.id = ?`,
    [id]
  );
  if (!row) return null;

  const ctx = parseJson<StoredContext>(row.context, {});
  const failedRefs = ctx.failed_assignments ?? [];

  // Expand each failed assignment into full review context (question, options,
  // their answer, the correct answer + explanation, band, when submitted).
  const failed_missions: AssistanceFailedMission[] = [];
  for (const ref of failedRefs) {
    const [[a]] = await pool.query<any[]>(
      `SELECT a.id AS assignment_id, a.mission_id, a.response, a.score_band, a.submitted_at,
              m.title, m.body, m.answer_key
         FROM assignments a JOIN missions m ON m.id = a.mission_id
        WHERE a.id = ?`,
      [ref.assignment_id]
    );
    if (!a) continue;
    const [opts] = await pool.query<any[]>(
      `SELECT option_key, option_text FROM mission_options WHERE mission_id = ? ORDER BY option_key ASC`,
      [a.mission_id]
    );
    const key = parseJson<{ correct?: string; explanation?: string }>(a.answer_key, {});
    const correctKey = String(key.correct ?? '');
    const resp = parseJson<{ selected?: string }>(a.response, {});
    const selectedKey = ref.selected ?? resp.selected ?? null;
    const byKey = new Map(opts.map((o: any) => [o.option_key, o.option_text]));
    failed_missions.push({
      assignment_id: Number(a.assignment_id),
      mission_id: Number(a.mission_id),
      title: a.title,
      body: a.body,
      options: opts.map((o: any) => ({ option_key: o.option_key, option_text: o.option_text })),
      selected_key: selectedKey,
      selected_text: selectedKey != null ? (byKey.get(selectedKey) ?? null) : null,
      correct_key: correctKey,
      correct_text: byKey.get(correctKey) ?? null,
      explanation: String(key.explanation ?? ''),
      score_band: a.score_band ?? null,
      submitted_at: a.submitted_at ?? null,
      tags: ref.tags ?? [],
    });
  }

  const [levelRows] = await pool.query<any[]>(
    `SELECT from_level, to_level, reason, created_at
       FROM level_events
      WHERE student_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 10`,
    [row.student_id]
  );

  return {
    id: Number(row.id),
    student_id: Number(row.student_id),
    student_name: row.student_name,
    current_level: Number(row.current_level),
    segment_name: row.segment_name ?? null,
    trigger_reason: row.trigger_reason,
    level_at_trigger: Number(row.level_at_trigger),
    tags_involved: ctx.tags_involved ?? [],
    status: row.status,
    created_at: row.created_at,
    waiting_seconds: Math.max(0, Number(row.waiting_seconds ?? 0)),
    acknowledged_at: row.acknowledged_at ?? null,
    resolved_at: row.resolved_at ?? null,
    resolution_note: row.resolution_note ?? null,
    failed_missions,
    level_history: levelRows.map((r) => ({
      from_level: Number(r.from_level),
      to_level: Number(r.to_level),
      reason: r.reason,
      created_at: r.created_at,
    })),
  };
}

export class AssistanceError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * Acknowledge an open event. Idempotent-ish: only an 'open' event transitions to
 * 'acknowledged'; acknowledging an already-acknowledged one is a no-op success,
 * but a resolved one is a 409 (you can't un-resolve by acknowledging).
 */
export async function acknowledgeAssistance(id: number, staffId: number): Promise<AssistanceDetail> {
  const [[row]] = await pool.query<any[]>(`SELECT status FROM assistance_events WHERE id = ?`, [id]);
  if (!row) throw new AssistanceError(404, 'assistance event not found');
  if (row.status === 'resolved') throw new AssistanceError(409, 'event is already resolved');
  await pool.query(
    `UPDATE assistance_events
        SET status = 'acknowledged',
            acknowledged_at = COALESCE(acknowledged_at, UTC_TIMESTAMP()),
            acknowledged_by = COALESCE(acknowledged_by, ?)
      WHERE id = ? AND status <> 'resolved'`,
    [staffId, id]
  );
  return (await getAssistanceDetail(id))!;
}

/** Resolve an event with a required note describing what was done. */
export async function resolveAssistance(id: number, staffId: number, note: string): Promise<AssistanceDetail> {
  const trimmed = (note ?? '').trim();
  if (trimmed.length === 0) throw new AssistanceError(400, 'a resolution note is required');
  if (trimmed.length > 1000) throw new AssistanceError(400, 'resolution note exceeds 1000 characters');
  const [[row]] = await pool.query<any[]>(`SELECT status FROM assistance_events WHERE id = ?`, [id]);
  if (!row) throw new AssistanceError(404, 'assistance event not found');
  if (row.status === 'resolved') throw new AssistanceError(409, 'event is already resolved');
  await pool.query(
    `UPDATE assistance_events
        SET status = 'resolved',
            resolved_at = UTC_TIMESTAMP(),
            resolved_by = ?,
            resolution_note = ?,
            acknowledged_at = COALESCE(acknowledged_at, UTC_TIMESTAMP()),
            acknowledged_by = COALESCE(acknowledged_by, ?)
      WHERE id = ?`,
    [staffId, trimmed, staffId, id]
  );
  return (await getAssistanceDetail(id))!;
}
