// Applications business logic (spec A, C and D). Every write runs in one
// transaction: the row, its events (including status-change events) and its
// contact links commit together or not at all.
//
// Write functions take (db, deps, actor, input) and either resolve with the
// full record or throw ApplicationError, whose `status` is the HTTP status the
// API answers with (400, 404, 409, 412 or 428) and which carries `details`
// (400) or the current `record` (409, 412).
import { and, asc, desc, eq, gte, ilike, inArray, lte, ne, or, sql } from "drizzle-orm";
import {
  type ApplicationInsert,
  type ApplicationRow,
  type ContactRow,
  type EventRow,
  applicationContacts,
  applications,
  contacts,
  events,
  settings,
} from "../../../db/schema.ts";
import type { ErrorDetail } from "../../../shared/errors.ts";
import {
  type ApplicationRecord,
  type EventRecord,
  type Status,
  TERMINAL_STATUSES,
  applicationCreateSchema,
  applicationPatchSchema,
  eventCreateSchema,
} from "../../../shared/schemas.ts";
import type { Actor } from "../../context.ts";
import type { Db } from "../../db.ts";
import {
  applicationId,
  computeMeetsFloor,
  slugify,
  splitApplicationInput,
  toApplicationRecord,
  toEventRecord,
  todayIn,
} from "../../records.ts";
import { newEventId } from "./event-id.ts";
import { ifMatchInstant, issueDetails, parseListQuery } from "./input.ts";

/** What the service needs from the app's deps. `RequestDeps` (c.get("deps")) satisfies it. */
export type ServiceDeps = { config: { timezone: string }; now: () => Date };

export type ApplicationErrorStatus = 400 | 404 | 409 | 412 | 428;

/** A refused request. `status` is the HTTP status; 409 and 412 carry the current full record. */
export class ApplicationError extends Error {
  status: ApplicationErrorStatus;
  details?: ErrorDetail[];
  record?: ApplicationRecord;

  constructor(
    status: ApplicationErrorStatus,
    message: string,
    opts: { details?: ErrorDetail[]; record?: ApplicationRecord } = {},
  ) {
    super(message);
    this.name = "ApplicationError";
    this.status = status;
    this.details = opts.details;
    this.record = opts.record;
  }
}

/** The database or an open transaction: both run the same query builders. */
type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const idOrder = sql`${applications.id} collate "C"`;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function findRow(ex: Executor, id: string, forUpdate = false): Promise<ApplicationRow | undefined> {
  const query = ex.select().from(applications).where(eq(applications.id, id));
  const [row] = forUpdate ? await query.for("update") : await query;
  return row;
}

/** The full record: events sorted by at then id, contact_ids and contacts sorted by id. */
async function fullRecord(ex: Executor, row: ApplicationRow): Promise<ApplicationRecord> {
  const eventRows: EventRow[] = await ex
    .select()
    .from(events)
    .where(eq(events.application_id, row.id))
    .orderBy(asc(events.at), asc(events.id));
  const contactRows: ContactRow[] = (
    await ex
      .select({ contact: contacts })
      .from(applicationContacts)
      .innerJoin(contacts, eq(applicationContacts.contact_id, contacts.id))
      .where(eq(applicationContacts.application_id, row.id))
  )
    .map((r) => r.contact)
    .sort((a, b) => byCodeUnit(a.id, b.id));
  return toApplicationRecord(row, {
    events: eventRows,
    contactIds: contactRows.map((c) => c.id),
    contacts: contactRows,
  });
}

async function fullRecordById(ex: Executor, id: string): Promise<ApplicationRecord | null> {
  const row = await findRow(ex, id);
  return row ? fullRecord(ex, row) : null;
}

/** GET /applications/:id. Null when there is no such record. */
export async function getApplication(db: Db, id: string): Promise<ApplicationRecord | null> {
  return fullRecordById(db, id);
}

function likeLiteral(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * GET /applications. `params` is the raw query string (spec D filters).
 * Throws a 400 ApplicationError naming each invalid parameter. List records
 * omit events and contacts (A.9). Sorted by updated_at desc, then id.
 */
export async function listApplications(
  db: Db,
  params: Record<string, string | undefined>,
): Promise<ApplicationRecord[]> {
  const parsed = parseListQuery(params);
  if (!parsed.ok) throw new ApplicationError(400, "Invalid query parameters", { details: parsed.details });
  const f = parsed.value;

  const where = and(
    f.status ? inArray(applications.status, f.status) : undefined,
    f.track ? eq(applications.track, f.track) : undefined,
    f.work_arrangement ? eq(applications.work_arrangement, f.work_arrangement) : undefined,
    f.detroit_metro !== undefined ? eq(applications.detroit_metro, f.detroit_metro) : undefined,
    f.meets_floor !== undefined ? eq(applications.meets_floor, f.meets_floor) : undefined,
    f.min_fit !== undefined ? sql`(${applications.fit} ->> 'total')::numeric >= ${f.min_fit}` : undefined,
    f.due_before !== undefined
      ? or(lte(applications.next_action_due, f.due_before), lte(applications.follow_up_date, f.due_before))
      : undefined,
    f.q !== undefined
      ? or(ilike(applications.company, likeLiteral(f.q)), ilike(applications.role_title, likeLiteral(f.q)))
      : undefined,
    f.updated_since !== undefined ? gte(applications.updated_at, f.updated_since) : undefined,
  );

  const rows = await db.select().from(applications).where(where).orderBy(desc(applications.updated_at), idOrder);
  return rows.map((row) => toApplicationRecord(row));
}

// ---------------------------------------------------------------------------
// Shared write helpers
// ---------------------------------------------------------------------------

async function compFloor(ex: Executor): Promise<number> {
  const [setting] = await ex.select({ value: settings.value }).from(settings).where(eq(settings.key, "comp_floor"));
  if (typeof setting?.value !== "number") throw new Error("settings.comp_floor is missing or not a number");
  return setting.value;
}

/** Trims a string posting_url so duplicates are compared trimmed (spec D). */
function withTrimmedPostingUrl(input: Record<string, unknown>): Record<string, unknown> {
  return typeof input.posting_url === "string" ? { ...input, posting_url: input.posting_url.trim() } : input;
}

function invalid(details: ErrorDetail[]): ApplicationError {
  return new ApplicationError(400, "Invalid application", { details });
}

/** Unique ids in first-seen order (ruling b: duplicates are dropped). */
function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/** 400 naming each unknown contact id (by its position in the request). */
async function assertContactsExist(ex: Executor, requested: string[]): Promise<void> {
  if (requested.length === 0) return;
  const found = new Set(
    (await ex.select({ id: contacts.id }).from(contacts).where(inArray(contacts.id, dedupe(requested)))).map(
      (r) => r.id,
    ),
  );
  const details: ErrorDetail[] = [];
  requested.forEach((id, i) => {
    if (!found.has(id)) details.push({ path: `contact_ids.${i}`, message: `No contact with id ${id}` });
  });
  if (details.length > 0) throw invalid(details);
}

async function replaceLinks(ex: Executor, id: string, contactIds: string[]): Promise<void> {
  await ex.delete(applicationContacts).where(eq(applicationContacts.application_id, id));
  if (contactIds.length > 0) {
    await ex.insert(applicationContacts).values(contactIds.map((contact_id) => ({ application_id: id, contact_id })));
  }
}

const TERMINAL = new Set<string>(TERMINAL_STATUSES);

/** A.7: entering applied fills a null applied_at; entering a terminal status fills a null closed_at. */
function autoDates(
  status: string,
  current: { applied_at: string | null; closed_at: string | null },
  today: string,
): { applied_at: string | null; closed_at: string | null } {
  return {
    applied_at: status === "applied" && current.applied_at === null ? today : current.applied_at,
    closed_at: TERMINAL.has(status) && current.closed_at === null ? today : current.closed_at,
  };
}

function statusChangeEvent(id: string, from: string, to: Status, actor: Actor, at: Date) {
  return {
    id: newEventId(),
    application_id: id,
    at,
    type: "status-change",
    note: `${from} → ${to}`,
    by: actor,
    from_status: from,
    to_status: to,
  };
}

/** The other record that already holds `postingUrl`, if any. */
async function holderOfPostingUrl(ex: Executor, postingUrl: string, exceptId?: string) {
  const [row] = await ex
    .select()
    .from(applications)
    .where(
      exceptId === undefined
        ? eq(applications.posting_url, postingUrl)
        : and(eq(applications.posting_url, postingUrl), ne(applications.id, exceptId)),
    );
  return row;
}

function conflict(record: ApplicationRecord, why: string): ApplicationError {
  return new ApplicationError(409, why, { record });
}

function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && typeof e === "object" && e !== null; depth++) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Column values from parsed input: only the keys the client sent, contact_ids excluded. */
function columnValues(sent: Record<string, unknown>, parsed: Record<string, unknown>): Partial<ApplicationInsert> {
  const values: Record<string, unknown> = {};
  for (const key of Object.keys(sent)) {
    if (key === "contact_ids") continue;
    if (key in parsed) values[key] = parsed[key];
  }
  return values as Partial<ApplicationInsert>;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * POST /applications. `input` is the request body as sent: recognized fields
 * are validated, unknown keys go to `extra`, server-managed keys are ignored.
 * Resolves with the full record (201). Throws ApplicationError 400 (invalid,
 * or an unknown contact id) or 409 with the existing record when the generated
 * id or the trimmed posting_url already exists.
 */
export async function createApplication(
  db: Db,
  deps: ServiceDeps,
  actor: Actor,
  input: Record<string, unknown>,
): Promise<ApplicationRecord> {
  const { known, extra } = splitApplicationInput(withTrimmedPostingUrl(input));
  const parsed = applicationCreateSchema.safeParse(known);
  if (!parsed.success) throw invalid(issueDetails(parsed.error));
  const data = parsed.data;

  const slugProblems: ErrorDetail[] = [];
  if (slugify(data.company) === "") slugProblems.push({ path: "company", message: "Needs a letter or digit to form an id" });
  if (slugify(data.role_title) === "") {
    slugProblems.push({ path: "role_title", message: "Needs a letter or digit to form an id" });
  }
  if (slugProblems.length > 0) throw invalid(slugProblems);

  const now = deps.now();
  const today = todayIn(deps.config.timezone, now);
  const discoveredAt = data.discovered_at ?? today;
  const id = applicationId(data.company, data.role_title, discoveredAt);
  const requestedContacts = data.contact_ids ?? [];
  const storedExtra = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== null && v !== undefined));

  return db.transaction(async (tx) => {
    const existing = await findRow(tx, id);
    if (existing) throw conflict(await fullRecord(tx, existing), `An application with id ${id} already exists`);
    if (data.posting_url) {
      const holder = await holderOfPostingUrl(tx, data.posting_url);
      if (holder) throw conflict(await fullRecord(tx, holder), `An application with this posting_url already exists`);
    }
    await assertContactsExist(tx, requestedContacts);

    const fields = columnValues(known, data);
    const dates = autoDates(data.status, { applied_at: data.applied_at ?? null, closed_at: data.closed_at ?? null }, today);
    const values: ApplicationInsert = {
      ...fields,
      id,
      company: data.company,
      role_title: data.role_title,
      work_arrangement: data.work_arrangement,
      status: data.status,
      discovered_at: discoveredAt,
      applied_at: dates.applied_at,
      closed_at: dates.closed_at,
      meets_floor: computeMeetsFloor(data.comp_min ?? null, data.comp_max ?? null, await compFloor(tx)),
      extra: storedExtra,
      created_at: now,
      updated_at: now,
      updated_by: actor,
    };

    // Any unique clash (id or posting_url) committed since the checks above is a conflict, not a 500.
    const [row] = await tx.insert(applications).values(values).onConflictDoNothing().returning();
    if (!row) {
      const winner = (await findRow(tx, id)) ?? (data.posting_url ? await holderOfPostingUrl(tx, data.posting_url) : undefined);
      if (!winner) throw new Error(`insert of ${id} conflicted but no conflicting record was found`);
      throw conflict(await fullRecord(tx, winner), `An application with id ${winner.id} already exists`);
    }

    await tx.insert(events).values({ id: newEventId(), application_id: id, at: now, type: "discovered", note: null, by: actor });
    await replaceLinks(tx, id, dedupe(requestedContacts));
    return fullRecord(tx, row);
  });
}

// ---------------------------------------------------------------------------
// Patch
// ---------------------------------------------------------------------------

/**
 * PATCH /applications/:id. `input.ifMatch` is the If-Match header (the
 * updated_at the client last saw); `input.body` is the request body as sent.
 * Throws ApplicationError 428 (no If-Match), 400, 404, 412 (stale, with the
 * current record) or 409 (posting_url held by another record, with that one).
 */
export async function updateApplication(
  db: Db,
  deps: ServiceDeps,
  actor: Actor,
  input: { id: string; ifMatch: string | undefined; body: Record<string, unknown> },
): Promise<ApplicationRecord> {
  if (input.ifMatch === undefined || input.ifMatch.trim() === "") {
    throw new ApplicationError(428, "PATCH requires an If-Match header with the record's updated_at");
  }
  const expected = ifMatchInstant(input.ifMatch);
  const { known, extra } = splitApplicationInput(withTrimmedPostingUrl(input.body));
  const parsed = applicationPatchSchema.safeParse(known);
  if (!parsed.success) throw invalid(issueDetails(parsed.error));
  const data = parsed.data;
  const requestedContacts = "contact_ids" in data ? (data.contact_ids ?? []) : undefined;

  const now = deps.now();
  const today = todayIn(deps.config.timezone, now);

  try {
    return await db.transaction(async (tx) => {
      const row = await findRow(tx, input.id, true);
      if (!row) throw new ApplicationError(404, `No application with id ${input.id}`);
      if (expected === null || expected.getTime() !== row.updated_at.getTime()) {
        throw new ApplicationError(412, "The application has changed since If-Match was read", {
          record: await fullRecord(tx, row),
        });
      }
      if (data.posting_url) {
        const holder = await holderOfPostingUrl(tx, data.posting_url, row.id);
        if (holder) {
          throw conflict(await fullRecord(tx, holder), `Another application (${holder.id}) has this posting_url`);
        }
      }
      if (requestedContacts) await assertContactsExist(tx, requestedContacts);

      const fields = columnValues(known, data);
      const merged = { ...row, ...fields } as ApplicationRow;

      const nextExtra: Record<string, unknown> = { ...row.extra };
      for (const [key, value] of Object.entries(extra)) {
        if (value === null || value === undefined) delete nextExtra[key];
        else nextExtra[key] = value;
      }

      const set: Partial<ApplicationInsert> = {
        ...fields,
        meets_floor: computeMeetsFloor(merged.comp_min, merged.comp_max, await compFloor(tx)),
        extra: nextExtra,
        updated_at: now,
        updated_by: actor,
      };

      if (data.status !== undefined && data.status !== row.status) {
        Object.assign(set, autoDates(data.status, merged, today));
        await tx.insert(events).values(statusChangeEvent(row.id, row.status, data.status, actor, now));
      }

      const [updated] = await tx.update(applications).set(set).where(eq(applications.id, row.id)).returning();
      if (requestedContacts) await replaceLinks(tx, row.id, dedupe(requestedContacts));
      return fullRecord(tx, updated);
    });
  } catch (err) {
    // posting_url taken by a concurrent write after the check: a conflict, not a 500.
    if (isUniqueViolation(err) && data.posting_url) {
      const holder = await holderOfPostingUrl(db, data.posting_url, input.id);
      if (holder) throw conflict(await fullRecord(db, holder), `Another application (${holder.id}) has this posting_url`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * POST /applications/:id/events. Never 412. Inserts the client's event; a
 * `status` that differs from the current one also changes status, adds a
 * status-change event and applies A.7; next_action / next_action_due are set
 * when sent (null clears). The record's updated_at/updated_by are bumped.
 * Throws ApplicationError 400 or 404.
 */
export async function addEvent(
  db: Db,
  deps: ServiceDeps,
  actor: Actor,
  input: { id: string; body: Record<string, unknown> },
): Promise<{ event: EventRecord; record: ApplicationRecord }> {
  const parsed = eventCreateSchema.safeParse(input.body);
  if (!parsed.success) throw new ApplicationError(400, "Invalid event", { details: issueDetails(parsed.error) });
  const data = parsed.data;

  const now = deps.now();
  const today = todayIn(deps.config.timezone, now);

  return db.transaction(async (tx) => {
    const row = await findRow(tx, input.id, true);
    if (!row) throw new ApplicationError(404, `No application with id ${input.id}`);

    const [eventRow] = await tx
      .insert(events)
      .values({
        id: newEventId(),
        application_id: row.id,
        at: data.at !== undefined ? new Date(data.at) : now,
        type: data.type,
        note: data.note ?? null,
        by: actor,
      })
      .returning();

    const set: Partial<ApplicationInsert> = { updated_at: now, updated_by: actor };
    if ("next_action" in data) set.next_action = data.next_action ?? null;
    if ("next_action_due" in data) set.next_action_due = data.next_action_due ?? null;
    if (data.status !== undefined && data.status !== row.status) {
      set.status = data.status;
      Object.assign(set, autoDates(data.status, row, today));
      await tx.insert(events).values(statusChangeEvent(row.id, row.status, data.status, actor, now));
    }

    const [updated] = await tx.update(applications).set(set).where(eq(applications.id, row.id)).returning();
    return { event: toEventRecord(eventRow), record: await fullRecord(tx, updated) };
  });
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * DELETE /applications/:id?confirm=<id> (A.10). `confirm` must equal the id
 * exactly (400 otherwise); an unknown id is 404. Events and links cascade.
 * Session-only: the route refuses the agent key before calling this.
 */
export async function deleteApplication(
  db: Db,
  _deps: ServiceDeps,
  _actor: Actor,
  input: { id: string; confirm: string | undefined },
): Promise<void> {
  if (input.confirm !== input.id) {
    throw new ApplicationError(400, "Hard delete needs ?confirm=<id> matching the application id", {
      details: [{ path: "confirm", message: "Must equal the application id" }],
    });
  }
  const deleted = await db.delete(applications).where(eq(applications.id, input.id)).returning({ id: applications.id });
  if (deleted.length === 0) throw new ApplicationError(404, `No application with id ${input.id}`);
}
