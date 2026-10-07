// Query-parameter parsing for the views (spec D, Views).
import { dateSchema } from "../../../shared/schemas.ts";
import type { ErrorDetail } from "../../../shared/errors.ts";
import { MIN_DATE } from "./dates.ts";

export type DateParam = { ok: true; value: string | undefined } | { ok: false; detail: ErrorDetail };

/**
 * Validates an optional `YYYY-MM-DD` query parameter. Absent gives `undefined`;
 * present (including empty) must be a real calendar date from 0001-01-01 on
 * (dateSchema allows year 0000, which Postgres cannot store).
 */
export function parseDateParam(name: string, raw: string | undefined): DateParam {
  if (raw === undefined) return { ok: true, value: undefined };
  const parsed = dateSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, detail: { path: name, message: parsed.error.issues[0]?.message ?? "Expected a real date as YYYY-MM-DD" } };
  }
  if (parsed.data < MIN_DATE) return { ok: false, detail: { path: name, message: `Expected a date on or after ${MIN_DATE}` } };
  return { ok: true, value: parsed.data };
}
