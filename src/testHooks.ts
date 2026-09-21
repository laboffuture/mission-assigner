/**
 * Whether the test-only hooks (/api/test/*, the in-memory log buffer, runtime
 * feedback-gating injection) are active.
 *
 * Never in production, whatever ENABLE_TEST_HOOKS says. env validation already
 * refuses to boot with ENABLE_TEST_HOOKS set under NODE_ENV=production; this is
 * the second, independent line, so the hooks stay off even if that check were
 * ever bypassed or reordered.
 */
export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.NODE_ENV ?? 'development') === 'production';
}

export function testHooksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isProduction(env)) return false;
  return !!env.ENABLE_TEST_HOOKS;
}
