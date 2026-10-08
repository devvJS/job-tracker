import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers/app.ts";
import { BASE, signIn } from "../helpers/auth.ts";
import { createFakeGithub } from "../helpers/github.ts";

const INDEX = "<!doctype html><html><body>SPA-INDEX-MARKER</body></html>";

type Built = Awaited<ReturnType<typeof buildTestApp>>;
let built: Built;
let tmp: string;
let session: Record<string, string>;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "jt-cache-"));
  await writeFile(join(tmp, "index.html"), INDEX);
  await writeFile(join(tmp, "robots.txt"), "User-agent: *\n");
  await mkdir(join(tmp, "assets"));
  await writeFile(join(tmp, "assets", "index-AbC123xy.js"), "console.log('hashed');\n");
  await writeFile(join(tmp, "assets", "index-Zq9_-Lm2.css"), "body{}\n");
  await writeFile(join(tmp, "assets", "vendor-v2.js"), "console.log('vendor');\n");
  await writeFile(join(tmp, "assets", "page-AbC123xy.html"), "<!doctype html><p>page</p>");
  await writeFile(join(tmp, "assets", "app.js"), "console.log('plain');\n");
  built = await buildTestApp({ fetch: createFakeGithub().fetch, config: { staticDir: tmp } });
  session = (await signIn(built.app)).headers;
});

afterEach(async () => {
  await built.close();
  await rm(tmp, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string> = {}) =>
  built.app.request(`${BASE}${path}`, { headers, redirect: "manual" });

describe("HTML responses are never cached", () => {
  it.each(["/", "/due", "/applications/acme--eng--2026-10-07", "/index.html"])(
    "%s with a session -> 200 HTML with Cache-Control: no-store",
    async (path) => {
      const res = await get(path, session);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-store");
    },
  );

  it("/login without a session -> 200 HTML with Cache-Control: no-store", async () => {
    const res = await get("/login");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each(["/", "/due", "/applications/acme--eng--2026-10-07"])(
    "the gate's 302 from %s to /login has Cache-Control: no-store",
    async (path) => {
      const res = await get(path);
      expect(res.status).toBe(302);
      expect(res.headers.get("cache-control")).toBe("no-store");
    },
  );

  it("the 302 from /login to / (signed in) has Cache-Control: no-store", async () => {
    const res = await get("/login", session);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!, "http://localhost").pathname).toBe("/job-tracker/");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("static assets", () => {
  it.each(["/assets/index-AbC123xy.js", "/assets/index-Zq9_-Lm2.css"])(
    "hashed build asset %s is public, max-age one year, immutable",
    async (path) => {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    },
  );

  it.each(["/assets/app.js", "/robots.txt"])("non-hashed file %s is not immutable", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control") ?? "").not.toContain("immutable");
  });

  it("a non-hashed file with a short suffix (vendor-v2.js) is not immutable", async () => {
    const res = await get("/assets/vendor-v2.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control") ?? "").not.toContain("immutable");
  });

  it("a missing hashed-looking asset is a 404 and not immutable", async () => {
    const res = await get("/assets/missing-AbC123xy.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control") ?? "").not.toContain("immutable");
  });

  it("an HTML file at a hashed-looking path is no-store", async () => {
    const res = await get("/assets/page-AbC123xy.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("/healthz is not immutable", async () => {
    const res = await get("/healthz");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control") ?? "").not.toContain("immutable");
  });
});

describe("conditional requests and /api", () => {
  it("GET / with a session and a future If-Modified-Since -> 200 no-store, never 304", async () => {
    const res = await get("/", { ...session, "If-Modified-Since": "Wed, 01 Jan 2200 00:00:00 GMT" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("GET /api/applications without auth -> 401 no-store", async () => {
    const res = await get("/api/applications");
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("GET /api/auth/me with a session -> 200 no-store", async () => {
    const res = await get("/api/auth/me", session);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("GET /api/auth/login -> 302 no-store", async () => {
    const res = await get("/api/auth/login");
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
