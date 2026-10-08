// Bearer agent keys and their per-key rate limit (spec E).
import { safeEqual } from "./crypto.ts";

/**
 * Returns the index in `keys` of the key that matches `candidate`, or -1.
 * Every configured key is compared (in constant time), with no early exit.
 */
export function matchAgentKey(candidate: string, keys: readonly string[]): number {
  let match = -1;
  for (let i = 0; i < keys.length; i++) {
    if (safeEqual(candidate, keys[i]) && match === -1) match = i;
  }
  return match;
}

/**
 * The bearer token of an `Authorization` header: `{ scheme: "bearer", token }` for the Bearer
 * scheme (the token may be empty), `{ scheme: "other" }` for any other scheme, null when absent.
 */
export function parseAuthorization(header: string | undefined): { scheme: "bearer"; token: string } | { scheme: "other" } | null {
  if (header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;
  const space = trimmed.indexOf(" ");
  const scheme = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  if (scheme !== "bearer") return { scheme: "other" };
  return { scheme: "bearer", token: space === -1 ? "" : trimmed.slice(space + 1).trim() };
}

const WINDOW_MS = 60_000;

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * A fixed-window limiter kept in memory: each key gets `limit` requests per wall-clock minute
 * (window = floor(now / 60000)). One limiter per app instance.
 */
export function createRateLimiter() {
  const windows = new Map<number, { window: number; count: number }>();

  return {
    hit(keyIndex: number, limit: number, now: Date): RateLimitResult {
      const t = now.getTime();
      const window = Math.floor(t / WINDOW_MS);
      let entry = windows.get(keyIndex);
      if (!entry || entry.window !== window) {
        entry = { window, count: 0 };
        windows.set(keyIndex, entry);
      }
      if (entry.count >= limit) {
        const msLeft = (window + 1) * WINDOW_MS - t;
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(msLeft / 1000)) };
      }
      entry.count += 1;
      return { ok: true };
    },
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
