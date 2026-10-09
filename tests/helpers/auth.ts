// Auth helpers for API tests: Set-Cookie parsing, a real sign-in through /api/auth/login and
// /api/auth/callback against the fake GitHub, and agent-key headers.
import { expect } from "vitest";
import { TEST_AGENT_KEY } from "./config.ts";

type AnyApp = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

export const BASE = "/job-tracker";
export const SESSION_COOKIE = "jt_session";
export const STATE_COOKIE = "jt_oauth_state";

export type ParsedCookie = {
  name: string;
  value: string;
  /** Attribute names lowercased. Flags (HttpOnly, Secure) are `true`. */
  attrs: Record<string, string | true>;
};

export function parseSetCookie(header: string): ParsedCookie {
  const [pair, ...rest] = header.split(";").map((s) => s.trim());
  const eq = pair.indexOf("=");
  const attrs: Record<string, string | true> = {};
  for (const a of rest) {
    const i = a.indexOf("=");
    if (i === -1) attrs[a.toLowerCase()] = true;
    else attrs[a.slice(0, i).toLowerCase()] = a.slice(i + 1);
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attrs };
}

/** All Set-Cookie headers of a response, parsed. */
export function setCookies(res: Response): ParsedCookie[] {
  return res.headers.getSetCookie().map(parseSetCookie);
}

export function findSetCookie(res: Response, name: string): ParsedCookie | undefined {
  return setCookies(res).find((c) => c.name === name);
}

/** True when the cookie is being deleted: empty value and Max-Age=0 or an Expires in the past. */
export function isCleared(c: ParsedCookie | undefined): boolean {
  if (!c || c.value !== "") return false;
  if (c.attrs["max-age"] === "0") return true;
  const exp = c.attrs["expires"];
  return typeof exp === "string" && new Date(exp).getTime() < Date.now();
}

export const cookieHeader = (name: string, value: string) => ({ Cookie: `${name}=${value}` });

/** Authorization header for the agent key (defaults to the test key). */
export const agentHeaders = (key: string = TEST_AGENT_KEY): Record<string, string> => ({
  Authorization: `Bearer ${key}`,
});

export type StartedLogin = { state: string; location: URL; response: Response; stateCookie: ParsedCookie };

/** Runs the real GET /api/auth/login and returns the state it issued. */
export async function startLogin(app: AnyApp): Promise<StartedLogin> {
  const response = await app.request(`${BASE}/api/auth/login`, { redirect: "manual" });
  const location = new URL(response.headers.get("location") ?? "http://missing.invalid/");
  const stateCookie = findSetCookie(response, STATE_COOKIE) ?? { name: "", value: "", attrs: {} };
  return { state: location.searchParams.get("state") ?? "", location, response, stateCookie };
}

/** GET /api/auth/callback with the given code, state param and (optional) state cookie value. */
export function callback(app: AnyApp, p: { code?: string; state?: string; stateCookie?: string | null }) {
  const qs = new URLSearchParams();
  if (p.code !== undefined) qs.set("code", p.code);
  if (p.state !== undefined) qs.set("state", p.state);
  return app.request(`${BASE}/api/auth/callback?${qs}`, {
    redirect: "manual",
    headers: p.stateCookie == null ? {} : cookieHeader(STATE_COOKIE, p.stateCookie),
  });
}

export type SignedIn = { cookie: string; headers: Record<string, string>; value: string; response: Response };

/**
 * Obtains a real session: runs /api/auth/login, then /api/auth/callback with the issued state.
 * The app must have been built with the fake GitHub's `fetch`. Fails (assertion) if no session cookie results.
 */
export async function signIn(app: AnyApp, code = "test-code"): Promise<SignedIn> {
  const started = await startLogin(app);
  const response = await callback(app, { code, state: started.state, stateCookie: started.stateCookie.value });
  expect(response.status, "signIn: the callback should redirect after a successful login").toBe(302);
  const c = findSetCookie(response, SESSION_COOKIE);
  expect(c, `signIn: the callback should set ${SESSION_COOKIE}`).toBeDefined();
  if (!c) throw new Error("unreachable");
  return {
    cookie: `${SESSION_COOKIE}=${c.value}`,
    headers: { Cookie: `${SESSION_COOKIE}=${c.value}` },
    value: c.value,
    response,
  };
}

/** A mutable clock for tests that move time. */
export function createClock(start: Date) {
  const clock = { current: start, now: (): Date => clock.current, set: (d: Date) => void (clock.current = d) };
  return clock;
}

