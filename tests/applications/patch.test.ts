import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { applicationContacts, applications, events } from "../../db/schema.ts";
import { TEST_NOW } from "../helpers/config.ts";
import { ACME_ID, base, detailPaths, expectEnvelope, minutes, setup, type Harness, type Json } from "./helpers/harness.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const url = `/applications/${ACME_ID}`;
const LATER = minutes(TEST_NOW, 60);
const LATER_ISO = LATER.toISOString();

async function created(body: Record<string, unknown> = {}) {
  h = await setup();
  return h.create(base(body));
}
const types = (rec: Json) => rec.events.map((e: { type: string }) => e.type);

describe("PATCH /applications/:id: If-Match", () => {
  it("without If-Match is 428 and changes nothing", async () => {
    const rec = await created();
    const r = await h!.call("PATCH", url, { body: { notes: "x" } });
    expectEnvelope(r, 428, "precondition_required");
    expect(await h!.get(ACME_ID)).toEqual(rec);
  });

  it("a stale If-Match is 412 with the current full record and changes nothing", async () => {
    const rec = await created();
    h!.clock.set(LATER);
    const first = await h!.patch(ACME_ID, { notes: "first" }, rec.updated_at);
    const r = await h!.call("PATCH", url, { body: { notes: "second" }, headers: { "If-Match": rec.updated_at } });
    expectEnvelope(r, 412, "precondition_failed");
    expect(r.json.record).toEqual(first);
    expect(r.json.record.notes).toBe("first");
    expect(await h!.get(ACME_ID)).toEqual(first);
  });

  it("succeeds with the exact updated_at from the previous response, and chains", async () => {
    const rec = await created();
    h!.clock.set(LATER);
    const one = await h!.patch(ACME_ID, { notes: "one" }, rec.updated_at);
    h!.clock.set(minutes(TEST_NOW, 120));
    const two = await h!.patch(ACME_ID, { notes: "two" }, one.updated_at);
    expect(two.notes).toBe("two");
    expect(two.updated_at).toBe(minutes(TEST_NOW, 120).toISOString());
  });

  it.each([
    ["no milliseconds", "2026-10-07T14:00:00Z"],
    ["an explicit +00:00 offset", "2026-10-07T14:00:00.000+00:00"],
    ["the same instant in another offset", "2026-10-07T10:00:00.000-04:00"],
  ])("If-Match is compared as an instant (%s)", async (_n, value) => {
    await created();
    h!.clock.set(LATER);
    const r = await h!.call("PATCH", url, { body: { notes: "ok" }, headers: { "If-Match": value } });
    expect(r.status).toBe(200);
    expect(r.json.notes).toBe("ok");
  });

  it("an If-Match one millisecond off is 412", async () => {
    await created();
    const r = await h!.call("PATCH", url, {
      body: { notes: "x" },
      headers: { "If-Match": "2026-10-07T14:00:00.001Z" },
    });
    expectEnvelope(r, 412, "precondition_failed");
  });

  it("an unknown id is 404", async () => {
    await created();
    const r = await h!.call("PATCH", "/applications/nope--nope--2026-10-07", {
      body: { notes: "x" },
      headers: { "If-Match": TEST_NOW.toISOString() },
    });
    expectEnvelope(r, 404, "not_found");
  });

  it("an invalid body with a valid If-Match is 400", async () => {
    const rec = await created();
    const r = await h!.call("PATCH", url, { body: { status: "nope" }, headers: { "If-Match": rec.updated_at } });
    expectEnvelope(r, 400, "bad_request");
    expect(detailPaths(r.json)).toContain("status");
  });
});

describe("PATCH /applications/:id: field updates", () => {
  it("is partial: only the sent fields change; updated_at/updated_by come from now and the actor", async () => {
    const rec = await created({ location: "Dearborn, MI", track: "ai-engineer", notes: "old" });
    h!.clock.set(LATER);
    const out = await h!.patch(ACME_ID, { notes: "new" }, rec.updated_at, "agent");
    expect(out).toEqual({ ...rec, notes: "new", updated_at: LATER_ISO, updated_by: "claude-project" });
    expect(await h!.get(ACME_ID)).toEqual(out);
    const [row] = await h!.db.select().from(applications);
    expect(row.updated_at.toISOString()).toBe(LATER_ISO);
    expect(row.created_at.toISOString()).toBe(TEST_NOW.toISOString());
  });

  it("a session patch is attributed to dakota", async () => {
    const rec = await created();
    h!.clock.set(LATER);
    expect((await h!.patch(ACME_ID, { notes: "x" }, rec.updated_at)).updated_by).toBe("dakota");
  });

  it("null clears an optional field, including nested objects and arrays", async () => {
    const rec = await created({
      location: "Dearborn, MI",
      comp_max: 160000,
      fit: { total: 80 },
      mission_interest: ["art"],
      next_action_due: "2026-10-10",
    });
    const out = await h!.patch(
      ACME_ID,
      { location: null, fit: null, mission_interest: null, next_action_due: null },
      rec.updated_at,
    );
    expect(out.location).toBeNull();
    expect(out.fit).toBeNull();
    expect(out.mission_interest).toBeNull();
    expect(out.next_action_due).toBeNull();
    expect(out.comp_max).toBe(160000);
  });

  it.each(["company", "role_title", "work_arrangement", "status", "discovered_at"])(
    "null on required field %s is 400 and changes nothing",
    async (field) => {
      const rec = await created();
      const r = await h!.call("PATCH", url, { body: { [field]: null }, headers: { "If-Match": rec.updated_at } });
      expectEnvelope(r, 400, "bad_request");
      expect(detailPaths(r.json)).toContain(field);
      expect(await h!.get(ACME_ID)).toEqual(rec);
    },
  );

  it.each([
    [{ work_arrangement: "office" }, "work_arrangement"],
    [{ next_action_due: "2026-02-30" }, "next_action_due"],
    [{ comp_min: 1.5 }, "comp_min"],
    [{ fit: { total: 200 } }, "fit.total"],
  ])("invalid %j -> 400 naming %s", async (body, path) => {
    const rec = await created();
    const r = await h!.call("PATCH", url, { body, headers: { "If-Match": rec.updated_at } });
    expectEnvelope(r, 400, "bad_request");
    expect(detailPaths(r.json)).toContain(path);
  });

  it("unknown keys merge into extra and null removes one", async () => {
    const rec = await created({ keep: 1, drop: 2 });
    const out = await h!.patch(ACME_ID, { drop: null, added: { a: [1] } }, rec.updated_at);
    expect(out.keep).toBe(1);
    expect(out.added).toEqual({ a: [1] });
    expect(out).not.toHaveProperty("drop");
    const [row] = await h!.db.select().from(applications);
    expect(row.extra).toEqual({ keep: 1, added: { a: [1] } });
  });

  it("server-managed keys are ignored", async () => {
    const rec = await created({ comp_max: 100000 });
    h!.clock.set(LATER);
    const out = await h!.patch(
      ACME_ID,
      { id: "other--id--2020-01-01", created_at: "2000-01-01T00:00:00.000Z", updated_by: "tracker-app", meets_floor: true, events: [], extra: { z: 1 } },
      rec.updated_at,
    );
    expect(out.id).toBe(ACME_ID);
    expect(out.created_at).toBe(TEST_NOW.toISOString());
    expect(out.updated_by).toBe("dakota");
    expect(out.updated_at).toBe(LATER_ISO);
    expect(out.meets_floor).toBe(false);
    expect(out.events).toHaveLength(1);
    expect(out).not.toHaveProperty("z");
  });

  it("the id does not change when the company or role changes", async () => {
    const rec = await created();
    const out = await h!.patch(ACME_ID, { company: "Renamed Inc", role_title: "Staff Engineer" }, rec.updated_at);
    expect(out.id).toBe(ACME_ID);
    expect(out.company).toBe("Renamed Inc");
    expect(out.role_title).toBe("Staff Engineer");
    expect((await h!.get(ACME_ID)).company).toBe("Renamed Inc");
    expect((await h!.counts()).applications).toBe(1);
    expect((await h!.call("GET", "/applications/renamed-inc--staff-engineer--2026-10-07")).status).toBe(404);
  });
});

describe("PATCH /applications/:id: meets_floor recomputed", () => {
  it("follows comp changes and ignores a client value", async () => {
    const rec = await created({ comp_max: 160000 });
    expect(rec.meets_floor).toBe(true);
    const a = await h!.patch(ACME_ID, { comp_max: 100000 }, rec.updated_at);
    expect(a.meets_floor).toBe(false);
    const b = await h!.patch(ACME_ID, { comp_max: null, comp_min: 155000 }, a.updated_at);
    expect(b.meets_floor).toBe(true);
    const c = await h!.patch(ACME_ID, { comp_min: null, meets_floor: true }, b.updated_at);
    expect(c.meets_floor).toBeNull();
  });

  it("uses the stored value of the comp field that was not sent", async () => {
    const rec = await created({ comp_min: 100000 });
    expect(rec.meets_floor).toBe(false);
    const a = await h!.patch(ACME_ID, { comp_min: 155000 }, rec.updated_at);
    expect(a.meets_floor).toBe(true);
    const b = await h!.patch(ACME_ID, { comp_max: 120000 }, a.updated_at);
    expect(b.meets_floor).toBe(false); // top is now comp_max
    const [row] = await h!.db.select().from(applications);
    expect(row.meets_floor).toBe(false);
  });

  it("an unrelated patch keeps it", async () => {
    const rec = await created({ comp_max: 160000 });
    expect((await h!.patch(ACME_ID, { notes: "x" }, rec.updated_at)).meets_floor).toBe(true);
  });
});

describe("PATCH /applications/:id: status changes", () => {
  it("inserts exactly one status-change event with from, to, note and actor", async () => {
    const rec = await created();
    h!.clock.set(LATER);
    const out = await h!.patch(ACME_ID, { status: "shortlisted" }, rec.updated_at, "agent");
    expect(out.status).toBe("shortlisted");
    expect(out.events).toHaveLength(2);
    expect(out.events[1]).toEqual({
      id: expect.any(String),
      application_id: ACME_ID,
      at: LATER_ISO,
      type: "status-change",
      note: "watching → shortlisted",
      by: "claude-project",
      from_status: "watching",
      to_status: "shortlisted",
    });
    expect(await h!.db.select().from(events).where(eq(events.application_id, ACME_ID))).toHaveLength(2);
  });

  it("one event per change, with the right from/to each time; a same-status patch adds none", async () => {
    const rec = await created();
    const a = await h!.patch(ACME_ID, { status: "applied" }, rec.updated_at);
    const b = await h!.patch(ACME_ID, { status: "applied", notes: "same status" }, a.updated_at);
    expect(types(b)).toEqual(["discovered", "status-change"]);
    const c = await h!.patch(ACME_ID, { status: "screen" }, b.updated_at);
    expect(c.events.filter((e: Json) => e.type === "status-change").map((e: Json) => e.note)).toEqual([
      "watching → applied",
      "applied → screen",
    ]);
  });

  it("a patch that does not touch status adds no event", async () => {
    const rec = await created();
    const out = await h!.patch(ACME_ID, { notes: "x", company: "Other" }, rec.updated_at);
    expect(types(out)).toEqual(["discovered"]);
  });

  it("a status change with other fields still logs one event", async () => {
    const rec = await created();
    const out = await h!.patch(ACME_ID, { status: "preparing", notes: "n", priority: "high" }, rec.updated_at);
    expect(types(out)).toEqual(["discovered", "status-change"]);
    expect(out.priority).toBe("high");
  });

  it("is atomic: a failing contact link leaves status, row and events untouched", async () => {
    const rec = await created();
    h!.clock.set(LATER);
    const r = await h!.call("PATCH", url, {
      body: { status: "applied", notes: "should not stick", contact_ids: ["ghost"] },
      headers: { "If-Match": rec.updated_at },
    });
    expectEnvelope(r, 400, "bad_request");
    expect(await h!.get(ACME_ID)).toEqual(rec);
    expect(await h!.db.select().from(events)).toHaveLength(1);
  });
});

describe("PATCH /applications/:id: automatic dates (A.7)", () => {
  it("moving to applied sets applied_at to today in Detroit", async () => {
    const rec = await created();
    h!.clock.set(new Date("2026-10-09T02:30:00.000Z")); // 22:30 on Oct 8 in Detroit
    const out = await h!.patch(ACME_ID, { status: "applied" }, rec.updated_at);
    expect(out.applied_at).toBe("2026-10-08");
    expect(out.closed_at).toBeNull();
  });

  it("an existing applied_at is not overwritten", async () => {
    const rec = await created({ status: "preparing", applied_at: "2026-09-01" });
    h!.clock.set(LATER);
    expect((await h!.patch(ACME_ID, { status: "applied" }, rec.updated_at)).applied_at).toBe("2026-09-01");
  });

  it("a status change that sends its own applied_at uses it", async () => {
    const rec = await created();
    const out = await h!.patch(ACME_ID, { status: "applied", applied_at: "2026-10-02" }, rec.updated_at);
    expect(out.applied_at).toBe("2026-10-02");
  });

  it.each(["rejected", "withdrawn", "closed"])("moving to %s sets closed_at to today", async (status) => {
    const rec = await created({ status: "applied" });
    h!.clock.set(LATER);
    const out = await h!.patch(ACME_ID, { status }, rec.updated_at);
    expect(out.closed_at).toBe("2026-10-07");
    expect(out.applied_at).toBe("2026-10-07");
  });

  it("an existing closed_at is not overwritten", async () => {
    const rec = await created({ status: "applied", closed_at: "2026-10-01" });
    expect((await h!.patch(ACME_ID, { status: "rejected" }, rec.updated_at)).closed_at).toBe("2026-10-01");
  });

  it("moving to screen sets neither date", async () => {
    const rec = await created();
    const out = await h!.patch(ACME_ID, { status: "screen" }, rec.updated_at);
    expect(out.applied_at).toBeNull();
    expect(out.closed_at).toBeNull();
  });

  it("a patch that does not change status sets no date", async () => {
    const rec = await created({ status: "watching" });
    const out = await h!.patch(ACME_ID, { status: "watching", notes: "x" }, rec.updated_at);
    expect(out.applied_at).toBeNull();
    expect(out.closed_at).toBeNull();
    const applied = await h!.patch(ACME_ID, { status: "applied" }, out.updated_at);
    const again = await h!.patch(ACME_ID, { status: "applied", notes: "y" }, applied.updated_at);
    expect(again.applied_at).toBe("2026-10-07");
  });
});

describe("PATCH /applications/:id: contact_ids", () => {
  it("replaces the set; omitting it leaves it; [] clears it; an unknown id is 400", async () => {
    h = await setup();
    for (const c of ["a", "b", "c"]) await h.addContact(c);
    const rec = await h.create(base({ contact_ids: ["a", "b"] }));
    const noChange = await h.patch(ACME_ID, { notes: "x" }, rec.updated_at);
    expect(noChange.contact_ids).toEqual(["a", "b"]);
    const swapped = await h.patch(ACME_ID, { contact_ids: ["c", "a"] }, noChange.updated_at);
    expect(swapped.contact_ids).toEqual(["a", "c"]);
    expect(swapped.contacts.map((c: Json) => c.id)).toEqual(["a", "c"]);
    expect((await h.db.select().from(applicationContacts)).map((l) => l.contact_id).sort()).toEqual(["a", "c"]);
    const bad = await h.call("PATCH", url, { body: { contact_ids: ["a", "ghost"] }, headers: { "If-Match": swapped.updated_at } });
    expectEnvelope(bad, 400, "bad_request");
    expect((await h.get(ACME_ID)).contact_ids).toEqual(["a", "c"]);
    const cleared = await h.patch(ACME_ID, { contact_ids: [] }, swapped.updated_at);
    expect(cleared.contact_ids).toEqual([]);
    expect(cleared.contacts).toEqual([]);
    expect((await h.counts()).links).toBe(0);
    expect((await h.counts()).contacts).toBe(3);
  });
});
