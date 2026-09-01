// Item 2 (logging + error tracking) acceptance harness.
// Requires the server running on :3000 with ENABLE_TEST_HOOKS=1.
// Run: npm run verify:logging
const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`))
       : (fail++, console.log(`  FAIL ${name} ${detail}`));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function raw(path, opts) {
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, reqId: r.headers.get('x-request-id'), text, body };
}
async function logsFor(requestId) {
  const r = await fetch(`${BASE}/api/test/logs?requestId=${encodeURIComponent(requestId)}`);
  return r.json();
}

console.log('\n[An error response contains a requestId and no stack trace]');
const boom = await raw('/api/test/boom');
check('synthetic error -> 500', boom.status === 500, `(got ${boom.status})`);
check('X-Request-Id response header present', !!boom.reqId, `(reqId=${boom.reqId})`);
check('body.error.requestId matches the header', boom.body?.error?.requestId === boom.reqId,
  `(header=${boom.reqId}, body=${boom.body?.error?.requestId})`);
check('generic message (no internal detail leaked)', boom.body?.error?.message === 'internal server error',
  `(msg=${boom.body?.error?.message})`);
check('response body carries NO stack trace', !/\bat\s+\w/.test(boom.text) && !boom.text.toLowerCase().includes('stack'),
  `(body=${boom.text.slice(0, 100)})`);
check('response body does not leak the thrown message', !boom.text.includes('synthetic error'));

console.log('\n[The same requestId appears in the log lines for that request]');
await sleep(250); // let the completion log flush to the ring
const entries = await logsFor(boom.reqId);
check('log entries exist for the requestId', Array.isArray(entries) && entries.length >= 1, `(n=${entries?.length})`);
const errEntry = (entries || []).find((e) => e.msg === 'unhandled error');
check('error logged server-side WITH stack + requestId',
  !!errEntry && errEntry.requestId === boom.reqId && !!errEntry.err && typeof errEntry.err.stack === 'string' && errEntry.err.stack.length > 0,
  `(hasErr=${!!errEntry?.err})`);
const doneEntry = (entries || []).find((e) => e.req && e.res);
check('request completion logged: method/status/duration/requestId',
  !!doneEntry && doneEntry.req.method === 'GET' && typeof doneEntry.res.statusCode === 'number' &&
    typeof doneEntry.responseTime === 'number' && doneEntry.requestId === boom.reqId,
  `(status=${doneEntry?.res?.statusCode}, ms=${doneEntry?.responseTime})`);

console.log('\n[Redaction: secrets never reach the logs]');
const authed = await raw('/api/feedback/questions', { headers: { 'X-User-Id': '1', Authorization: 'Bearer topsecret-value' } });
check('authenticated request succeeds', authed.status === 200, `(got ${authed.status})`);
await sleep(250);
const logs2 = await logsFor(authed.reqId);
const done2 = (logs2 || []).find((e) => e.req);
check('Authorization header redacted in the log', !!done2 && done2.req.headers && done2.req.headers.authorization === '[REDACTED]',
  `(auth=${done2?.req?.headers?.authorization})`);
check('raw secret value appears in NO log line for the request', !JSON.stringify(logs2 || []).includes('topsecret-value'));

console.log(`\n==== Logging: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
