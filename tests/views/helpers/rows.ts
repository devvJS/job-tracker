// Row factories for the views tests. They insert straight through Drizzle, so the tests
// do not depend on the applications API.
import { applications, events } from "../../../db/schema.ts";
import type { ApplicationInsert, ApplicationRow } from "../../../db/schema.ts";
import type { Db } from "../../../server/db.ts";

export const VIEWS_BASE = "/job-tracker/api";

const CREATED = new Date("2026-09-01T12:00:00.000Z");

/** A minimal valid application row. Override any column. */
export function appRow(id: string, over: Partial<ApplicationInsert> = {}): ApplicationInsert {
  return {
    id,
    company: `Company ${id}`,
    role_title: `Role ${id}`,
    work_arrangement: "remote",
    status: "applied",
    discovered_at: "2026-09-01",
    created_at: CREATED,
    updated_at: CREATED,
    updated_by: "dakota",
    ...over,
  };
}

export async function insertApp(db: Db, id: string, over: Partial<ApplicationInsert> = {}): Promise<ApplicationRow> {
  const [row] = await db.insert(applications).values(appRow(id, over)).returning();
  return row;
}

/** Inserts an event. `at` is an ISO string. */
export async function insertEvent(
  db: Db,
  applicationId: string,
  e: { at: string; type: string; from_status?: string | null; to_status?: string | null; note?: string | null },
): Promise<void> {
  await db.insert(events).values({
    application_id: applicationId,
    at: new Date(e.at),
    type: e.type,
    note: e.note ?? null,
    by: "dakota",
    from_status: e.from_status ?? null,
    to_status: e.to_status ?? null,
  });
}

/** A status-change event, as the server would write it. */
export function statusChange(applicationId: string, at: string, from: string, to: string) {
  return { applicationId, at, type: "status-change", from_status: from, to_status: to, note: `${from} → ${to}` };
}

export async function insertStatusChange(db: Db, applicationId: string, at: string, from: string, to: string) {
  await insertEvent(db, applicationId, statusChange(applicationId, at, from, to));
}
