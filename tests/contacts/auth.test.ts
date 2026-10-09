import { afterEach, describe, expect, it } from "vitest";
import { contacts } from "../../db/schema.ts";
import { TEST_AGENT_KEY } from "../helpers/config.ts";
import { type Harness, CONTACTS, JSON_HEADERS, get, post, send, setup } from "./helpers/setup.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("contacts: authentication", () => {
  it("every contacts route without credentials: 401 unauthorized with WWW-Authenticate: Bearer", async () => {
    h = await setup();
    const c = await post(h, { name: "Guarded" });
    const cases: [string, string, unknown][] = [
      ["GET", "/contacts", undefined],
      ["GET", `/contacts/${c.json.id}`, undefined],
      ["POST", "/contacts", { name: "Anon" }],
      ["PATCH", `/contacts/${c.json.id}`, { notes: "x" }],
    ];
    for (const [method, path, body] of cases) {
      const { res, json } = await send(h, method, path, {
        body,
        headers: method === "PATCH" ? { "If-Match": c.json.updated_at } : {},
      });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(json.error?.code, `${method} ${path}`).toBe("unauthorized");
      expect(res.headers.get("www-authenticate"), `${method} ${path}`).toBe("Bearer");
    }
    expect((await h.db.select().from(contacts)).map((r) => r.id)).toEqual(["guarded"]);
    expect((await get(h, "/contacts/guarded")).json.notes).toBeNull();
  });

  it("a wrong agent key: 401", async () => {
    h = await setup();
    expect((await get(h, "/contacts", h.agent)).res.status).toBe(200); // control: the right key works
    const { res } = await get(h, "/contacts", { Authorization: `Bearer ${TEST_AGENT_KEY}x` });
    expect(res.status).toBe(401);
  });
});

describe("contacts: Content-Type", () => {
  it("a POST without application/json: 415 unsupported_media_type, nothing created", async () => {
    h = await setup();
    const ok = await post(h, { name: "Plain Text Control" }); // control: JSON is accepted
    expect(ok.res.status).toBe(201);
    const { res, json } = await send(h, "POST", "/contacts", {
      raw: JSON.stringify({ name: "Plain Text" }),
      headers: { ...h.session, "Content-Type": "text/plain" },
    });
    expect(res.status).toBe(415);
    expect(json.error?.code).toBe("unsupported_media_type");
    expect((await h.db.select().from(contacts)).map((r) => r.id)).toEqual(["plain-text-control"]);
  });

  it("a PATCH without application/json: 415", async () => {
    h = await setup();
    const c = await post(h, { name: "Patch Type" });
    const { res, json } = await send(h, "PATCH", `/contacts/${c.json.id}`, {
      raw: JSON.stringify({ notes: "x" }),
      headers: { ...h.session, "Content-Type": "text/plain", "If-Match": c.json.updated_at },
    });
    expect(res.status).toBe(415);
    expect(json.error?.code).toBe("unsupported_media_type");
    expect((await get(h, `/contacts/${c.json.id}`)).json.notes).toBeNull();
  });

  it("application/json with a charset is accepted", async () => {
    h = await setup();
    const res = await h.app.request(CONTACTS, {
      method: "POST",
      headers: { ...h.session, ...JSON_HEADERS, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ name: "Charset Ok" }),
    });
    expect(res.status).toBe(201);
  });
});
