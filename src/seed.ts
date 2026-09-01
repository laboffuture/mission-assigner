import 'dotenv/config';
import { pool } from './db.js';
import { assignSegment } from './segmentation.js';
import { publishWeek } from './weekPublisher.js';
import { logger } from './logger.js';

/**
 * Wipes and re-seeds the demo data for Stage 1 + Stage 3.
 *
 * Stage 1:
 *   - 50 short-band missions (10 at each difficulty 0..4) + 25 medium-band
 *     missions (5 at each difficulty) so weekly/medium slots fill normally
 *   - 3 demo students with interests, KEEPING their Stage 1 levels (A:2, B:3,
 *     C:0) so the existing verify.mjs acceptance harness still passes
 *
 * Stage 3:
 *   - 3 Computer Science segments + prerequisites
 *   - student_courses so the 3 demo students land in different segments
 *   - 1 week_template with 8 slots
 *   - xp_rules (PLACEHOLDER values — see below)
 *   - assigns each demo student a segment and publishes their current week
 *
 * Run via `npm run db:seed` (after `npm run db:schema` and `npm run db:migrate`).
 */

const SUBJECT = 'Computer Science';
const TAGS = ['loops', 'recursion', 'sorting', 'strings', 'data-structures'] as const;
const LETTERS = ['a', 'b', 'c', 'd'] as const;

function mondayOf(d: Date): string {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = copy.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7;   // days since Monday
  copy.setUTCDate(copy.getUTCDate() - diff);
  return copy.toISOString().slice(0, 10);
}

async function main() {
  const conn = await pool.getConnection();
  try {
    // Wipe in FK-safe order (Stage 3 tables first, then Stage 1).
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [
      'idempotency_keys',
      'feedback_responses',
      'attempt_logs',
      'feedback_questions',
      'xp_events',
      'assistance_events',
      'week_slots',
      'student_weeks',
      'week_template_slots',
      'week_templates',
      'xp_rules',
      'student_courses',
      'segment_prerequisites',
      'segments',
      'selection_log',
      'level_events',
      'assignments',
      'mission_tags',
      'mission_options',
      'missions',
      'student_interests',
      'students',
    ]) {
      await conn.query(`TRUNCATE TABLE \`${t}\``);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');

    // ---- Missions: 50 short + 25 medium ---------------------------------
    let missionCount = 0;
    let optionCount = 0;
    let tagCount = 0;

    async function insertMission(difficulty: number, n: number, timeBand: 'short' | 'medium') {
      const globalIndex = difficulty * 10 + n;
      const tag = TAGS[globalIndex % TAGS.length];
      const correct = LETTERS[globalIndex % LETTERS.length];
      const title = `L${difficulty} ${capitalize(tag)} ${capitalize(timeBand)} #${n + 1}`;
      const body =
        `A ${tag} question at difficulty ${difficulty} (${timeBand}). ` +
        `Read each option carefully and pick the single correct answer.`;

      const [res] = await conn.query<any>(
        `INSERT INTO missions
           (version, subject, title, body, mission_type, grading_mode,
            difficulty, age_min, age_max, time_band, answer_key, rubric, status)
         VALUES (?, ?, ?, ?, 'quiz', 'auto', ?, 12, 18, ?, ?, NULL, 'live')`,
        [1, SUBJECT, title, body, difficulty, timeBand, JSON.stringify({ correct })]
      );
      const missionId = res.insertId as number;
      missionCount++;
      for (const key of LETTERS) {
        const text =
          key === correct
            ? `Option ${key.toUpperCase()} — the correct choice for ${tag}`
            : `Option ${key.toUpperCase()} — a plausible ${tag} distractor`;
        await conn.query(
          `INSERT INTO mission_options (mission_id, option_key, option_text) VALUES (?, ?, ?)`,
          [missionId, key, text]
        );
        optionCount++;
      }
      await conn.query(`INSERT INTO mission_tags (mission_id, tag) VALUES (?, ?)`, [missionId, tag]);
      tagCount++;
    }

    for (let difficulty = 0; difficulty <= 4; difficulty++) {
      for (let n = 0; n < 10; n++) await insertMission(difficulty, n, 'short');
      for (let n = 0; n < 5; n++) await insertMission(difficulty, n + 100, 'medium');
    }

    // ---- Segments (management/SME-defined) ------------------------------
    const segs: Record<string, number> = {};
    for (const seg of [
      { name: 'CS Foundation', age_min: 12, age_max: 14, min: 0, max: 4, start: 0, desc: 'Entry segment, no prerequisites.' },
      { name: 'CS Intermediate', age_min: 14, age_max: 16, min: 0, max: 4, start: 1, desc: 'Requires CS-101.' },
      { name: 'CS Advanced', age_min: 16, age_max: 18, min: 0, max: 4, start: 2, desc: 'Requires CS-101 and CS-201.' },
    ]) {
      const [r] = await conn.query<any>(
        `INSERT INTO segments (name, subject, age_min, age_max, min_level, max_level, start_level, description, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
        [seg.name, SUBJECT, seg.age_min, seg.age_max, seg.min, seg.max, seg.start, seg.desc]
      );
      segs[seg.name] = r.insertId as number;
    }
    // Prerequisites.
    await conn.query(`INSERT INTO segment_prerequisites (segment_id, course_ref) VALUES (?, 'CS-101')`, [segs['CS Intermediate']]);
    await conn.query(`INSERT INTO segment_prerequisites (segment_id, course_ref) VALUES (?, 'CS-101'), (?, 'CS-201')`, [segs['CS Advanced'], segs['CS Advanced']]);

    // ---- Week template + 8 slots ----------------------------------------
    const [wt] = await conn.query<any>(
      `INSERT INTO week_templates (name, subject, segment_id, active) VALUES ('CS Standard Week', ?, NULL, TRUE)`,
      [SUBJECT]
    );
    const templateId = wt.insertId as number;
    // slot_index, day_label, mission_type, time_band, level_offset, is_weekly
    const slots: Array<[number, string, string, string, number, boolean]> = [
      [1, 'Day 1', 'quiz', 'short', 0, false],
      [2, 'Day 2', 'quiz', 'short', 0, false],
      [3, 'Day 3', 'quiz', 'short', 0, false],
      [4, 'Day 4', 'quiz', 'short', 0, false],
      [5, 'Day 5', 'quiz', 'short', 1, false],
      [6, 'Day 6', 'quiz', 'short', 1, false],
      [7, 'Day 7', 'quiz', 'medium', 1, false],
      [8, 'Weekly', 'quiz', 'medium', 0, true],
    ];
    for (const [idx, day, type, band, offset, weekly] of slots) {
      await conn.query(
        `INSERT INTO week_template_slots
           (template_id, slot_index, day_label, mission_type, time_band, level_offset, is_weekly)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [templateId, idx, day, type, band, offset, weekly]
      );
    }

    // ---- XP rules — PLACEHOLDER VALUES, TO BE REPLACED BY SME/MANAGEMENT --
    // These point values are placeholders only. Management/SME must set the
    // real economy before launch. Never hardcode them anywhere else.
    const xpRules: Array<[string, number | null, number]> = [
      ['attempt', null, 2],
      ['submit', null, 5],
      ['correct', 0, 10],
      ['correct', 1, 15],
      ['correct', 2, 20],
      ['correct', 3, 30],
      ['correct', 4, 45],
      // Stage 5 — XP for submitting feedback.
      // PLACEHOLDER — to be set by SME and management.
      ['feedback', null, 5],
    ];
    for (const [evt, diff, pts] of xpRules) {
      await conn.query(
        `INSERT INTO xp_rules (event_type, difficulty, points, active) VALUES (?, ?, ?, TRUE)`,
        [evt, diff, pts]
      );
    }

    // ---- Feedback questions (Stage 5) -----------------------------------
    // PLACEHOLDER — to be replaced by SME and management before pilot.
    // Question text is DATA, configured here (and editable live in the DB),
    // never hardcoded in the application or the HTML.
    const feedbackQuestions: Array<{
      key: string;
      prompt: string;
      type: 'scale_1_5' | 'yes_no' | 'single_select' | 'free_text';
      options: string[] | null;
      order: number;
      required: boolean;
    }> = [
      { key: 'perceived_difficulty', prompt: 'PLACEHOLDER — How difficult was this mission?', type: 'single_select', options: ['Too easy', 'About right', 'Too hard'], order: 1, required: true },
      { key: 'time_taken', prompt: 'PLACEHOLDER — How long did this take compared to what you expected?', type: 'single_select', options: ['Less than expected', 'About as expected', 'Longer than expected'], order: 2, required: true },
      { key: 'clarity', prompt: 'PLACEHOLDER — How clear was the question? (1 = very unclear, 5 = very clear)', type: 'scale_1_5', options: null, order: 3, required: true },
      { key: 'confidence', prompt: 'PLACEHOLDER — How confident are you in your answer? (1 = not at all, 5 = very)', type: 'scale_1_5', options: null, order: 4, required: true },
      { key: 'comments', prompt: 'PLACEHOLDER — Any comments? (optional)', type: 'free_text', options: null, order: 5, required: false },
    ];
    for (const q of feedbackQuestions) {
      await conn.query(
        `INSERT INTO feedback_questions
           (question_key, prompt, answer_type, options, display_order, required, active)
         VALUES (?, ?, ?, ?, ?, ?, TRUE)`,
        [q.key, q.prompt, q.type, q.options ? JSON.stringify(q.options) : null, q.order, q.required]
      );
    }

    // ---- Students (keep Stage 1 levels; placement complete = has history) --
    const students: Array<{
      name: string;
      age: number;
      level: number;
      interests: string[];
      courses: string[];
    }> = [
      { name: 'Demo Student A', age: 15, level: 2, interests: ['loops', 'sorting'], courses: ['CS-101'] },
      { name: 'Demo Student B', age: 16, level: 3, interests: ['recursion'], courses: ['CS-101', 'CS-201'] },
      { name: 'Demo Student C', age: 14, level: 0, interests: ['strings'], courses: [] },
    ];

    const studentIds: number[] = [];
    for (const s of students) {
      const [res] = await conn.query<any>(
        `INSERT INTO students
           (moodle_user_id, display_name, age, subject, current_level, consecutive_wrong,
            total_xp, placement_status, stall_count, role)
         VALUES (NULL, ?, ?, ?, ?, 0, 0, 'complete', 0, 'student')`,
        [s.name, s.age, SUBJECT, s.level]
      );
      const studentId = res.insertId as number;
      studentIds.push(studentId);
      for (const tag of s.interests) {
        await conn.query(`INSERT INTO student_interests (student_id, tag) VALUES (?, ?)`, [studentId, tag]);
      }
      for (const course of s.courses) {
        await conn.query(
          `INSERT INTO student_courses (student_id, course_ref, completed_at) VALUES (?, ?, NOW())`,
          [studentId, course]
        );
      }
    }

    // ---- Staff users (Item 1: one per non-student role) ------------------
    // These live in the users (students) table with a non-student role. They
    // have no missions/weeks; they exist so role-gated endpoints can be exercised.
    const staff: Array<{ name: string; role: string }> = [
      { name: 'SME User', role: 'sme' },
      { name: 'QC User', role: 'qc' },
      { name: 'Instructor User', role: 'instructor' },
      { name: 'Admin User', role: 'admin' },
    ];
    for (const st of staff) {
      await conn.query<any>(
        `INSERT INTO students
           (moodle_user_id, display_name, age, subject, current_level, consecutive_wrong,
            total_xp, placement_status, stall_count, role)
         VALUES (NULL, ?, 30, ?, 0, 0, 0, 'complete', 0, ?)`,
        [st.name, SUBJECT, st.role]
      );
    }

    logger.info(
      {
        missions: missionCount,
        mission_options: optionCount,
        mission_tags: tagCount,
        segments: 3,
        xp_rules: xpRules.length,
        feedback_questions: feedbackQuestions.length,
        students: students.length,
        staff: staff.length,
      },
      'base seed complete (feedback questions are PLACEHOLDERS)'
    );

    conn.release();

    // ---- Segment assignment + week publication (use the real modules) ----
    const weekStart = mondayOf(new Date());
    for (const sid of studentIds) {
      const decision = await assignSegment(sid);
      const wk = await publishWeek(sid, weekStart);
      logger.info(
        { studentId: sid, segment: decision.segmentName, reason: decision.reason, weekStart, slots: wk.slots.length },
        'seeded student'
      );
    }
  } finally {
    await pool.end();
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

main().catch((err) => {
  logger.error({ err }, 'seed failed');
  process.exit(1);
});
