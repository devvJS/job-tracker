import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { applicationContacts, applications, events } from "../../db/schema.ts";
import { TEST_NOW } from "../helpers/config.ts";
import { ACME_ID, NULL_FIELDS, UUID_RE, base, detailPaths, expectEnvelope, setup, type Harness } from "./helpers/harness.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
const NOW_ISO = TEST_NOW.toISOString();

describe("POST /applications: the record", () => {
  it("session create returns 201 and the exact full record", async () => {
    h = await setup();
    const r = await h.call("POST", "/applications", { body: base() });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({
      id: ACME_ID,
      company: "Acme Corp",
      role_title: "Senior Engineer",
      work_arrangement: "remote",
      status: "watching",
      ...NULL_FIELDS,
      discovered_at: "2026-10-07",
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
      updated_by: "dakota",
      contact_ids: [],
      events: [
        {
          id: expect.stringMatching(UUID_RE),
          application_id: ACME_ID,
          at: NOW_ISO,
          type: "discovered",
          note: null,
          by: "dakota",
          from_status: null,
          to_status: null,
        },
      ],
      contacts: [],
    });
    expect(await h.get(ACME_ID)).toEqual(r.json);
  });

  it("the agent key creates as claude-project (updated_by and the discovered event's by)", async () => {
    h = await setup();
    const r = await h.call("POST", "/applications", { as: "agent", body: base() });
    expect(r.status).toBe(201);
    expect(r.json.id).toBe(ACME_ID);
    expect(r.json.updated_by).toBe("claude-project");
    expect(r.json.events).toHaveLength(1);
    expect(r.json.events[0]).toMatchObject({ type: "discovered", by: "claude-project", note: null });
  });

  it("stores the row and exactly one discovered event", async () => {
    h = await setup();
    await h.create(base());
    const rows = await h.db.select().from(applications);
    expect(rows).toHaveLength(1);
    expect(rows[0].updated_by).toBe("dakota");
    const evs = await h.db.select().from(events).where(eq(events.application_id, ACME_ID));
    expect(evs.map((e) => [e.type, e.by])).toEqual([["discovered", "dakota"]]);
  });

  it("an explicit discovered_at is used in the id", async () => {
    h = await setup();
    const rec = await h.create(base({ company: "Gynger", role_title: "Senior Software Engineer", discovered_at: "2026-09-15" }));
    expect(rec.id).toBe("gynger--senior-software-engineer--2026-09-15");
    expect(rec.discovered_at).toBe("2026-09-15");
  });

  it("the id slug folds accents and punctuation", async () => {
    h = await setup();
    const rec = await h.create(base({ company: "Café Ünïcorn, Inc.", role_title: "Sr. Eng / Platform" }));
    expect(rec.id).toBe("cafe-unicorn-inc--sr-eng-platform--2026-10-07");
  });

  it("discovered_at defaults to today in America/Detroit: 22:00 on Oct 7 is still Oct 7 although UTC is Oct 8", async () => {
    h = await setup(new Date("2026-10-08T02:00:00.000Z"));
    const rec = await h.create(base());
    expect(rec.discovered_at).toBe("2026-10-07");
    expect(rec.id).toBe(ACME_ID);
  });

  it("discovered_at defaults to the Detroit date before UTC midnight rolls back too (Oct 7 03:00Z is Oct 6 in Detroit)", async () => {
    h = await setup(new Date("2026-10-07T03:00:00.000Z"));
    const rec = await h.create(base());
    expect(rec.discovered_at).toBe("2026-10-06");
    expect(rec.id).toBe("acme-corp--senior-engineer--2026-10-06");
  });

  it("same company and role on another discovered_at is a different record", async () => {
    h = await setup();
    await h.create(base());
    const second = await h.create(base({ discovered_at: "2026-10-01" }));
    expect(second.id).toBe("acme-corp--senior-engineer--2026-10-01");
    expect((await h.counts()).applications).toBe(2);
  });

  it("known optional fields round-trip with their exact values", async () => {
    h = await setup();
    const body = base({
      posting_url: "https://jobs.example.com/acme/1",
      location: "Dearborn, MI",
      detroit_metro: true,
      track: "ai-engineer",
      source: "linkedin",
      priority: "high",
      next_action: "Apply",
      next_action_due: "2026-10-10",
      follow_up_date: "2026-10-17",
      mission_interest: ["art", "fintech"],
      fit: { skills: 90, total: 88, gaps: ["GCP"], custom_note: "kept" },
      materials: { resume: "r.pdf", checklist: [{ item: "cv", done: true }] },
      notes: "n",
    });
    const rec = await h.create(body);
    expect(rec).toMatchObject(body);
    expect(rec.fit).toEqual({ skills: 90, total: 88, gaps: ["GCP"], custom_note: "kept" });
    expect(rec.mission_interest).toEqual(["art", "fintech"]);
  });
});

describe("POST /applications: meets_floor (A.2)", () => {
  it.each([
    [{ comp_max: 150000 }, true],
    [{ comp_max: 149999 }, false],
    [{ comp_min: 150000 }, true],
    [{ comp_min: 149999 }, false],
    [{ comp_min: 100000, comp_max: 200000 }, true],
    [{ comp_min: 200000, comp_max: 100000 }, false],
    [{}, null],
  ])("%j -> meets_floor %s", async (comp, expected) => {
    h = await setup();
    const rec = await h.create(base(comp));
    expect(rec.meets_floor).toBe(expected);
  });

  it("a client-sent meets_floor is ignored", async () => {
    h = await setup();
    expect((await h.create(base({ comp_max: 200000, meets_floor: false }))).meets_floor).toBe(true);
    const other = await h.create(base({ company: "Other", comp_max: 100000, meets_floor: true }));
    expect(other.meets_floor).toBe(false);
    const none = await h.create(base({ company: "Third", meets_floor: true }));
    expect(none.meets_floor).toBeNull();
    const [row] = await h.db.select().from(applications).where(eq(applications.id, none.id));
    expect(row.meets_floor).toBeNull();
  });
});

describe("POST /applications: unknown and server-managed fields", () => {
  it("unknown fields go to extra and come back flattened", async () => {
    h = await setup();
    const rec = await h.create(base({ favorite_color: "teal", ats: { name: "greenhouse", n: 2 } }));
    expect(rec.favorite_color).toBe("teal");
    expect(rec.ats).toEqual({ name: "greenhouse", n: 2 });
    expect(rec).not.toHaveProperty("extra");
    const [row] = await h.db.select().from(applications);
    expect(row.extra).toEqual({ favorite_color: "teal", ats: { name: "greenhouse", n: 2 } });
    const again = await h.get(ACME_ID);
    expect(again.favorite_color).toBe("teal");
  });

  it("server-managed keys are ignored", async () => {
    h = await setup();
    const rec = await h.create(
      base({
        id: "hacked--id--2020-01-01",
        created_at: "2000-01-01T00:00:00.000Z",
        updated_at: "2000-01-01T00:00:00.000Z",
        updated_by: "tracker-app",
        events: [{ type: "note", note: "forged", by: "tracker-app", at: "2000-01-01T00:00:00.000Z" }],
        contacts: [{ id: "forged" }],
        extra: { smuggled: 1 },
      }),
    );
    expect(rec.id).toBe(ACME_ID);
    expect(rec.created_at).toBe(NOW_ISO);
    expect(rec.updated_at).toBe(NOW_ISO);
    expect(rec.updated_by).toBe("dakota");
    expect(rec.events.map((e: { type: string }) => e.type)).toEqual(["discovered"]);
    expect(rec.contacts).toEqual([]);
    expect(rec).not.toHaveProperty("smuggled");
    expect(rec).not.toHaveProperty("extra");
    const [row] = await h.db.select().from(applications);
    expect(row.extra).toEqual({});
    expect((await h.counts()).applications).toBe(1);
  });
});

describe("POST /applications: validation (400 with details paths)", () => {
  it("an empty body names every required field", async () => {
    h = await setup();
    const r = await h.call("POST", "/applications", { body: {} });
    expectEnvelope(r, 400, "bad_request");
    expect(detailPaths(r.json)).toEqual(["company", "role_title", "status", "work_arrangement"]);
    for (const d of r.json.error.details) expect(typeof d.message).toBe("string");
    expect(await h.counts()).toEqual({ applications: 0, events: 0, links: 0, contacts: 0 });
  });

  it.each([
    ["bad status", { status: "nope" }, "status"],
    ["bad work_arrangement", { work_arrangement: "office" }, "work_arrangement"],
    ["bad track", { track: "janitor" }, "track"],
    ["bad source", { source: "billboard" }, "source"],
    ["bad priority", { priority: "urgent" }, "priority"],
    ["bad discovered_at (not a date)", { discovered_at: "10/07/2026" }, "discovered_at"],
    ["bad discovered_at (impossible day)", { discovered_at: "2026-02-30" }, "discovered_at"],
    ["bad next_action_due", { next_action_due: "tomorrow" }, "next_action_due"],
    ["bad follow_up_date", { follow_up_date: "2026-13-01" }, "follow_up_date"],
    ["non-integer comp", { comp_min: 150000.5 }, "comp_min"],
    ["string comp", { comp_max: "160000" }, "comp_max"],
    ["relative posting_url", { posting_url: "/jobs/1" }, "posting_url"],
    ["non-http posting_url", { posting_url: "ftp://example.com/x" }, "posting_url"],
    ["fit.total over 100", { fit: { total: 101 } }, "fit.total"],
    ["detroit_metro not a boolean", { detroit_metro: "yes" }, "detroit_metro"],
    ["blank company", { company: "   " }, "company"],
    ["company of the wrong type", { company: 7 }, "company"],
  ])("%s -> 400 naming %s and creating nothing", async (_name, extra, path) => {
    h = await setup();
    const r = await h.call("POST", "/applications", { body: base(extra) });
    expectEnvelope(r, 400, "bad_request");
    expect(detailPaths(r.json)).toContain(path);
    expect((await h.counts()).applications).toBe(0);
  });

  it("a company with no letters or digits cannot form an id: 400, not 500", async () => {
    h = await setup();
    const r = await h.call("POST", "/applications", { body: base({ company: "!!!" }) });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("bad_request");
  });

  it("a body that is not JSON is 400", async () => {
    h = await setup();
    const r = await h.call("POST", "/applications", { raw: "{not json" });
    expectEnvelope(r, 400, "bad_request");
  });
});

describe("POST /applications: duplicates (409 plus the existing record)", () => {
  it("the same generated id is 409 with the existing full record, and nothing is added", async () => {
    h = await setup();
    const first = await h.create(base({ notes: "original" }));
    h.clock.set(new Date("2026-10-07T15:00:00.000Z"));
    const r = await h.call("POST", "/applications", { body: base({ notes: "second attempt" }) });
    expectEnvelope(r, 409, "conflict");
    expect(r.json.record).toEqual(first);
    expect(r.json.record.notes).toBe("original");
    expect(await h.counts()).toEqual({ applications: 1, events: 1, links: 0, contacts: 0 });
  });

  it("the same posting_url under another id is 409 with the existing record", async () => {
    h = await setup();
    const first = await h.create(base({ posting_url: "https://jobs.example.com/p/1" }));
    const r = await h.call("POST", "/applications", {
      body: base({ company: "Different Co", posting_url: "https://jobs.example.com/p/1" }),
    });
    expectEnvelope(r, 409, "conflict");
    expect(r.json.record).toEqual(first);
    expect((await h.counts()).applications).toBe(1);
  });

  it("posting_url is compared trimmed", async () => {
    h = await setup();
    const first = await h.create(base({ posting_url: "https://jobs.example.com/p/2" }));
    const r = await h.call("POST", "/applications", {
      body: base({ company: "Different Co", posting_url: "  https://jobs.example.com/p/2  " }),
    });
    expectEnvelope(r, 409, "conflict");
    expect(r.json.record.id).toBe(first.id);
    expect((await h.counts()).applications).toBe(1);
  });

  it("posting_url comparison is exact: a different path case is a new record", async () => {
    h = await setup();
    await h.create(base({ posting_url: "https://jobs.example.com/p/abc" }));
    const r = await h.call("POST", "/applications", {
      body: base({ company: "Different Co", posting_url: "https://jobs.example.com/p/ABC" }),
    });
    expect(r.status).toBe(201);
    expect((await h.counts()).applications).toBe(2);
  });

  it("a retried identical agent POST is 409 with the existing record and still one row", async () => {
    h = await setup();
    const body = base({ posting_url: "https://jobs.example.com/p/9", comp_max: 170000 });
    const first = await h.call("POST", "/applications", { as: "agent", body });
    expect(first.status).toBe(201);
    h.clock.set(new Date("2026-10-07T14:00:30.000Z"));
    const retry = await h.call("POST", "/applications", { as: "agent", body });
    expectEnvelope(retry, 409, "conflict");
    expect(retry.json.record).toEqual(first.json);
    expect(retry.json.record.updated_by).toBe("claude-project");
    expect(await h.counts()).toEqual({ applications: 1, events: 1, links: 0, contacts: 0 });
  });
});

describe("POST /applications: contact_ids", () => {
  it("links existing contacts and returns the ids sorted, with the contact records", async () => {
    h = await setup();
    await h.addContact("zed--acme", "Zed");
    await h.addContact("amy--acme", "Amy");
    const rec = await h.create(base({ contact_ids: ["zed--acme", "amy--acme"] }));
    expect(rec.contact_ids).toEqual(["amy--acme", "zed--acme"]);
    expect(rec.contacts.map((c: { id: string; name: string }) => [c.id, c.name])).toEqual([
      ["amy--acme", "Amy"],
      ["zed--acme", "Zed"],
    ]);
    const links = await h.db.select().from(applicationContacts);
    expect(links.map((l) => l.contact_id).sort()).toEqual(["amy--acme", "zed--acme"]);
    expect((await h.get(ACME_ID)).contact_ids).toEqual(["amy--acme", "zed--acme"]);
  });

  it("an unknown contact id is 400 naming contact_ids, and nothing is created", async () => {
    h = await setup();
    await h.addContact("amy--acme");
    const r = await h.call("POST", "/applications", { body: base({ contact_ids: ["amy--acme", "ghost"] }) });
    expectEnvelope(r, 400, "bad_request");
    expect(detailPaths(r.json).some((p) => p === "contact_ids" || p.startsWith("contact_ids"))).toBe(true);
    expect(await h.counts()).toEqual({ applications: 0, events: 0, links: 0, contacts: 1 });
  });
});

describe("POST /applications: automatic dates (A.7)", () => {
  it("status applied sets applied_at to today", async () => {
    h = await setup();
    const rec = await h.create(base({ status: "applied" }));
    expect(rec.applied_at).toBe("2026-10-07");
    expect(rec.closed_at).toBeNull();
    expect(rec.events.map((e: { type: string }) => e.type)).toEqual(["discovered"]);
  });

  it("applied_at uses the Detroit date, not the UTC date", async () => {
    h = await setup(new Date("2026-10-08T02:00:00.000Z"));
    expect((await h.create(base({ status: "applied" }))).applied_at).toBe("2026-10-07");
  });

  it("an explicit applied_at is kept", async () => {
    h = await setup();
    expect((await h.create(base({ status: "applied", applied_at: "2026-09-30" }))).applied_at).toBe("2026-09-30");
  });

  it.each(["rejected", "withdrawn", "closed"])("status %s sets closed_at to today", async (status) => {
    h = await setup();
    const rec = await h.create(base({ status }));
    expect(rec.closed_at).toBe("2026-10-07");
    expect(rec.applied_at).toBeNull();
  });

  it("an explicit closed_at is kept", async () => {
    h = await setup();
    expect((await h.create(base({ status: "closed", closed_at: "2026-10-01" }))).closed_at).toBe("2026-10-01");
  });

  it.each(["watching", "shortlisted", "preparing", "screen", "interviewing", "offer", "accepted"])(
    "status %s sets neither date",
    async (status) => {
      h = await setup();
      const rec = await h.create(base({ status }));
      expect(rec.applied_at).toBeNull();
      expect(rec.closed_at).toBeNull();
    },
  );
});
