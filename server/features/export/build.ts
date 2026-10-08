// The full export dump (spec D, Export), shared by GET /export and runExport.
// Every record goes through the canonical record helpers, so the dump, the
// files in the data repo and the rest of the API agree on field order.
import { eq } from "drizzle-orm";
import { applicationContacts, applications, contacts, events, settings, type EventRow } from "../../../db/schema.ts";
import type { Db } from "../../db.ts";
import { formatDateTime, toApplicationRecord, toContactRecord } from "../../records.ts";
import type { ApplicationRecord, ContactRecord } from "../../../shared/schemas.ts";
import { compareCodeUnits as byString } from "./util.ts";

export type ExportSettings = { comp_floor: number };

export type ExportDump = {
  exported_at: string;
  /** Full records with events and contact_ids, never contacts objects; sorted by id. */
  applications: ApplicationRecord[];
  /** Records with application_ids; sorted by id. */
  contacts: ContactRecord[];
  settings: ExportSettings;
};

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

async function readCompFloor(db: Db): Promise<number> {
  const [row] = await db.select().from(settings).where(eq(settings.key, "comp_floor"));
  if (!row) throw new Error("export: the comp_floor setting is missing from the settings table");
  if (typeof row.value !== "number" || !Number.isFinite(row.value)) {
    throw new Error("export: the comp_floor setting is not a number");
  }
  return row.value;
}

/**
 * Reads every application, event, link, contact and the comp_floor setting in
 * one read-only snapshot and returns the dump, with exported_at = now().
 */
export async function buildExport(db: Db, now: () => Date): Promise<ExportDump> {
  const exportedAt = formatDateTime(now());
  return db.transaction(
    async (tx) => {
      const appRows = await tx.select().from(applications);
      const eventRows = await tx.select().from(events);
      const linkRows = await tx.select().from(applicationContacts);
      const contactRows = await tx.select().from(contacts);
      const compFloor = await readCompFloor(tx);

      const eventsByApp = groupBy(eventRows, (e) => e.application_id);
      const contactIdsByApp = groupBy(linkRows, (l) => l.application_id);
      const appIdsByContact = groupBy(linkRows, (l) => l.contact_id);
      const byTimeThenId = (a: EventRow, b: EventRow) => a.at.getTime() - b.at.getTime() || byString(a.id, b.id);

      const apps = appRows
        .sort((a, b) => byString(a.id, b.id))
        .map((row) =>
          toApplicationRecord(row, {
            contactIds: (contactIdsByApp.get(row.id) ?? []).map((l) => l.contact_id).sort(byString),
            events: (eventsByApp.get(row.id) ?? []).sort(byTimeThenId),
          }),
        );
      const cons = contactRows
        .sort((a, b) => byString(a.id, b.id))
        .map((row) =>
          toContactRecord(row, {
            applicationIds: (appIdsByContact.get(row.id) ?? []).map((l) => l.application_id).sort(byString),
          }),
        );

      return {
        exported_at: exportedAt,
        applications: apps,
        contacts: cons,
        settings: { comp_floor: compFloor },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
