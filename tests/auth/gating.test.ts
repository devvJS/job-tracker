import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers/app.ts";
import { BASE, agentHeaders, signIn } from "../helpers/auth.ts";
import { createFakeGithub } from "../helpers/github.ts";

type Built = Awaited<ReturnType<typeof buildTestApp>>;
let built: Built | undefined;
afterEach(async () => {
  await built?.close();
  built = undefined;
});

async function setup() {
  const gh = createFakeGithub();
  built = await buildTestApp({ fetch: gh.fetch });
  return built.app;
}

async function expect401(res: Response) {
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBe("Bearer");
  expect(res.headers.get("x-robots-tag")).toBe("noindex");
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(Object.keys(body)).toEqual(["error"]);
  expect(body.error.code).toBe("unauthorized");
}

describe("API gating", () => {
  it.each([
    "/api/applications",
    "/api/applications/some--id--2026-10-07",
    "/api/contacts",
    "/api/due",
    "/api/summary",
    "/api/export",
    "/api/openapi.yaml",
    "/api/does-not-exist",
    "/api",
    "/api/authx",
  ])("GET %s without auth -> 401", async (path) => {
    const app = await setup();
    await expect401(await app.request(`${BASE}${path}`));
  });

  it.each(["POST", "PATCH", "PUT", "DELETE"])("%s to an /api route without auth -> 401", async (method) => {
    const app = await setup();
    await expect401(
      await app.request(`${BASE}/api/applications`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "DELETE" ? undefined : "{}",
      }),
    );
  });

  it("GET /api/auth/me without auth -> 401", async () => {
    const app = await setup();
    await expect401(await app.request(`${BASE}/api/auth/me`));
  });

  it("the auth routes login and callback are reachable without auth", async () => {
    const app = await setup();
    const login = await app.request(`${BASE}/api/auth/login`, { redirect: "manual" });
    expect(login.status).toBe(302);
    const cb = await app.request(`${BASE}/api/auth/callback?code=x&state=y`, { redirect: "manual" });
    expect(cb.status).toBe(400); // the state check, not 401
  });

  it("/healthz stays public", async () => {
    const app = await setup();
    const res = await app.request(`${BASE}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, lastExportAt: null });
  });

  it("an unknown /api path with a session -> 404 envelope", async () => {
    const app = await setup();
    const s = await signIn(app);
    const res = await app.request(`${BASE}/api/nope`, { headers: s.headers });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("an unknown /api path with the agent key -> 404 envelope", async () => {
    const app = await setup();
    const res = await app.request(`${BASE}/api/nope`, { headers: agentHeaders() });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("an unknown /api path with a bad key -> 401, not 404", async () => {
    const app = await setup();
    await expect401(await app.request(`${BASE}/api/nope`, { headers: agentHeaders("bad-bad-bad-bad-bad-bad-bad-bad-bad") }));
  });
});

describe("415 ordering (contract: authentication runs before the media-type check)", () => {
  it("an unauthenticated non-JSON POST -> 401", async () => {
    const app = await setup();
    await expect401(
      await app.request(`${BASE}/api/applications`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "hello",
      }),
    );
  });

  it("an unauthenticated POST with no content type -> 401", async () => {
    const app = await setup();
    await expect401(await app.request(`${BASE}/api/applications`, { method: "POST" }));
  });

  it("an authenticated non-JSON POST -> 415 (agent key)", async () => {
    const app = await setup();
    const res = await app.request(`${BASE}/api/applications`, {
      method: "POST",
      headers: { ...agentHeaders(), "Content-Type": "text/plain" },
      body: "hello",
    });
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unsupported_media_type");
  });

  it("an authenticated non-JSON POST -> 415 (session)", async () => {
    const app = await setup();
    const s = await signIn(app);
    const res = await app.request(`${BASE}/api/applications`, {
      method: "POST",
      headers: { ...s.headers, "Content-Type": "text/plain" },
      body: "hello",
    });
    expect(res.status).toBe(415);
  });

  it("an authenticated JSON POST passes both checks and reaches the 404", async () => {
    const app = await setup();
    const res = await app.request(`${BASE}/api/nope`, {
      method: "POST",
      headers: { ...agentHeaders(), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });
});

describe("actor and authVia in the Hono context", () => {
  type Seen = { actor: unknown; authVia: unknown };

  async function withProbe() {
    const app = await setup();
    let seen: Seen | undefined;
    app.get(`${BASE}/api/_actor`, (c) => {
      seen = { actor: c.get("actor"), authVia: c.get("authVia") };
      return c.json({ ok: true });
    });
    return { app, seen: () => seen };
  }

  it("a session sets actor dakota, authVia session", async () => {
    const { app, seen } = await withProbe();
    const s = await signIn(app);
    const res = await app.request(`${BASE}/api/_actor`, { headers: s.headers });
    expect(res.status).toBe(200);
    expect(seen()).toEqual({ actor: "dakota", authVia: "session" });
  });

  it("the agent key sets actor claude-project, authVia agent", async () => {
    const { app, seen } = await withProbe();
    const res = await app.request(`${BASE}/api/_actor`, { headers: agentHeaders() });
    expect(res.status).toBe(200);
    expect(seen()).toEqual({ actor: "claude-project", authVia: "agent" });
  });

  it("the probe is never reached without auth", async () => {
    const { app, seen } = await withProbe();
    const res = await app.request(`${BASE}/api/_actor`);
    expect(res.status).toBe(401);
    expect(seen()).toBeUndefined();
  });
});

describe("method, path and cookie-name edge cases", () => {
  it("/api/auth/login/ (trailing slash) is not exempt: 401 without credentials", async () => {
    const app = await setup();
    await expect401(await app.request(`${BASE}/api/auth/login/`));
  });

  it("OPTIONS on an /api data path -> 401", async () => {
    const app = await setup();
    await expect401(await app.request(`${BASE}/api/applications`, { method: "OPTIONS" }));
  });

  it("a __Host-jt_session cookie alone is ignored", async () => {
    const app = await setup();
    const s = await signIn(app);
    const res = await app.request(`${BASE}/api/auth/me`, { headers: { Cookie: `__Host-jt_session=${s.value}` } });
    await expect401(res);
  });
});
