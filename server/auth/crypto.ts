// Constant-time comparisons for secrets (agent keys, signatures, OAuth state).
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compares two strings in constant time with respect to their content. Both
 * sides are hashed first, so differing lengths neither throw nor leak through
 * an early exit.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}
