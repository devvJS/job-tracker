import { afterEach, describe, expect, it } from "vitest";
import { ACME_ID, base, expectEnvelope, setup, type Harness } from "./helpers/harness.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const routes: [string, string, unknown][] = [
  ["GET", "/applications", undefined],
  ["POST", "/applications", base()],
  ["GET", `/applications/${ACME_ID}`, undefined],
  ["PATCH", `/applications/${ACME_ID}`, { notes: "x" }],
  ["POST", `/applications/${ACME_ID}/events`, { type: "note" }],
  ["DELETE", `/applications/${ACME_ID}?confirm=${ACME_ID}`, undefined],
];

describe("auth and content-type on the applications routes", () => {
  it.each(routes)("%s %s without auth is 401 and has no effect", async (method, path, body) => {
    h = await setup();
    await h.create(base());
    const before = await h.get(ACME_ID);
    const r = await h.call(method, path, { as: "none", body, headers: method === "PATCH" ? { "If-Match": before.updated_at } : {} });
    expectEnvelope(r, 401, "unauthorized");
    expect(r.headers.get("www-authenticate")).toBe("Bearer");
    expect(await h.get(ACME_ID)).toEqual(before);
    expect(await h.counts()).toEqual({ applications: 1, events: 1, links: 0, contacts: 0 });
  });

  it("401 comes before 404 for an unknown id", async () => {
    h = await setup();
    await h.create(base());
    const r = await h.call("GET", "/applications/nope--nope--2026-10-07", { as: "none" });
    expectEnvelope(r, 401, "unauthorized");
  });

  it("a wrong agent key is 401 on every route", async () => {
    h = await setup();
    await h.create(base());
    for (const [method, path, body] of routes) {
      const r = await h.call(method, path, { as: "none", body, headers: { Authorization: "Bearer wrong-key-wrong-key-wrong-key-wrong-key" } });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
  });

  it.each([
    ["POST", "/applications"],
    ["PATCH", `/applications/${ACME_ID}`],
    ["POST", `/applications/${ACME_ID}/events`],
  ])("%s %s with a non-JSON content type is 415 (session)", async (method, path) => {
    h = await setup();
    await h.create(base());
    const before = await h.get(ACME_ID);
    const r = await h.call(method, path, {
      raw: JSON.stringify(method === "POST" && path === "/applications" ? base({ company: "Second" }) : { type: "note", notes: "x" }),
      headers: { "Content-Type": "text/plain", "If-Match": before.updated_at },
    });
    expectEnvelope(r, 415, "unsupported_media_type");
    expect(await h.get(ACME_ID)).toEqual(before);
    expect(await h.counts()).toEqual({ applications: 1, events: 1, links: 0, contacts: 0 });
  });

  it("a write with no Content-Type at all is 415, also for the agent", async () => {
    h = await setup();
    await h.create(base({ company: "Seed Co" }));
    const a = await h.call("POST", "/applications", { raw: JSON.stringify(base()), noContentType: true });
    expectEnvelope(a, 415, "unsupported_media_type");
    const b = await h.call("POST", "/applications", { as: "agent", raw: JSON.stringify(base()), noContentType: true });
    expectEnvelope(b, 415, "unsupported_media_type");
    expect((await h.counts()).applications).toBe(1);
  });
});
