import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { applications, settings } from "../../db/schema.ts";
import { buildTestApp } from "../helpers/app.ts";
import { BASE, agentHeaders, createClock, signIn } from "../helpers/auth.ts";
import { TEST_NOW } from "../helpers/config.ts";
import { createFakeGithub } from "../helpers/github.ts";
import { APP_ALPHA, APP_ZETA, CONTACT_BOB, CONTACT_JANE, JD_TEXT, expectedRecords, seedData } from "./helpers/fixtures.ts";

type Built = Awaited<ReturnType<typeof buildTestApp>>;
let built: Built | undefined;
afterEach(async () => {
  await built?.close();
  built = undefined;
});

async function setup(now?: () => Date) {
  const gh = createFakeGithub();
  built = await buildTestApp({ fetch: gh.fetch, now });
  return built;
}

const URL_EXPORT = `${BASE}/api/export`;

describe("GET /export", () => {
  it("returns 401 without credentials", async () => {
    const { app } = await setup();
    const res = await app.request(URL_EXPORT);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 401 for a wrong agent key", async () => {
    const { app } = await setup();
    const res = await app.request(URL_EXPORT, { headers: agentHeaders("wrong-key-wrong-key-wrong-key-wrong-key") });
    expect(res.status).toBe(401);
  });

  it("with an empty database returns empty lists, the comp floor and exported_at from now", async () => {
    const { app } = await setup();
    const res = await app.request(URL_EXPORT, { headers: agentHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      exported_at: "2026-10-07T14:00:00.000Z",
      applications: [],
      contacts: [],
      settings: { comp_floor: 150000 },
    });
  });

  it("serves the full dump to the agent key: sorted by id, events and contact_ids, no contacts objects", async () => {
    const { app, db } = await setup();
    await seedData(db);
    const { apps, cons } = await expectedRecords(db);
    const res = await app.request(URL_EXPORT, { headers: agentHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      exported_at: string;
      applications: Record<string, unknown>[];
      contacts: Record<string, unknown>[];
      settings: unknown;
    };
    expect(Object.keys(body)).toEqual(["exported_at", "applications", "contacts", "settings"]);
    expect(body.exported_at).toBe(TEST_NOW.toISOString());
    expect(body.settings).toEqual({ comp_floor: 150000 });
    expect(body.applications.map((a) => a.id)).toEqual([APP_ALPHA, APP_ZETA]);
    expect(body.contacts.map((c) => c.id)).toEqual([CONTACT_BOB, CONTACT_JANE]);
    expect(body.applications).toEqual(JSON.parse(JSON.stringify(apps)));
    expect(body.contacts).toEqual(JSON.parse(JSON.stringify(cons)));

    const zeta = body.applications[1];
    expect("contacts" in zeta).toBe(false);
    expect(zeta.contact_ids).toEqual([CONTACT_BOB, CONTACT_JANE]);
    expect(zeta.custom_flag).toBe("yes");
    expect(zeta.nested).toEqual({ a: 1 });
    expect("extra" in zeta).toBe(false);
    expect(zeta.jd_snapshot).toBe(JD_TEXT);
    expect(zeta.meets_floor).toBe(true);
    // canonical order: the tail is jd_snapshot, extra keys, contact_ids, events
    const [storedZeta] = await db.select().from(applications).where(eq(applications.id, APP_ZETA));
    const tail = ["jd_snapshot", ...Object.keys(storedZeta.extra), "contact_ids", "events"];
    expect(Object.keys(zeta).slice(-tail.length)).toEqual(tail);
    const evs = zeta.events as { id: string; at: string; type: string; note: string | null; by: string }[];
    expect(evs.map((e) => [e.id, e.at, e.type, e.note, e.by])).toEqual([
      ["00000000-0000-4000-8000-0000000000b2", "2026-10-01T12:00:00.000Z", "discovered", null, "claude-project"],
      ["00000000-0000-4000-8000-0000000000a1", "2026-10-02T09:00:00.000Z", "note", "second", "dakota"],
    ]);
    const alpha = body.applications[0];
    expect(alpha.events).toEqual([]);
    expect(alpha.contact_ids).toEqual([CONTACT_JANE]);
    expect("contacts" in alpha).toBe(false);
  });

  it("serves the same dump to a signed-in session", async () => {
    const { app, db } = await setup();
    await seedData(db);
    const { cookie } = await signIn(app);
    const res = await app.request(URL_EXPORT, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applications: { id: string }[]; contacts: { id: string }[] };
    expect(body.applications.map((a) => a.id)).toEqual([APP_ALPHA, APP_ZETA]);
    expect(body.contacts.map((c) => c.id)).toEqual([CONTACT_BOB, CONTACT_JANE]);
  });

  it("takes exported_at from the clock on every request", async () => {
    const clock = createClock(new Date("2026-11-02T03:04:05.678Z"));
    const { app } = await setup(clock.now);
    const first = (await (await app.request(URL_EXPORT, { headers: agentHeaders() })).json()) as { exported_at: string };
    expect(first.exported_at).toBe("2026-11-02T03:04:05.678Z");
    clock.set(new Date("2026-11-03T00:00:00.000Z"));
    const second = (await (await app.request(URL_EXPORT, { headers: agentHeaders() })).json()) as { exported_at: string };
    expect(second.exported_at).toBe("2026-11-03T00:00:00.000Z");
  });

  it("settings.comp_floor is read from the settings table", async () => {
    const { app, db } = await setup();
    await db.update(settings).set({ value: 175000 }).where(eq(settings.key, "comp_floor"));
    const res = await app.request(URL_EXPORT, { headers: agentHeaders() });
    const body = (await res.json()) as { settings: unknown };
    expect(body.settings).toEqual({ comp_floor: 175000 });
  });

  it("contact_ids and application_ids are sorted although the links were inserted in the other order", async () => {
    const { app, db } = await setup();
    await seedData(db);
    const res = await app.request(URL_EXPORT, { headers: agentHeaders() });
    const body = (await res.json()) as {
      applications: { id: string; contact_ids: string[] }[];
      contacts: { id: string; application_ids: string[] }[];
    };
    expect(body.applications.map((a) => [a.id, a.contact_ids])).toEqual([
      [APP_ALPHA, [CONTACT_JANE]],
      [APP_ZETA, [CONTACT_BOB, CONTACT_JANE]],
    ]);
    expect(body.contacts.map((c) => [c.id, c.application_ids])).toEqual([
      [CONTACT_BOB, [APP_ZETA]],
      [CONTACT_JANE, [APP_ALPHA, APP_ZETA]],
    ]);
  });
});
