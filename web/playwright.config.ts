import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config. Assumes the full stack is already running:
 *   - Express API on :3000 with ENABLE_TEST_HOOKS=1
 *   - MySQL up and migrated
 *   - Next dev on :3001
 * Tests reseed the DB themselves (see e2e/helpers.ts) for deterministic state.
 * Serial (workers: 1) because the tests mutate shared student state.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'retain-on-failure',
    actionTimeout: 10_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
