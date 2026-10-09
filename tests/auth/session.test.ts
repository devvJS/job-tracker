import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers/app.ts";
import { BASE, SESSION_COOKIE, createClock, findSetCookie, isCleared, signIn } from "../helpers/auth.ts";
import { TEST_NOW, TEST_SESSION_SECRET } from "../helpers/config.ts";
import { createFakeGithub } from "../helpers/github.ts";

type Built = Awaited<ReturnType<typeof buildTestApp>>;
const built: Built[] = [];
afterEach(async () => {
  await Promise.all(built.splice(0).map((b) => b.close()));
});

async function setup(opts: { sessionSecret?: string; clock?: ReturnType<typeof createClock> } = {}) {
  const gh = createFakeGithub();
  const b = await buildTestApp({
    fetch: gh.fetch,
    now: opts.clock ? opts.clock.now : TEST_NOW,
    config: opts.sessionSecret ? { sessionSecret: opts.sessionSecret } : undefined,
  });
  built.push(b);
  return b.app;
}

const me = (app: Built["app"], headers: Record<string, string> = {}) =>
  app.request(`${BASE}/api/auth/me`, { headers });

async function expectUnauthorized(res: Response) {
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBe("Bearer");
  const body = (await res.json()) as { error: { code: string } };
  expect(Object.keys(body)).toEqual(["error"]);
  expect(body.error.code).toBe("unauthorized");
}

function b64urlJson(v: unknown) {
  return Buffer.from(JSON.stringify(v)).toString("base64url");
}

describe("GET /api/auth/me with a session", () => {
  it("returns the login and via:session", async () => {
    const app = await setup();
    const s = await signIn(app);
    const res = await me(app, s.headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ login: "devvJS", via: "session" });
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("is 401 without any credentials", async () => {
    const app = await setup();
    await expectUnauthorized(await me(app));
  });

  it("a session is still valid just before 30 days", async () => {
    const clock = createClock(TEST_NOW);
    const app = await setup({ clock });
    const s = await signIn(app);
    clock.set(new Date(TEST_NOW.getTime() + 29 * 86_400_000));
    expect((await me(app, s.headers)).status).toBe(200);
  });
});

describe("invalid sessions are 401", () => {
  it("a tampered signature", async () => {
    const app = await setup();
    const s = await signIn(app);
    const [payload, sig] = s.value.split(".");
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    await expectUnauthorized(await me(app, { Cookie: `${SESSION_COOKIE}=${payload}.${flipped}` }));
  });

  it("a truncated signature", async () => {
    const app = await setup();
    const s = await signIn(app);
    const [payload, sig] = s.value.split(".");
    await expectUnauthorized(await me(app, { Cookie: `${SESSION_COOKIE}=${payload}.${sig.slice(0, -4)}` }));
  });

  it("a tampered payload with the original signature", async () => {
    const app = await setup();
    const s = await signIn(app);
    const [payload, sig] = s.value.split(".");
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { login: string; exp: number };
    const forged = b64urlJson({ ...parsed, login: "mallory" });
    expect(forged).not.toBe(payload);
    await expectUnauthorized(await me(app, { Cookie: `${SESSION_COOKIE}=${forged}.${sig}` }));
  });

  it("an extended expiry with the original signature", async () => {
    const app = await setup();
    const s = await signIn(app);
    const [payload, sig] = s.value.split(".");
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { login: string; exp: number };
    const forged = b64urlJson({ ...parsed, exp: parsed.exp * 2 });
    await expectUnauthorized(await me(app, { Cookie: `${SESSION_COOKIE}=${forged}.${sig}` }));
  });

  it("an expired session (clock moved past 30 days)", async () => {
    const clock = createClock(TEST_NOW);
    const app = await setup({ clock });
    const s = await signIn(app);
    expect((await me(app, s.headers)).status).toBe(200);
    clock.set(new Date(TEST_NOW.getTime() + 31 * 86_400_000));
    await expectUnauthorized(await me(app, s.headers));
  });

  it("a session signed with another secret", async () => {
    const other = await setup({ sessionSecret: "a-completely-different-secret-0123456789abc" });
    const foreign = await signIn(other);
    const app = await setup();
    await expectUnauthorized(await me(app, foreign.headers));
  });

  it.each(["", "garbage", "a.b", "a.b.c", "."])("a malformed cookie value %j", async (value) => {
    const app = await setup();
    await expectUnauthorized(await me(app, { Cookie: `${SESSION_COOKIE}=${value}` }));
  });
});

describe("POST /api/auth/logout", () => {
  it("returns 204 and clears the session cookie on the right path", async () => {
    const app = await setup();
    const s = await signIn(app);
    const res = await app.request(`${BASE}/api/auth/logout`, { method: "POST", headers: s.headers });
    expect(res.status).toBe(204);
    const c = findSetCookie(res, SESSION_COOKIE);
    expect(isCleared(c)).toBe(true);
    expect(c!.attrs["path"]).toBe("/job-tracker");
    expect(await res.text()).toBe("");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("needs no JSON content type (auth routes are exempt from the 415 check)", async () => {
    const app = await setup();
    const res = await app.request(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "x",
    });
    expect(res.status).toBe(204);
  });
});

/** A cookie value with a correct HMAC for the given payload, signed with the app's real secret. */
function signed(payload: unknown): string {
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${p}.${createHmac("sha256", TEST_SESSION_SECRET).update(p).digest("base64url")}`;
}

describe("validly signed but malformed payloads are 401", () => {
  const far = Math.floor(TEST_NOW.getTime() / 1000) + 86_400;
  it("control: a well-formed signed payload is accepted (seconds or milliseconds exp)", async () => {
    const app = await setup();
    const s = await signIn(app);
    const parsed = JSON.parse(Buffer.from(s.value.split(".")[0], "base64url").toString("utf8")) as { exp: number };
    const res = await me(app, { Cookie: `${SESSION_COOKIE}=${signed({ login: "devvJS", exp: parsed.exp })}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ login: "devvJS", via: "session" });
  });

  it.each([
    ["no exp", { login: "devvJS" }],
    ["exp as a string", { login: "devvJS", exp: String(far) }],
    ["exp null (what NaN serializes to)", { login: "devvJS", exp: null }],
    ["negative exp", { login: "devvJS", exp: -1 }],
    ["empty login", { login: "", exp: far * 1000 }],
    ["login as an array", { login: ["devvJS"], exp: far * 1000 }],
    ["login as an object", { login: { name: "devvJS" }, exp: far * 1000 }],
    ["no login", { exp: far * 1000 }],
    ["a JSON array", ["devvJS", far * 1000]],
  ])("%s", async (_name, payload) => {
    const app = await setup();
    await expectUnauthorized(await me(app, { Cookie: `${SESSION_COOKIE}=${signed(payload)}` }));
  });
});

describe("expiry boundary", () => {
  it("is invalid at exactly exp, valid one second before", async () => {
    const clock = createClock(TEST_NOW);
    const app = await setup({ clock });
    const s = await signIn(app);
    const { exp } = JSON.parse(Buffer.from(s.value.split(".")[0], "base64url").toString("utf8")) as { exp: number };
    const expMs = exp > 1e11 ? exp : exp * 1000; // derive the unit from the cookie
    clock.set(new Date(expMs - 1000));
    expect((await me(app, s.headers)).status).toBe(200);
    clock.set(new Date(expMs));
    await expectUnauthorized(await me(app, s.headers));
    clock.set(new Date(expMs + 1000));
    await expectUnauthorized(await me(app, s.headers));
  });
});
