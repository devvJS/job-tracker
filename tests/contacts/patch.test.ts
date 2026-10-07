import { afterEach, describe, expect, it } from "vitest";
import { contacts } from "../../db/schema.ts";
import { TEST_NOW } from "../helpers/config.ts";
import { createClock } from "../helpers/auth.ts";
import { type Harness, get, insertContact, patch, post, send, setup } from "./helpers/setup.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const LATER = new Date("2026-10-08T09:30:15.250Z");

async function withClock() {
  const clock = createClock(TEST_NOW);
  const harness = await setup({ now: clock.now });
  h = harness;
  const created = await post(harness, {
    name: "Pat Example",
    company: "Patco",
    role: "Recruiter",
    relationship: "recruiter",
    email: "pat@patco.test",
    notes: "first note",
    pronouns: "they/them",
    keep: "me",
  });
  expect(created.res.status).toBe(201);
  return { harness, clock, created: created.json };
}

describe("PATCH /contacts/:id: preconditions", () => {
  it("428 precondition_required without If-Match, and nothing changes", async () => {
    const { harness, created } = await withClock();
    const { res, json } = await patch(harness, created.id, { notes: "changed" }, null);
    expect(res.status).toBe(428);
    expect(json.error?.code).toBe("precondition_required");
    expect((await get(harness, `/contacts/${created.id}`)).json).toEqual(created);
  });

  it("412 precondition_failed when stale, with the current record, and nothing changes", async () => {
    const { harness, clock, created } = await withClock();
    clock.set(LATER);
    const first = await patch(harness, created.id, { notes: "newer" }, created.updated_at);
    expect(first.res.status).toBe(200);
    // second writer still holds the old updated_at
    const stale = await patch(harness, created.id, { notes: "lost update" }, created.updated_at);
    expect(stale.res.status).toBe(412);
    expect(stale.json.error?.code).toBe("precondition_failed");
    expect(stale.json.record).toEqual(first.json);
    expect(stale.json.record.notes).toBe("newer");
    expect((await get(harness, `/contacts/${created.id}`)).json.notes).toBe("newer");
  });

  it("412 for an If-Match that is not any updated_at", async () => {
    const { harness, created } = await withClock();
    const { res, json } = await patch(harness, created.id, { notes: "x" }, "2020-01-01T00:00:00.000Z");
    expect(res.status).toBe(412);
    expect(json.record).toEqual(created);
  });

  it("an If-Match that is the same instant in another spelling matches (compared as an instant)", async () => {
    const { harness, created } = await withClock();
    const { res, json } = await patch(harness, created.id, { notes: "same instant" }, "2026-10-07T14:00:00Z");
    expect(res.status).toBe(200);
    expect(json.notes).toBe("same instant");
  });

  it("unknown id with an If-Match: 404", async () => {
    h = await setup();
    const real = await post(h, { name: "Real One" }); // control: a real id patches fine
    expect((await patch(h, real.json.id, { notes: "ok" }, real.json.updated_at)).res.status).toBe(200);
    const { res, json } = await patch(h, "ghost--nowhere", { notes: "x" }, "2026-10-07T14:00:00.000Z");
    expect(res.status).toBe(404);
    expect(json.error?.code).toBe("not_found");
  });
});

describe("PATCH /contacts/:id: updates", () => {
  it("a partial update changes only the given fields and sets updated_at and updated_by from now and the actor", async () => {
    const { harness, clock, created } = await withClock();
    clock.set(LATER);
    const { res, json } = await patch(harness, created.id, { notes: "second note" }, created.updated_at, harness.agent);
    expect(res.status).toBe(200);
    expect(json).toEqual({
      ...created,
      notes: "second note",
      updated_at: "2026-10-08T09:30:15.250Z",
      updated_by: "claude-project",
    });
    expect(json.created_at).toBe(created.created_at);
    const got = await get(harness, `/contacts/${created.id}`);
    expect(got.json).toEqual(json);
  });

  it("the new updated_at works as the next If-Match, exactly as returned", async () => {
    const { harness, clock, created } = await withClock();
    clock.set(LATER);
    const one = await patch(harness, created.id, { role: "Lead" }, created.updated_at);
    expect(one.json.updated_at).toBe("2026-10-08T09:30:15.250Z");
    clock.set(new Date("2026-10-09T00:00:00.000Z"));
    const two = await patch(harness, created.id, { role: "Director" }, one.json.updated_at);
    expect(two.res.status).toBe(200);
    expect(two.json.role).toBe("Director");
    expect(two.json.updated_at).toBe("2026-10-09T00:00:00.000Z");
    expect(two.json.updated_by).toBe("dakota");
  });

  it("every writable field can be updated", async () => {
    const { harness, created } = await withClock();
    const { res, json } = await patch(
      harness,
      created.id,
      {
        company: "Newco",
        role: "VP",
        relationship: "hiring-manager",
        linkedin_url: "https://linkedin.com/in/pat",
        email: "pat@newco.test",
        last_contact_at: "2026-10-05",
        notes: "n",
      },
      created.updated_at,
    );
    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      name: "Pat Example", company: "Newco", role: "VP", relationship: "hiring-manager",
      linkedin_url: "https://linkedin.com/in/pat", email: "pat@newco.test", last_contact_at: "2026-10-05", notes: "n",
    });
  });

  it("the id does not change on a rename or a company change", async () => {
    const { harness, created } = await withClock();
    const { res, json } = await patch(harness, created.id, { name: "Patricia Renamed", company: "Elsewhere" }, created.updated_at);
    expect(res.status).toBe(200);
    expect(json.id).toBe("pat-example--patco");
    expect(json.name).toBe("Patricia Renamed");
    expect((await get(harness, "/contacts/pat-example--patco")).json.name).toBe("Patricia Renamed");
    expect((await get(harness, "/contacts/patricia-renamed--elsewhere")).res.status).toBe(404);
    expect(await harness.db.select({ id: contacts.id }).from(contacts)).toEqual([{ id: "pat-example--patco" }]);
  });

  it("null clears an optional field", async () => {
    const { harness, created } = await withClock();
    const { res, json } = await patch(
      harness,
      created.id,
      { company: null, role: null, relationship: null, email: null, notes: null },
      created.updated_at,
    );
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ company: null, role: null, relationship: null, email: null, notes: null });
    expect(json.id).toBe("pat-example--patco");
    expect(json.name).toBe("Pat Example");
  });

  it("name: null is 400 naming name, and nothing changes", async () => {
    const { harness, created } = await withClock();
    const { res, json } = await patch(harness, created.id, { name: null }, created.updated_at);
    expect(res.status).toBe(400);
    expect(json.error?.code).toBe("bad_request");
    expect((json.error?.details ?? []).map((d: { path: string }) => d.path)).toEqual(["name"]);
    expect((await get(harness, `/contacts/${created.id}`)).json).toEqual(created);
  });

  it("invalid values are 400 with a details path", async () => {
    const { harness, created } = await withClock();
    const bad = await patch(harness, created.id, { relationship: "buddy", linkedin_url: "nope" }, created.updated_at);
    expect(bad.res.status).toBe(400);
    expect((bad.json.error?.details ?? []).map((d: { path: string }) => d.path).sort()).toEqual(["linkedin_url", "relationship"]);
    const blank = await patch(harness, created.id, { name: "  " }, created.updated_at);
    expect(blank.res.status).toBe(400);
  });

  it("validation runs against a fresh If-Match: a 400 does not touch the record", async () => {
    const { harness, created } = await withClock();
    await patch(harness, created.id, { relationship: "buddy" }, created.updated_at);
    expect((await get(harness, `/contacts/${created.id}`)).json.updated_at).toBe(created.updated_at);
  });

  it("extra keys merge into the existing extra, and null removes one", async () => {
    const { harness, created } = await withClock();
    const merged = await patch(harness, created.id, { timezone: "EST", pronouns: "she/her" }, created.updated_at);
    expect(merged.res.status).toBe(200);
    expect(merged.json.pronouns).toBe("she/her");
    expect(merged.json.timezone).toBe("EST");
    expect(merged.json.keep).toBe("me");
    const [row] = await harness.db.select().from(contacts);
    expect(row.extra).toEqual({ pronouns: "she/her", keep: "me", timezone: "EST" });

    const removed = await patch(harness, created.id, { keep: null, timezone: null }, merged.json.updated_at);
    expect(removed.res.status).toBe(200);
    expect("keep" in removed.json).toBe(false);
    expect("timezone" in removed.json).toBe(false);
    expect(removed.json.pronouns).toBe("she/her");
    const [row2] = await harness.db.select().from(contacts);
    expect(row2.extra).toEqual({ pronouns: "she/her" });
  });

  it("server-managed keys in a patch are ignored", async () => {
    const { harness, clock, created } = await withClock();
    clock.set(LATER);
    const { res, json } = await patch(
      harness,
      created.id,
      {
        notes: "managed",
        id: "other-id",
        created_at: "2000-01-01T00:00:00.000Z",
        updated_at: "2000-01-01T00:00:00.000Z",
        updated_by: "tracker-app",
        application_ids: ["a"],
        extra: { sneaky: 1 },
        meets_floor: true,
      },
      created.updated_at,
    );
    expect(res.status).toBe(200);
    expect(json.id).toBe(created.id);
    expect(json.created_at).toBe(created.created_at);
    expect(json.updated_at).toBe("2026-10-08T09:30:15.250Z");
    expect(json.updated_by).toBe("dakota");
    expect(json.application_ids).toEqual([]);
    expect("sneaky" in json).toBe(false);
    expect("extra" in json).toBe(false);
    expect("meets_floor" in json).toBe(false);
    const [row] = await harness.db.select().from(contacts);
    expect(row.extra).toEqual({ pronouns: "they/them", keep: "me" });
  });

  it("the response keeps application_ids", async () => {
    const { harness, created } = await withClock();
    const { insertApplication, linkContact } = await import("./helpers/setup.ts");
    await insertApplication(harness, "b--role--2026-10-01");
    await insertApplication(harness, "a--role--2026-10-01");
    await linkContact(harness, "b--role--2026-10-01", created.id);
    await linkContact(harness, "a--role--2026-10-01", created.id);
    const { res, json } = await patch(harness, created.id, { notes: "linked" }, created.updated_at);
    expect(res.status).toBe(200);
    expect(json.application_ids).toEqual(["a--role--2026-10-01", "b--role--2026-10-01"]);
  });

  it("a PATCH body that is not a JSON object: 400", async () => {
    const { harness, created } = await withClock();
    const { res, json } = await send(harness, "PATCH", `/contacts/${created.id}`, {
      raw: "[1]",
      headers: { ...harness.session, "Content-Type": "application/json", "If-Match": created.updated_at },
    });
    expect(res.status).toBe(400);
    expect(json.error?.code).toBe("bad_request");
  });
});

describe("PATCH /contacts/:id: other rows are untouched", () => {
  const T0 = "2026-10-02T08:00:00.000Z";

  async function three() {
    const harness = await setup();
    h = harness;
    await insertContact(harness, { id: "target-one", name: "Target One", company: "T", extra: { k: 1 } });
    await insertContact(harness, { id: "bystander-a", name: "Bystander A", extra: { a: true } });
    await insertContact(harness, { id: "bystander-b", name: "Bystander B", company: "B" });
    const snap = async () => ({
      a: await get(harness, "/contacts/bystander-a"),
      b: await get(harness, "/contacts/bystander-b"),
      rows: (await harness.db.select().from(contacts)).filter((r) => r.id !== "target-one").sort((x, y) => (x.id < y.id ? -1 : 1)),
    });
    return { harness, snap };
  }

  it("a successful PATCH changes only the target row", async () => {
    const { harness, snap } = await three();
    const before = await snap();
    expect(before.a.json.updated_at).toBe(T0);
    const { res, json } = await patch(harness, "target-one", { notes: "changed", k: 2 }, T0, harness.agent);
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ notes: "changed", updated_at: "2026-10-07T14:00:00.000Z", updated_by: "claude-project" });
    const after = await snap();
    expect(after.a.json).toEqual(before.a.json);
    expect(after.b.json).toEqual(before.b.json);
    expect(after.rows).toEqual(before.rows);
    expect(after.a.json.updated_by).toBe("dakota");
    expect(after.b.json.updated_at).toBe(T0);
  });

  it("a 412 changes no row", async () => {
    const { harness, snap } = await three();
    const before = await snap();
    const target = await get(harness, "/contacts/target-one");
    const { res } = await patch(harness, "target-one", { notes: "nope" }, "2020-01-01T00:00:00.000Z");
    expect(res.status).toBe(412);
    expect((await snap())).toEqual(before);
    expect((await get(harness, "/contacts/target-one")).json).toEqual(target.json);
  });

  it("a 400 changes no row", async () => {
    const { harness, snap } = await three();
    const before = await snap();
    const target = await get(harness, "/contacts/target-one");
    const { res } = await patch(harness, "target-one", { relationship: "buddy" }, T0);
    expect(res.status).toBe(400);
    expect((await snap())).toEqual(before);
    expect((await get(harness, "/contacts/target-one")).json).toEqual(target.json);
  });
});
