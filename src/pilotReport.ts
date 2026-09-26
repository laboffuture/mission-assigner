/**
 * The weekly pilot report (audit item 15).
 *
 * Everything in here was already being captured — time_to_submit_seconds,
 * selection_log, feedback_responses, assignments, hours — and nothing read it.
 * A pilot that produces no evidence is a pilot that has to be run again.
 *
 * TWO DECISIONS THAT SHAPE THIS FILE:
 *
 * 1. The audience is the SME and management, not us. So the report carries its
 *    own prose: every section states the question it answers and how to read the
 *    numbers, and every value arrives pre-formatted ("62%", "18 min", "Too
 *    hard"). A reader should never have to divide two columns in their head.
 *
 * 2. The prose and the numbers live HERE, once, and both renderers — the staff
 *    page and the emailable document — display the same object. Anything else
 *    drifts: the page says one thing, the document that got emailed says
 *    another, and nobody can tell which was right.
 *
 * Reuses getMissionQuality for observed-vs-tagged difficulty rather than
 * recomputing pass rates, so the mis-tagged list here and the SME report at
 * /api/mission-quality can never disagree.
 */
import { pool } from './db.js';
import { getMissionQuality, MIN_ATTEMPTS, type MissionQualityRow } from './tracking.js';
import { reportTimezone, reportWeeks, timeBandMinutes, type TimeBand } from './config.js';
import { selectionMode } from './config.js';

// --------------------------------------------------------------- thresholds --
/**
 * An hour is "thin" below this many live missions. Three is the least that lets
 * selection choose at all: with one or two, every student sees the same thing in
 * the same order and the difficulty ranking has nothing to work with.
 */
const MIN_MISSIONS_PER_HOUR = 3;
/** ...and it needs at least this many distinct difficulties to adapt. */
const MIN_DIFFICULTY_SPREAD = 2;
/** Below this many observations a row is noise, so it is not reported as a finding. */
const MIN_SAMPLES = 5;
/** A stall is this many consecutive failures on the same hour by one student. */
const STALL_RUN = 2;
/** Hard ceiling on rows pulled for the streak walk; the report says if it is hit. */
const MAX_ATTEMPT_ROWS = 50_000;
/**
 * Longest table a person will actually read. An empty curriculum makes the
 * coverage list as long as the curriculum itself, which buries every other
 * section; the count above it stays exact.
 */
const MAX_TABLE_ROWS = 25;

// -------------------------------------------------------------------- types --
export interface ReportColumn {
  key: string;
  label: string;
  numeric?: boolean;
}

export type ReportValue = string | number | null;

export interface ReportSection {
  key: string;
  title: string;
  /** The question this section answers, in the words it was asked in. */
  question: string;
  /** How to read it — written for someone who does not know the schema. */
  explainer: string;
  columns: ReportColumn[];
  rows: Record<string, ReportValue>[];
  /** Shown instead of an empty table. Never "no data" without saying what that means. */
  empty: string;
  /** Plain-English things that need a human decision. */
  flags: string[];
}

export interface PilotReport {
  generated_at: string;
  timezone: string;
  window: { weeks: number; from: string; to: string };
  selection_mode: string;
  /** What to look at first, in sentences. Empty means nothing needs attention. */
  headline: string[];
  /** Caveats that apply to the whole report — thin data, mode, assumptions. */
  notes: string[];
  sections: ReportSection[];
}

// ------------------------------------------------------------------ helpers --
const asNumber = (v: unknown): number => Number(v ?? 0);

/** 0.6231 -> "62%". Null stays null so a renderer can show a dash. */
function pct(part: number, whole: number): string | null {
  if (!whole) return null;
  return `${Math.round((part / whole) * 100)}%`;
}

/** Seconds -> "18 min" / "45 sec" / "1 h 20 min". For reading, not arithmetic. */
function duration(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const s = Math.round(seconds);
  if (s < 90) return `${s} sec`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const toISODate = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/** "C1 · hour 7" plus the hour's own title, or a truthful stand-in when unmapped. */
function hourLabel(row: { credit_code?: string | null; hour_number?: number | null; hour_title?: string | null }) {
  if (row.hour_number == null) return 'Not linked to an hour';
  const code = row.credit_code ? `${row.credit_code} · ` : '';
  const title = row.hour_title ? ` — ${row.hour_title}` : '';
  return `${code}hour ${row.hour_number}${title}`;
}

/** The report window: Monday of the week `weeks - 1` back, to today, in the report zone. */
async function windowStart(weeks: number, tz: string): Promise<{ from: string; to: string }> {
  const [[row]] = await pool.query<any[]>(
    `SELECT DATE_FORMAT(DATE_SUB(DATE_SUB(d, INTERVAL WEEKDAY(d) DAY), INTERVAL ? WEEK), '%Y-%m-%d') AS f,
            DATE_FORMAT(d, '%Y-%m-%d') AS t
       FROM (SELECT DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?)) AS d) x`,
    [weeks - 1, tz]
  );
  // CONVERT_TZ returns NULL when the named zone is not loaded (see timezoneCheck.ts).
  if (!row?.f) throw new Error(`report timezone '${tz}' does not resolve — load the MySQL timezone tables`);
  return { from: toISODate(row.f), to: toISODate(row.t) };
}

// ------------------------------------------------------------- 1. completion --
async function completionSection(from: string, tz: string): Promise<ReportSection> {
  const [rows] = await pool.query<any[]>(
    `SELECT DATE_FORMAT(wk, '%Y-%m-%d') AS week_start,
            COUNT(*)                                        AS assigned,
            COUNT(DISTINCT student_id)                      AS students,
            SUM(status IN ('submitted','graded'))           AS submitted,
            SUM(status = 'graded')                          AS graded
       FROM (SELECT a.student_id, a.status,
                    DATE_SUB(DATE(CONVERT_TZ(a.assigned_at, '+00:00', ?)),
                             INTERVAL WEEKDAY(CONVERT_TZ(a.assigned_at, '+00:00', ?)) DAY) AS wk
               FROM assignments a
              WHERE a.assigned_at >= ?) x
      GROUP BY wk
      ORDER BY wk DESC`,
    [tz, tz, from]
  );

  const flags: string[] = [];
  const out = rows.map((r) => {
    const assigned = asNumber(r.assigned);
    const graded = asNumber(r.graded);
    const rate = assigned ? graded / assigned : 0;
    if (assigned >= MIN_SAMPLES && rate < 0.5) {
      flags.push(
        `In the week of ${toISODate(r.week_start)}, only ${pct(graded, assigned)} of the work handed out was finished.`
      );
    }
    return {
      week_start: toISODate(r.week_start),
      students: asNumber(r.students),
      assigned,
      submitted: asNumber(r.submitted),
      graded,
      finished: pct(graded, assigned),
    };
  });

  return {
    key: 'completion',
    title: 'How much of the work gets finished',
    question: 'Completion rate: assigned versus submitted versus graded, per week.',
    explainer:
      'One row per week, most recent first. "Assigned" is how many missions students were given, ' +
      '"submitted" how many they sent in, "graded" how many were marked. The last column is graded ' +
      'as a share of assigned — the closest thing to "did the week happen". A gap between submitted ' +
      'and graded points at marking, not at the students.',
    columns: [
      { key: 'week_start', label: 'Week beginning' },
      { key: 'students', label: 'Students', numeric: true },
      { key: 'assigned', label: 'Assigned', numeric: true },
      { key: 'submitted', label: 'Submitted', numeric: true },
      { key: 'graded', label: 'Graded', numeric: true },
      { key: 'finished', label: 'Finished', numeric: true },
    ],
    rows: out,
    empty: 'No missions were handed out in this window.',
    flags,
  };
}

// ----------------------------------------------------------------- 2. stalls --
async function stallsSection(from: string): Promise<ReportSection> {
  const [rows] = await pool.query<any[]>(
    `SELECT a.student_id, a.score_band, a.id,
            m.hour_id, h.hour_number, h.title AS hour_title, c.code AS credit_code
       FROM assignments a
       JOIN missions m ON m.id = a.mission_id
       LEFT JOIN hours h   ON h.id = m.hour_id
       LEFT JOIN credits c ON c.id = h.credit_id
      WHERE a.status = 'graded' AND a.graded_at >= ?
      ORDER BY a.student_id, a.graded_at, a.id
      LIMIT ?`,
    [from, MAX_ATTEMPT_ROWS + 1]
  );

  const truncated = rows.length > MAX_ATTEMPT_ROWS;
  const attempts = truncated ? rows.slice(0, MAX_ATTEMPT_ROWS) : rows;

  // Walk each student's graded attempts in time order. A run of failures counts
  // only while the hour does not change: two failures on two different hours is
  // two bad questions, not a student who is stuck on one thing.
  interface Bucket {
    label: string;
    sort: number;
    attempts: number;
    failures: number;
    stuck: Set<number>;
    longest: number;
  }
  const byHour = new Map<string, Bucket>();
  let student: number | null = null;
  let runKey: string | null = null;
  let run = 0;

  for (const r of attempts) {
    const key = r.hour_id == null ? 'unmapped' : String(r.hour_id);
    const bucket =
      byHour.get(key) ??
      byHour
        .set(key, {
          label: hourLabel(r),
          sort: r.hour_number == null ? Number.MAX_SAFE_INTEGER : asNumber(r.hour_number),
          attempts: 0,
          failures: 0,
          stuck: new Set<number>(),
          longest: 0,
        })
        .get(key)!;
    bucket.attempts++;

    const sid = asNumber(r.student_id);
    if (sid !== student || key !== runKey) {
      student = sid;
      runKey = key;
      run = 0;
    }
    if (r.score_band === 'fail') {
      bucket.failures++;
      run++;
      if (run >= STALL_RUN) {
        bucket.stuck.add(sid);
        bucket.longest = Math.max(bucket.longest, run);
      }
    } else {
      run = 0;
    }
  }

  const flags: string[] = [];
  const out = [...byHour.values()]
    .filter((b) => b.stuck.size > 0)
    .sort((a, b) => b.stuck.size - a.stuck.size || b.longest - a.longest || a.sort - b.sort)
    .map((b) => {
      if (b.stuck.size >= 2 || b.longest >= 3) {
        flags.push(
          `${b.label}: ${b.stuck.size} student${b.stuck.size === 1 ? '' : 's'} failed ` +
            `${b.longest} in a row here. Worth a look at the teaching content, not just the questions.`
        );
      }
      return {
        hour: b.label,
        students_stuck: b.stuck.size,
        longest_run: b.longest,
        attempts: b.attempts,
        failures: b.failures,
        fail_rate: pct(b.failures, b.attempts),
      };
    });

  return {
    key: 'stalls',
    title: 'Where students get stuck',
    question: 'Where do students stall? Which hours produce the most consecutive failures.',
    explainer:
      `Only runs of ${STALL_RUN} or more failures in a row on the SAME hour are counted. ` +
      'One wrong answer is a wrong answer; several in a row on one hour usually means the content ' +
      'was not understood, or the questions are testing something the material never taught. ' +
      '"Longest run" is the worst single run any one student had.',
    columns: [
      { key: 'hour', label: 'Hour' },
      { key: 'students_stuck', label: 'Students stuck', numeric: true },
      { key: 'longest_run', label: 'Longest run', numeric: true },
      { key: 'attempts', label: 'Attempts', numeric: true },
      { key: 'failures', label: 'Failures', numeric: true },
      { key: 'fail_rate', label: 'Fail rate', numeric: true },
    ],
    rows: out,
    empty: `No student failed ${STALL_RUN} or more in a row on the same hour in this window.`,
    flags: truncated
      ? [
          ...flags,
          `Only the first ${MAX_ATTEMPT_ROWS.toLocaleString('en-GB')} graded attempts were read, so this ` +
            `section may be incomplete. Shorten the window.`,
        ]
      : flags,
  };
}

// -------------------------------------------------------------- 3. mis-tagged --
/** Reuses getMissionQuality — the same numbers the SME report shows. */
function mistaggedSection(quality: MissionQualityRow[]): ReportSection {
  const flags: string[] = [];
  const out = quality
    .filter((r) => r.mismatch)
    .sort(
      (a, b) =>
        Math.abs(b.observed_difficulty - b.tagged_difficulty) - Math.abs(a.observed_difficulty - a.tagged_difficulty) ||
        a.mission_id - b.mission_id
    )
    .map((r) => {
      const harder = r.observed_difficulty > r.tagged_difficulty;
      flags.push(
        `"${r.title}" is tagged difficulty ${r.tagged_difficulty} but behaves like ${r.observed_difficulty} — ` +
          `${harder ? 'harder' : 'easier'} than labelled (${pct(r.passes, r.attempts)} passed).`
      );
      return {
        mission: r.title,
        mission_id: r.mission_id,
        tagged: r.tagged_difficulty,
        observed: r.observed_difficulty,
        verdict: harder ? 'Harder than labelled' : 'Easier than labelled',
        attempts: r.attempts,
        pass_rate: pct(r.passes, r.attempts),
        students_said: r.median_perceived_difficulty ?? null,
        typical_time: duration(r.median_time_to_submit_seconds),
      };
    });

  return {
    key: 'mistagged',
    title: 'Missions labelled with the wrong difficulty',
    question: 'Which missions are mis-tagged? Observed difficulty from pass rate versus tagged difficulty.',
    explainer:
      '"Tagged" is the difficulty a person gave the mission. "Observed" is the difficulty its pass rate ' +
      'implies: almost everyone passing means easy, almost nobody passing means hard. A mission appears ' +
      'here only when those two differ by 2 or more bands and it has been attempted at least ' +
      `${MIN_ATTEMPTS} times. Re-tagging it is usually the fix; if students also say "too hard", the ` +
      'question itself may be the problem.',
    columns: [
      { key: 'mission', label: 'Mission' },
      { key: 'tagged', label: 'Tagged', numeric: true },
      { key: 'observed', label: 'Observed', numeric: true },
      { key: 'verdict', label: 'Verdict' },
      { key: 'attempts', label: 'Attempts', numeric: true },
      { key: 'pass_rate', label: 'Passed', numeric: true },
      { key: 'students_said', label: 'Students said' },
      { key: 'typical_time', label: 'Typical time', numeric: true },
    ],
    rows: out,
    empty:
      quality.length === 0
        ? `No mission has been attempted ${MIN_ATTEMPTS} times yet, so difficulty cannot be judged.`
        : 'Every mission with enough attempts is behaving close to its tagged difficulty.',
    flags,
  };
}

// ---------------------------------------------------------------- 4. coverage --
async function coverageSection(): Promise<ReportSection> {
  const [rows] = await pool.query<any[]>(
    `SELECT h.id, h.hour_number, h.title AS hour_title, c.code AS credit_code, t.name AS track_name,
            COUNT(m.id)                 AS live_missions,
            COUNT(DISTINCT m.difficulty) AS spread,
            MIN(m.difficulty)            AS min_difficulty,
            MAX(m.difficulty)            AS max_difficulty
       FROM hours h
       JOIN credits c ON c.id = h.credit_id
       JOIN tracks  t ON t.id = c.track_id
       LEFT JOIN missions m ON m.hour_id = h.id AND m.status = 'live'
      GROUP BY h.id, h.hour_number, h.title, c.code, t.name, c.sequence
      ORDER BY t.name, c.sequence, h.hour_number`,
    []
  );

  const flags: string[] = [];
  const thin = rows.filter(
    (r) => asNumber(r.live_missions) < MIN_MISSIONS_PER_HOUR || asNumber(r.spread) < MIN_DIFFICULTY_SPREAD
  );
  const out = thin.map((r) => {
    const n = asNumber(r.live_missions);
    const spread = asNumber(r.spread);
    const why =
      n === 0
        ? 'Nothing to give students at all'
        : n < MIN_MISSIONS_PER_HOUR
          ? `Only ${n} mission${n === 1 ? '' : 's'} — students will repeat`
          : 'Every mission is the same difficulty';
    return {
      track: r.track_name,
      hour: hourLabel(r),
      live_missions: n,
      difficulties: spread === 0 ? null : `${asNumber(r.min_difficulty)}–${asNumber(r.max_difficulty)}`,
      problem: why,
    };
  });
  const healthy = rows.length - thin.length;
  if (thin.length) {
    const none = thin.filter((r) => asNumber(r.live_missions) === 0).length;
    const hours = `${thin.length} hour${thin.length === 1 ? '' : 's'}`;
    flags.push(
      none === thin.length
        ? `${hours} have no missions at all — nothing can be taught from them yet.`
        : `${hours} do not have enough missions to teach from` +
            (none ? `, and ${none} of them have none at all.` : '.')
    );
  }
  const shown = out.slice(0, MAX_TABLE_ROWS);
  const truncation =
    out.length > shown.length
      ? ` Only the first ${MAX_TABLE_ROWS} of the ${thin.length} are listed, in curriculum order.`
      : '';

  return {
    key: 'coverage',
    title: 'Hours without enough material',
    question: 'Which hours have thin coverage, by mission count and by difficulty spread.',
    explainer:
      `An hour needs at least ${MIN_MISSIONS_PER_HOUR} live missions across at least ` +
      `${MIN_DIFFICULTY_SPREAD} difficulties. Below that, every student sees the same questions in the ` +
      'same order and there is nothing easier to fall back on when someone struggles. Only the hours ' +
      `that fall short are listed; ${healthy} hour${healthy === 1 ? ' is' : 's are'} fine.` +
      truncation,
    columns: [
      { key: 'track', label: 'Track' },
      { key: 'hour', label: 'Hour' },
      { key: 'live_missions', label: 'Live missions', numeric: true },
      { key: 'difficulties', label: 'Difficulties' },
      { key: 'problem', label: 'Problem' },
    ],
    rows: shown,
    empty:
      rows.length === 0
        ? 'No curriculum hours are loaded yet.'
        : 'Every hour has enough missions and enough of a difficulty spread.',
    flags,
  };
}

// ---------------------------------------------------------------- 5. feedback --
async function feedbackSection(from: string, quality: MissionQualityRow[]): Promise<ReportSection> {
  const [[rate]] = await pool.query<any[]>(
    `SELECT SUM(feedback_status = 'complete')                       AS complete,
            SUM(feedback_status IN ('complete','pending'))          AS asked
       FROM assignments
      WHERE status = 'graded' AND graded_at >= ?`,
    [from]
  );
  const [spread] = await pool.query<any[]>(
    `SELECT a.mission_id, fr.answer_value AS answer, COUNT(*) AS n
       FROM feedback_responses fr
       JOIN assignments a ON a.id = fr.assignment_id
      WHERE fr.question_key = 'perceived_difficulty' AND fr.created_at >= ?
      GROUP BY a.mission_id, fr.answer_value`,
    [from]
  );

  const counts = new Map<number, Record<string, number>>();
  for (const r of spread) {
    const mid = asNumber(r.mission_id);
    const row = counts.get(mid) ?? {};
    row[String(r.answer)] = asNumber(r.n);
    counts.set(mid, row);
  }

  const asked = asNumber(rate?.asked);
  const complete = asNumber(rate?.complete);
  const flags: string[] = [];
  if (asked >= MIN_SAMPLES && complete / asked < 0.8) {
    flags.push(
      `Only ${pct(complete, asked)} of graded missions got feedback. Everything on this page that ` +
        'depends on what students said gets weaker the lower that number is.'
    );
  }

  const out = quality
    .map((r) => {
      const c = counts.get(r.mission_id) ?? {};
      const tooHard = c['Too hard'] ?? 0;
      const tooEasy = c['Too easy'] ?? 0;
      const aboutRight = c['About right'] ?? 0;
      const total = tooHard + tooEasy + aboutRight;
      return {
        mission: r.title,
        mission_id: r.mission_id,
        attempts: r.attempts,
        answers: total,
        students_said: r.median_perceived_difficulty ?? null,
        too_easy: tooEasy,
        about_right: aboutRight,
        too_hard: tooHard,
        _total: total,
      };
    })
    .filter((r) => r._total > 0)
    .sort((a, b) => b.too_hard - a.too_hard || a.mission_id - b.mission_id)
    .map(({ _total, ...r }) => r);

  return {
    key: 'feedback',
    title: 'What students say about the work',
    question: 'Feedback completion rate, and the aggregate perceived difficulty per mission.',
    explainer:
      `Students were asked for feedback on ${asked} graded mission${asked === 1 ? '' : 's'} and gave it on ` +
      `${complete} of them — ${pct(complete, asked) ?? 'no rate yet'}. The table is what they said about ` +
      'difficulty, mission by mission, hardest-feeling first. "Students said" is the middle answer of all ' +
      'of them, which is steadier than an average when there are only a handful.',
    columns: [
      { key: 'mission', label: 'Mission' },
      { key: 'answers', label: 'Answers', numeric: true },
      { key: 'students_said', label: 'Students said' },
      { key: 'too_easy', label: 'Too easy', numeric: true },
      { key: 'about_right', label: 'About right', numeric: true },
      { key: 'too_hard', label: 'Too hard', numeric: true },
    ],
    rows: out,
    empty: 'No student has answered the difficulty question in this window.',
    flags,
  };
}

// -------------------------------------------------------------- 6. time bands --
async function timeBandSection(from: string): Promise<ReportSection> {
  const bands = timeBandMinutes();
  const order = Object.keys(bands) as TimeBand[];
  const [rows] = await pool.query<any[]>(
    `SELECT m.time_band AS band, a.time_to_submit_seconds AS secs
       FROM assignments a
       JOIN missions m ON m.id = a.mission_id
      WHERE a.status = 'graded' AND a.graded_at >= ? AND a.time_to_submit_seconds IS NOT NULL`,
    [from]
  );

  const samples = new Map<string, number[]>();
  for (const r of rows) {
    const band = String(r.band);
    const list = samples.get(band) ?? [];
    list.push(asNumber(r.secs));
    samples.set(band, list);
  }

  const flags: string[] = [];
  const out: Record<string, ReportValue>[] = [];
  order.forEach((band, i) => {
    const list = samples.get(band) ?? [];
    const lowerMin = i === 0 ? 0 : bands[order[i - 1]];
    const upperMin = bands[band];
    const med = median(list);
    let verdict: string;
    if (list.length < MIN_SAMPLES) verdict = 'Not enough attempts to say';
    else if (med! < lowerMin * 60) verdict = 'Students finish quicker than this band expects';
    else if (med! > upperMin * 60) verdict = 'Students take longer than this band allows';
    else verdict = 'About right';
    if (list.length >= MIN_SAMPLES && verdict !== 'About right') {
      flags.push(
        `"${band}" missions are expected to take ${lowerMin}–${upperMin} minutes but typically take ` +
          `${duration(med)}. Either the band is wrong or those missions are.`
      );
    }
    out.push({
      band,
      expected: `${lowerMin}–${upperMin} min`,
      attempts: list.length,
      typical_time: duration(med),
      quickest: duration(list.length ? Math.min(...list) : null),
      slowest: duration(list.length ? Math.max(...list) : null),
      verdict,
    });
  });

  return {
    key: 'time_bands',
    title: 'Whether the time bands are honest',
    question: "Time taken versus the mission's time band — which bands are wrong.",
    explainer:
      'Every mission is labelled short, medium, long or heavy. This compares that label with how long ' +
      'students actually took, measured from opening the mission to submitting it. "Typical time" is the ' +
      'middle of all attempts, so one student who wandered off does not move it. The expected ranges are ' +
      'a configured assumption (TIME_BAND_MINUTES), not something the data discovered — if they are wrong, ' +
      'change them and the verdicts change with them.',
    columns: [
      { key: 'band', label: 'Band' },
      { key: 'expected', label: 'Expected' },
      { key: 'attempts', label: 'Attempts', numeric: true },
      { key: 'typical_time', label: 'Typical time', numeric: true },
      { key: 'quickest', label: 'Quickest', numeric: true },
      { key: 'slowest', label: 'Slowest', numeric: true },
      { key: 'verdict', label: 'Verdict' },
    ],
    rows: out,
    empty: 'No mission has been submitted with a recorded time in this window.',
    flags,
  };
}

// ---------------------------------------------------------------- 7. revision --
async function revisionSection(from: string): Promise<ReportSection> {
  const [[totals]] = await pool.query<any[]>(
    `SELECT COUNT(*) AS selections,
            SUM(JSON_UNQUOTE(JSON_EXTRACT(filters_applied, '$.tier')) = 'repeat_oldest') AS pool_dry,
            SUM(JSON_EXTRACT(filters_applied, '$.revision_mix') = true)                  AS deliberate,
            SUM(chosen_mission IS NULL)                                                  AS nothing_served
       FROM selection_log
      WHERE created_at >= ?`,
    [from]
  );
  const [byHour] = await pool.query<any[]>(
    `SELECT h.hour_number, h.title AS hour_title, c.code AS credit_code, COUNT(*) AS repeats
       FROM selection_log sl
       LEFT JOIN hours h   ON h.id = sl.chosen_hour_id
       LEFT JOIN credits c ON c.id = h.credit_id
      WHERE sl.created_at >= ?
        AND JSON_UNQUOTE(JSON_EXTRACT(sl.filters_applied, '$.tier')) = 'repeat_oldest'
      GROUP BY h.hour_number, h.title, c.code
      ORDER BY repeats DESC, h.hour_number`,
    [from]
  );

  const selections = asNumber(totals?.selections);
  const poolDry = asNumber(totals?.pool_dry);
  const deliberate = asNumber(totals?.deliberate);
  const nothing = asNumber(totals?.nothing_served);

  const flags: string[] = [];
  if (selections >= MIN_SAMPLES && poolDry / selections > 0.1) {
    flags.push(
      `${pct(poolDry, selections)} of missions handed out were repeats because nothing new was left. ` +
        'That is a content shortage, not a teaching choice.'
    );
  }
  if (nothing > 0) {
    flags.push(
      `${nothing} time${nothing === 1 ? '' : 's'} the system had nothing at all to give a student. ` +
        'Those students saw an empty slot.'
    );
  }

  const out = byHour.map((r) => ({
    hour: hourLabel(r),
    repeats: asNumber(r.repeats),
  }));

  return {
    key: 'revision',
    title: 'Repeats handed out because the content ran out',
    question: 'Revision rate: how often students are served repeats because a pool ran dry.',
    explainer:
      `Of ${selections} mission${selections === 1 ? '' : 's'} chosen in this window, ${poolDry} were a ` +
      `repeat of something the student had already done, handed over because nothing new was left ` +
      `(${pct(poolDry, selections) ?? '0%'}). A further ${deliberate} were repeats ON PURPOSE — planned ` +
      'revision of earlier hours, which is meant to happen. Only the first kind is a problem, and the ' +
      'table shows which hours it happened in.',
    columns: [
      { key: 'hour', label: 'Hour the repeat came from' },
      { key: 'repeats', label: 'Repeats', numeric: true },
    ],
    rows: out,
    empty:
      selections === 0
        ? 'No missions were chosen in this window.'
        : 'No student was given a repeat because the content ran out.',
    flags,
  };
}

// ------------------------------------------------------------------ assembly --
export async function getPilotReport(opts: { weeks?: number } = {}): Promise<PilotReport> {
  const weeks = opts.weeks ?? reportWeeks();
  const tz = reportTimezone();
  const { from, to } = await windowStart(weeks, tz);
  const mode = selectionMode();

  // One pass over the SME report, shared by the two sections that need it.
  const quality = await getMissionQuality();

  const sections = [
    await completionSection(from, tz),
    await stallsSection(from),
    mistaggedSection(quality),
    await coverageSection(),
    await feedbackSection(from, quality),
    await timeBandSection(from),
    await revisionSection(from),
  ];

  const notes: string[] = [
    `Everything except the coverage table is limited to ${weeks} week${weeks === 1 ? '' : 's'}: ` +
      `${from} to ${to}. Coverage describes the whole curriculum, which has no window.`,
    `A finding needs at least ${MIN_SAMPLES} observations before it is reported, so a quiet pilot ` +
      'produces a short report rather than a confident wrong one.',
  ];
  if (mode === 'legacy') {
    notes.push(
      'The system is running in legacy selection mode, which picks missions by difficulty and interest ' +
        'rather than by curriculum hour. Hour-by-hour figures only fill in once curriculum mode is on, ' +
        'and repeats cannot happen at all in legacy mode.'
    );
  }

  const headline = sections.flatMap((s) => s.flags);

  return {
    generated_at: new Date().toISOString(),
    timezone: tz,
    window: { weeks, from, to },
    selection_mode: mode,
    headline,
    notes,
    sections,
  };
}
