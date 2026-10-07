import { afterEach, describe, expect, it } from "vitest";
import { TEST_NOW } from "../helpers/config.ts";
import { ACME_ID, base, detailPaths, expectEnvelope, minutes, setup, type Harness } from "./helpers/harness.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const url = `/applications/${ACME_ID}`;

describe("PATCH posting_url uniqueness (ruling c)", () => {
  it("a posting_url held by another record is 409 with THAT record; own url is 200", async () => {
    h = await setup();
    const holder = await h.create(base({ company: "Holder", posting_url: "https://jobs.example.com/held" }));
    const mine = await h.create(base({ posting_url: "https://jobs.example.com/mine" }));
    const r = await h.call("PATCH", url, { body: { posting_url: "https://jobs.example.com/held" }, headers: { "If-Match": mine.updated_at } });
    expectEnvelope(r, 409, "conflict");
    expect(r.json.record).toEqual(holder);
    expect(await h.get(ACME_ID)).toEqual(mine);
    const own = await h.call("PATCH", url, { body: { posting_url: "https://jobs.example.com/mine", notes: "same url" }, headers: { "If-Match": mine.updated_at } });
    expect(own.status).toBe(200);
    expect(own.json.notes).toBe("same url");
  });
});

describe("duplicate contact_ids are de-duplicated (ruling b)", () => {
  it("on create", async () => {
    h = await setup();
    await h.addContact("amy");
    const rec = await h.create(base({ contact_ids: ["amy", "amy"] }));
    expect(rec.contact_ids).toEqual(["amy"]);
    expect(rec.contacts.map((c: { id: string }) => c.id)).toEqual(["amy"]);
    expect((await h.counts()).links).toBe(1);
  });
  it("on patch", async () => {
    h = await setup();
    await h.addContact("amy");
    await h.addContact("bo");
    const rec = await h.create(base());
    const out = await h.patch(ACME_ID, { contact_ids: ["bo", "amy", "bo", "amy"] }, rec.updated_at);
    expect(out.contact_ids).toEqual(["amy", "bo"]);
    expect((await h.counts()).links).toBe(2);
  });
});

describe("PATCH without If-Match is 428 before the body is parsed (ruling d)", () => {
  it("428 even with an invalid JSON body", async () => {
    h = await setup();
    const rec = await h.create(base());
    const r = await h.call("PATCH", url, { raw: "{not json" });
    expectEnvelope(r, 428, "precondition_required");
    expect(await h.get(ACME_ID)).toEqual(rec);
  });
});

describe("a plain event bumps updated_at and updated_by (ruling a)", () => {
  it("session and agent", async () => {
    h = await setup();
    const rec = await h.create(base());
    h.clock.set(minutes(TEST_NOW, 10));
    const r = await h.call("POST", `${url}/events`, { body: { type: "note", note: "hi" } });
    expect(r.status).toBe(201);
    expect(r.json.record.updated_at).toBe(minutes(TEST_NOW, 10).toISOString());
    expect(r.json.record.updated_by).toBe("dakota");
    expect((await h.get(ACME_ID)).updated_at).toBe(minutes(TEST_NOW, 10).toISOString());
    h.clock.set(minutes(TEST_NOW, 20));
    const a = await h.call("POST", `${url}/events`, { as: "agent", body: { type: "note" } });
    expect(a.json.record.updated_at).toBe(minutes(TEST_NOW, 20).toISOString());
    expect(a.json.record.updated_by).toBe("claude-project");
    expect(rec.updated_at).toBe(TEST_NOW.toISOString());
  });
});

describe("q matches LIKE wildcards literally", () => {
  it("_, % and backslash", async () => {
    h = await setup();
    for (const company of ["Under_score Co", "Underscore Co", "Hundred Percent", "100% Match", "Back\\slash Ltd"]) {
      await h.create(base({ company }));
    }
    const names = async (q: string) =>
      (await h!.call("GET", `/applications?q=${encodeURIComponent(q)}`)).json.items.map((i: { company: string }) => i.company);
    expect(await names("_score")).toEqual(["Under_score Co"]);
    expect(await names("%")).toEqual(["100% Match"]);
    expect(await names("\\")).toEqual(["Back\\slash Ltd"]);
    expect(await names("%25")).toEqual([]);
  });
});

describe("comp outside the int4 range is 400 (new behavior)", () => {
  it.each([
    ["comp_min", 3000000000],
    ["comp_max", 3000000000],
    ["comp_min", -2147483649],
    ["comp_max", -2147483649],
  ])("POST %s=%i -> 400 naming the field", async (field, value) => {
    h = await setup();
    const r = await h.call("POST", "/applications", { body: base({ [field]: value }) });
    expectEnvelope(r, 400, "bad_request");
    expect(detailPaths(r.json)).toContain(field);
    expect((await h.counts()).applications).toBe(0);
  });
  it.each([
    ["comp_min", 3000000000],
    ["comp_max", 3000000000],
    ["comp_min", -2147483649],
    ["comp_max", -2147483649],
  ])("PATCH %s=%i -> 400 naming the field", async (field, value) => {
    h = await setup();
    const rec = await h.create(base());
    const r = await h.call("PATCH", url, { body: { [field]: value }, headers: { "If-Match": rec.updated_at } });
    expectEnvelope(r, 400, "bad_request");
    expect(detailPaths(r.json)).toContain(field);
    expect(await h.get(ACME_ID)).toEqual(rec);
  });
});

describe("int4 boundaries are exact", () => {
  it.each([
    ["comp_max", 2147483647],
    ["comp_min", 2147483647],
    ["comp_max", -2147483648],
    ["comp_min", -2147483648],
  ])("POST %s=%i is accepted and stored", async (field, value) => {
    h = await setup();
    const rec = await h.create(base({ [field]: value }));
    expect(rec[field]).toBe(value);
    expect((await h.get(rec.id))[field]).toBe(value);
  });
  it.each([
    ["comp_max", 2147483648],
    ["comp_min", 2147483648],
    ["comp_max", -2147483649],
    ["comp_min", -2147483649],
  ])("POST %s=%i is 400 naming the field", async (field, value) => {
    h = await setup();
    const r = await h.call("POST", "/applications", { body: base({ [field]: value }) });
    expectEnvelope(r, 400, "bad_request");
    expect(detailPaths(r.json)).toContain(field);
  });
  it.each([
    ["comp_max", 2147483647],
    ["comp_min", -2147483648],
  ])("PATCH %s=%i is accepted", async (field, value) => {
    h = await setup();
    const rec = await h.create(base());
    const out = await h.patch(ACME_ID, { [field]: value }, rec.updated_at);
    expect(out[field]).toBe(value);
  });
  it.each([
    ["comp_max", 2147483648],
    ["comp_min", 2147483648],
  ])("PATCH %s=%i is 400 naming the field", async (field, value) => {
    h = await setup();
    const rec = await h.create(base());
    const r = await h.call("PATCH", url, { body: { [field]: value }, headers: { "If-Match": rec.updated_at } });
    expectEnvelope(r, 400, "bad_request");
    expect(detailPaths(r.json)).toContain(field);
  });
});
