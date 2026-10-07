// Auth routes (spec E), mounted at /job-tracker/api/auth:
//   GET  /login     302 to GitHub authorize, sets jt_oauth_state
//   GET  /callback  state check, code exchange, allowed-login check, session cookie
//   POST /logout    clears the session, 204
//   GET  /me        who authenticated (runs behind the auth middleware)
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { type AppEnv, jsonError } from "../context.ts";
import { safeEqual } from "./crypto.ts";
import { UpstreamError, authorizeUrl, exchangeCodeForLogin } from "./github.ts";
import { AUTH_PATH, HOME_PATH, OAUTH_CALLBACK_PATH } from "./paths.ts";
import { clearSessionCookie, createSessionValue, setSessionCookie } from "./session.ts";

export const STATE_COOKIE = "jt_oauth_state";
const STATE_MAX_AGE_SECONDS = 600;

const stateCookieOptions = {
  path: AUTH_PATH,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
} as const;

const authRoutes = new Hono<AppEnv>();

authRoutes.get("/login", (c) => {
  const { config } = c.get("deps");
  const state = randomBytes(32).toString("base64url");
  setCookie(c, STATE_COOKIE, state, { ...stateCookieOptions, maxAge: STATE_MAX_AGE_SECONDS });
  return c.redirect(authorizeUrl(config, `${config.publicUrl}${OAUTH_CALLBACK_PATH}`, state), 302);
});

// GitHub redirects with GET; POST is accepted too (code and state are still read from the query),
// so the state check answers instead of a 404.
authRoutes.on(["GET", "POST"], "/callback", async (c) => {
  const { config, fetch: doFetch, now } = c.get("deps");
  const state = c.req.query("state");
  const expected = getCookie(c, STATE_COOKIE);
  if (!state || !expected || !safeEqual(state, expected)) {
    return jsonError(c, 400, "Invalid OAuth state");
  }
  // The state is single use: clear it whatever happens next.
  deleteCookie(c, STATE_COOKIE, stateCookieOptions);

  const code = c.req.query("code");
  if (!code) return jsonError(c, 400, "Missing OAuth code");

  let login: string;
  try {
    login = await exchangeCodeForLogin(config, doFetch, code, `${config.publicUrl}${OAUTH_CALLBACK_PATH}`);
  } catch (err) {
    if (err instanceof UpstreamError) {
      console.warn(`GitHub OAuth failed: ${err.reason}`);
      return jsonError(c, 502, "GitHub sign-in failed", { code: "upstream_error" });
    }
    throw err;
  }

  if (login.toLowerCase() !== config.allowedLogin.toLowerCase()) {
    return jsonError(c, 403, "This GitHub account is not allowed");
  }

  setSessionCookie(c, createSessionValue(login, config.sessionSecret, now()));
  return c.redirect(HOME_PATH, 302);
});

authRoutes.post("/logout", (c) => {
  clearSessionCookie(c);
  return c.body(null, 204);
});

authRoutes.get("/me", (c) => c.json({ login: c.get("login"), via: c.get("authVia") }));

export default authRoutes;
