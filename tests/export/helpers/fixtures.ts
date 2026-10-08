import { eq } from "drizzle-orm";
import { applicationContacts, applications, contacts, events } from "../../../db/schema.ts";
import type { Db } from "../../../server/db.ts";
import { toApplicationRecord, toContactRecord } from "../../../server/records.ts";

export const JD_TEXT = "# Staff Engineer\n\nBuild the thing.\nBring snacks.\n";
export const APP_ZETA = "zeta-co--staff-engineer--2026-10-01"; // has a JD, a contact, two events, extra keys
export const APP_ALPHA = "alpha-inc--backend-engineer--2026-10-02"; // no JD, no events, no contacts
export const CONTACT_JANE = "jane-doe--zeta-co";
export const CONTACT_BOB = "bob-roe";

const created = new Date("2026-10-01T12:00:00.000Z");

/** Inserts rows directly (deliberately in non-sorted order) so tests do not depend on S1/S2. */
export async function seedData(db: Db): Promise<void> {
  const base = {
    work_arrangement: "remote",
    status: "watching",
    created_at: created,
    updated_at: new Date("2026-10-03T08:30:15.250Z"),
    updated_by: "claude-project",
  };
  await db.insert(applications).values({
    ...base,
    id: APP_ZETA,
    company: "Zeta Co",
    role_title: "Staff Engineer",
    discovered_at: "2026-10-01",
    posting_url: "https://zeta.example/jobs/1",
    comp_min: 160000,
    comp_max: 200000,
    meets_floor: true,
    mission_interest: ["climate", "health"],
    fit: { total: 88, notes: "good" },
    jd_snapshot: JD_TEXT,
    extra: { custom_flag: "yes", nested: { a: 1 } },
  });
  await db.insert(applications).values({
    ...base,
    id: APP_ALPHA,
    company: "Alpha Inc",
    role_title: "Backend Engineer",
    discovered_at: "2026-10-02",
    jd_snapshot: null,
  });
  await db.insert(contacts).values({
    id: CONTACT_JANE,
    name: "Jane Doe",
    company: "Zeta Co",
    relationship: "recruiter",
    extra: { favorite_color: "teal" },
    created_at: created,
    updated_at: created,
    updated_by: "dakota",
  });
  await db.insert(contacts).values({
    id: CONTACT_BOB,
    name: "Bob Roe",
    created_at: created,
    updated_at: created,
    updated_by: "dakota",
  });
  // Link order differs from id order on both sides: zeta gets jane before bob, and jane gets zeta before alpha.
  await db.insert(applicationContacts).values({ application_id: APP_ZETA, contact_id: CONTACT_JANE });
  await db.insert(applicationContacts).values({ application_id: APP_ZETA, contact_id: CONTACT_BOB });
  await db.insert(applicationContacts).values({ application_id: APP_ALPHA, contact_id: CONTACT_JANE });
  // The later event has the smaller id (a1 < b2), so time order and id order are reverse.
  await db.insert(events).values([
    {
      id: "00000000-0000-4000-8000-0000000000a1",
      application_id: APP_ZETA,
      at: new Date("2026-10-02T09:00:00.000Z"),
      type: "note",
      note: "second",
      by: "dakota",
    },
    {
      id: "00000000-0000-4000-8000-0000000000b2",
      application_id: APP_ZETA,
      at: new Date("2026-10-01T12:00:00.000Z"),
      type: "discovered",
      note: null,
      by: "claude-project",
    },
  ]);
}

/** What the canonical export of the seeded data must contain, built from the stored rows. */
export async function expectedRecords(db: Db) {
  const appRows = (await db.select().from(applications)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const contactRows = (await db.select().from(contacts)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const links = await db.select().from(applicationContacts);
  const evRows = await db.select().from(events);
  const apps = appRows.map((row) =>
    toApplicationRecord(row, {
      contactIds: links.filter((l) => l.application_id === row.id).map((l) => l.contact_id).sort(),
      events: evRows
        .filter((e) => e.application_id === row.id)
        .sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : 1)),
    }),
  );
  const cons = contactRows.map((row) =>
    toContactRecord(row, {
      applicationIds: links.filter((l) => l.contact_id === row.id).map((l) => l.application_id).sort(),
    }),
  );
  return { apps, cons };
}

export const fileText = (x: unknown) => JSON.stringify(x, null, 2) + "\n";

export async function deleteApplication(db: Db, id: string) {
  await db.delete(applications).where(eq(applications.id, id));
}
