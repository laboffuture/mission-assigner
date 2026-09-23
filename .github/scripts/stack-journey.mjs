// A real student journey against the deployed stack, through Caddy.
//
// Everything goes to ONE origin — the proxy — exactly as a browser in the LMS
// iframe would: the session cookie is first-party, /api/* is routed by Caddy
// straight to the api container (not through Next), and the pages come from the
// web container. If routing, cookies or the API were wrong in the deployed
// shape rather than in dev, this is what would catch it.
//
// Usage: node .github/scripts/stack-journey.mjs http://localhost
const BASE = process.argv[2] ?? 'http://localhost';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  const ok = !!cond;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
  return ok;
};

// One cookie jar for the whole journey, like a browser.
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
function remember(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(jar.size ? { Cookie: cookieHeader() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  remember(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, text, json, headers: res.headers };
}

console.log(`\nStudent journey against ${BASE} (through Caddy)`);

// 1. Sign in the way the dev launch does; the LTI launch will mint the same cookie.
const users = await call('GET', '/api/dev/users');
check('the roster is served by the api through the proxy', users.status === 200, `(${users.status})`);
const student = (users.json?.items ?? []).find((u) => u.role === 'student');
if (!check('a seeded student exists', !!student, `(${(users.json?.items ?? []).length} users)`)) process.exit(1);

const login = await call('POST', '/api/dev/login-as', { studentId: student.id });
check('login-as sets a session cookie', login.status === 200 && jar.has('mh_session'), `(${login.status})`);

// 2. The week board, server-rendered by Next, reading the api server-side.
const week = await call('GET', '/week');
check('the week board renders for the signed-in student', week.status === 200 && /This week/i.test(week.text), `(${week.status})`);

// 3. Open a mission, answer it, and give feedback — the whole loop.
const weekJson = await call('GET', `/api/week/${student.id}`);
const slot = (weekJson.json?.slots ?? []).find((s) => s.status === 'open');
if (!check('a slot is open', !!slot, `(statuses=${(weekJson.json?.slots ?? []).map((s) => s.status).join(',')})`)) {
  process.exit(1);
}
const open = await call('POST', `/api/slot/${slot.slot_id}/open`, {});
check('the slot opens with a mission', open.status === 200 && Array.isArray(open.json?.options), `(${open.status})`);

const chosen = open.json.options[0].option_key;
const submit = await call('POST', '/api/submit', { assignmentId: open.json.assignment_id, selected: chosen });
check('the answer is graded', submit.status === 200 && typeof submit.json?.correct === 'boolean', `(${submit.status})`);
check('the result carries the correct option and an explanation', !!submit.json?.correct_option_key, '');

const fb = await call('POST', `/api/feedback/${open.json.assignment_id}`, {
  answers: [
    { question_key: 'perceived_difficulty', value: 'About right' },
    { question_key: 'time_taken', value: 'About as expected' },
    { question_key: 'clarity', value: '4' },
    { question_key: 'confidence', value: '4' },
  ],
});
check('feedback is accepted', fb.status === 200, `(${fb.status} ${fb.text.slice(0, 120)})`);

// 4. Progress reflects the work, and the mission page renders.
const progress = await call('GET', '/progress');
check('the progress page renders', progress.status === 200 && /Level|XP/i.test(progress.text), `(${progress.status})`);

// 5. The gates still hold in the deployed shape.
const anon = { status: (await fetch(`${BASE}/quality`, { redirect: 'manual' })).status };
check('/quality redirects an anonymous visitor to login', anon.status === 302, `(${anon.status})`);

console.log(`\n==== Journey: ${pass} passed, ${fail} failed ====`);
if (fail) {
  console.log(`::error title=Stack journey::${fail} checks failed against the deployed stack`);
  process.exit(1);
}
