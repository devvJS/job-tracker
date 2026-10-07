// Pure helpers shared by every slice: ids, dates, input splitting and the
// canonical record shapes the API returns (spec A, B and D).
import type { ApplicationRow, ContactRow, EventRow } from "../db/schema.ts";
import type { ApplicationRecord, ContactRecord, EventRecord } from "../shared/schemas.ts";

/** NFKD, strip combining marks, lowercase, every run of [^a-z0-9] becomes "-", trim "-". */
export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `<company-slug>--<role-slug>--<discovered_at>`. Throws if either slug is empty. */
export function applicationId(company: string, roleTitle: string, discoveredAt: string): string {
  const c = slugify(company);
  const r = slugify(roleTitle);
  if (c === "") throw new Error("company has no letters or digits to build an id from");
  if (r === "") throw new Error("role_title has no letters or digits to build an id from");
  return `${c}--${r}--${discoveredAt}`;
}

/** `<name-slug>--<company-slug>`, or `<name-slug>` without a company. Throws if the name slug is empty. */
export function contactId(name: string, company?: string | null): string {
  const n = slugify(name);
  if (n === "") throw new Error("name has no letters or digits to build an id from");
  const c = company ? slugify(company) : "";
  return c === "" ? n : `${n}--${c}`;
}

/** `top >= floor` where `top = compMax ?? compMin`; null when both are null (spec A.2). */
export function computeMeetsFloor(compMin: number | null, compMax: number | null, floor: number): boolean | null {
  const top = compMax ?? compMin;
  return top === null ? null : top >= floor;
}

/** The calendar date ("YYYY-MM-DD") of `now` in `timezone`. */
export function todayIn(timezone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}`;
}

/** ISO 8601 UTC with milliseconds and "Z", e.g. "2026-10-07T14:03:22.123Z". */
export function formatDateTime(d: Date): string {
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Input splitting
// ---------------------------------------------------------------------------

/** Application fields a client may write (everything else is server-managed or extra). */
export const APPLICATION_WRITABLE_FIELDS = [
  "company",
  "role_title",
  "posting_url",
  "job_id",
  "posting_status",
  "posting_verified_at",
  "jd_snapshot_path",
  "jd_snapshot",
  "work_arrangement",
  "location",
  "detroit_metro",
  "onsite_requirement",
  "remote_scope",
  "move_timing_ok",
  "comp_min",
  "comp_max",
  "comp_source",
  "equity_bonus_notes",
  "track",
  "company_archetype",
  "company_stage",
  "industry",
  "mission_interest",
  "fit",
  "source",
  "source_detail",
  "connection",
  "referral",
  "contact_ids",
  "status",
  "priority",
  "next_action",
  "next_action_due",
  "follow_up_date",
  "discovered_at",
  "applied_at",
  "closed_at",
  "closed_reason",
  "materials",
  "notes",
  "project_thread_url",
] as const;

/** Keys ignored on input for applications and contacts (spec D). */
export const SERVER_MANAGED_KEYS = [
  "id",
  "created_at",
  "updated_at",
  "updated_by",
  "events",
  "contacts",
  "application_ids",
  "meets_floor",
  "extra",
] as const;

const writable = new Set<string>(APPLICATION_WRITABLE_FIELDS);
const serverManaged = new Set<string>(SERVER_MANAGED_KEYS);

/** Splits a request body into recognized writable fields and unknown keys (destined for `extra`). */
export function splitApplicationInput(input: Record<string, unknown>): {
  known: Record<string, unknown>;
  extra: Record<string, unknown>;
} {
  const known: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (serverManaged.has(key)) continue;
    if (writable.has(key)) known[key] = value;
    else extra[key] = value;
  }
  return { known, extra };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Adds `extra`'s keys to `record`, skipping any key the record already has or reserves. */
function flattenExtra(
  record: Record<string, unknown>,
  extra: Record<string, unknown> | null | undefined,
  reserved: ReadonlySet<string>,
): void {
  if (!extra) return;
  for (const [key, value] of Object.entries(extra)) {
    if (key in record || reserved.has(key)) continue;
    record[key] = value;
  }
}

const APPLICATION_RESERVED = new Set<string>(["extra", "contact_ids", "events", "contacts"]);
const CONTACT_RESERVED = new Set<string>(["extra", "application_ids"]);

export function toEventRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    application_id: row.application_id,
    at: formatDateTime(row.at),
    type: row.type as EventRecord["type"],
    note: row.note,
    by: row.by as EventRecord["by"],
    from_status: row.from_status as EventRecord["from_status"],
    to_status: row.to_status as EventRecord["to_status"],
  };
}

export function toContactRecord(row: ContactRow, opts: { applicationIds?: string[] } = {}): ContactRecord {
  const record: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    company: row.company,
    role: row.role,
    relationship: row.relationship,
    linkedin_url: row.linkedin_url,
    email: row.email,
    last_contact_at: row.last_contact_at,
    notes: row.notes,
    created_at: formatDateTime(row.created_at),
    updated_at: formatDateTime(row.updated_at),
    updated_by: row.updated_by,
  };
  flattenExtra(record, row.extra, CONTACT_RESERVED);
  if (opts.applicationIds !== undefined) record.application_ids = opts.applicationIds;
  return record as ContactRecord;
}

/**
 * The API shape of an application row: canonical field order (section 3, then
 * jd_snapshot), extra keys flattened (a known field always wins), then
 * contact_ids, events and contacts when they are passed.
 */
export function toApplicationRecord(
  row: ApplicationRow,
  opts: { events?: EventRow[]; contactIds?: string[]; contacts?: ContactRow[] } = {},
): ApplicationRecord {
  const record: Record<string, unknown> = {
    id: row.id,
    company: row.company,
    role_title: row.role_title,
    posting_url: row.posting_url,
    job_id: row.job_id,
    posting_status: row.posting_status,
    posting_verified_at: row.posting_verified_at,
    jd_snapshot_path: row.jd_snapshot_path,
    work_arrangement: row.work_arrangement,
    location: row.location,
    detroit_metro: row.detroit_metro,
    onsite_requirement: row.onsite_requirement,
    remote_scope: row.remote_scope,
    move_timing_ok: row.move_timing_ok,
    comp_min: row.comp_min,
    comp_max: row.comp_max,
    comp_source: row.comp_source,
    meets_floor: row.meets_floor,
    equity_bonus_notes: row.equity_bonus_notes,
    track: row.track,
    company_archetype: row.company_archetype,
    company_stage: row.company_stage,
    industry: row.industry,
    mission_interest: row.mission_interest,
    fit: row.fit,
    source: row.source,
    source_detail: row.source_detail,
    connection: row.connection,
    referral: row.referral,
    status: row.status,
    priority: row.priority,
    next_action: row.next_action,
    next_action_due: row.next_action_due,
    follow_up_date: row.follow_up_date,
    discovered_at: row.discovered_at,
    applied_at: row.applied_at,
    closed_at: row.closed_at,
    closed_reason: row.closed_reason,
    materials: row.materials,
    notes: row.notes,
    project_thread_url: row.project_thread_url,
    created_at: formatDateTime(row.created_at),
    updated_at: formatDateTime(row.updated_at),
    updated_by: row.updated_by,
    jd_snapshot: row.jd_snapshot,
  };
  flattenExtra(record, row.extra, APPLICATION_RESERVED);
  if (opts.contactIds !== undefined) record.contact_ids = opts.contactIds;
  if (opts.events !== undefined) record.events = opts.events.map(toEventRecord);
  if (opts.contacts !== undefined) record.contacts = opts.contacts.map((c) => toContactRecord(c));
  return record as ApplicationRecord;
}
