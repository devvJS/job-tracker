import { afterEach, describe, expect, it } from "vitest";
import { type Harness, type Json, get, insertApplication, insertContact, linkContact, setup } from "./helpers/setup.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function seed(harness: Harness) {
  // created out of name order on purpose
  await insertContact(harness, { id: "carol-danvers--avengers-llc", name: "Carol Danvers", company: "Avengers LLC" });
  await insertContact(harness, { id: "alice-smith--bluebird", name: "Alice Smith", company: "Bluebird" });
  await insertContact(harness, { id: "bob-jones--alpha-industries", name: "Bob Jones", company: "Alpha Industries" });
  await insertContact(harness, { id: "dan-brown", name: "Dan Brown" });
}

describe("GET /contacts", () => {
  it("empty database: 200 with {items: [], count: 0}", async () => {
    h = await setup();
    const { res, json } = await get(h, "/contacts");
    expect(res.status).toBe(200);
    expect(json).toEqual({ items: [], count: 0 });
  });

  it("returns {items, count} sorted by name", async () => {
    h = await setup();
    await seed(h);
    const { res, json } = await get(h, "/contacts");
    expect(res.status).toBe(200);
    expect(json.count).toBe(4);
    expect(json.items.map((c: { name: string }) => c.name)).toEqual([
      "Alice Smith", "Bob Jones", "Carol Danvers", "Dan Brown",
    ]);
    expect(json.items.map((c: { id: string }) => c.id)).toEqual([
      "alice-smith--bluebird", "bob-jones--alpha-industries", "carol-danvers--avengers-llc", "dan-brown",
    ]);
    expect(json.items[0]).toMatchObject({ company: "Bluebird", updated_by: "dakota" });
  });

  it("items are full records, including application_ids", async () => {
    h = await setup();
    await seed(h);
    await insertApplication(h, "direct--one--2026-10-01");
    await linkContact(h, "direct--one--2026-10-01", "alice-smith--bluebird");
    const { json } = await get(h, "/contacts");
    expect(json.items[0].application_ids).toEqual(["direct--one--2026-10-01"]);
    expect(json.items[1].application_ids).toEqual([]);
  });

  it("q filters by name substring, case-insensitively", async () => {
    h = await setup();
    await seed(h);
    const { res, json } = await get(h, "/contacts?q=ALI");
    expect(res.status).toBe(200);
    expect(json.items.map((c: { name: string }) => c.name)).toEqual(["Alice Smith"]);
    expect(json.count).toBe(1);
  });

  it("q filters by company substring, case-insensitively", async () => {
    h = await setup();
    await seed(h);
    const { json } = await get(h, "/contacts?q=alp");
    expect(json.items.map((c: { name: string }) => c.name)).toEqual(["Bob Jones"]);
  });

  it("q matching name or company returns both kinds, sorted by name", async () => {
    h = await setup();
    await seed(h);
    // "an": Carol Danvers (name), Dan Brown (name), Avengers LLC no, Alpha Industries no... "Bluebird" no
    const { json } = await get(h, "/contacts?q=an");
    expect(json.items.map((c: { name: string }) => c.name)).toEqual(["Carol Danvers", "Dan Brown"]);
    const co = await get(h, "/contacts?q=BIRD");
    expect(co.json.items.map((c: { name: string }) => c.name)).toEqual(["Alice Smith"]);
  });

  it("q with no match: 200 with an empty list (not 404)", async () => {
    h = await setup();
    await seed(h);
    const { res, json } = await get(h, "/contacts?q=zzzz");
    expect(res.status).toBe(200);
    expect(json).toEqual({ items: [], count: 0 });
  });

  it("works with the agent key", async () => {
    h = await setup();
    await seed(h);
    const { res, json } = await get(h, "/contacts", h.agent);
    expect(res.status).toBe(200);
    expect(json.count).toBe(4);
  });
});

describe("GET /contacts: ordering and literal q", () => {
  it("sorts by name case-insensitively, not by id and not by raw bytes", async () => {
    h = await setup();
    await insertContact(h, { id: "zed-last", name: "Aaron Renamed" }); // id order differs from name order
    await insertContact(h, { id: "aaa-upper", name: "Bob Upper" });
    await insertContact(h, { id: "bob-lower", name: "bob lower" });
    await insertContact(h, { id: "m-carol", name: "Carol Z" });
    await insertContact(h, { id: "a-zed", name: "zed lower" });
    const { res, json } = await get(h, "/contacts");
    expect(res.status).toBe(200);
    expect(json.items.map((c: { name: string }) => c.name)).toEqual([
      "Aaron Renamed", "bob lower", "Bob Upper", "Carol Z", "zed lower",
    ]);
    expect(json.items.map((c: { id: string }) => c.id)).toEqual(["zed-last", "bob-lower", "aaa-upper", "m-carol", "a-zed"]);
  });

  describe("q treats % _ and \\ literally", () => {
    async function wild(harness: Harness) {
      await insertContact(harness, { id: "a-under-b", name: "a_b", company: "x%y" });
      await insertContact(harness, { id: "ab", name: "ab", company: "back\\slash" });
      await insertContact(harness, { id: "abc", name: "abc" });
    }
    const names = (json: Json) => json.items.map((c: { name: string }) => c.name);

    it.each([
      ["_", ["a_b"]],
      ["%", ["a_b"]],
      ["\\", ["ab"]],
      ["a_b", ["a_b"]],
      ["x%y", ["a_b"]],
      ["k\\s", ["ab"]],
    ])("q=%j matches %j only", async (q, expected) => {
      h = await setup();
      await wild(h);
      const { res, json } = await get(h, `/contacts?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      expect(names(json)).toEqual(expected);
      expect(json.count).toBe(expected.length);
    });
  });
});

describe("GET /contacts/:id", () => {
  it("returns the full record with application_ids sorted, from rows inserted directly", async () => {
    h = await setup();
    await insertContact(h, { id: "linked-person--hub", name: "Linked Person", company: "Hub", extra: { pronouns: "he/him" } });
    for (const id of ["zeta--role--2026-10-01", "alpha--role--2026-10-01", "mid--role--2026-10-01"]) {
      await insertApplication(h, id);
      await linkContact(h, id, "linked-person--hub");
    }
    await insertApplication(h, "unlinked--role--2026-10-01");
    const { res, json } = await get(h, "/contacts/linked-person--hub");
    expect(res.status).toBe(200);
    expect(json).toEqual({
      id: "linked-person--hub",
      name: "Linked Person",
      company: "Hub",
      role: null,
      relationship: null,
      linkedin_url: null,
      email: null,
      last_contact_at: null,
      notes: null,
      created_at: "2026-10-02T08:00:00.000Z",
      updated_at: "2026-10-02T08:00:00.000Z",
      updated_by: "dakota",
      pronouns: "he/him",
      application_ids: ["alpha--role--2026-10-01", "mid--role--2026-10-01", "zeta--role--2026-10-01"],
    });
  });

  it("a contact with no links has application_ids []", async () => {
    h = await setup();
    await insertContact(h, { id: "lonely", name: "Lonely" });
    const { res, json } = await get(h, "/contacts/lonely");
    expect(res.status).toBe(200);
    expect(json.application_ids).toEqual([]);
  });

  it("links belong to the right contact only", async () => {
    h = await setup();
    await insertContact(h, { id: "contact-a", name: "Contact A" });
    await insertContact(h, { id: "contact-b", name: "Contact B" });
    await insertApplication(h, "only-a--role--2026-10-01");
    await linkContact(h, "only-a--role--2026-10-01", "contact-a");
    expect((await get(h, "/contacts/contact-a")).json.application_ids).toEqual(["only-a--role--2026-10-01"]);
    expect((await get(h, "/contacts/contact-b")).json.application_ids).toEqual([]);
  });

  it("works with the agent key", async () => {
    h = await setup();
    await insertContact(h, { id: "lonely", name: "Lonely" });
    const { res, json } = await get(h, "/contacts/lonely", h.agent);
    expect(res.status).toBe(200);
    expect(json.id).toBe("lonely");
  });

  it("unknown id: 404 not_found envelope", async () => {
    h = await setup();
    await insertContact(h, { id: "somebody", name: "Somebody" });
    expect((await get(h, "/contacts/somebody")).res.status).toBe(200); // control
    const { res, json } = await get(h, "/contacts/nobody--nowhere");
    expect(res.status).toBe(404);
    expect(json.error?.code).toBe("not_found");
    expect(typeof json.error?.message).toBe("string");
  });
});
