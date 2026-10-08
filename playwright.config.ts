import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, E2E_PORT, FAKE_GITHUB_PORT, FAKE_GITHUB_URL, SERVER_ENV, STATIC_DIR } from "./e2e/support/env.ts";

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
  webServer: [
    {
      command: "node e2e/support/fake-github.ts",
      url: `${FAKE_GITHUB_URL}/__health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { FAKE_GITHUB_PORT: String(FAKE_GITHUB_PORT) },
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `npx vite build --outDir ${STATIC_DIR} && node server/main.ts`,
      url: `${BASE_URL}/job-tracker/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: SERVER_ENV,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
  outputDir: `.e2e/${E2E_PORT}/test-results`,
});
