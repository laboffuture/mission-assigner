// Production security guard harness.
// Proves the server refuses to boot in NODE_ENV=production while any staff
// account still has the default password, and boots once they're changed.
// Requires a fresh seed (default password 'changeme'). Run: npm run verify:prod-guard
import 'dotenv/config';
import { spawnSync, spawn, execSync } from 'node:child_process';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`))
       : (fail++, console.log(`  FAIL ${name} ${detail}`));
}

// A valid production env EXCEPT for the password state under test. A distinct
// PORT avoids colliding with the dev server on :3000, and a strong SESSION_SECRET
// lets env validation pass so we actually reach the password guard.
const prodEnv = {
  NODE_ENV: 'production',
  SESSION_SECRET: 'x'.repeat(48),
  PORT: '3998',
};
const childEnv = { ...process.env, ...prodEnv };

// Boot and wait for the process to EXIT on its own (the failure case). Generous
// timeout absorbs the tsx cold-start; the guard exits ~immediately once compiled.
function bootExpectExit(timeout = 45000) {
  const r = spawnSync('npx tsx src/server.ts', { env: childEnv, encoding: 'utf8', timeout, shell: true });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// Boot and resolve as soon as the server logs "listening" (the pass case), then
// kill it — so we don't wait out a timeout on a server that started fine.
function bootExpectListen(timeout = 45000) {
  return new Promise((resolve) => {
    const child = spawn('npx tsx src/server.ts', { env: childEnv, shell: true });
    let out = '';
    let done = false;
    const finish = (listened) => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* already gone */ }
      resolve({ listened, out });
    };
    const onData = (b) => {
      out += b.toString();
      if (/Mission Hub listening/i.test(out)) finish(true);
      if (/refusing to start in production/i.test(out)) finish(false);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => finish(/Mission Hub listening/i.test(out)));
    setTimeout(() => finish(/Mission Hub listening/i.test(out)), timeout);
  });
}

console.log('\n[Refuses to boot in production while staff have the default password]');
{
  // Fresh seed => sme/qc/instructor/admin all have 'changeme'.
  execSync('npm run db:seed', { stdio: 'ignore' });
  const { status, out } = bootExpectExit();
  check('non-zero exit', status !== 0 && status != null, `(exit=${status})`);
  check('message says refusing to start', /refusing to start in production/i.test(out));
  check('names the default password', /default password/i.test(out) && /changeme/.test(out));
  for (const u of ['sme', 'qc', 'instructor', 'admin']) {
    check(`names account "${u}"`, out.includes(u));
  }
}

console.log('\n[Boots once every staff password is changed]');
{
  for (const u of ['sme', 'qc', 'instructor', 'admin']) {
    execSync(`npm run set-password -- ${u} StrongPassw0rd!${u}`, { stdio: 'ignore' });
  }
  const { listened, out } = await bootExpectListen();
  check('server reached listen', listened, `(started=${listened})`);
  check('no default-password fatal', !/refusing to start in production/i.test(out));
}

// Restore the pristine demo seed (default password) for the rest of the suite.
execSync('npm run db:seed', { stdio: 'ignore' });

console.log(`\n==== Prod guard: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
