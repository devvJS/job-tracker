// The stateless session cookie (spec E):
//   jt_session = base64url(JSON {login, exp}) + "." + base64url(HMAC-SHA256(sessionSecret, payload))
// exp is in seconds since the epoch.
import { createHmac } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { safeEqual } from "./crypto.ts";

export const SESSION_COOKIE = "jt_session";
export const SESSION_COOKIE_PATH = "/job-tracker";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 2592000

export type Session = { login: string; exp: number };

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Builds a signed cookie value for `login`, valid for 30 days from `now`. */
export function createSessionValue(login: string, secret: string, now: Date): string {
  const session: Session = { login, exp: Math.floor(now.getTime() / 1000) + SESSION_MAX_AGE_SECONDS };
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** Verifies a cookie value: shape, signature (constant time), payload and expiry. Returns null when invalid. */
export function verifySessionValue(value: string | undefined, secret: string, now: Date): Session | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!payload || !signature) return null;
  if (!safeEqual(signature, sign(payload, secret))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { login, exp } = parsed as Record<string, unknown>;
  if (typeof login !== "string" || login === "") return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  if (exp * 1000 <= now.getTime()) return null;
  return { login, exp };
}

const cookieOptions = {
  path: SESSION_COOKIE_PATH,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
} as const;

/** Reads and verifies the session cookie of the current request. */
export function readSession(c: Context, secret: string, now: Date): Session | null {
  return verifySessionValue(getCookie(c, SESSION_COOKIE), secret, now);
}

export function setSessionCookie(c: Context, value: string): void {
  setCookie(c, SESSION_COOKIE, value, { ...cookieOptions, maxAge: SESSION_MAX_AGE_SECONDS });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, cookieOptions);
}
