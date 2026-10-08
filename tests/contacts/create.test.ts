import { afterEach, describe, expect, it } from "vitest";
import { contacts } from "../../db/schema.ts";
import { TEST_NOW } from "../helpers/config.ts";
import { type Harness, get, post, send, setup } from "./helpers/setup.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const NOW_ISO = TEST_NOW.toISOString();

describe("POST /contacts: success", () => {
  it("201 with the full record, id from name and company, as dakota for a session", async () => {
    h = await setup();
    const { res, json } = await post(h, {
      name: "Ada Lovelace",
      company: "Acme Corp",
      role: "Recruiter",
      relationship: "recruiter",
      linkedin_url: "https://www.linkedin.com/in/ada",
      email: "ada@acme.test",
      last_contact_at: "2026-10-01",
      notes: "Met at a meetup",
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(json).toEqual({
      id: "ada-lovelace--acme-corp",
      name: "Ada Lovelace",
      company: "Acme Corp",
      role: "Recruiter",
      relationship: "recruiter",
      linkedin_url: "https://www.linkedin.com/in/ada",
      email: "ada@acme.test",
      last_contact_at: "2026-10-01",
      notes: "Met at a meetup",
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
      updated_by: "dakota",
      application_ids: [],
    });
    expect(Object.keys(json)).toEqual([
      "id", "name", "company", "role", "relationship", "linkedin_url", "email",
      "last_contact_at", "notes", "created_at", "updated_at", "updated_by", "application_ids",
    ]);
  });

  it("the id is slug(name) alone when there is no company, and optional fields are null", async () => {
    h = await setup();
    const { res, json } = await post(h, { name: "José Núñez" });
    expect(res.status).toBe(201);
    expect(json.id).toBe("jose-nunez");
    expect(json).toMatchObject({
      name: "José Núñez", company: null, role: null, relationship: null, linkedin_url: null,
      email: null, last_contact_at: null, notes: null, application_ids: [],
    });
  });

  it("a null or empty company also gives the name-only id", async () => {
    h = await setup();
    const a = await post(h, { name: "Null Company", company: null });
    expect(a.res.status).toBe(201);
    expect(a.json.id).toBe("null-company");
    expect(a.json.company).toBeNull();
  });

  it("the record is persisted and readable by GET", async () => {
    h = await setup();
    const created = await post(h, { name: "Grace Hopper", company: "Navy" });
    const got = await get(h, `/contacts/${created.json.id}`);
    expect(got.res.status).toBe(200);
    expect(got.json).toEqual(created.json);
    const rows = await h.db.select().from(contacts);
    expect(rows.map((r) => r.id)).toEqual(["grace-hopper--navy"]);
  });

  it("the agent key writes as claude-project", async () => {
    h = await setup();
    const { res, json } = await post(h, { name: "Agent Made", company: "Bot Inc" }, h.agent);
    expect(res.status).toBe(201);
    expect(json.id).toBe("agent-made--bot-inc");
    expect(json.updated_by).toBe("claude-project");
  });

  it("unknown fields are stored in extra and returned flattened, after the known fields", async () => {
    h = await setup();
    const { res, json } = await post(h, { name: "Extra Person", pronouns: "she/her", rank: 3, tags: ["a", "b"] });
    expect(res.status).toBe(201);
    expect(json.pronouns).toBe("she/her");
    expect(json.rank).toBe(3);
    expect(json.tags).toEqual(["a", "b"]);
    expect("extra" in json).toBe(false);
    const keys = Object.keys(json);
    expect(keys.indexOf("pronouns")).toBeGreaterThan(keys.indexOf("updated_by"));
    const [row] = await h.db.select().from(contacts);
    expect(row.extra).toEqual({ pronouns: "she/her", rank: 3, tags: ["a", "b"] });
    const got = await get(h, "/contacts/extra-person");
    expect(got.json.pronouns).toBe("she/her");
    expect(got.json.tags).toEqual(["a", "b"]);
  });

  it("server-managed fields on input are ignored", async () => {
    h = await setup();
    const { res, json } = await post(h, {
      name: "Managed Keys",
      id: "hacked-id",
      created_at: "2000-01-01T00:00:00.000Z",
      updated_at: "2000-01-01T00:00:00.000Z",
      updated_by: "tracker-app",
      application_ids: ["x", "y"],
      events: [{ a: 1 }],
      contacts: [1],
      meets_floor: true,
      extra: { smuggled: true },
    });
    expect(res.status).toBe(201);
    expect(json.id).toBe("managed-keys");
    expect(json.created_at).toBe(NOW_ISO);
    expect(json.updated_at).toBe(NOW_ISO);
    expect(json.updated_by).toBe("dakota");
    expect(json.application_ids).toEqual([]);
    for (const k of ["events", "contacts", "meets_floor", "extra", "smuggled"]) {
      expect(k in json, k).toBe(false);
    }
    const [row] = await h.db.select().from(contacts);
    expect(row.extra).toEqual({});
  });
});

describe("POST /contacts: validation", () => {
  it("missing name: 400 with a details path of name", async () => {
    h = await setup();
    const { res, json } = await post(h, { company: "Nameless" });
    expect(res.status).toBe(400);
    expect(json.error?.code).toBe("bad_request");
    expect(typeof json.error?.message).toBe("string");
    expect((json.error?.details ?? []).map((d: { path: string }) => d.path)).toContain("name");
    expect(await h.db.select().from(contacts)).toEqual([]);
  });

  it.each([
    ["null name", { name: null }],
    ["blank name", { name: "   " }],
    ["numeric name", { name: 42 }],
  ])("%s: 400 naming name", async (_l, body) => {
    h = await setup();
    const { res, json } = await post(h, body);
    expect(res.status).toBe(400);
    expect(json.error?.code).toBe("bad_request");
    expect((json.error?.details ?? []).map((d: { path: string }) => d.path)).toContain("name");
  });

  it("a bad relationship enum: 400 naming relationship", async () => {
    h = await setup();
    const { res, json } = await post(h, { name: "Bad Rel", relationship: "friend" });
    expect(res.status).toBe(400);
    expect((json.error?.details ?? []).map((d: { path: string }) => d.path)).toEqual(["relationship"]);
  });

  it.each(["not a url", "ftp://example.com/x", "linkedin.com/in/x", "/in/x"])(
    "linkedin_url %j is rejected: 400 naming linkedin_url",
    async (bad) => {
      h = await setup();
      const { res, json } = await post(h, { name: "Bad Url", linkedin_url: bad });
      expect(res.status).toBe(400);
      expect((json.error?.details ?? []).map((d: { path: string }) => d.path)).toEqual(["linkedin_url"]);
    },
  );

  it.each(["2026-13-01", "2026-02-30", "10/01/2026", "2026-10-01T00:00:00Z"])(
    "last_contact_at %j is rejected: 400 naming last_contact_at",
    async (bad) => {
      h = await setup();
      const { res, json } = await post(h, { name: "Bad Date", last_contact_at: bad });
      expect(res.status).toBe(400);
      expect((json.error?.details ?? []).map((d: { path: string }) => d.path)).toEqual(["last_contact_at"]);
    },
  );

  it("wrong types on optional strings: 400", async () => {
    h = await setup();
    const { res, json } = await post(h, { name: "Types", notes: 5, role: ["x"] });
    expect(res.status).toBe(400);
    expect((json.error?.details ?? []).map((d: { path: string }) => d.path).sort()).toEqual(["notes", "role"]);
  });

  it("a name with no letters or digits cannot form an id: 400, not 500", async () => {
    h = await setup();
    const { res, json } = await post(h, { name: "!!!" });
    expect(res.status).toBe(400);
    expect(json.error?.code).toBe("bad_request");
    expect(await h.db.select().from(contacts)).toEqual([]);
  });

  it("a body that is not a JSON object: 400", async () => {
    h = await setup();
    for (const raw of ["[]", "null", "\"x\"", "{not json"]) {
      const { res, json } = await send(h, "POST", "/contacts", {
        raw,
        headers: { ...h.session, "Content-Type": "application/json" },
      });
      expect(res.status, raw).toBe(400);
      expect(json.error?.code, raw).toBe("bad_request");
    }
  });
});

describe("POST /contacts: duplicates", () => {
  it("the same id: 409 conflict with the existing record, which is unchanged", async () => {
    h = await setup();
    const first = await post(h, { name: "Dup Person", company: "Dup Co", notes: "original" });
    expect(first.res.status).toBe(201);
    const second = await post(h, { name: "Dup Person", company: "Dup Co", notes: "second try" });
    expect(second.res.status).toBe(409);
    expect(second.json.error?.code).toBe("conflict");
    expect(second.json.record).toEqual(first.json);
    expect(second.json.record.notes).toBe("original");
    expect(await h.db.select().from(contacts)).toHaveLength(1);
  });

  it("ids collide through slugs: different spelling of the same name and company is a duplicate", async () => {
    h = await setup();
    await post(h, { name: "Zoë Müller", company: "R&D Labs" });
    const dup = await post(h, { name: "zoe muller", company: "R D labs" });
    expect(dup.res.status).toBe(409);
    expect(dup.json.record.id).toBe("zoe-muller--r-d-labs");
  });

  it("the same name with a different company is a different contact", async () => {
    h = await setup();
    const a = await post(h, { name: "Sam Lee", company: "One" });
    const b = await post(h, { name: "Sam Lee", company: "Two" });
    const c = await post(h, { name: "Sam Lee" });
    expect([a.res.status, b.res.status, c.res.status]).toEqual([201, 201, 201]);
    expect(await h.db.select().from(contacts)).toHaveLength(3);
  });

  it("a retried agent POST: 409 with the existing record, still one row", async () => {
    h = await setup();
    const body = { name: "Retry Me", company: "Flaky Net", relationship: "referral" };
    const first = await post(h, body, h.agent);
    const retry = await post(h, body, h.agent);
    expect(first.res.status).toBe(201);
    expect(retry.res.status).toBe(409);
    expect(retry.json.error?.code).toBe("conflict");
    expect(retry.json.record).toEqual(first.json);
    expect(retry.json.record.updated_by).toBe("claude-project");
    expect(await h.db.select().from(contacts)).toHaveLength(1);
  });
});
