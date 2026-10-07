import { afterEach, describe, expect, it } from "vitest";
import { ACME_ID, base, expectEnvelope, minutes, setup, type Harness } from "./helpers/harness.ts";
import { TEST_NOW } from "../helpers/config.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("GET /applications/:id", () => {
  it("returns the full record for the session and for the agent", async () => {
    h = await setup();
    const created = await h.create(base({ extra_flag: "x" }));
    const s = await h.call("GET", `/applications/${ACME_ID}`);
    expect(s.status).toBe(200);
    expect(s.json).toEqual(created);
    const a = await h.call("GET", `/applications/${ACME_ID}`, { as: "agent" });
    expect(a.status).toBe(200);
    expect(a.json).toEqual(created);
    expect(a.json.extra_flag).toBe("x");
  });

  it("sorts events by at ascending then id, and contacts and contact_ids by id", async () => {
    h = await setup();
    await h.addContact("zed");
    await h.addContact("amy");
    await h.addContact("mia");
    await h.create(base({ contact_ids: ["zed", "amy", "mia"] }));
    const post = (at: string, note: string) =>
      h!.call("POST", `/applications/${ACME_ID}/events`, { body: { type: "note", note, at } });
    expect((await post("2026-10-03T12:00:00Z", "third")).status).toBe(201);
    expect((await post("2026-10-01T12:00:00Z", "first")).status).toBe(201);
    expect((await post("2026-10-02T12:00:00Z", "tie-a")).status).toBe(201);
    expect((await post("2026-10-02T12:00:00Z", "tie-b")).status).toBe(201);
    const rec = await h.get(ACME_ID);
    const evs = rec.events as { id: string; at: string; note: string | null; type: string }[];
    expect(evs.map((e) => e.at)).toEqual([
      "2026-10-01T12:00:00.000Z",
      "2026-10-02T12:00:00.000Z",
      "2026-10-02T12:00:00.000Z",
      "2026-10-03T12:00:00.000Z",
      TEST_NOW.toISOString(), // the discovered event
    ]);
    expect(evs[0].note).toBe("first");
    expect(evs[3].note).toBe("third");
    expect(evs[4].type).toBe("discovered");
    const tie = [evs[1].id, evs[2].id];
    expect(tie).toEqual([...tie].sort());
    expect(rec.contact_ids).toEqual(["amy", "mia", "zed"]);
    expect(rec.contacts.map((c: { id: string }) => c.id)).toEqual(["amy", "mia", "zed"]);
  });

  it("an unknown id is 404 not_found", async () => {
    h = await setup();
    await h.create(base());
    const r = await h.call("GET", "/applications/nope--nope--2026-10-07");
    expectEnvelope(r, 404, "not_found");
    expect((await h.call("GET", `/applications/${ACME_ID}`)).status).toBe(200);
  });

  it("the list and the detail agree on updated_at", async () => {
    h = await setup();
    await h.create(base());
    h.clock.set(minutes(TEST_NOW, 3));
    const rec = await h.get(ACME_ID);
    await h.patch(ACME_ID, { notes: "x" }, rec.updated_at);
    const detail = await h.get(ACME_ID);
    const list = (await h.call("GET", "/applications")).json;
    expect(list.items[0].updated_at).toBe(detail.updated_at);
    expect(detail.updated_at).toBe(minutes(TEST_NOW, 3).toISOString());
  });
});
