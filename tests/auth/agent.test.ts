import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers/app.ts";
import { BASE, SESSION_COOKIE, agentHeaders, createClock, signIn } from "../helpers/auth.ts";
import { TEST_AGENT_KEY, TEST_NOW } from "../helpers/config.ts";
import { createFakeGithub } from "../helpers/github.ts";

const NEXT_KEY = "next-agent-key-0123456789-abcdefghijklmnopq";
const BAD_KEY = "nope-nope-nope-nope-nope-nope-nope-nope";

type Built = Awaited<ReturnType<typeof buildTestApp>>;
let built: Built | undefined;
afterEach(async () => {
  await built?.close();
  built = undefined;
});

async function setup(opts: { limit?: number; keys?: string[]; now?: Date | (() => Date) } = {}) {
  const gh = createFakeGithub();
  built = await buildTestApp({
    fetch: gh.fetch,
    now: opts.now,
    config: {
      agentKeys: opts.keys ?? [TEST_AGENT_KEY, NEXT_KEY],
      ...(opts.limit !== undefined ? { agentRateLimitPerMinute: opts.limit } : {}),
    },
  });
  // A route behind the auth middleware, so rate limiting is observed on an ordinary API request.
  built.app.get(`${BASE}/api/_probe`, (c) => c.json({ ok: true }));
  return built.app;
}

const probe = (app: Built["app"], headers: Record<string, string> = {}) =>
  app.request(`${BASE}/api/_probe`, { headers });
const me = (app: Built["app"], headers: Record<string, string> = {}) =>
  app.request(`${BASE}/api/auth/me`, { headers });

describe("agent key authentication", () => {
  it("TRACKER_AGENT_KEY works: me returns claude-project via agent", async () => {
    const app = await setup();
    const res = await me(app, agentHeaders(TEST_AGENT_KEY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ login: "claude-project", via: "agent" });
  });

  it("TRACKER_AGENT_KEY_NEXT works too", async () => {
    const app = await setup();
    const res = await me(app, agentHeaders(NEXT_KEY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ login: "claude-project", via: "agent" });
  });

  it.each([
    ["a wrong key", "wrong-key-0123456789-abcdefghijklmnopqrstuv"],
    ["a prefix of the key", TEST_AGENT_KEY.slice(0, -1)],
    ["the key plus a character", `${TEST_AGENT_KEY}x`],
    ["an empty key", ""],
  ])("%s gives 401 with WWW-Authenticate: Bearer", async (_name, key) => {
    const app = await setup();
    const res = await me(app, { Authorization: `Bearer ${key}` });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("a key no longer configured (rotated out) gives 401", async () => {
    const app = await setup({ keys: [NEXT_KEY] });
    expect((await me(app, agentHeaders(TEST_AGENT_KEY))).status).toBe(401);
    expect((await me(app, agentHeaders(NEXT_KEY))).status).toBe(200);
  });

  it("a non-Bearer scheme carrying the key gives 401", async () => {
    const app = await setup();
    const res = await me(app, { Authorization: `Basic ${TEST_AGENT_KEY}` });
    expect(res.status).toBe(401);
  });

  it("an invalid bearer key plus a valid session cookie still gives 401 (precedence)", async () => {
    const app = await setup();
    const s = await signIn(app);
    expect((await me(app, s.headers)).status).toBe(200);
    const res = await me(app, { ...s.headers, Authorization: `Bearer ${BAD_KEY}` });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    const viaProbe = await probe(app, { ...s.headers, Authorization: `Bearer ${BAD_KEY}` });
    expect(viaProbe.status).toBe(401);
  });

  it("a valid key wins over an invalid session cookie", async () => {
    const app = await setup();
    const res = await me(app, { ...agentHeaders(), Cookie: `${SESSION_COOKIE}=garbage.garbage` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ login: "claude-project", via: "agent" });
  });

  it("a valid key wins over a valid session: via is agent", async () => {
    const app = await setup();
    const s = await signIn(app);
    const res = await me(app, { ...s.headers, ...agentHeaders() });
    expect(await res.json()).toEqual({ login: "claude-project", via: "agent" });
  });
});

describe("agent rate limit", () => {
  it("allows exactly agentRateLimitPerMinute requests, then 429 with Retry-After", async () => {
    const now = new Date("2026-10-07T14:00:20.000Z");
    const app = await setup({ limit: 5, now });
    for (let i = 0; i < 5; i++) {
      const res = await probe(app, agentHeaders());
      expect(res.status, `request ${i + 1}`).toBe(200);
    }
    const res = await probe(app, agentHeaders());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("40"); // seconds to the next minute boundary
    const body = (await res.json()) as { error: { code: string } };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error.code).toBe("rate_limited");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect((await probe(app, agentHeaders())).status).toBe(429);
  });

  it("the default limit is 60 per minute", async () => {
    const app = await setup({ now: TEST_NOW });
    for (let i = 0; i < 60; i++) {
      expect((await probe(app, agentHeaders())).status, `request ${i + 1}`).toBe(200);
    }
    const res = await probe(app, agentHeaders());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("counts requests to /api/auth/me too", async () => {
    const app = await setup({ limit: 2, now: TEST_NOW });
    expect((await me(app, agentHeaders())).status).toBe(200);
    expect((await probe(app, agentHeaders())).status).toBe(200);
    expect((await me(app, agentHeaders())).status).toBe(429);
  });

  it("resets in the next minute window", async () => {
    const clock = createClock(new Date("2026-10-07T14:00:10.000Z"));
    const app = await setup({ limit: 3, now: clock.now });
    for (let i = 0; i < 3; i++) expect((await probe(app, agentHeaders())).status).toBe(200);
    expect((await probe(app, agentHeaders())).status).toBe(429);
    clock.set(new Date("2026-10-07T14:00:59.999Z"));
    const stillLimited = await probe(app, agentHeaders());
    expect(stillLimited.status).toBe(429);
    expect(stillLimited.headers.get("retry-after")).toBe("1");
    clock.set(new Date("2026-10-07T14:01:00.000Z"));
    for (let i = 0; i < 3; i++) expect((await probe(app, agentHeaders())).status, `new window ${i + 1}`).toBe(200);
    expect((await probe(app, agentHeaders())).status).toBe(429);
  });

  it("each key has its own budget", async () => {
    const app = await setup({ limit: 2, now: TEST_NOW });
    expect((await probe(app, agentHeaders(TEST_AGENT_KEY))).status).toBe(200);
    expect((await probe(app, agentHeaders(TEST_AGENT_KEY))).status).toBe(200);
    expect((await probe(app, agentHeaders(TEST_AGENT_KEY))).status).toBe(429);
    expect((await probe(app, agentHeaders(NEXT_KEY))).status).toBe(200);
    expect((await probe(app, agentHeaders(NEXT_KEY))).status).toBe(200);
    expect((await probe(app, agentHeaders(NEXT_KEY))).status).toBe(429);
  });

  it("sessions are not rate limited", async () => {
    const app = await setup({ limit: 2, now: TEST_NOW });
    const s = await signIn(app);
    for (let i = 0; i < 10; i++) {
      expect((await probe(app, s.headers)).status, `request ${i + 1}`).toBe(200);
    }
  });

  it("session requests do not use up the agent budget", async () => {
    const app = await setup({ limit: 2, now: TEST_NOW });
    const s = await signIn(app);
    for (let i = 0; i < 5; i++) await probe(app, s.headers);
    expect((await probe(app, agentHeaders())).status).toBe(200);
    expect((await probe(app, agentHeaders())).status).toBe(200);
    expect((await probe(app, agentHeaders())).status).toBe(429);
  });
});
