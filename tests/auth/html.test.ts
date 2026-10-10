import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers/app.ts";
import { BASE, SESSION_COOKIE, agentHeaders, signIn } from "../helpers/auth.ts";
import { createFakeGithub } from "../helpers/github.ts";

const INDEX = '<!doctype html><html><body><div id="root">SPA-INDEX-MARKER</div></body></html>';
const ASSET = "console.log('asset-content-marker');\n";

type Built = Awaited<ReturnType<typeof buildTestApp>>;
let built: Built;
let tmp: string;
let session: Record<string, string>;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "jt-auth-html-"));
  await writeFile(join(tmp, "index.html"), INDEX);
  await mkdir(join(tmp, "assets"));
  await writeFile(join(tmp, "assets", "app.js"), ASSET);
  built = await buildTestApp({ fetch: createFakeGithub().fetch, config: { staticDir: tmp } });
  session = (await signIn(built.app)).headers;
});

afterEach(async () => {
  await built.close();
  await rm(tmp, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string> = {}) =>
  built.app.request(`${BASE}${path}`, { headers, redirect: "manual" });

const PAGES = ["/", "/due", "/summary", "/contacts", "/applications/new", "/applications/acme--eng--2026-10-07"];

describe("HTML gating", () => {
  it.each(PAGES)("%s without a session -> 302 to /job-tracker/login with noindex", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!, "http://localhost").pathname).toBe("/job-tracker/login");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res.text()).not.toContain("SPA-INDEX-MARKER");
  });

  it.each(PAGES)("%s with a session -> index.html with noindex", async (path) => {
    const res = await get(path, session);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res.text()).toBe(INDEX);
  });

  it("a tampered session cookie counts as no session", async () => {
    const [payload, sig] = session.Cookie.slice(`${SESSION_COOKIE}=`.length).split(".");
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    const res = await get("/", { Cookie: `${SESSION_COOKIE}=${payload}.${flipped}` });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!, "http://localhost").pathname).toBe("/job-tracker/login");
  });

  it("an agent key does not open the HTML pages", async () => {
    const res = await get("/", agentHeaders());
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!, "http://localhost").pathname).toBe("/job-tracker/login");
  });

  it("/login without a session serves index.html", async () => {
    const res = await get("/login");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res.text()).toBe(INDEX);
  });

  it("/login with a session -> 302 to /job-tracker/ with noindex", async () => {
    const res = await get("/login", session);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!, "http://localhost").pathname).toBe("/job-tracker/");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("/login with an invalid session serves index.html", async () => {
    const res = await get("/login", { Cookie: `${SESSION_COOKIE}=garbage.garbage` });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX);
  });

  it("assets are public with noindex", async () => {
    const res = await get("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res.text()).toBe(ASSET);
  });

  it("a missing asset stays a 404, not a redirect", async () => {
    const res = await get("/assets/missing.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("HEAD on a gated page without a session -> 302 to login", async () => {
    const res = await built.app.request(`${BASE}/`, { method: "HEAD", redirect: "manual" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!, "http://localhost").pathname).toBe("/job-tracker/login");
  });

  it("/healthz is public", async () => {
    const res = await get("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, lastExportAt: null });
  });
});
