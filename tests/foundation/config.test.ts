import { describe, expect, it } from "vitest";
import { loadConfig } from "../../server/config.ts";

const KEY = "a".repeat(32);
const SECRET = "s".repeat(32);

function validEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DATABASE_URL: "pglite://memory",
    PUBLIC_URL: "https://devvjs.dev",
    SESSION_SECRET: SECRET,
    TRACKER_AGENT_KEY: KEY,
    GITHUB_CLIENT_ID: "cid",
    GITHUB_CLIENT_SECRET: "csecret",
    ...extra,
  };
}

function errorMessage(env: Record<string, string | undefined>): string {
  try {
    loadConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    return (e as Error).message;
  }
  throw new Error("loadConfig did not throw");
}

describe("loadConfig defaults", () => {
  it("maps required variables and applies every default", () => {
    expect(loadConfig(validEnv())).toEqual({
      port: 3000,
      publicUrl: "https://devvjs.dev",
      databaseUrl: "pglite://memory",
      sessionSecret: SECRET,
      agentKeys: [KEY],
      github: {
        clientId: "cid",
        clientSecret: "csecret",
        oauthUrl: "https://github.com",
        apiUrl: "https://api.github.com",
      },
      allowedLogin: "devvJS",
      staticDir: "dist",
      agentRateLimitPerMinute: 60,
      timezone: "America/Detroit",
    });
  });

  it("reads overrides as typed values", () => {
    const c = loadConfig(
      validEnv({
        PORT: "8080",
        GITHUB_OAUTH_URL: "http://localhost:4301",
        GITHUB_API_URL: "http://localhost:4302",
        ALLOWED_GITHUB_LOGIN: "someoneElse",
        STATIC_DIR: "/srv/ui",
        AGENT_RATE_LIMIT_PER_MINUTE: "5",
        TRACKER_TIMEZONE: "UTC",
      }),
    );
    expect(c.port).toBe(8080);
    expect(c.github.oauthUrl).toBe("http://localhost:4301");
    expect(c.github.apiUrl).toBe("http://localhost:4302");
    expect(c.allowedLogin).toBe("someoneElse");
    expect(c.staticDir).toBe("/srv/ui");
    expect(c.agentRateLimitPerMinute).toBe(5);
    expect(c.timezone).toBe("UTC");
  });
});

describe("loadConfig publicUrl", () => {
  it("removes a trailing slash", () => {
    expect(loadConfig(validEnv({ PUBLIC_URL: "https://devvjs.dev/" })).publicUrl).toBe("https://devvjs.dev");
  });

  it("removes repeated trailing slashes", () => {
    expect(loadConfig(validEnv({ PUBLIC_URL: "http://localhost:4300//" })).publicUrl).toBe("http://localhost:4300");
  });
});

describe("loadConfig agentKeys", () => {
  it("drops an empty TRACKER_AGENT_KEY_NEXT", () => {
    expect(loadConfig(validEnv({ TRACKER_AGENT_KEY_NEXT: "" })).agentKeys).toEqual([KEY]);
  });

  it("drops an unset TRACKER_AGENT_KEY_NEXT", () => {
    expect(loadConfig(validEnv({ TRACKER_AGENT_KEY_NEXT: undefined })).agentKeys).toEqual([KEY]);
  });

  it("keeps both keys, primary first", () => {
    const next = "b".repeat(40);
    expect(loadConfig(validEnv({ TRACKER_AGENT_KEY_NEXT: next })).agentKeys).toEqual([KEY, next]);
  });

  it("accepts a key of exactly 32 characters", () => {
    expect(loadConfig(validEnv({ TRACKER_AGENT_KEY: "k".repeat(32) })).agentKeys).toEqual(["k".repeat(32)]);
  });

  it("rejects a TRACKER_AGENT_KEY shorter than 32 characters", () => {
    expect(errorMessage(validEnv({ TRACKER_AGENT_KEY: "k".repeat(31) }))).toContain("TRACKER_AGENT_KEY");
  });

  it("rejects a non-empty TRACKER_AGENT_KEY_NEXT shorter than 32 characters", () => {
    expect(errorMessage(validEnv({ TRACKER_AGENT_KEY_NEXT: "short" }))).toContain("TRACKER_AGENT_KEY_NEXT");
  });
});

describe("loadConfig errors", () => {
  it("names every missing required variable in one error", () => {
    const msg = errorMessage({});
    for (const name of [
      "DATABASE_URL",
      "PUBLIC_URL",
      "SESSION_SECRET",
      "TRACKER_AGENT_KEY",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
    ]) {
      expect(msg, `message should name ${name}`).toContain(name);
    }
  });

  it("treats an empty string as missing", () => {
    expect(errorMessage(validEnv({ DATABASE_URL: "" }))).toContain("DATABASE_URL");
  });

  it("names only the problem variables when others are fine", () => {
    const msg = errorMessage(validEnv({ GITHUB_CLIENT_ID: undefined }));
    expect(msg).toContain("GITHUB_CLIENT_ID");
    expect(msg).not.toContain("GITHUB_CLIENT_SECRET");
    expect(msg).not.toContain("DATABASE_URL");
  });

  it("names a SESSION_SECRET shorter than 32 characters together with other missing variables", () => {
    const msg = errorMessage({ SESSION_SECRET: "x".repeat(31) });
    expect(msg).toContain("SESSION_SECRET");
    expect(msg).toContain("DATABASE_URL");
    expect(msg).toContain("TRACKER_AGENT_KEY");
  });

  it("accepts a SESSION_SECRET of exactly 32 characters", () => {
    expect(loadConfig(validEnv({ SESSION_SECRET: "x".repeat(32) })).sessionSecret).toBe("x".repeat(32));
  });

  it("names a non-numeric PORT", () => {
    expect(errorMessage(validEnv({ PORT: "abc" }))).toContain("PORT");
  });
});

describe("loadConfig gap coverage", () => {
  it("rejects an invalid TRACKER_TIMEZONE, naming it", () => {
    expect(errorMessage(validEnv({ TRACKER_TIMEZONE: "Mars/Olympus" }))).toContain("TRACKER_TIMEZONE");
  });

  it.each(["0", "abc", "-1", "1.5"])("rejects AGENT_RATE_LIMIT_PER_MINUTE=%s, naming it", (v) => {
    expect(errorMessage(validEnv({ AGENT_RATE_LIMIT_PER_MINUTE: v }))).toContain("AGENT_RATE_LIMIT_PER_MINUTE");
  });

  it("accepts AGENT_RATE_LIMIT_PER_MINUTE=1", () => {
    expect(loadConfig(validEnv({ AGENT_RATE_LIMIT_PER_MINUTE: "1" })).agentRateLimitPerMinute).toBe(1);
  });

  it.each(["ftp://devvjs.dev", "devvjs.dev", "not a url", "javascript:alert(1)"])(
    "rejects PUBLIC_URL=%s, naming it",
    (v) => {
      expect(errorMessage(validEnv({ PUBLIC_URL: v }))).toContain("PUBLIC_URL");
    },
  );

  it("accepts http and https PUBLIC_URL", () => {
    expect(loadConfig(validEnv({ PUBLIC_URL: "http://localhost:4300" })).publicUrl).toBe("http://localhost:4300");
  });
});
