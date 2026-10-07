import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, E2E_PORT, SERVER_ENV, STATIC_DIR } from "./e2e/support/env.ts";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx vite build --outDir ${STATIC_DIR} && node server/main.ts`,
    url: `${BASE_URL}/job-tracker/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: SERVER_ENV,
    stdout: "pipe",
    stderr: "pipe",
  },
  outputDir: `.e2e/${E2E_PORT}/test-results`,
});
