import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../../server/config.ts";
import { buildTestApp } from "../helpers/app.ts";
import {
  BASE,
  SESSION_COOKIE,
  STATE_COOKIE,
  callback,
  findSetCookie,
  isCleared,
  setCookies,
  startLogin,
} from "../helpers/auth.ts";
import { TEST_NOW, TEST_SESSION_SECRET } from "../helpers/config.ts";
import { FAKE_ACCESS_TOKEN, LEAKY_UPSTREAM_TEXT, createFakeGithub, type FailureMode } from "../helpers/github.ts";

type Built = Awaited<ReturnType<typeof buildTestApp>>;
let built: Built | undefined;
afterEach(async () => {
  await built?.close();
  built = undefined;
});

async function setup(opts: { login?: string; failure?: FailureMode | null; config?: Partial<Config> } = {}) {
  const gh = createFakeGithub({ login: opts.login, failure: opts.failure });
  built = await buildTestApp({ fetch: gh.fetch, config: opts.config });
  return { app: built.app, gh, config: built.config };
}

async function fullCallback(app: Built["app"], code = "the-code") {
  const started = await startLogin(app);
  const res = await callback(app, { code, state: started.state, stateCookie: started.stateCookie.value });
  return { started, res };
}

describe("GET /api/auth/login", () => {
  it("302s to GitHub authorize with client_id, redirect_uri from publicUrl, scope and a state", async () => {
    const { app } = await setup();
    const res = await app.request(`${BASE}/api/auth/login`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe("https://github.test/login/oauth/authorize");
    expect([...loc.searchParams.keys()].sort()).toEqual(["client_id", "redirect_uri", "scope", "state"]);
    expect(loc.searchParams.get("client_id")).toBe("test-client-id");
    expect(loc.searchParams.get("redirect_uri")).toBe("http://localhost:3000/job-tracker/api/auth/callback");
    expect(loc.searchParams.get("scope")).toBe("read:user");
    expect(loc.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("builds redirect_uri and the authorize URL from config (publicUrl, oauthUrl, clientId)", async () => {
    const { app } = await setup({
      config: {
        publicUrl: "https://devvjs.dev",
        github: { clientId: "other-id", clientSecret: "s", oauthUrl: "https://gh.example", apiUrl: "https://api.gh.example" },
      },
    });
    const { location } = await startLogin(app);
    expect(`${location.origin}${location.pathname}`).toBe("https://gh.example/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("other-id");
    expect(location.searchParams.get("redirect_uri")).toBe("https://devvjs.dev/job-tracker/api/auth/callback");
  });

  it("sets jt_oauth_state equal to the state, with the spec attributes", async () => {
    const { app } = await setup();
    const { state, stateCookie } = await startLogin(app);
    expect(stateCookie.name).toBe(STATE_COOKIE);
    expect(stateCookie.value).toBe(state);
    expect(stateCookie.attrs["path"]).toBe("/job-tracker/api/auth");
    expect(stateCookie.attrs["httponly"]).toBe(true);
    expect(stateCookie.attrs["secure"]).toBe(true);
    expect(String(stateCookie.attrs["samesite"]).toLowerCase()).toBe("lax");
    expect(stateCookie.attrs["max-age"]).toBe("600");
  });

  it("issues a different state on every login", async () => {
    const { app } = await setup();
    const a = await startLogin(app);
    const b = await startLogin(app);
    expect(a.state).not.toBe("");
    expect(b.state).not.toBe("");
    expect(a.state).not.toBe(b.state);
    expect(a.stateCookie.value).not.toBe(b.stateCookie.value);
  });

  it("needs no authentication and sets no session", async () => {
    const { app } = await setup();
    const res = await app.request(`${BASE}/api/auth/login`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(findSetCookie(res, SESSION_COOKIE)).toBeUndefined();
  });
});

describe("GET /api/auth/callback: success", () => {
  it("exchanges the code, reads the user, sets the session cookie, clears state, 302s to /job-tracker/", async () => {
    const { app, gh } = await setup();
    const { res } = await fullCallback(app, "abc123");
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!, "http://localhost").pathname).toBe("/job-tracker/");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");

    expect(gh.tokenCalls()).toHaveLength(1);
    const t = gh.tokenCalls()[0];
    expect(t.method).toBe("POST");
    expect(t.url).toBe("https://github.test/login/oauth/access_token");
    expect(t.headers["accept"]).toBe("application/json");
    expect(t.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(t.body!)).toEqual({
      client_id: "test-client-id",
      client_secret: "test-client-secret",
      code: "abc123",
      redirect_uri: "http://localhost:3000/job-tracker/api/auth/callback",
    });

    expect(gh.userCalls()).toHaveLength(1);
    const u = gh.userCalls()[0];
    expect(u.method).toBe("GET");
    expect(u.url).toBe("https://api.github.test/user");
    expect(u.headers["authorization"]).toBe(`Bearer ${FAKE_ACCESS_TOKEN}`);
    expect(gh.calls).toHaveLength(2);
  });

  it("session cookie: signed payload {login, exp} and every spec attribute", async () => {
    const { app } = await setup();
    const { res } = await fullCallback(app);
    const c = findSetCookie(res, SESSION_COOKIE)!;
    expect(c).toBeDefined();
    expect(c.attrs["path"]).toBe("/job-tracker");
    expect(c.attrs["httponly"]).toBe(true);
    expect(c.attrs["secure"]).toBe(true);
    expect(String(c.attrs["samesite"]).toLowerCase()).toBe("lax");
    expect(c.attrs["max-age"]).toBe("2592000");

    const parts = c.value.split(".");
    expect(parts).toHaveLength(2);
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { login: string; exp: number };
    expect(Object.keys(payload).sort()).toEqual(["exp", "login"]);
    expect(payload.login).toBe("devvJS");
    // exp is 30 days after now(); the spec does not fix the unit, so accept seconds or milliseconds
    const secs = Math.floor(TEST_NOW.getTime() / 1000) + 2592000;
    const ms = TEST_NOW.getTime() + 2592000 * 1000;
    expect([secs, ms]).toContain(payload.exp);
    const sig = createHmac("sha256", TEST_SESSION_SECRET).update(parts[0]).digest("base64url");
    expect(parts[1]).toBe(sig);
  });

  it("clears the state cookie on the same path", async () => {
    const { app } = await setup();
    const { res } = await fullCallback(app);
    const cleared = findSetCookie(res, STATE_COOKIE);
    expect(isCleared(cleared)).toBe(true);
    expect(cleared!.attrs["path"]).toBe("/job-tracker/api/auth");
  });

  it("compares the allowed login case-insensitively", async () => {
    const { app } = await setup({ login: "DEVVJS" });
    const { res } = await fullCallback(app);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!, "http://localhost").pathname).toBe("/job-tracker/");
    expect(findSetCookie(res, SESSION_COOKIE)!.value).not.toBe("");
  });

  it("honors a configured allowedLogin", async () => {
    const { app } = await setup({ login: "someone-else", config: { allowedLogin: "Someone-Else" } });
    const { res } = await fullCallback(app);
    expect(res.status).toBe(302);
    expect(findSetCookie(res, SESSION_COOKIE)).toBeDefined();
  });
});

describe("GET /api/auth/callback: refusals", () => {
  it("a login that is not allowed gets 403 forbidden and no session", async () => {
    const { app } = await setup({ login: "mallory" });
    const { res } = await fullCallback(app);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error.code).toBe("forbidden");
    const session = findSetCookie(res, SESSION_COOKIE);
    expect(session === undefined || session.value === "").toBe(true);
    expect(res.headers.get("location")).toBeNull();
  });

  it("a login that merely contains the allowed one is refused", async () => {
    const { app } = await setup({ login: "devvJS-evil" });
    const { res } = await fullCallback(app);
    expect(res.status).toBe(403);
  });

  it("a state that differs from the cookie gets 400 and never calls GitHub", async () => {
    const { app, gh } = await setup();
    const started = await startLogin(app);
    const res = await callback(app, { code: "c", state: "not-the-state", stateCookie: started.stateCookie.value });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_request");
    expect(findSetCookie(res, SESSION_COOKIE)).toBeUndefined();
    expect(gh.calls).toEqual([]);
  });

  it("a missing state cookie gets 400 and never calls GitHub", async () => {
    const { app, gh } = await setup();
    const started = await startLogin(app);
    const res = await callback(app, { code: "c", state: started.state, stateCookie: null });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_request");
    expect(findSetCookie(res, SESSION_COOKIE)).toBeUndefined();
    expect(gh.calls).toEqual([]);
  });

  it("a missing state query param gets 400", async () => {
    const { app, gh } = await setup();
    const started = await startLogin(app);
    const res = await callback(app, { code: "c", stateCookie: started.stateCookie.value });
    expect(res.status).toBe(400);
    expect(gh.calls).toEqual([]);
  });
});

describe("GET /api/auth/callback: GitHub failures", () => {
  const modes: FailureMode[] = [
    "token-network-error",
    "token-http-500",
    "token-no-access-token",
    "token-not-json",
    "user-network-error",
    "user-http-401",
    "user-http-500",
    "user-no-login",
    "user-not-json",
  ];

  it.each(modes)("%s -> 502 upstream_error, no session, no secret or token in the body", async (mode) => {
    const { app, config } = await setup({ failure: mode });
    const { res } = await fullCallback(app, "code-for-failure");
    expect(res.status).toBe(502);
    const text = await res.text();
    const body = JSON.parse(text) as { error: { code: string; message: string } };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error.code).toBe("upstream_error");
    expect(typeof body.error.message).toBe("string");
    for (const secret of [config.github.clientSecret, FAKE_ACCESS_TOKEN, LEAKY_UPSTREAM_TEXT, config.sessionSecret]) {
      expect(text).not.toContain(secret);
    }
    expect(setCookies(res).filter((c) => c.name === SESSION_COOKIE && c.value !== "")).toEqual([]);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });
});
