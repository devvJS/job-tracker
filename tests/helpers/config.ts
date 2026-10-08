import type { Config } from "../../server/config.ts";

/** Fixed clock used by every test unless it passes its own. 2026-10-07 10:00 in America/Detroit. */
export const TEST_NOW = new Date("2026-10-07T14:00:00.000Z");
export const TEST_AGENT_KEY = "test-agent-key-0123456789-abcdefghijklmnop";
export const TEST_SESSION_SECRET = "test-session-secret-0123456789-abcdefghijkl";

/** A valid Config built as a literal (does not depend on loadConfig). Override any top-level field. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    publicUrl: "http://localhost:3000",
    databaseUrl: "pglite://memory",
    sessionSecret: TEST_SESSION_SECRET,
    agentKeys: [TEST_AGENT_KEY],
    github: {
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      oauthUrl: "https://github.test",
      apiUrl: "https://api.github.test",
    },
    allowedLogin: "devvJS",
    staticDir: "dist",
    agentRateLimitPerMinute: 60,
    timezone: "America/Detroit",
    ...overrides,
  };
}
