// Shared e2e environment. Imported by playwright.config.ts and by specs.
export const E2E_PORT = Number(process.env.E2E_PORT ?? 4300);
export const FAKE_GITHUB_PORT = E2E_PORT + 1;
export const BASE_URL = `http://localhost:${E2E_PORT}`;
export const FAKE_GITHUB_URL = `http://localhost:${FAKE_GITHUB_PORT}`;
export const AGENT_KEY = "e2e-agent-key-0123456789-abcdefghijklmnop";
export const SESSION_SECRET = "e2e-session-secret-0123456789-abcdefghijklmnop";
export const STATIC_DIR = `.e2e/${E2E_PORT}/dist`;

export const SERVER_ENV: Record<string, string> = {
  PORT: String(E2E_PORT),
  STATIC_DIR,
  DATABASE_URL: "pglite://memory",
  PUBLIC_URL: BASE_URL,
  SESSION_SECRET,
  TRACKER_AGENT_KEY: AGENT_KEY,
  GITHUB_CLIENT_ID: "e2e-client-id",
  GITHUB_CLIENT_SECRET: "e2e-client-secret",
  GITHUB_OAUTH_URL: FAKE_GITHUB_URL,
  GITHUB_API_URL: FAKE_GITHUB_URL,
};
