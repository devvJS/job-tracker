// Contacts data access (spec C and D): list, get, create and patch, each
// returning full records with sorted application_ids.
import { asc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { type ContactRow, applicationContacts, contacts } from "../../../db/schema.ts";
import type { ContactCreateInput, ContactPatchInput, ContactRecord } from "../../../shared/schemas.ts";
import type { Actor } from "../../context.ts";
import type { Db } from "../../db.ts";
import { contactId, toContactRecord } from "../../records.ts";

/** The database or an open transaction: both run the same query builders. */
type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Linked application ids per contact id, each list sorted. Contacts with no links get []. */
async function applicationIdsFor(db: Executor, contactIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>(contactIds.map((id) => [id, []]));
  if (contactIds.length === 0) return map;
  const links = await db
    .select({ application_id: applicationContacts.application_id, contact_id: applicationContacts.contact_id })
    .from(applicationContacts)
    .where(inArray(applicationContacts.contact_id, contactIds));
  for (const link of links) map.get(link.contact_id)?.push(link.application_id);
  for (const ids of map.values()) ids.sort(byCodeUnit);
  return map;
}

async function toFullRecord(db: Executor, row: ContactRow): Promise<ContactRecord> {
  const ids = await applicationIdsFor(db, [row.id]);
  return toContactRecord(row, { applicationIds: ids.get(row.id) ?? [] });
}

/** Escapes LIKE wildcards so `q` is matched literally. */
function likeLiteral(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** All contacts (or those whose name or company contains `q`, case-insensitively), sorted by name. */
export async function listContacts(db: Db, q?: string): Promise<ContactRecord[]> {
  const term = q?.trim();
  const filter = term ? or(ilike(contacts.name, likeLiteral(term)), ilike(contacts.company, likeLiteral(term))) : undefined;
  const rows = await db
    .select()
    .from(contacts)
    .where(filter)
    .orderBy(sql`lower(${contacts.name})`, asc(contacts.name), asc(contacts.id));
  const ids = await applicationIdsFor(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => toContactRecord(row, { applicationIds: ids.get(row.id) ?? [] }));
}

async function findRow(db: Executor, id: string): Promise<ContactRow | undefined> {
  const [row] = await db.select().from(contacts).where(eq(contacts.id, id));
  return row;
}

export async function getContact(db: Db, id: string): Promise<ContactRecord | null> {
  const row = await findRow(db, id);
  return row ? toFullRecord(db, row) : null;
}

export type CreateResult = { kind: "created"; record: ContactRecord } | { kind: "conflict"; record: ContactRecord };

/**
 * Inserts a contact with id `contactId(name, company)`. If that id already
 * exists, nothing is written and the existing record is returned as a conflict.
 * The caller has checked that the name can form an id.
 */
export async function createContact(
  db: Db,
  input: { fields: ContactCreateInput; extra: Record<string, unknown> },
  actor: Actor,
  now: Date,
): Promise<CreateResult> {
  const { fields } = input;
  const id = contactId(fields.name, fields.company);
  const extra = Object.fromEntries(Object.entries(input.extra).filter(([, v]) => v !== null && v !== undefined));
  const inserted = await db
    .insert(contacts)
    .values({
      id,
      name: fields.name,
      company: fields.company ?? null,
      role: fields.role ?? null,
      relationship: fields.relationship ?? null,
      linkedin_url: fields.linkedin_url ?? null,
      email: fields.email ?? null,
      last_contact_at: fields.last_contact_at ?? null,
      notes: fields.notes ?? null,
      extra,
      created_at: now,
      updated_at: now,
      updated_by: actor,
    })
    .onConflictDoNothing({ target: contacts.id })
    .returning();
  if (inserted.length === 1) return { kind: "created", record: await toFullRecord(db, inserted[0]) };

  const existing = await findRow(db, id);
  if (!existing) throw new Error(`contact ${id} conflicted on insert but could not be read back`);
  return { kind: "conflict", record: await toFullRecord(db, existing) };
}

export type UpdateResult =
  | { kind: "updated"; record: ContactRecord }
  | { kind: "not_found" }
  | { kind: "stale"; record: ContactRecord };

/** Merges an extra patch into the stored extra: a null value removes the key, anything else sets it. */
function mergeExtra(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

/**
 * Applies a partial update when `ifMatch` is the same instant as the stored
 * updated_at. The id never changes, even when name or company does. Runs in a
 * transaction with the row locked, so a concurrent writer cannot slip between
 * the precondition check and the write.
 */
export async function updateContact(
  db: Db,
  id: string,
  ifMatch: Date | null,
  input: { fields: ContactPatchInput; extra: Record<string, unknown> },
  actor: Actor,
  now: Date,
): Promise<UpdateResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(contacts).where(eq(contacts.id, id)).for("update");
    if (!row) return { kind: "not_found" } as const;
    if (ifMatch === null || ifMatch.getTime() !== row.updated_at.getTime()) {
      return { kind: "stale", record: await toFullRecord(tx, row) } as const;
    }

    const [updated] = await tx
      .update(contacts)
      .set({
        ...input.fields,
        extra: mergeExtra(row.extra, input.extra),
        updated_at: now,
        updated_by: actor,
      })
      .where(eq(contacts.id, id))
      .returning();
    return { kind: "updated", record: await toFullRecord(tx, updated) } as const;
  });
}
