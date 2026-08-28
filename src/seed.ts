import 'dotenv/config';
import { pool } from './db.js';

/**
 * Wipes and re-seeds the demo data:
 *   - 50 missions (10 at each difficulty 0..4), each with 4 options + 1 tag
 *   - 3 students with interests
 * Run via `npm run db:seed`.
 */

const SUBJECT = 'Computer Science';
const TAGS = ['loops', 'recursion', 'sorting', 'strings', 'data-structures'] as const;
const LETTERS = ['a', 'b', 'c', 'd'] as const;

async function main() {
  const conn = await pool.getConnection();
  try {
    // Wipe in FK-safe order.
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [
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

    // ---- Missions -------------------------------------------------------
    let missionCount = 0;
    let optionCount = 0;
    let tagCount = 0;

    for (let difficulty = 0; difficulty <= 4; difficulty++) {
      for (let n = 0; n < 10; n++) {
        const globalIndex = difficulty * 10 + n; // 0..49
        const tag = TAGS[globalIndex % TAGS.length];
        // Vary the correct answer across missions.
        const correct = LETTERS[globalIndex % LETTERS.length];

        const title = `L${difficulty} ${capitalize(tag)} Challenge #${n + 1}`;
        const body =
          `A ${tag} question at difficulty ${difficulty}. ` +
          `Read each option carefully and pick the single correct answer.`;

        const [res] = await conn.query<any>(
          `INSERT INTO missions
             (version, subject, title, body, mission_type, grading_mode,
              difficulty, age_min, age_max, time_band, answer_key, rubric, status)
           VALUES (?, ?, ?, ?, 'quiz', 'auto', ?, 12, 18, 'short', ?, NULL, 'live')`,
          [1, SUBJECT, title, body, difficulty, JSON.stringify({ correct })]
        );
        const missionId = res.insertId as number;
        missionCount++;

        // 4 options a,b,c,d — label the correct one so the demo is legible.
        for (const key of LETTERS) {
          const text =
            key === correct
              ? `Option ${key.toUpperCase()} — the correct choice for ${tag}`
              : `Option ${key.toUpperCase()} — a plausible ${tag} distractor`;
          await conn.query(
            `INSERT INTO mission_options (mission_id, option_key, option_text)
             VALUES (?, ?, ?)`,
            [missionId, key, text]
          );
          optionCount++;
        }

        // Exactly 1 tag.
        await conn.query(
          `INSERT INTO mission_tags (mission_id, tag) VALUES (?, ?)`,
          [missionId, tag]
        );
        tagCount++;
      }
    }

    // ---- Students -------------------------------------------------------
    const students: Array<{
      name: string;
      age: number;
      level: number;
      interests: string[];
    }> = [
      { name: 'Demo Student A', age: 15, level: 2, interests: ['loops', 'sorting'] },
      { name: 'Demo Student B', age: 16, level: 3, interests: ['recursion'] },
      { name: 'Demo Student C', age: 14, level: 0, interests: ['strings'] },
    ];

    for (const s of students) {
      const [res] = await conn.query<any>(
        `INSERT INTO students
           (moodle_user_id, display_name, age, subject, current_level, consecutive_wrong)
         VALUES (NULL, ?, ?, ?, ?, 0)`,
        [s.name, s.age, SUBJECT, s.level]
      );
      const studentId = res.insertId as number;
      for (const tag of s.interests) {
        await conn.query(
          `INSERT INTO student_interests (student_id, tag) VALUES (?, ?)`,
          [studentId, tag]
        );
      }
    }

    console.log('Seed complete:');
    console.log(`  missions:        ${missionCount}`);
    console.log(`  mission_options: ${optionCount}`);
    console.log(`  mission_tags:    ${tagCount}`);
    console.log(`  students:        ${students.length}`);
  } finally {
    conn.release();
    await pool.end();
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
