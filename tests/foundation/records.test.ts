import {
  applicationId,
  computeMeetsFloor,
  contactId,
  formatDateTime,
  slugify,
  splitApplicationInput,
  toApplicationRecord,
  todayIn,
} from "../../server/records.ts";
import { createTestDb, type TestDb } from "../helpers/db.ts";
import { applications, contacts, events } from "../../db/schema.ts";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("slugify", () => {
  it.each([
    ["Senior Software Engineer (Remote)", "senior-software-engineer-remote"],
    ["Café Ünïcode!!", "cafe-unicode"],
    ["  Multiple   spaces -- and___runs  ", "multiple-spaces-and-runs"],
    ["C++ / C#", "c-c"],
    ["Gynger", "gynger"],
    ["2026 Q4", "2026-q4"],
    ["---edge---", "edge"],
  ])("slugify(%j) = %j", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it("returns an empty string when nothing alphanumeric remains", () => {
    expect(slugify("!!!")).toBe("");
  });
});

describe("applicationId", () => {
  it("matches the spec example", () => {
    expect(applicationId("Gynger", "Senior Software Engineer", "2026-09-15")).toBe(
      "gynger--senior-software-engineer--2026-09-15",
    );
  });

  it("slugs both parts", () => {
    expect(applicationId("Café & Co.", "Sr. Engineer (Remote)", "2026-10-07")).toBe(
      "cafe-co--sr-engineer-remote--2026-10-07",
    );
  });

  it("throws if a slug is empty", () => {
    expect(() => applicationId("!!!", "Engineer", "2026-10-07")).toThrow();
    expect(() => applicationId("Acme", "???", "2026-10-07")).toThrow();
  });
});

describe("contactId", () => {
  it("joins name and company slugs with a double dash", () => {
    expect(contactId("Jane Doe", "Acme Corp")).toBe("jane-doe--acme-corp");
  });

  it("is just the name slug without a company", () => {
    expect(contactId("Jane Doe")).toBe("jane-doe");
    expect(contactId("Jane Doe", null)).toBe("jane-doe");
    expect(contactId("Jane Doe", "")).toBe("jane-doe");
  });

  it("handles accents", () => {
    expect(contactId("José Núñez", "Café")).toBe("jose-nunez--cafe");
  });
});

describe("computeMeetsFloor", () => {
  const floor = 150000;
  it.each([
    [null, 200000, true],
    [null, 100000, false],
    [160000, null, true],
    [100000, null, false],
    [100000, 200000, true],
    [100000, 140000, false],
    [200000, 100000, false],
    [null, 150000, true],
    [150000, null, true],
    [null, 149999, false],
    [null, null, null],
  ] as const)("min %s, max %s -> %s", (min, max, expected) => {
    expect(computeMeetsFloor(min, max, floor)).toBe(expected);
  });

  it("uses the floor it is given", () => {
    expect(computeMeetsFloor(null, 120000, 100000)).toBe(true);
  });
});

describe("todayIn", () => {
  it("is the previous day in Detroit across the UTC boundary", () => {
    expect(todayIn("America/Detroit", new Date("2026-10-08T03:30:00Z"))).toBe("2026-10-07");
    expect(todayIn("UTC", new Date("2026-10-08T03:30:00Z"))).toBe("2026-10-08");
  });

  it("uses standard time in winter", () => {
    expect(todayIn("America/Detroit", new Date("2026-01-01T04:30:00Z"))).toBe("2025-12-31");
    expect(todayIn("America/Detroit", new Date("2026-01-01T05:00:00Z"))).toBe("2026-01-01");
  });

  it("rolls over at local midnight (EDT is UTC-4)", () => {
    expect(todayIn("America/Detroit", new Date("2026-10-08T03:59:59Z"))).toBe("2026-10-07");
    expect(todayIn("America/Detroit", new Date("2026-10-08T04:00:00Z"))).toBe("2026-10-08");
  });
});

describe("formatDateTime", () => {
  it("is ISO UTC with milliseconds and Z", () => {
    expect(formatDateTime(new Date("2026-10-07T14:03:22.123Z"))).toBe("2026-10-07T14:03:22.123Z");
    expect(formatDateTime(new Date("2026-10-07T14:03:22Z"))).toBe("2026-10-07T14:03:22.000Z");
  });
});

describe("splitApplicationInput", () => {
  it("puts unknown keys in extra and recognized fields in known", () => {
    const { known, extra } = splitApplicationInput({
      company: "Acme",
      role_title: "Engineer",
      comp_min: 150000,
      fit: { total: 80 },
      glassdoor_rating: 4.2,
      referrer_note: "met at meetup",
    });
    expect(known).toEqual({ company: "Acme", role_title: "Engineer", comp_min: 150000, fit: { total: 80 } });
    expect(extra).toEqual({ glassdoor_rating: 4.2, referrer_note: "met at meetup" });
  });

  it("drops server-managed keys from both outputs", () => {
    const { known, extra } = splitApplicationInput({
      company: "Acme",
      id: "forged",
      created_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2020-01-01T00:00:00.000Z",
      updated_by: "dakota",
      events: [{ type: "note" }],
      contacts: [{ id: "x" }],
      application_ids: ["a"],
      meets_floor: true,
      extra: { sneaky: 1 },
      keeper: "yes",
    });
    expect(known).toEqual({ company: "Acme" });
    expect(extra).toEqual({ keeper: "yes" });
  });

  it("returns empty objects for empty input", () => {
    expect(splitApplicationInput({})).toEqual({ known: {}, extra: {} });
  });
});

describe("toApplicationRecord", () => {
  let handle: TestDb;
  beforeEach(async () => {
    handle = await createTestDb();
  });
  afterEach(async () => {
    await handle.close();
  });

  async function insertApp(extraJson = "{}") {
    await handle.db.execute(sql`
      insert into applications
        (id, company, role_title, work_arrangement, status, discovered_at, applied_at, next_action_due,
         comp_min, comp_max, meets_floor, mission_interest, fit, extra,
         created_at, updated_at, updated_by)
      values
        ('acme--eng--2026-10-07', 'Acme', 'Engineer', 'remote', 'applied', '2026-10-07', '2026-10-08', '2026-10-14',
         150000, 180000, true, ARRAY['art','music']::text[], '{"total": 80}'::jsonb, ${extraJson}::jsonb,
         '2026-10-07T14:03:22.123Z', '2026-10-07T15:04:05.007Z', 'claude-project')`);
    const [row] = await handle.db.select().from(applications);
    return row;
  }

  it("emits canonical field order with dates and datetimes as strings", async () => {
    const row = await insertApp();
    const rec = toApplicationRecord(row) as Record<string, unknown>;
    expect(Object.keys(rec)).toEqual([
      "id", "company", "role_title", "posting_url", "job_id", "posting_status", "posting_verified_at",
      "jd_snapshot_path", "work_arrangement", "location", "detroit_metro", "onsite_requirement", "remote_scope",
      "move_timing_ok", "comp_min", "comp_max", "comp_source", "meets_floor", "equity_bonus_notes", "track",
      "company_archetype", "company_stage", "industry", "mission_interest", "fit", "source", "source_detail",
      "connection", "referral", "status", "priority", "next_action", "next_action_due", "follow_up_date",
      "discovered_at", "applied_at", "closed_at", "closed_reason", "materials", "notes", "project_thread_url",
      "created_at", "updated_at", "updated_by", "jd_snapshot",
    ]);
    expect(rec).toMatchObject({
      id: "acme--eng--2026-10-07",
      company: "Acme",
      role_title: "Engineer",
      work_arrangement: "remote",
      status: "applied",
      posting_url: null,
      comp_min: 150000,
      comp_max: 180000,
      meets_floor: true,
      mission_interest: ["art", "music"],
      fit: { total: 80 },
      discovered_at: "2026-10-07",
      applied_at: "2026-10-08",
      next_action_due: "2026-10-14",
      closed_at: null,
      created_at: "2026-10-07T14:03:22.123Z",
      updated_at: "2026-10-07T15:04:05.007Z",
      updated_by: "claude-project",
    });
    expect("events" in rec).toBe(false);
    expect("contacts" in rec).toBe(false);
    expect("extra" in rec).toBe(false);
  });

  it("flattens extra keys onto the top level", async () => {
    const row = await insertApp('{"glassdoor_rating": 4.2, "tags": ["a"]}');
    const rec = toApplicationRecord(row) as Record<string, unknown>;
    expect(rec.glassdoor_rating).toBe(4.2);
    expect(rec.tags).toEqual(["a"]);
    expect("extra" in rec).toBe(false);
  });

  it("a known field beats a clashing extra key", async () => {
    const row = await insertApp('{"company": "Evil Corp", "status": "closed", "glassdoor_rating": 3}');
    const rec = toApplicationRecord(row) as Record<string, unknown>;
    expect(rec.company).toBe("Acme");
    expect(rec.status).toBe("applied");
    expect(rec.glassdoor_rating).toBe(3);
  });

  it("includes contact_ids, events and contacts only when passed, at the end in that order", async () => {
    const row = await insertApp();
    await handle.db.execute(sql`
      insert into events (application_id, at, type, note, by)
      values ('acme--eng--2026-10-07', '2026-10-07T14:03:22.123Z', 'discovered', null, 'dakota')`);
    await handle.db.execute(sql`
      insert into contacts (id, name, company, created_at, updated_at, updated_by)
      values ('jane--acme', 'Jane', 'Acme', '2026-10-07T14:03:22.123Z', '2026-10-07T14:03:22.123Z', 'dakota')`);
    const eventRows = await handle.db.select().from(events);
    const contactRows = await handle.db.select().from(contacts);
    expect(eventRows).toHaveLength(1);
    expect(contactRows).toHaveLength(1);

    const rec = toApplicationRecord(row, {
      events: eventRows,
      contactIds: ["jane--acme"],
      contacts: contactRows,
    }) as Record<string, unknown>;

    expect(Object.keys(rec).slice(-4)).toEqual(["jd_snapshot", "contact_ids", "events", "contacts"]);
    expect(rec.contact_ids).toEqual(["jane--acme"]);
    expect(rec.events).toEqual([
      expect.objectContaining({ at: "2026-10-07T14:03:22.123Z", type: "discovered", note: null, by: "dakota" }),
    ]);
    expect(rec.contacts).toEqual([expect.objectContaining({ id: "jane--acme", name: "Jane", company: "Acme" })]);
  });
});
