import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app.ts";
import { createTestDb } from "../helpers/db.ts";
import { testConfig, TEST_NOW } from "../helpers/config.ts";
import { buildTestApp } from "../helpers/app.ts";
import { TEST_AGENT_KEY } from "../helpers/config.ts";
import { signIn } from "../helpers/auth.ts";
import { createFakeGithub } from "../helpers/github.ts";

type Built = Awaited<ReturnType<typeof buildTestApp>>;
let built: Built | undefined;
let tmp: string | undefined;

afterEach(async () => {
  await built?.close();
  built = undefined;
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

// The agent key keeps these requests valid once F2 adds auth; F1 ignores it.
const authHeaders = { Authorization: `Bearer ${TEST_AGENT_KEY}` };

describe("foundation routes", () => {
  beforeEach(async () => {
    built = await buildTestApp();
  });

  it("GET /job-tracker/healthz -> 200 {ok:true} with noindex, no auth needed", async () => {
    const res = await built!.app.request("/job-tracker/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("GET /job-tracker -> 301 to /job-tracker/ with noindex", async () => {
    const res = await built!.app.request("/job-tracker", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(new URL(res.headers.get("location")!, "http://localhost").pathname).toBe("/job-tracker/");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("unknown /job-tracker/api route -> 404 error envelope with noindex", async () => {
    const res = await built!.app.request("/job-tracker/api/x", { headers: authHeaders });
    expect(res.status).toBe(404);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(Object.keys(body.error)).toEqual(["code", "message"]);
    expect(body.error.code).toBe("not_found");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it("POST with Content-Type text/plain to an /api path -> 415 envelope with noindex", async () => {
    const res = await built!.app.request("/job-tracker/api/x", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "text/plain" },
      body: "hello",
    });
    expect(res.status).toBe(415);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(Object.keys(body.error)).toEqual(["code", "message"]);
    expect(body.error.code).toBe("unsupported_media_type");
    expect(typeof body.error.message).toBe("string");
  });

  it.each(["POST", "PATCH", "PUT"])("%s without a JSON content type -> 415", async (method) => {
    const res = await built!.app.request("/job-tracker/api/x", {
      method,
      headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unsupported_media_type");
  });

  it("POST with no Content-Type header -> 415", async () => {
    const res = await built!.app.request("/job-tracker/api/x", { method: "POST", headers: authHeaders });
    expect(res.status).toBe(415);
  });

  it("POST with application/json (charset allowed) passes the media-type check and reaches the 404", async () => {
    for (const ct of ["application/json", "application/json; charset=utf-8"]) {
      const res = await built!.app.request("/job-tracker/api/x", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": ct },
        body: "{}",
      });
      expect(res.status, ct).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    }
  });

  it("GET and DELETE need no content type", async () => {
    const res = await built!.app.request("/job-tracker/api/x", { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(404);
  });
});

describe("static serving and SPA fallback", () => {
  const INDEX = '<!doctype html><html><body><div id="root">SPA-INDEX-MARKER</div></body></html>';
  const ASSET = "console.log('asset-content-marker');\n";
  // F2 gates the HTML pages behind a session; a real one is obtained through the fake GitHub.
  const sessionFor = async () => (await signIn(built!.app)).headers;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "jt-static-"));
    await writeFile(join(tmp, "index.html"), INDEX);
    await mkdir(join(tmp, "assets"));
    await writeFile(join(tmp, "assets", "app.js"), ASSET);
    built = await buildTestApp({ config: { staticDir: tmp }, fetch: createFakeGithub().fetch });
  });

  it("/job-tracker/ serves index.html", async () => {
    const res = await built!.app.request("/job-tracker/", { headers: await sessionFor() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res.text()).toBe(INDEX);
  });

  it("a deep link falls back to index.html", async () => {
    // /login is public when signed out (with a session it redirects), so it is requested without one.
    const session = await sessionFor();
    const cases: [string, Record<string, string>][] = [
      ["/job-tracker/applications/acme--eng--2026-10-07", session],
      ["/job-tracker/due", session],
      ["/job-tracker/login", {}],
    ];
    for (const [path, headers] of cases) {
      const res = await built!.app.request(path, { headers });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toContain("text/html");
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex");
      expect(await res.text(), path).toBe(INDEX);
    }
  });

  it("an asset returns its own content with noindex", async () => {
    const res = await built!.app.request("/job-tracker/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res.text()).toBe(ASSET);
  });

  it("a missing asset is 404, not index.html", async () => {
    for (const path of ["/job-tracker/assets/missing.js", "/job-tracker/favicon.ico"]) {
      const res = await built!.app.request(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex");
      expect(await res.text(), path).not.toContain("SPA-INDEX-MARKER");
    }
  });

  it("an unknown /api route does not fall back to index.html", async () => {
    const res = await built!.app.request("/job-tracker/api/nope", { headers: authHeaders });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("SPA-INDEX-MARKER");
  });

  it("routes outside /job-tracker are not served", async () => {
    const res = await built!.app.request("/other");
    expect(res.status).toBe(404);
  });
});

describe("foundation routes: gap coverage", () => {
  const jsonPost = (app: Built["app"], path: string, headers: Record<string, string>) =>
    app.request(path, { method: "POST", headers: { ...authHeaders, ...headers }, body: "x" });

  it("an internal error returns the 500 envelope with no stack and noindex", async () => {
    const b = await buildTestApp();
    await b.close(); // the DB is now closed, so healthz's select 1 fails
    const res = await b.app.request("/job-tracker/healthz");
    expect(res.status).toBe(500);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const text = await res.text();
    const body = JSON.parse(text) as { error: { code: string; message: unknown } };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(Object.keys(body.error)).toEqual(["code", "message"]);
    expect(body.error.code).toBe("internal");
    expect(typeof body.error.message).toBe("string");
    expect(text).not.toMatch(/\bat \S/);
    expect(text).not.toMatch(/node_modules|\.ts:\d+|file:\/\/|\/home\//);
    expect(text).not.toContain("\n");
  });

  it("auth routes are exempt from the 415 check (F2 adds them: logout 204, callback state check 400)", async () => {
    built = await buildTestApp();
    const res = await built.app.request("/job-tracker/api/auth/logout", { method: "POST" });
    expect(res.status).toBe(204);
    const res2 = await jsonPost(built.app, "/job-tracker/api/auth/callback", { "Content-Type": "text/plain" });
    expect(res2.status).toBe(400);
  });

  it("a sibling path that merely starts with auth is not exempt", async () => {
    built = await buildTestApp();
    const res = await jsonPost(built.app, "/job-tracker/api/authx", { "Content-Type": "text/plain" });
    expect(res.status).toBe(415);
  });

  it.each(["text/json", "application/jsonx", "application/x-json"])("Content-Type %s -> 415", async (ct) => {
    built = await buildTestApp();
    const res = await jsonPost(built.app, "/job-tracker/api/x", { "Content-Type": ct });
    expect(res.status).toBe(415);
  });

  it("Content-Type APPLICATION/JSON is case-insensitive and reaches the 404", async () => {
    built = await buildTestApp();
    const res = await jsonPost(built.app, "/job-tracker/api/x", { "Content-Type": "APPLICATION/JSON" });
    expect(res.status).toBe(404);
  });
});

describe("deps contract", () => {
  type Deps = { now: () => Date; fetch: unknown };
  const probe = (app: Built["app"]) => {
    let seen: Deps | undefined;
    (app as unknown as { get: (p: string, h: (c: { get: (k: string) => Deps; json: (v: unknown) => Response }) => Response) => void }).get(
      "/probe",
      (c) => {
        seen = c.get("deps");
        return c.json({ ok: true });
      },
    );
    return () => seen;
  };

  it("exposes the injected now and fetch", async () => {
    const fixed = new Date("2030-01-02T03:04:05.678Z");
    const myFetch: typeof fetch = async () => new Response("x");
    built = await buildTestApp({ now: fixed, fetch: myFetch });
    const seen = probe(built.app);
    expect((await built.app.request("/probe")).status).toBe(200);
    expect(seen()!.now()).toEqual(fixed);
    expect(seen()!.fetch).toBe(myFetch);
  });

  it("defaults now to the real clock and fetch to a function when omitted", async () => {
    const { db, close } = await createTestDb();
    try {
      const app = createApp({ db, config: testConfig() });
      const seen = probe(app);
      expect((await app.request("/probe")).status).toBe(200);
      const n = seen()!.now();
      expect(n).toBeInstanceOf(Date);
      expect(Math.abs(n.getTime() - Date.now())).toBeLessThan(5000);
      expect(typeof seen()!.fetch).toBe("function");
    } finally {
      await close();
    }
  });

  it("uses TEST_NOW by default in the helper", async () => {
    built = await buildTestApp();
    const seen = probe(built.app);
    await built.app.request("/probe");
    expect(seen()!.now()).toEqual(TEST_NOW);
  });
});
