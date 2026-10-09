import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { applicationContacts, events } from "../../db/schema.ts";
import { ACME_ID, base, expectEnvelope, setup, type Harness } from "./helpers/harness.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function seeded() {
  h = await setup();
  await h.addContact("amy");
  await h.create(base({ contact_ids: ["amy"] }));
  await h.create(base({ company: "Other Co" }));
  await h.call("POST", `/applications/${ACME_ID}/events`, { body: { type: "note", note: "n" } });
  await h.call("POST", `/applications/${ACME_ID}/events`, { body: { type: "note", status: "applied" } });
}

describe("DELETE /applications/:id?confirm=<id>", () => {
  it("session: 204 with no body; the record, events and links are gone; other data is intact", async () => {
    await seeded();
    expect(await h!.counts()).toEqual({ applications: 2, events: 5, links: 1, contacts: 1 });
    const r = await h!.call("DELETE", `/applications/${ACME_ID}?confirm=${ACME_ID}`);
    expect(r.status).toBe(204);
    expect(r.text).toBe("");
    expect((await h!.call("GET", `/applications/${ACME_ID}`)).status).toBe(404);
    expect(await h!.db.select().from(events).where(eq(events.application_id, ACME_ID))).toEqual([]);
    expect(await h!.db.select().from(applicationContacts)).toEqual([]);
    expect(await h!.counts()).toEqual({ applications: 1, events: 1, links: 0, contacts: 1 });
    const list = (await h!.call("GET", "/applications")).json;
    expect(list.items.map((i: { id: string }) => i.id)).toEqual(["other-co--senior-engineer--2026-10-07"]);
  });

  it("the agent key gets 403 forbidden and nothing is deleted", async () => {
    await seeded();
    const r = await h!.call("DELETE", `/applications/${ACME_ID}?confirm=${ACME_ID}`, { as: "agent" });
    expectEnvelope(r, 403, "forbidden");
    expect(await h!.counts()).toEqual({ applications: 2, events: 5, links: 1, contacts: 1 });
  });

  it.each([
    ["no confirm", ""],
    ["empty confirm", "?confirm="],
    ["a mismatched confirm", "?confirm=something-else"],
    ["the id with different case", `?confirm=${ACME_ID.toUpperCase()}`],
    ["another existing id", "?confirm=other-co--senior-engineer--2026-10-07"],
  ])("%s is 400 and nothing is deleted", async (_n, qs) => {
    await seeded();
    const r = await h!.call("DELETE", `/applications/${ACME_ID}${qs}`);
    expectEnvelope(r, 400, "bad_request");
    expect(await h!.counts()).toEqual({ applications: 2, events: 5, links: 1, contacts: 1 });
  });

  it("an unknown id is 404", async () => {
    await seeded();
    const id = "ghost--ghost--2026-10-07";
    const r = await h!.call("DELETE", `/applications/${id}?confirm=${id}`);
    expectEnvelope(r, 404, "not_found");
    expect((await h!.counts()).applications).toBe(2);
  });

  it("a second delete of the same id is 404, and the id can be created again", async () => {
    await seeded();
    expect((await h!.call("DELETE", `/applications/${ACME_ID}?confirm=${ACME_ID}`)).status).toBe(204);
    expect((await h!.call("DELETE", `/applications/${ACME_ID}?confirm=${ACME_ID}`)).status).toBe(404);
    expect((await h!.call("POST", "/applications", { body: base() })).status).toBe(201);
  });
});
