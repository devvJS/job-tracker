// Enum values and Zod schemas shared by the server and the UI.
// Enums are validated here, not by database constraints (spec C).
import { z } from "zod";

// ---------------------------------------------------------------------------
// Enum value arrays (source-spec sections 3, 4 and 5)
// ---------------------------------------------------------------------------

/** Pipeline order, then the terminal statuses. */
export const STATUSES = [
  "watching",
  "shortlisted",
  "preparing",
  "applied",
  "screen",
  "interviewing",
  "offer",
  "accepted",
  "rejected",
  "withdrawn",
  "closed",
] as const;
export const TERMINAL_STATUSES = ["rejected", "withdrawn", "closed"] as const;
export const WORK_ARRANGEMENTS = ["remote", "hybrid", "onsite"] as const;
export const POSTING_STATUSES = ["live", "removed", "unverified"] as const;
export const MOVE_TIMING = ["yes", "no", "unknown"] as const;
export const COMP_SOURCES = ["posting", "recruiter", "estimate"] as const;
export const TRACKS = ["ai-engineer", "senior-frontend", "senior-fullstack", "devex-platform", "other"] as const;
export const COMPANY_STAGES = ["startup", "scaleup", "public-product", "enterprise", "consultancy"] as const;
export const SOURCES = [
  "linkedin",
  "builtin",
  "company-site",
  "referral",
  "recruiter-inbound",
  "community",
  "other",
] as const;
export const REFERRALS = ["none", "asked", "submitted"] as const;
export const PRIORITIES = ["high", "medium", "low"] as const;
export const CLOSED_REASONS = [
  "rejected",
  "withdrew",
  "posting-removed",
  "no-response",
  "declined-offer",
  "accepted",
] as const;
/** Event types a client may post. `status-change` is created only by the server (spec A.6). */
export const CLIENT_EVENT_TYPES = [
  "discovered",
  "scored",
  "materials-drafted",
  "applied",
  "email",
  "call",
  "interview",
  "take-home",
  "offer",
  "rejected",
  "withdrew",
  "note",
] as const;
export const EVENT_TYPES = [...CLIENT_EVENT_TYPES, "status-change"] as const;
export const ACTORS = ["dakota", "claude-project", "tracker-app"] as const;
export const RELATIONSHIPS = ["recruiter", "referral", "hiring-manager", "interviewer", "peer"] as const;
/** Suggested mission_interest tags. Not an enum (spec A.8). */
export const MISSION_INTEREST_SUGGESTIONS = [
  "art",
  "mental-health",
  "education",
  "music",
  "punk-metal",
  "breweries",
  "fintech",
] as const;

export type Status = (typeof STATUSES)[number];
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export type WorkArrangement = (typeof WORK_ARRANGEMENTS)[number];
export type PostingStatus = (typeof POSTING_STATUSES)[number];
export type MoveTiming = (typeof MOVE_TIMING)[number];
export type CompSource = (typeof COMP_SOURCES)[number];
export type Track = (typeof TRACKS)[number];
export type CompanyStage = (typeof COMPANY_STAGES)[number];
export type Source = (typeof SOURCES)[number];
export type Referral = (typeof REFERRALS)[number];
export type Priority = (typeof PRIORITIES)[number];
export type ClosedReason = (typeof CLOSED_REASONS)[number];
export type EventType = (typeof EVENT_TYPES)[number];
export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];
export type ActorName = (typeof ACTORS)[number];
export type Relationship = (typeof RELATIONSHIPS)[number];

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a `YYYY-MM-DD` string that names a real calendar date. */
export function isCalendarDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth;
}

/** True for an absolute http(s) URL. */
export function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
}

export const dateSchema = z.string().refine(isCalendarDate, { message: "Expected a real date as YYYY-MM-DD" });
/** True when the instant's UTC year is 1000-9999: earlier years read back as BC timestamps that Drizzle can't parse. */
function inSupportedYearRange(value: string): boolean {
  const year = new Date(value).getUTCFullYear();
  return year >= 1000 && year <= 9999;
}
export const dateTimeSchema = z.iso
  .datetime({ offset: true, abort: true, message: "Expected an ISO 8601 datetime" })
  .refine(inSupportedYearRange, { message: "Datetime year must be from 1000 to 9999 (UTC)" });
export const urlSchema = z.string().refine(isHttpUrl, { message: "Expected an absolute http(s) URL" });
const nonBlank = z.string().refine((s) => s.trim().length > 0, { message: "Must not be blank" });
const score = z.int().min(0).max(100);

// ---------------------------------------------------------------------------
// Nested objects (loose: unknown keys are preserved)
// ---------------------------------------------------------------------------

export const fitSchema = z.looseObject({
  skills: score.optional(),
  experience: score.optional(),
  industry: score.optional(),
  growth: score.optional(),
  total: score.optional(),
  weights: z.record(z.string(), z.number()).optional(),
  biggest_risk: z.string().optional(),
  gaps: z.array(z.string()).optional(),
  scored_at: dateSchema.optional(),
});

export const materialsSchema = z.looseObject({
  resume: z.string().optional(),
  cover_letter: z.string().optional(),
  answers: z.string().optional(),
  portfolio_links: z.array(z.string()).optional(),
  email_used: z.string().optional(),
  checklist: z.array(z.looseObject({ item: z.string(), done: z.boolean() })).optional(),
});

export type Fit = z.infer<typeof fitSchema>;
export type Materials = z.infer<typeof materialsSchema>;

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

/** Writable optional application fields. On create and patch, `null` means "no value". */
const applicationOptionalFields = {
  posting_url: urlSchema.nullable().optional(),
  job_id: z.string().nullable().optional(),
  posting_status: z.enum(POSTING_STATUSES).nullable().optional(),
  posting_verified_at: dateSchema.nullable().optional(),
  jd_snapshot_path: z.string().nullable().optional(),
  jd_snapshot: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  detroit_metro: z.boolean().nullable().optional(),
  onsite_requirement: z.string().nullable().optional(),
  remote_scope: z.string().nullable().optional(),
  move_timing_ok: z.enum(MOVE_TIMING).nullable().optional(),
  // Bounded to the Postgres integer (int4) column range, so an oversized value is a 400, not a 500.
  comp_min: z.int().min(-2147483648).max(2147483647).nullable().optional(),
  comp_max: z.int().min(-2147483648).max(2147483647).nullable().optional(),
  comp_source: z.enum(COMP_SOURCES).nullable().optional(),
  equity_bonus_notes: z.string().nullable().optional(),
  track: z.enum(TRACKS).nullable().optional(),
  company_archetype: z.string().nullable().optional(),
  company_stage: z.enum(COMPANY_STAGES).nullable().optional(),
  industry: z.string().nullable().optional(),
  mission_interest: z.array(z.string()).nullable().optional(),
  fit: fitSchema.nullable().optional(),
  source: z.enum(SOURCES).nullable().optional(),
  source_detail: z.string().nullable().optional(),
  connection: z.string().nullable().optional(),
  referral: z.enum(REFERRALS).nullable().optional(),
  contact_ids: z.array(nonBlank).nullable().optional(),
  priority: z.enum(PRIORITIES).nullable().optional(),
  next_action: z.string().nullable().optional(),
  next_action_due: dateSchema.nullable().optional(),
  follow_up_date: dateSchema.nullable().optional(),
  applied_at: dateSchema.nullable().optional(),
  closed_at: dateSchema.nullable().optional(),
  closed_reason: z.enum(CLOSED_REASONS).nullable().optional(),
  materials: materialsSchema.nullable().optional(),
  notes: z.string().nullable().optional(),
  project_thread_url: urlSchema.nullable().optional(),
};

/**
 * POST /applications body. Unknown keys are stripped from the parsed output;
 * the server keeps them through `splitApplicationInput` (they go to `extra`).
 * `discovered_at` is optional and defaults to today on the server.
 */
export const applicationCreateSchema = z.object({
  company: nonBlank,
  role_title: nonBlank,
  work_arrangement: z.enum(WORK_ARRANGEMENTS),
  status: z.enum(STATUSES),
  discovered_at: dateSchema.optional(),
  ...applicationOptionalFields,
});

/** PATCH /applications/:id body. Every field optional; required fields cannot be nulled. */
export const applicationPatchSchema = z.object({
  company: nonBlank.optional(),
  role_title: nonBlank.optional(),
  work_arrangement: z.enum(WORK_ARRANGEMENTS).optional(),
  status: z.enum(STATUSES).optional(),
  discovered_at: dateSchema.optional(),
  ...applicationOptionalFields,
});

export type ApplicationCreateInput = z.infer<typeof applicationCreateSchema>;
export type ApplicationPatchInput = z.infer<typeof applicationPatchSchema>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** POST /applications/:id/events body. */
export const eventCreateSchema = z.object({
  type: z.enum(CLIENT_EVENT_TYPES),
  note: z.string().nullable().optional(),
  at: dateTimeSchema.optional(),
  status: z.enum(STATUSES).optional(),
  next_action: z.string().nullable().optional(),
  next_action_due: dateSchema.nullable().optional(),
});

export type EventCreateInput = z.infer<typeof eventCreateSchema>;

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

const contactOptionalFields = {
  company: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  relationship: z.enum(RELATIONSHIPS).nullable().optional(),
  linkedin_url: urlSchema.nullable().optional(),
  email: z.string().nullable().optional(),
  last_contact_at: dateSchema.nullable().optional(),
  notes: z.string().nullable().optional(),
};

export const contactCreateSchema = z.object({
  name: nonBlank,
  ...contactOptionalFields,
});

export const contactPatchSchema = z.object({
  name: nonBlank.optional(),
  ...contactOptionalFields,
});

export type ContactCreateInput = z.infer<typeof contactCreateSchema>;
export type ContactPatchInput = z.infer<typeof contactPatchSchema>;

// ---------------------------------------------------------------------------
// Records as the API returns them
// ---------------------------------------------------------------------------

/** Dates are `YYYY-MM-DD`; datetimes are ISO 8601 UTC with milliseconds and `Z`. */
export type EventRecord = {
  id: string;
  application_id: string;
  at: string;
  type: EventType;
  note: string | null;
  by: ActorName;
  from_status: Status | null;
  to_status: Status | null;
};

export type ContactRecord = {
  id: string;
  name: string;
  company: string | null;
  role: string | null;
  relationship: Relationship | null;
  linkedin_url: string | null;
  email: string | null;
  last_contact_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  updated_by: ActorName;
  application_ids?: string[];
  /** Unknown keys stored in `extra`, flattened onto the record. */
  [extra: string]: unknown;
};

export type ApplicationRecord = {
  id: string;
  company: string;
  role_title: string;
  posting_url: string | null;
  job_id: string | null;
  posting_status: PostingStatus | null;
  posting_verified_at: string | null;
  jd_snapshot_path: string | null;
  work_arrangement: WorkArrangement;
  location: string | null;
  detroit_metro: boolean | null;
  onsite_requirement: string | null;
  remote_scope: string | null;
  move_timing_ok: MoveTiming | null;
  comp_min: number | null;
  comp_max: number | null;
  comp_source: CompSource | null;
  meets_floor: boolean | null;
  equity_bonus_notes: string | null;
  track: Track | null;
  company_archetype: string | null;
  company_stage: CompanyStage | null;
  industry: string | null;
  mission_interest: string[] | null;
  fit: Fit | null;
  source: Source | null;
  source_detail: string | null;
  connection: string | null;
  referral: Referral | null;
  status: Status;
  priority: Priority | null;
  next_action: string | null;
  next_action_due: string | null;
  follow_up_date: string | null;
  discovered_at: string;
  applied_at: string | null;
  closed_at: string | null;
  closed_reason: ClosedReason | null;
  materials: Materials | null;
  notes: string | null;
  project_thread_url: string | null;
  created_at: string;
  updated_at: string;
  updated_by: ActorName;
  jd_snapshot: string | null;
  /** Present on full records (GET :id, writes, 409/412 bodies, export). */
  contact_ids?: string[];
  events?: EventRecord[];
  contacts?: ContactRecord[];
  /** Unknown keys stored in `extra`, flattened onto the record. */
  [extra: string]: unknown;
};
