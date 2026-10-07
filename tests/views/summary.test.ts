import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers/app.ts";
import { agentHeaders, signIn } from "../helpers/auth.ts";
import { createFakeGithub } from "../helpers/github.ts";
import { STATUSES } from "../../shared/schemas.ts";
import { VIEWS_BASE, insertApp, insertEvent, insertStatusChange } from "./helpers/rows.ts";

type Built = Awaited<ReturnType<typeof buildTestApp>>;
let built: Built | undefined;
afterEach(async () => {
  await built?.close();
  built = undefined;
});

type SourceRow = { source: string; applied: number; responded: number; interviewed: number; response_rate: number };
type Summary = {
  from: string;
  to: string;
  applied: number;
  responses: number;
  interviews: number;
  by_status: Record<string, number>;
  by_source: SourceRow[];
};

const get = (b: Built, qs = "", headers: Record<string, string> = agentHeaders()) =>
  b.app.request(`${VIEWS_BASE}/summary${qs}`, { headers });
const summary = async (b: Built, qs = "") => {
  const res = await get(b, qs);
  expect(res.status).toBe(200);
  return (await res.json()) as Summary;
};

const zeroStatuses = Object.fromEntries(STATUSES.map((s) => [s, 0]));

// TEST_NOW is 2026-10-07 in Detroit (UTC-4), so the default window is 2026-10-01 .. 2026-10-07.
describe("GET /summary: window and shape", () => {
  it("an empty database gives the default window, zero counts, all 11 statuses and no sources", async () => {
    built = await buildTestApp();
    expect(STATUSES).toHaveLength(11);
    expect(await summary(built)).toEqual({
      from: "2026-10-01",
      to: "2026-10-07",
      applied: 0,
      responses: 0,
      interviews: 0,
      by_status: zeroStatuses,
      by_source: [],
    });
  });

  it("the default window follows the Detroit date", async () => {
    built = await buildTestApp({ now: new Date("2026-10-08T03:30:00.000Z") });
    const s = await summary(built);
    expect([s.from, s.to]).toEqual(["2026-10-01", "2026-10-07"]);
  });

  it("explicit from and to are echoed", async () => {
    built = await buildTestApp();
    const s = await summary(built, "?from=2026-09-01&to=2026-09-30");
    expect([s.from, s.to]).toEqual(["2026-09-01", "2026-09-30"]);
  });

  it("only to given: from is to minus 6 days (across a month boundary)", async () => {
    built = await buildTestApp();
    const s = await summary(built, "?to=2026-10-03");
    expect([s.from, s.to]).toEqual(["2026-09-27", "2026-10-03"]);
  });

  it("only from given: to is today", async () => {
    built = await buildTestApp();
    const s = await summary(built, "?from=2026-10-05");
    expect([s.from, s.to]).toEqual(["2026-10-05", "2026-10-07"]);
  });

  it("from equal to to is a valid one-day window", async () => {
    built = await buildTestApp();
    await insertApp(built.db, "one", { applied_at: "2026-10-04" });
    await insertApp(built.db, "two", { applied_at: "2026-10-05" });
    const s = await summary(built, "?from=2026-10-04&to=2026-10-04");
    expect([s.from, s.to, s.applied]).toEqual(["2026-10-04", "2026-10-04", 1]);
  });

  it.each([
    ["from not a date", "?from=yesterday"],
    ["to not a date", "?to=2026-10-32"],
    ["from a day that does not exist", "?from=2026-02-30&to=2026-03-05"],
    ["from after to", "?from=2026-10-07&to=2026-10-01"],
    ["from after the default to", "?from=2026-10-08"],
    ["to before the default from", "?to=2026-09-01&from=2026-09-02"],
    ["empty from", "?from="],
  ])("%s gives 400 bad_request", async (_n, qs) => {
    built = await buildTestApp();
    const res = await get(built, qs);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_request");
  });

  it("requires auth: 401 without credentials, 200 with the agent key or a session", async () => {
    const gh = createFakeGithub();
    built = await buildTestApp({ fetch: gh.fetch });
    expect((await get(built, "", agentHeaders())).status).toBe(200);
    const session = await signIn(built.app);
    expect((await get(built, "", session.headers)).status).toBe(200);
    const anon = await get(built, "", {});
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
  });
});

describe("GET /summary: applied", () => {
  it("counts applied_at inside [from, to], inclusive at both ends", async () => {
    built = await buildTestApp();
    const { db } = built;
    await insertApp(db, "before", { applied_at: "2026-09-30" });
    await insertApp(db, "on-from", { applied_at: "2026-10-01" });
    await insertApp(db, "middle", { applied_at: "2026-10-04" });
    await insertApp(db, "on-to", { applied_at: "2026-10-07" });
    await insertApp(db, "after", { applied_at: "2026-10-08" });
    await insertApp(db, "never", { applied_at: null });
    expect((await summary(built)).applied).toBe(3);
    expect((await summary(built, "?from=2026-09-30&to=2026-09-30")).applied).toBe(1);
    expect((await summary(built, "?from=2026-10-02&to=2026-10-03")).applied).toBe(0);
  });
});

describe("GET /summary: responses", () => {
  it("counts distinct applications with an in-range status-change to screen, interviewing, offer or rejected", async () => {
    built = await buildTestApp();
    const { db } = built;
    // Two qualifying events on one application count once.
    await insertApp(db, "twice", { status: "interviewing" });
    await insertStatusChange(db, "twice", "2026-10-02T15:00:00.000Z", "applied", "screen");
    await insertStatusChange(db, "twice", "2026-10-04T15:00:00.000Z", "screen", "interviewing");
    // One qualifying event each: rejected and offer.
    await insertApp(db, "rej", { status: "rejected" });
    await insertStatusChange(db, "rej", "2026-10-03T15:00:00.000Z", "applied", "rejected");
    await insertApp(db, "off", { status: "offer" });
    await insertStatusChange(db, "off", "2026-10-06T15:00:00.000Z", "interviewing", "offer");
    // A status-change to applied is not a response.
    await insertApp(db, "to-applied", { status: "applied" });
    await insertStatusChange(db, "to-applied", "2026-10-02T15:00:00.000Z", "preparing", "applied");
    // Other target statuses are not responses.
    await insertApp(db, "to-withdrawn", { status: "withdrawn" });
    await insertStatusChange(db, "to-withdrawn", "2026-10-02T15:00:00.000Z", "applied", "withdrawn");
    await insertApp(db, "to-accepted", { status: "accepted" });
    await insertStatusChange(db, "to-accepted", "2026-10-02T15:00:00.000Z", "offer", "accepted");
    // A qualifying event outside the window is not counted.
    await insertApp(db, "old", { status: "screen" });
    await insertStatusChange(db, "old", "2026-09-20T15:00:00.000Z", "applied", "screen");
    // A non status-change event is not a response.
    await insertApp(db, "plain", { status: "screen" });
    await insertEvent(db, "plain", { at: "2026-10-03T15:00:00.000Z", type: "email", to_status: "screen" });
    expect((await summary(built)).responses).toBe(3);
  });

  it("range edges are local Detroit dates", async () => {
    built = await buildTestApp();
    const { db } = built;
    // 2026-10-08T03:30Z is local 2026-10-07 (in). 2026-10-08T04:00Z is local 2026-10-08 (out).
    // 2026-10-01T04:00Z is local 2026-10-01 (in). 2026-10-01T03:59Z is local 2026-09-30 (out).
    for (const [id, at] of [
      ["in-late", "2026-10-08T03:30:00.000Z"],
      ["out-late", "2026-10-08T04:00:00.000Z"],
      ["in-early", "2026-10-01T04:00:00.000Z"],
      ["out-early", "2026-10-01T03:59:00.000Z"],
    ] as const) {
      await insertApp(db, id, { status: "screen" });
      await insertStatusChange(db, id, at, "applied", "screen");
    }
    expect((await summary(built)).responses).toBe(2);
  });
});

describe("GET /summary: interviews", () => {
  it("counts interview events in range by local Detroit date, and only that type", async () => {
    built = await buildTestApp();
    const { db } = built;
    await insertApp(db, "a1");
    await insertApp(db, "a2");
    const interview = (id: string, at: string) => insertEvent(db, id, { at, type: "interview" });
    await interview("a1", "2026-10-08T03:30:00.000Z"); // local 10-07: in
    await interview("a1", "2026-10-04T12:00:00.000Z"); // in; same application counts per event
    await interview("a2", "2026-10-01T04:00:00.000Z"); // local 10-01 00:00: in
    await interview("a2", "2026-10-01T03:59:00.000Z"); // local 09-30: out
    await interview("a2", "2026-10-08T04:00:00.000Z"); // local 10-08: out
    await insertEvent(db, "a2", { at: "2026-10-04T12:00:00.000Z", type: "call" });
    await insertEvent(db, "a2", { at: "2026-10-04T12:00:00.000Z", type: "take-home" });
    expect((await summary(built)).interviews).toBe(3);
    expect((await summary(built, "?from=2026-09-30&to=2026-09-30")).interviews).toBe(1);
    expect((await summary(built, "?from=2026-10-08&to=2026-10-08")).interviews).toBe(1);
  });
});

describe("GET /summary: by_status", () => {
  it("lists all 11 statuses with current, all-time counts and zeros", async () => {
    built = await buildTestApp();
    const { db } = built;
    await insertApp(db, "w1", { status: "watching" });
    await insertApp(db, "w2", { status: "watching" });
    await insertApp(db, "p1", { status: "preparing" });
    // Old and null-applied rows still count: it is all-time.
    await insertApp(db, "ap1", { status: "applied", applied_at: "2026-01-02" });
    await insertApp(db, "ap2", { status: "applied", applied_at: "2026-10-03" });
    await insertApp(db, "ap3", { status: "applied" });
    await insertApp(db, "r1", { status: "rejected", closed_at: "2026-10-02" });
    // History does not matter: current status only.
    await insertApp(db, "moved", { status: "interviewing" });
    await insertStatusChange(db, "moved", "2026-10-02T15:00:00.000Z", "applied", "screen");
    const s = await summary(built);
    expect(s.by_status).toEqual({ ...zeroStatuses, watching: 2, preparing: 1, applied: 3, rejected: 1, interviewing: 1 });
    expect(Object.keys(s.by_status).sort()).toEqual([...STATUSES].sort());
  });
});

describe("GET /summary: by_source", () => {
  it("is all-time, applied-only, unknown for null, sorted, with rule-based responded, interviewed and rounded rate", async () => {
    built = await buildTestApp();
    const { db } = built;
    // linkedin: 3 applied. L2 responded by status, L3 responded and interviewed by history.
    await insertApp(db, "l1", { source: "linkedin", status: "applied", applied_at: "2026-01-05" });
    await insertStatusChange(db, "l1", "2026-01-05T15:00:00.000Z", "preparing", "applied");
    await insertApp(db, "l2", { source: "linkedin", status: "rejected", applied_at: "2026-10-02" });
    await insertApp(db, "l3", { source: "linkedin", status: "withdrawn", applied_at: "2026-10-03" });
    await insertStatusChange(db, "l3", "2026-10-04T15:00:00.000Z", "applied", "interviewing");
    // referral: 3 applied; only the accepted one responded (and interviewed).
    await insertApp(db, "r1", { source: "referral", status: "accepted", applied_at: "2026-08-01" });
    await insertApp(db, "r2", { source: "referral", status: "applied", applied_at: "2026-08-02" });
    await insertApp(db, "r3", { source: "referral", status: "applied", applied_at: "2026-08-03" });
    // null source: U1 interviewed through an interview event only; U2 responded by status (screen).
    await insertApp(db, "u1", { source: null, status: "applied", applied_at: "2026-10-05" });
    await insertEvent(db, "u1", { at: "2026-10-06T15:00:00.000Z", type: "interview" });
    await insertApp(db, "u2", { source: null, status: "screen", applied_at: "2026-10-06" });
    // Not applied: excluded from by_source, whatever else it has.
    await insertApp(db, "n1", { source: "zzz-not-applied", status: "screen", applied_at: null });
    await insertApp(db, "n2", { source: "aaa-not-applied", status: "watching", applied_at: null });

    const s = await summary(built);
    expect(s.by_source).toEqual([
      { source: "linkedin", applied: 3, responded: 2, interviewed: 1, response_rate: 0.67 },
      { source: "referral", applied: 3, responded: 1, interviewed: 1, response_rate: 0.33 },
      { source: "unknown", applied: 2, responded: 1, interviewed: 1, response_rate: 0.5 },
    ]);
    // by_source ignores the window.
    const narrow = await summary(built, "?from=2026-10-07&to=2026-10-07");
    expect(narrow.by_source).toEqual(s.by_source);
  });

  it("status and history rules: each response or interview status counts, applied-only history does not", async () => {
    built = await buildTestApp();
    const { db } = built;
    // One application per row, all with source "x" so the counts add up in one bucket.
    const cases: Array<[string, string, boolean, boolean]> = [
      // [status, id, responded, interviewed] by current status alone
      ["applied", "c-applied", false, false],
      ["screen", "c-screen", true, false],
      ["interviewing", "c-interviewing", true, true],
      ["offer", "c-offer", true, true],
      ["accepted", "c-accepted", true, true],
      ["rejected", "c-rejected", true, false],
      ["withdrawn", "c-withdrawn", false, false],
      ["closed", "c-closed", false, false],
    ];
    for (const [status, id] of cases) await insertApp(db, id, { source: "x", status, applied_at: "2026-10-02" });
    // History only: current status is withdrawn.
    await insertApp(db, "h-screen", { source: "x", status: "withdrawn", applied_at: "2026-10-02" });
    await insertStatusChange(db, "h-screen", "2026-10-03T15:00:00.000Z", "applied", "screen");
    await insertApp(db, "h-offer", { source: "x", status: "closed", applied_at: "2026-10-02" });
    await insertStatusChange(db, "h-offer", "2026-10-03T15:00:00.000Z", "interviewing", "offer");
    const expectedResponded = cases.filter((c) => c[2]).length + 2;
    const expectedInterviewed = cases.filter((c) => c[3]).length + 1;
    expect(expectedResponded).toBe(7);
    expect(expectedInterviewed).toBe(4);
    const s = await summary(built);
    expect(s.by_source).toEqual([
      { source: "x", applied: 10, responded: 7, interviewed: 4, response_rate: 0.7 },
    ]);
  });
});

// Counts interview events in a one-day window [day, day] for the given instants.
async function interviewsOn(b: Built, day: string, instants: string[]): Promise<number> {
  await insertApp(b.db, "tz-app");
  for (const at of instants) await insertEvent(b.db, "tz-app", { at, type: "interview" });
  return (await summary(b, `?from=${day}&to=${day}`)).interviews;
}

describe("GET /summary: time zones and DST (revision 1)", () => {
  it("east of UTC (Pacific/Kiritimati, UTC+14): local day 2026-10-05 is [10-04T10:00Z, 10-05T10:00Z)", async () => {
    built = await buildTestApp({ config: { timezone: "Pacific/Kiritimati" } });
    const { db } = built;
    await insertApp(db, "k");
    const at = (iso: string) => insertEvent(db, "k", { at: iso, type: "interview" });
    await at("2026-10-04T10:00:00.000Z"); // local 10-05 00:00: in
    await at("2026-10-04T09:59:59.999Z"); // local 10-04 23:59: out
    await at("2026-10-05T09:59:59.999Z"); // local 10-05 23:59: in
    await at("2026-10-05T10:00:00.000Z"); // local 10-06 00:00: out
    expect((await summary(built, "?from=2026-10-05&to=2026-10-05")).interviews).toBe(2);
    // The previous local day gets the two events that fell outside.
    expect((await summary(built, "?from=2026-10-04&to=2026-10-04")).interviews).toBe(1);
    expect((await summary(built, "?from=2026-10-06&to=2026-10-06")).interviews).toBe(1);
  });

  it("east of UTC: the lower edge alone (10-04T10:00Z in, 09:59:59.999Z out)", async () => {
    built = await buildTestApp({ config: { timezone: "Pacific/Kiritimati" } });
    expect(await interviewsOn(built, "2026-10-05", ["2026-10-04T10:00:00.000Z"])).toBe(1);
  });

  it("east of UTC: 09:59:59.999Z the day before is not in the window", async () => {
    built = await buildTestApp({ config: { timezone: "Pacific/Kiritimati" } });
    expect(await interviewsOn(built, "2026-10-05", ["2026-10-04T09:59:59.999Z"])).toBe(0);
  });

  it("fall back (America/Detroit, 2026-11-01): the local day is [11-01T04:00Z, 11-02T05:00Z)", async () => {
    built = await buildTestApp();
    const { db } = built;
    await insertApp(db, "fb");
    for (const iso of [
      "2026-11-01T03:59:59.000Z", // local 10-31 23:59:59 EDT: out
      "2026-11-01T04:00:00.000Z", // local 11-01 00:00 EDT: in
      "2026-11-02T04:59:00.000Z", // local 11-01 23:59 EST: in
      "2026-11-02T05:00:00.000Z", // local 11-02 00:00 EST: out
    ])
      await insertEvent(db, "fb", { at: iso, type: "interview" });
    expect((await summary(built, "?from=2026-11-01&to=2026-11-01")).interviews).toBe(2);
    expect((await summary(built, "?from=2026-11-02&to=2026-11-02")).interviews).toBe(1);
  });

  it("spring forward (America/Detroit, 2026-03-08): the local day is [03-08T05:00Z, 03-09T04:00Z)", async () => {
    built = await buildTestApp();
    const { db } = built;
    await insertApp(db, "sf");
    for (const iso of [
      "2026-03-08T04:59:00.000Z", // local 03-07 23:59 EST: out
      "2026-03-08T05:00:00.000Z", // local 03-08 00:00 EST: in
      "2026-03-09T03:59:00.000Z", // local 03-08 23:59 EDT: in
      "2026-03-09T04:00:00.000Z", // local 03-09 00:00 EDT: out
    ])
      await insertEvent(db, "sf", { at: iso, type: "interview" });
    expect((await summary(built, "?from=2026-03-08&to=2026-03-08")).interviews).toBe(2);
    expect((await summary(built, "?from=2026-03-09&to=2026-03-09")).interviews).toBe(1);
  });

  it("the default window follows DST: now 2026-11-02T04:30Z is local 2026-11-01", async () => {
    built = await buildTestApp({ now: new Date("2026-11-02T04:30:00.000Z") });
    const s = await summary(built);
    expect([s.from, s.to]).toEqual(["2026-10-26", "2026-11-01"]);
  });
});

describe("GET /due: DST default date (revision 1)", () => {
  it("now 2026-11-02T04:30Z gives date 2026-11-01", async () => {
    built = await buildTestApp({ now: new Date("2026-11-02T04:30:00.000Z") });
    await insertApp(built.db, "d1", { next_action_due: "2026-11-01" });
    await insertApp(built.db, "d2", { next_action_due: "2026-11-02" });
    const res = await built.app.request(`${VIEWS_BASE}/due`, { headers: agentHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { date: string; items: Array<{ id: string }> };
    expect(body.date).toBe("2026-11-01");
    expect(body.items.map((i) => i.id)).toEqual(["d1"]);
  });
});

describe("GET /summary: by_source edge buckets (revision 1)", () => {
  it("a bucket with nothing responded has response_rate 0; a literal 'unknown' merges with null", async () => {
    built = await buildTestApp();
    const { db } = built;
    await insertApp(db, "lit", { source: "unknown", status: "applied", applied_at: "2026-10-02" });
    await insertApp(db, "nul", { source: null, status: "applied", applied_at: "2026-10-03" });
    const s = await summary(built);
    expect(s.by_source).toEqual([
      { source: "unknown", applied: 2, responded: 0, interviewed: 0, response_rate: 0 },
    ]);
  });
});

describe("GET /summary: extreme valid dates never 500 (revision 1)", () => {
  it.each([
    ["to=9999-12-30", "?to=9999-12-30", "9999-12-24", "9999-12-30"],
    ["from=0001-01-01&to=9999-12-31", "?from=0001-01-01&to=9999-12-31", "0001-01-01", "9999-12-31"],
    ["to=0050-01-10", "?to=0050-01-10", "0050-01-04", "0050-01-10"],
  ])("%s gives 200 with the right window", async (_n, qs, from, to) => {
    built = await buildTestApp();
    const res = await get(built, qs);
    expect(res.status).toBe(200);
    const s = (await res.json()) as Summary;
    expect([s.from, s.to]).toEqual([from, to]);
    expect(s.applied).toBe(0);
  });
});
