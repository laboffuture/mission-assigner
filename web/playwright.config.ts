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
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  // In CI, the 'github' reporter also turns each failure into an annotation on the
  // run, readable without repository-admin rights (job logs are not).
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'retain-on-failure',
    actionTimeout: 10_000,
  },
  // One project per engine and per shape a pilot student might actually hold.
  // Chromium is the reference; anything that passes there and fails elsewhere is
  // a real difference in the product, not in the test.
  //
  // The two device projects carry isMobile and hasTouch from their descriptors,
  // so clicks become taps and layout is measured at the real width — which is
  // where responsive bugs live. iPad runs on WebKit because iPads do; the phone
  // runs on Chromium because Android does.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'ipad', use: { ...devices['iPad Pro 11'] } },
    { name: 'phone', use: { ...devices['Pixel 5'] } },
  ],
});
