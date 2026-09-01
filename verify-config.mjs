// Item 6 (config validation) acceptance harness.
// Spawns the server with malformed env and asserts it refuses to start, naming
// the offending variable. Run: npm run verify:config
import { spawnSync } from 'node:child_process';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`))
       : (fail++, console.log(`  FAIL ${name} ${detail}`));
}

// Boot the server with an overridden env; a config failure exits fast.
function boot(overrides) {
  const r = spawnSync('npx tsx src/server.ts', {
    env: { ...process.env, ...overrides },
    encoding: 'utf8',
    timeout: 30000,
    shell: true,
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

console.log('\n[The server refuses to start on malformed config, naming the variable]');
for (const [label, overrides, needle] of [
  ['bad AUTH_MODE', { AUTH_MODE: 'nonsense' }, 'AUTH_MODE'],
  ['bad PORT', { PORT: 'not-a-port' }, 'PORT'],
  ['bad LOG_LEVEL', { LOG_LEVEL: 'chatty' }, 'LOG_LEVEL'],
]) {
  const { status, out } = boot(overrides);
  check(`${label}: non-zero exit`, status !== 0 && status != null, `(exit=${status})`);
  check(`${label}: message names ${needle}`, out.includes(needle), `(has=${out.includes(needle)})`);
  check(`${label}: refuses to start`, /refusing to start/i.test(out));
}

console.log(`\n==== Config: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
