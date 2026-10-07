// Request parsing for the applications API (spec D): JSON object bodies, Zod
// issue mapping, If-Match instants and the GET /applications query.
import type { z } from "zod";
import type { ErrorDetail } from "../../../shared/errors.ts";
import { STATUSES, TRACKS, WORK_ARRANGEMENTS, dateSchema, dateTimeSchema } from "../../../shared/schemas.ts";
import type { Status, Track, WorkArrangement } from "../../../shared/schemas.ts";

export type BodyResult = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

/** Parses a request body that must be a JSON object (not an array, null or a scalar). */
export function parseObjectBody(text: string): BodyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: "Request body must be valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: "Request body must be a JSON object" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** Zod issues as envelope details: `[{ path: "fit.total", message }]`. */
export function issueDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)).join("."),
    message: issue.message,
  }));
}

/**
 * The instant an If-Match header names. The header carries updated_at as the
 * API returned it; ETag-style quotes and a weak prefix are tolerated. A value
 * that is not an ISO 8601 datetime can never match, so it gives null.
 */
export function ifMatchInstant(header: string): Date | null {
  const value = header.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
  if (!dateTimeSchema.safeParse(value).success) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** GET /applications filters, validated (spec D). Absent filters are undefined. */
export type ListQuery = {
  status?: Status[];
  track?: Track;
  work_arrangement?: WorkArrangement;
  detroit_metro?: boolean;
  meets_floor?: boolean;
  min_fit?: number;
  due_before?: string;
  q?: string;
  updated_since?: Date;
};

export type ListQueryResult = { ok: true; value: ListQuery } | { ok: false; details: ErrorDetail[] };

const INTEGER_RE = /^-?\d+$/;

function parseBoolean(value: string): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

/**
 * Validates the list query. Every invalid parameter is reported, by name.
 * Unknown parameters are ignored. An empty value means "no filter" for q only.
 */
export function parseListQuery(params: Record<string, string | undefined>): ListQueryResult {
  const details: ErrorDetail[] = [];
  const value: ListQuery = {};
  const bad = (path: string, message: string) => details.push({ path, message });

  if (params.status !== undefined) {
    const parts = params.status.split(",").map((s) => s.trim());
    const unknown = parts.filter((s) => !isOneOf(STATUSES, s));
    if (unknown.length > 0) bad("status", `Unknown status: ${unknown.map((s) => JSON.stringify(s)).join(", ")}`);
    else value.status = parts as Status[];
  }

  if (params.track !== undefined) {
    if (isOneOf(TRACKS, params.track)) value.track = params.track;
    else bad("track", `Expected one of ${TRACKS.join(", ")}`);
  }

  if (params.work_arrangement !== undefined) {
    if (isOneOf(WORK_ARRANGEMENTS, params.work_arrangement)) value.work_arrangement = params.work_arrangement;
    else bad("work_arrangement", `Expected one of ${WORK_ARRANGEMENTS.join(", ")}`);
  }

  for (const key of ["detroit_metro", "meets_floor"] as const) {
    const raw = params[key];
    if (raw === undefined) continue;
    const parsed = parseBoolean(raw);
    if (parsed === undefined) bad(key, "Expected true or false");
    else value[key] = parsed;
  }

  if (params.min_fit !== undefined) {
    if (INTEGER_RE.test(params.min_fit)) value.min_fit = Number(params.min_fit);
    else bad("min_fit", "Expected an integer");
  }

  if (params.due_before !== undefined) {
    if (dateSchema.safeParse(params.due_before).success) value.due_before = params.due_before;
    else bad("due_before", "Expected a real date as YYYY-MM-DD");
  }

  if (params.updated_since !== undefined) {
    if (dateTimeSchema.safeParse(params.updated_since).success) value.updated_since = new Date(params.updated_since);
    else bad("updated_since", "Expected an ISO 8601 datetime");
  }

  if (params.q !== undefined && params.q.trim() !== "") value.q = params.q.trim();

  return details.length > 0 ? { ok: false, details } : { ok: true, value };
}
