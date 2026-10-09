import { afterEach, describe, expect, it } from "vitest";
import { TEST_NOW } from "../helpers/config.ts";
import { base, detailPaths, expectEnvelope, minutes, setup, type Harness } from "./helpers/harness.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

// Created one minute apart, so updated_at desc is D, C, B, A.
const A = "alpha-labs--frontend-dev--2026-10-07";
const B = "beta-works--ai-engineer--2026-10-07";
const C = "gamma-inc--platform-lead--2026-10-07";
const D = "delta-co--alpha-tooling-dev--2026-10-07";

async function seed() {
  const x = await setup();
  const mk = async (n: number, body: Record<string, unknown>) => {
    x.clock.set(minutes(TEST_NOW, n));
    await x.create(body);
  };
  await mk(0, {
    company: "Alpha Labs", role_title: "Frontend Dev", work_arrangement: "remote", status: "watching",
    track: "senior-frontend", detroit_metro: true, comp_max: 160000, fit: { total: 90 }, next_action_due: "2026-10-05",
  });
  await mk(1, {
    company: "Beta Works", role_title: "AI Engineer", work_arrangement: "hybrid", status: "applied",
    track: "ai-engineer", detroit_metro: false, comp_min: 100000, comp_max: 120000, fit: { total: 70 },
    follow_up_date: "2026-10-20",
  });
  await mk(2, {
    company: "Gamma Inc", role_title: "Platform Lead", work_arrangement: "onsite", status: "screen",
    track: "devex-platform", next_action_due: "2026-11-01",
  });
  await mk(3, {
    company: "Delta Co", role_title: "alpha tooling dev", work_arrangement: "remote", status: "rejected",
    track: "other", detroit_metro: true, comp_min: 150000, fit: { total: 80 },
  });
  return x;
}

const ids = (json: { items: { id: string }[] }) => json.items.map((i) => i.id);

describe("GET /applications", () => {
  it("returns {items, count} sorted by updated_at desc, with list records that omit events and contacts", async () => {
    h = await seed();
    const r = await h.call("GET", "/applications");
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(["count", "items"]);
    expect(r.json.count).toBe(4);
    expect(ids(r.json)).toEqual([D, C, B, A]);
    for (const item of r.json.items) {
      expect(item).not.toHaveProperty("events");
      expect(item).not.toHaveProperty("contacts");
    }
    expect(r.json.items[3]).toMatchObject({
      id: A, company: "Alpha Labs", role_title: "Frontend Dev", status: "watching", meets_floor: true,
      fit: { total: 90 }, updated_at: TEST_NOW.toISOString(), updated_by: "dakota",
    });
  });

  it("works with the agent key", async () => {
    h = await seed();
    const r = await h.call("GET", "/applications", { as: "agent" });
    expect(r.status).toBe(200);
    expect(r.json.count).toBe(4);
  });

  it("an empty table is {items: [], count: 0}", async () => {
    h = await setup();
    const r = await h.call("GET", "/applications");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ items: [], count: 0 });
  });

  it("ties on updated_at sort by id; a patch moves a record to the top", async () => {
    h = await setup();
    await h.create(base({ company: "Zulu", role_title: "Dev" }));
    await h.create(base({ company: "Mike", role_title: "Dev" }));
    await h.create(base({ company: "Alpha", role_title: "Dev" }));
    expect(ids((await h.call("GET", "/applications")).json)).toEqual([
      "alpha--dev--2026-10-07",
      "mike--dev--2026-10-07",
      "zulu--dev--2026-10-07",
    ]);
    h.clock.set(minutes(TEST_NOW, 5));
    const z = await h.get("zulu--dev--2026-10-07");
    await h.patch(z.id, { notes: "touched" }, z.updated_at);
    expect(ids((await h.call("GET", "/applications")).json)).toEqual([
      "zulu--dev--2026-10-07",
      "alpha--dev--2026-10-07",
      "mike--dev--2026-10-07",
    ]);
  });

  describe.each([
    ["status=applied", "status=applied", [B]],
    ["status comma list", "status=watching,screen", [C, A]],
    ["status list with all terminal", "status=rejected,applied", [D, B]],
    ["track", "track=ai-engineer", [B]],
    ["work_arrangement", "work_arrangement=remote", [D, A]],
    ["work_arrangement onsite", "work_arrangement=onsite", [C]],
    ["detroit_metro=true", "detroit_metro=true", [D, A]],
    ["detroit_metro=false", "detroit_metro=false", [B]],
    ["meets_floor=true (null excluded)", "meets_floor=true", [D, A]],
    ["meets_floor=false (null excluded)", "meets_floor=false", [B]],
    ["min_fit=80 (inclusive)", "min_fit=80", [D, A]],
    ["min_fit=81", "min_fit=81", [A]],
    ["min_fit=91", "min_fit=91", []],
    ["min_fit=0 excludes records with no fit", "min_fit=0", [D, B, A]],
    ["due_before on the next_action_due day (inclusive)", "due_before=2026-10-05", [A]],
    ["due_before before everything", "due_before=2026-10-04", []],
    ["due_before matches follow_up_date too", "due_before=2026-10-20", [B, A]],
    ["due_before later", "due_before=2026-11-01", [C, B, A]],
    ["q on company, case-insensitive", "q=BETA", [B]],
    ["q on role_title", "q=platform", [C]],
    ["q on company or role", "q=Alpha", [D, A]],
    ["q substring in the middle", "q=ooling", [D]],
    ["q with no match", "q=zzzz", []],
    ["updated_since is inclusive", `updated_since=${minutes(TEST_NOW, 2).toISOString()}`, [D, C]],
    ["updated_since after everything", `updated_since=${minutes(TEST_NOW, 4).toISOString()}`, []],
    ["combined: arrangement + metro + fit", "work_arrangement=remote&detroit_metro=true&min_fit=85", [A]],
    ["combined: status list + meets_floor", "status=watching,rejected&meets_floor=true", [D, A]],
    ["combined: q + track", "q=alpha&track=other", [D]],
    ["combined: due_before + status", "due_before=2026-11-01&status=applied,screen", [C, B]],
    ["combined: everything that matches only A", "status=watching&track=senior-frontend&work_arrangement=remote&detroit_metro=true&meets_floor=true&min_fit=90&due_before=2026-10-05&q=labs&updated_since=" + TEST_NOW.toISOString(), [A]],
  ])("filter: %s", (_name, qs, expected) => {
    it(`?${qs.slice(0, 70)} -> ${expected.length} item(s)`, async () => {
      h = await seed();
      const r = await h.call("GET", `/applications?${qs}`);
      expect(r.status).toBe(200);
      expect(ids(r.json)).toEqual(expected);
      expect(r.json.count).toBe(expected.length);
    });
  });

  it.each([
    ["status=bogus", "status"],
    ["status=watching,bogus", "status"],
    ["track=bogus", "track"],
    ["work_arrangement=bogus", "work_arrangement"],
    ["detroit_metro=maybe", "detroit_metro"],
    ["detroit_metro=1", "detroit_metro"],
    ["meets_floor=yes", "meets_floor"],
    ["min_fit=abc", "min_fit"],
    ["min_fit=1.5", "min_fit"],
    ["due_before=2026-13-01", "due_before"],
    ["due_before=tomorrow", "due_before"],
    ["updated_since=yesterday", "updated_since"],
    ["updated_since=2026-10-07", "updated_since"],
  ])("invalid parameter %s -> 400 naming %s", async (qs, path) => {
    h = await seed();
    const r = await h.call("GET", `/applications?${qs}`);
    expectEnvelope(r, 400, "bad_request");
    expect(detailPaths(r.json)).toContain(path);
  });
});
