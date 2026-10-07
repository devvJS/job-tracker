// Server configuration from environment variables (spec B and G).

export type Config = {
  port: number;
  publicUrl: string;
  databaseUrl: string;
  sessionSecret: string;
  agentKeys: string[];
  github: { clientId: string; clientSecret: string; oauthUrl: string; apiUrl: string };
  allowedLogin: string;
  staticDir: string;
  agentRateLimitPerMinute: number;
  timezone: string;
};

type Env = Record<string, string | undefined>;

const MIN_SECRET_LENGTH = 32;

/**
 * Reads and validates the configuration. Throws one Error naming every missing
 * or invalid variable (never their values). An empty string counts as unset.
 */
export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];
  const get = (name: string): string | undefined => {
    const v = env[name];
    return v === undefined || v === "" ? undefined : v;
  };
  const required = (name: string): string => {
    const v = get(name);
    if (v === undefined) problems.push(`${name} is required`);
    return v ?? "";
  };
  const secret = (name: string, value: string | undefined): void => {
    if (value !== undefined && value.length < MIN_SECRET_LENGTH) {
      problems.push(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
    }
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const v = get(name);
    if (v === undefined) return fallback;
    const n = /^\d+$/.test(v.trim()) ? Number(v.trim()) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      problems.push(`${name} must be an integer from ${min} to ${max}`);
      return fallback;
    }
    return n;
  };
  const httpUrl = (name: string, value: string | undefined): string => {
    if (value === undefined) return "";
    const trimmed = value.replace(/\/+$/, "");
    if (!URL.canParse(trimmed) || !/^https?:$/.test(new URL(trimmed).protocol)) {
      problems.push(`${name} must be an absolute http(s) URL`);
    }
    return trimmed;
  };

  const port = integer("PORT", 3000, 1, 65535);
  const publicUrl = httpUrl("PUBLIC_URL", required("PUBLIC_URL") || undefined);
  const databaseUrl = required("DATABASE_URL");

  const sessionSecret = required("SESSION_SECRET");
  secret("SESSION_SECRET", get("SESSION_SECRET"));

  const agentKey = required("TRACKER_AGENT_KEY");
  secret("TRACKER_AGENT_KEY", get("TRACKER_AGENT_KEY"));
  const nextKey = get("TRACKER_AGENT_KEY_NEXT");
  secret("TRACKER_AGENT_KEY_NEXT", nextKey);
  const agentKeys = [agentKey, nextKey].filter((k): k is string => k !== undefined && k !== "");

  const clientId = required("GITHUB_CLIENT_ID");
  const clientSecret = required("GITHUB_CLIENT_SECRET");
  const oauthUrl = httpUrl("GITHUB_OAUTH_URL", get("GITHUB_OAUTH_URL") ?? "https://github.com");
  const apiUrl = httpUrl("GITHUB_API_URL", get("GITHUB_API_URL") ?? "https://api.github.com");

  const timezone = get("TRACKER_TIMEZONE") ?? "America/Detroit";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    problems.push("TRACKER_TIMEZONE must be an IANA time zone");
  }

  const agentRateLimitPerMinute = integer("AGENT_RATE_LIMIT_PER_MINUTE", 60, 1, 1_000_000);

  if (problems.length > 0) {
    throw new Error(`Invalid configuration: ${problems.join("; ")}`);
  }

  return {
    port,
    publicUrl,
    databaseUrl,
    sessionSecret,
    agentKeys,
    github: { clientId, clientSecret, oauthUrl, apiUrl },
    allowedLogin: get("ALLOWED_GITHUB_LOGIN") ?? "devvJS",
    staticDir: get("STATIC_DIR") ?? "dist",
    agentRateLimitPerMinute,
    timezone,
  };
}
