// The API auth middleware and the HTML page gate (spec E).
import type { MiddlewareHandler } from "hono";
import { type AppEnv, jsonError } from "../context.ts";
import { type RateLimiter, matchAgentKey, parseAuthorization } from "./agent.ts";
import {
  BASE_PATH,
  HEALTHZ_PATH,
  HOME_PATH,
  LOGIN_PAGE_PATH,
  PUBLIC_API_PATHS,
  isApiPath,
  looksLikeFile,
} from "./paths.ts";
import { readSession } from "./session.ts";

/**
 * Authenticates every /api request except the public auth routes. A valid bearer key wins; any
 * other Bearer value is 401 even with a valid session. Otherwise a valid session cookie is needed.
 * Agent requests count toward the per-key rate limit; session requests do not.
 */
export function apiAuth(limiter: RateLimiter): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const path = c.req.path;
    if (!isApiPath(path) || PUBLIC_API_PATHS.has(path)) return next();

    const { config, now } = c.get("deps");
    const unauthorized = () => {
      c.header("WWW-Authenticate", "Bearer");
      return jsonError(c, 401, "Authentication required");
    };

    const auth = parseAuthorization(c.req.header("authorization"));
    if (auth?.scheme === "bearer") {
      const keyIndex = matchAgentKey(auth.token, config.agentKeys);
      if (keyIndex === -1) return unauthorized();
      const limit = limiter.hit(keyIndex, config.agentRateLimitPerMinute, now());
      if (!limit.ok) {
        c.header("Retry-After", String(limit.retryAfterSeconds));
        return jsonError(c, 429, "Rate limit exceeded");
      }
      c.set("actor", "claude-project");
      c.set("authVia", "agent");
      c.set("login", "claude-project");
      return next();
    }

    const session = readSession(c, config.sessionSecret, now());
    if (!session) return unauthorized();
    c.set("actor", "dakota");
    c.set("authVia", "session");
    c.set("login", session.login);
    return next();
  };
}

/** GET (and HEAD) page requests the gate covers: under /job-tracker/, not /api, not /healthz, not a file. */
function isGatedPage(method: string, path: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (!path.startsWith(`${BASE_PATH}/`)) return false;
  if (isApiPath(path) || path === HEALTHZ_PATH) return false;
  return !looksLikeFile(path);
}

/**
 * HTML gating: pages need a valid session (the agent key does not open them), otherwise 302 to
 * the login page. The login page itself is public, and 302s to the app when already signed in.
 */
export function htmlGate(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const path = c.req.path;
    if (!isGatedPage(c.req.method, path)) return next();

    const { config, now } = c.get("deps");
    const signedIn = readSession(c, config.sessionSecret, now()) !== null;
    if (path === LOGIN_PAGE_PATH) return signedIn ? c.redirect(HOME_PATH, 302) : next();
    return signedIn ? next() : c.redirect(LOGIN_PAGE_PATH, 302);
  };
}
