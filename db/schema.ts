// Drizzle tables (spec C). Property names are the snake_case column names, so a
// row's keys match the API record's field names.
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** timestamp(3) with time zone, read as a Date. */
const timestamptz = () => timestamp({ precision: 3, withTimezone: true, mode: "date" });
/** date, read as a "YYYY-MM-DD" string. */
const day = () => date({ mode: "string" });

export const applications = pgTable(
  "applications",
  {
    id: text().primaryKey(),
    company: text().notNull(),
    role_title: text().notNull(),
    posting_url: text().unique(),
    job_id: text(),
    posting_status: text(),
    posting_verified_at: day(),
    jd_snapshot_path: text(),
    jd_snapshot: text(),
    work_arrangement: text().notNull(),
    location: text(),
    detroit_metro: boolean(),
    onsite_requirement: text(),
    remote_scope: text(),
    move_timing_ok: text(),
    comp_min: integer(),
    comp_max: integer(),
    comp_source: text(),
    meets_floor: boolean(),
    equity_bonus_notes: text(),
    track: text(),
    company_archetype: text(),
    company_stage: text(),
    industry: text(),
    mission_interest: text().array(),
    fit: jsonb().$type<Record<string, unknown>>(),
    materials: jsonb().$type<Record<string, unknown>>(),
    source: text(),
    source_detail: text(),
    connection: text(),
    referral: text(),
    status: text().notNull(),
    priority: text(),
    next_action: text(),
    next_action_due: day(),
    follow_up_date: day(),
    discovered_at: day().notNull(),
    applied_at: day(),
    closed_at: day(),
    closed_reason: text(),
    notes: text(),
    project_thread_url: text(),
    extra: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamptz().notNull(),
    updated_at: timestamptz().notNull(),
    updated_by: text().notNull(),
  },
  (t) => [
    index("applications_status_idx").on(t.status),
    index("applications_next_action_due_idx").on(t.next_action_due),
    index("applications_follow_up_date_idx").on(t.follow_up_date),
    index("applications_updated_at_idx").on(t.updated_at),
  ],
);

export const events = pgTable(
  "events",
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    application_id: text()
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    at: timestamptz().notNull(),
    type: text().notNull(),
    note: text(),
    by: text().notNull(),
    from_status: text(),
    to_status: text(),
  },
  (t) => [index("events_application_id_at_idx").on(t.application_id, t.at)],
);

export const contacts = pgTable("contacts", {
  id: text().primaryKey(),
  name: text().notNull(),
  company: text(),
  role: text(),
  relationship: text(),
  linkedin_url: text(),
  email: text(),
  last_contact_at: day(),
  notes: text(),
  extra: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  created_at: timestamptz().notNull(),
  updated_at: timestamptz().notNull(),
  updated_by: text().notNull(),
});

export const applicationContacts = pgTable(
  "application_contacts",
  {
    application_id: text()
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    contact_id: text()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.application_id, t.contact_id] })],
);

export const settings = pgTable("settings", {
  key: text().primaryKey(),
  value: jsonb().notNull(),
});

export type ApplicationRow = typeof applications.$inferSelect;
export type ApplicationInsert = typeof applications.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type EventInsert = typeof events.$inferInsert;
export type ContactRow = typeof contacts.$inferSelect;
export type ContactInsert = typeof contacts.$inferInsert;
export type SettingRow = typeof settings.$inferSelect;
