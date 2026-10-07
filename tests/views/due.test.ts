import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers/app.ts";
import { agentHeaders, signIn } from "../helpers/auth.ts";
import { createFakeGithub } from "../helpers/github.ts";
import { toApplicationRecord } from "../../server/records.ts";
import { VIEWS_BASE, insertApp, insertEvent } from "./helpers/rows.ts";

type Built = Awaited<ReturnType<typeof buildTestApp>>;
let built: Built | undefined;
afterEach(async () => {
  await built?.close();
  built = undefined;
});

const get = (b: Built, qs = "", headers: Record<string, string> = agentHeaders()) =>
  b.app.request(`${VIEWS_BASE}/due${qs}`, { headers });

type DueBody = { date: string; items: Array<Record<string, unknown>> };
const ids = (body: DueBody) => body.items.map((i) => i.id);

describe("GET /due", () => {
  it("defaults the date to today in Detroit and returns exactly {date, items}", async () => {
    built = await buildTestApp();
    await insertApp(built.db, "a-due", { next_action_due: "2026-10-07" });
    const res = await get(built);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DueBody;
    expect(Object.keys(body).sort()).toEqual(["date", "items"]);
    expect(body.date).toBe("2026-10-07");
    expect(ids(body)).toEqual(["a-due"]);
  });

  it("uses the Detroit date, not the UTC date, for today", async () => {
    // 2026-10-08T03:30Z is 23:30 on 2026-10-07 in Detroit.
    built = await buildTestApp({ now: new Date("2026-10-08T03:30:00.000Z") });
    await insertApp(built.db, "a-today", { next_action_due: "2026-10-07" });
    await insertApp(built.db, "b-tomorrow", { next_action_due: "2026-10-08" });
    const body = (await (await get(built)).json()) as DueBody;
    expect(body.date).toBe("2026-10-07");
    expect(ids(body)).toEqual(["a-today"]);
  });

  it("an explicit ?date overrides today", async () => {
    built = await buildTestApp();
    await insertApp(built.db, "a-early", { next_action_due: "2026-10-09" });
    await insertApp(built.db, "b-late", { follow_up_date: "2026-10-12" });
    const none = (await (await get(built)).json()) as DueBody;
    expect(none).toEqual({ date: "2026-10-07", items: [] });
    const body = (await (await get(built, "?date=2026-10-10")).json()) as DueBody;
    expect(body.date).toBe("2026-10-10");
    expect(body.items.map((i) => [i.id, i.due_on, i.overdue])).toEqual([["a-early", "2026-10-09", true]]);
  });

  it("includes on-or-before the date by either field and excludes later or null", async () => {
    built = await buildTestApp();
    const { db } = built;
    await insertApp(db, "next-only", { next_action_due: "2026-10-05" });
    await insertApp(db, "follow-only", { follow_up_date: "2026-10-06" });
    await insertApp(db, "next-equal", { next_action_due: "2026-10-07" });
    await insertApp(db, "follow-equal", { follow_up_date: "2026-10-07" });
    await insertApp(db, "one-later-one-due", { next_action_due: "2026-10-20", follow_up_date: "2026-10-01" });
    await insertApp(db, "both-later", { next_action_due: "2026-10-08", follow_up_date: "2026-10-09" });
    await insertApp(db, "both-null");
    const body = (await (await get(built)).json()) as DueBody;
    expect(ids(body)).toEqual(["one-later-one-due", "next-only", "follow-only", "follow-equal", "next-equal"]);
  });

  it("due_on is the earliest non-null of the two dates", async () => {
    built = await buildTestApp();
    const { db } = built;
    await insertApp(db, "a-next-first", { next_action_due: "2026-10-02", follow_up_date: "2026-10-04" });
    await insertApp(db, "b-follow-first", { next_action_due: "2026-10-05", follow_up_date: "2026-10-03" });
    await insertApp(db, "c-next-only", { next_action_due: "2026-10-06" });
    await insertApp(db, "d-follow-only", { follow_up_date: "2026-10-01" });
    await insertApp(db, "e-later-other", { next_action_due: "2026-10-07", follow_up_date: "2026-12-01" });
    const body = (await (await get(built)).json()) as DueBody;
    expect(body.items.map((i) => [i.id, i.due_on])).toEqual([
      ["d-follow-only", "2026-10-01"],
      ["a-next-first", "2026-10-02"],
      ["b-follow-first", "2026-10-03"],
      ["c-next-only", "2026-10-06"],
      ["e-later-other", "2026-10-07"],
    ]);
  });

  it("overdue is true when due_on is before the date and false when it equals the date", async () => {
    built = await buildTestApp();
    await insertApp(built.db, "a-yesterday", { next_action_due: "2026-10-06" });
    await insertApp(built.db, "b-today", { follow_up_date: "2026-10-07" });
    await insertApp(built.db, "c-mixed", { next_action_due: "2026-10-07", follow_up_date: "2026-10-07" });
    const body = (await (await get(built)).json()) as DueBody;
    expect(body.items.map((i) => [i.id, i.due_on, i.overdue])).toEqual([
      ["a-yesterday", "2026-10-06", true],
      ["b-today", "2026-10-07", false],
      ["c-mixed", "2026-10-07", false],
    ]);
  });

  it("excludes rejected, withdrawn, closed and accepted, and keeps every other status", async () => {
    built = await buildTestApp();
    const { db } = built;
    const statuses = [
      "watching", "shortlisted", "preparing", "applied", "screen", "interviewing", "offer",
      "accepted", "rejected", "withdrawn", "closed",
    ];
    for (const s of statuses) await insertApp(db, `s-${s}`, { status: s, next_action_due: "2026-10-01" });
    const body = (await (await get(built)).json()) as DueBody;
    expect(ids(body)).toEqual([
      "s-applied", "s-interviewing", "s-offer", "s-preparing", "s-screen", "s-shortlisted", "s-watching",
    ]);
  });

  it("sorts by due_on ascending, then id", async () => {
    built = await buildTestApp();
    const { db } = built;
    await insertApp(db, "z-first", { next_action_due: "2026-10-01" });
    await insertApp(db, "b-tie", { next_action_due: "2026-10-03" });
    await insertApp(db, "a-tie", { follow_up_date: "2026-10-03" });
    await insertApp(db, "m-mid", { next_action_due: "2026-10-02" });
    const body = (await (await get(built)).json()) as DueBody;
    expect(ids(body)).toEqual(["z-first", "m-mid", "a-tie", "b-tie"]);
  });

  it("items are list records plus due_on and overdue: no events or contacts, extras flattened", async () => {
    built = await buildTestApp();
    const row = await insertApp(built.db, "rec-1", {
      company: "Acme",
      role_title: "Engineer",
      next_action: "Email recruiter",
      next_action_due: "2026-10-06",
      extra: { custom_flag: "yes" },
    });
    await insertEvent(built.db, "rec-1", { at: "2026-09-02T12:00:00.000Z", type: "discovered" });
    const body = (await (await get(built)).json()) as DueBody;
    expect(body.items).toHaveLength(1);
    const item = { ...body.items[0] };
    expect(item).not.toHaveProperty("events");
    expect(item).not.toHaveProperty("contacts");
    expect(item.custom_flag).toBe("yes");
    expect(item).not.toHaveProperty("extra");
    // contact_ids is not pinned by the spec for the list record, so it is ignored here.
    delete item.contact_ids;
    expect(item).toEqual({ ...toApplicationRecord(row), due_on: "2026-10-06", overdue: true });
  });

  it.each([
    ["not a date", "?date=tomorrow"],
    ["wrong format", "?date=10/07/2026"],
    ["a month of 13", "?date=2026-13-01"],
    ["a day that does not exist", "?date=2026-02-30"],
    ["empty", "?date="],
  ])("an invalid date (%s) gives 400 bad_request", async (_n, qs) => {
    built = await buildTestApp();
    const res = await get(built, qs);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("bad_request");
  });

  it("requires auth: 401 without credentials, 200 with the agent key or a session", async () => {
    const gh = createFakeGithub();
    built = await buildTestApp({ fetch: gh.fetch });
    await insertApp(built.db, "a-due", { next_action_due: "2026-10-07" });
    expect((await get(built, "", agentHeaders())).status).toBe(200);
    const session = await signIn(built.app);
    const viaSession = await get(built, "", session.headers);
    expect(viaSession.status).toBe(200);
    expect(((await viaSession.json()) as DueBody).items.map((i) => i.id)).toEqual(["a-due"]);
    const anon = await get(built, "", {});
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
  });
});
