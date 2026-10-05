import { defineConfig } from '@playwright/test';

const webPort = Number(process.env.E2E_WEB_PORT ?? 5174);
const apiPort = Number(process.env.E2E_API_PORT ?? 3101);
// E2E_BROWSER=firefox or webkit runs the suite in that engine; the default is Chromium.
const browserName = (process.env.E2E_BROWSER ?? 'chromium') as 'chromium' | 'firefox' | 'webkit';
const launchOptions = browserName === 'chromium'
  ? { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }
  : browserName === 'firefox' ? { firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true } } : {};

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: [
    ...(process.env.SMTP_CAPTURE_PATH ? [] : ['**/mail.spec.ts']),
    ...(process.env.GATHER_MANUAL_READING_MODE === '1' ? [] : ['**/manual-reading.spec.ts', '**/read-failure.spec.ts']),
    ...(process.env.GATHER_SCAN_QUOTA_MODE === '1' ? [] : ['**/scan-quota.spec.ts']),
  ],
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results',
  timeout: 30_000,
  expect: { timeout: 6_000 },
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    browserName,
    launchOptions,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
