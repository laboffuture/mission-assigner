// Production security guard harness.
// Proves the server refuses to boot in NODE_ENV=production while any staff
// account still has the default password, and that the gate passes once the
// passwords are changed. Run via tsx so it can call the gate directly.
// Requires a fresh seed (default password 'changeme'). Run: npm run verify:prod-guard
import 'dotenv/config';
import { spawnSync, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createProdDbUser } from './test-support/prod-db-user.mjs';
import { pool } from './src/db.js';
import { findDefaultStaffPasswords, assertProductionSecurity } from './src/securityChecks.js';

let pass = 0,
  fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`)) : (fail++, console.log(`  FAIL ${name} ${detail}`));
}

// A valid production env for the real-boot (failure) case. A strong SESSION_SECRET
// lets env validation pass so we actually reach the password guard; PORT is set
// but never bound because the guard throws BEFORE app.listen.
// AUTH_MODE=lti and no ENABLE_TEST_HOOKS: production now refuses to boot with
// dev auth (including an unset AUTH_MODE, or AUTH_MODE=dev inherited from .env)
// or with test hooks, so both must be valid here or env validation would stop
// the boot before the password guard this harness exists to test.
//
// DB_PASS is its own problem here: production also refuses to boot when a secret
// still looks like a placeholder or a shipped default, and the local database
// password IS such a default ('devpass'). Rather than weaken that check to suit
// the harness, this creates a throwaway MySQL user with a real password and
// boots production as that user, so the run reaches the staff-password guard
// this file exists to test.
const prodDb = await createProdDbUser(pool, 'prodguard');

const prodEnv = {
  NODE_ENV: 'production',
  SESSION_SECRET: randomBytes(32).toString('hex'),
  PORT: '3998',
  AUTH_MODE: 'lti',
  ENABLE_TEST_HOOKS: '',
  // Reached directly in this harness: no proxy in front.
  TRUST_PROXY: '0',
  ...prodDb.env,
};

console.log('\n[Refuses to boot in production while staff have the default password]');
{
  // Fresh seed => sme/qc/instructor/admin all have 'changeme'. The server boots,
  // the guard throws pre-listen, and it exits(1) on its own (never binds a port).
  execSync('npm run db:seed', { stdio: 'ignore' });
  const r = spawnSync('npx tsx src/server.ts', {
    env: { ...process.env, ...prodEnv },
    encoding: 'utf8',
    timeout: 60000,
    shell: true,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  check('non-zero exit', r.status !== 0 && r.status != null, `(exit=${r.status})`);
  check('message says refusing to start', /refusing to start in production/i.test(out));
  check('names the default password', /default password/i.test(out) && /changeme/.test(out));
  for (const u of ['sme', 'qc', 'instructor', 'admin']) {
    check(`names account "${u}"`, out.includes(u));
  }
}

console.log('\n[The gate passes once every staff password is changed]');
{
  for (const u of ['sme', 'qc', 'instructor', 'admin']) {
    execSync(`npm run set-password -- ${u} StrongPassw0rd!${u}`, { stdio: 'ignore' });
  }
  const offenders = await findDefaultStaffPasswords();
  check(
    'no staff account has the default password',
    offenders.length === 0,
    `(offenders=${offenders.join(',') || 'none'})`
  );

  // The production gate now resolves instead of throwing.
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  let threw = false;
  try {
    await assertProductionSecurity();
  } catch {
    threw = true;
  }
  process.env.NODE_ENV = prev;
  check('assertProductionSecurity() does not throw', threw === false);
}

// Restore the pristine demo seed (default password) for the rest of the suite.
execSync('npm run db:seed', { stdio: 'ignore' });

await prodDb.drop();
await pool.end();

console.log(`\n==== Prod guard: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
