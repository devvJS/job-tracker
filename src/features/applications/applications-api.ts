// API calls and form-value conversion for the applications pages.
import type { ApplicationRecord, EventRecord } from "../../../shared/schemas.ts";
import { ApiError, api } from "../../lib/api.ts";

export type ListResponse = { items: ApplicationRecord[]; count: number };
export type EventResponse = { event: EventRecord; record: ApplicationRecord };

/** Board filters as the UI holds them. Empty strings and false mean "no filter". */
export type BoardFilters = {
  q: string;
  work_arrangement: string;
  track: string;
  detroit_metro: boolean;
  meets_floor: boolean;
  min_fit_80: boolean;
};

export const NO_FILTERS: BoardFilters = {
  q: "",
  work_arrangement: "",
  track: "",
  detroit_metro: false,
  meets_floor: false,
  min_fit_80: false,
};

/** The GET /applications query string for the board filters. */
export function filterQuery(f: BoardFilters): string {
  const qs = new URLSearchParams();
  if (f.q.trim() !== "") qs.set("q", f.q.trim());
  if (f.work_arrangement !== "") qs.set("work_arrangement", f.work_arrangement);
  if (f.track !== "") qs.set("track", f.track);
  if (f.detroit_metro) qs.set("detroit_metro", "true");
  if (f.meets_floor) qs.set("meets_floor", "true");
  if (f.min_fit_80) qs.set("min_fit", "80");
  const s = qs.toString();
  return s === "" ? "" : `?${s}`;
}

/** GET /applications with a query string from filterQuery ("" or "?..."). */
export function listApplications(query: string): Promise<ListResponse> {
  return api<ListResponse>(`/applications${query}`);
}

export function getApplication(id: string): Promise<ApplicationRecord> {
  return api<ApplicationRecord>(`/applications/${encodeURIComponent(id)}`);
}

export function createApplication(body: Record<string, unknown>): Promise<ApplicationRecord> {
  return api<ApplicationRecord>("/applications", { method: "POST", body });
}

/** PATCH with If-Match = the updated_at of the record the edit started from. */
export function patchApplication(record: ApplicationRecord, body: Record<string, unknown>): Promise<ApplicationRecord> {
  return api<ApplicationRecord>(`/applications/${encodeURIComponent(record.id)}`, {
    method: "PATCH",
    body,
    headers: { "If-Match": record.updated_at },
  });
}

export function postEvent(id: string, body: Record<string, unknown>): Promise<EventResponse> {
  return api<EventResponse>(`/applications/${encodeURIComponent(id)}/events`, { method: "POST", body });
}

export function deleteApplication(id: string): Promise<void> {
  const enc = encodeURIComponent(id);
  return api<void>(`/applications/${enc}?confirm=${enc}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type Detail = { path: string; message: string };

/** Validation details from a 400 envelope, if any. */
export function detailsOf(error: unknown): Detail[] {
  if (!(error instanceof ApiError) || error.status !== 400) return [];
  const details = (error.body as { error?: { details?: unknown } } | undefined)?.error?.details;
  if (!Array.isArray(details)) return [];
  return details.filter(
    (d): d is Detail => typeof d === "object" && d !== null && typeof d.path === "string" && typeof d.message === "string",
  );
}

/** The record a 409 or 412 body carries, if any. */
export function recordOf(error: unknown): ApplicationRecord | null {
  if (!(error instanceof ApiError)) return null;
  const record = (error.body as { record?: unknown } | undefined)?.record;
  return typeof record === "object" && record !== null && typeof (record as { id?: unknown }).id === "string"
    ? (record as ApplicationRecord)
    : null;
}

// ---------------------------------------------------------------------------
// The create / edit form
// ---------------------------------------------------------------------------

export const FORM_FIELDS = [
  "company",
  "role_title",
  "work_arrangement",
  "status",
  "posting_url",
  "location",
  "comp_min",
  "comp_max",
  "track",
  "source",
  "priority",
  "next_action",
  "next_action_due",
  "follow_up_date",
  "notes",
] as const;

export type FormField = (typeof FORM_FIELDS)[number];
export type FormValues = Record<FormField, string>;

const INTEGER_FIELDS = new Set<FormField>(["comp_min", "comp_max"]);

export const EMPTY_FORM: FormValues = {
  company: "",
  role_title: "",
  work_arrangement: "remote",
  status: "watching",
  posting_url: "",
  location: "",
  comp_min: "",
  comp_max: "",
  track: "",
  source: "",
  priority: "",
  next_action: "",
  next_action_due: "",
  follow_up_date: "",
  notes: "",
};

/** The form's values for a record (null or missing fields become ""). */
export function formValuesOf(record: ApplicationRecord): FormValues {
  const values = { ...EMPTY_FORM };
  for (const field of FORM_FIELDS) {
    const v = record[field];
    values[field] = v === null || v === undefined ? "" : String(v);
  }
  return values;
}

/**
 * A form value as the API expects it: trimmed, "" as null, comp as an integer.
 * A comp value that is not a whole number is sent as typed, so the server's
 * validation names the field.
 */
function apiValue(field: FormField, raw: string): unknown {
  const v = raw.trim();
  if (v === "") return null;
  if (INTEGER_FIELDS.has(field)) return /^-?\d+$/.test(v) ? Number(v) : v;
  return v;
}

/** POST body: every non-empty field. */
export function createBody(values: FormValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of FORM_FIELDS) {
    const v = apiValue(field, values[field]);
    if (v !== null) body[field] = v;
  }
  return body;
}

/** PATCH body: only the fields that differ from the record (a cleared field is sent as null). */
export function patchBody(values: FormValues, initial: FormValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of FORM_FIELDS) {
    if (values[field].trim() !== initial[field].trim()) body[field] = apiValue(field, values[field]);
  }
  return body;
}
