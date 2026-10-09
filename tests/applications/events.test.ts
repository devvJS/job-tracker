import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { events } from "../../db/schema.ts";
import { TEST_NOW } from "../helpers/config.ts";
import { ACME_ID, UUID_RE, base, detailPaths, expectEnvelope, minutes, setup, type Harness, type Json } from "./helpers/harness.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const url = `/applications/${ACME_ID}/events`;
const LATER = minutes(TEST_NOW, 30);
const LATER_ISO = LATER.toISOString();
const post = (body: unknown, as: "session" | "agent" = "session") => h!.call("POST", url, { as, body });
const evTypes = (rec: Json) => rec.events.map((e: { type: string }) => e.type).sort();

async function seeded(body: Record<string, unknown> = {}) {
  h = await setup();
  const rec = await h.create(base(body));
  h.clock.set(LATER);
  return rec;
}

describe("POST /applications/:id/events", () => {
  it("201 {event, record}: the event defaults at to now and by to the actor", async () => {
    await seeded();
    const r = await post({ type: "note", note: "Spoke to recruiter" });
    expect(r.status).toBe(201);
    expect(Object.keys(r.json).sort()).toEqual(["event", "record"]);
    expect(r.json.event).toEqual({
      id: expect.stringMatching(UUID_RE),
      application_id: ACME_ID,
      at: LATER_ISO,
      type: "note",
      note: "Spoke to recruiter",
      by: "dakota",
      from_status: null,
      to_status: null,
    });
    expect(r.json.record.id).toBe(ACME_ID);
    expect(r.json.record.events).toHaveLength(2);
    expect(r.json.record.events.map((e: Json) => e.id)).toContain(r.json.event.id);
    expect(r.json.record.status).toBe("watching");
    expect(await h!.get(ACME_ID)).toEqual(r.json.record);
  });

  it("the agent key logs as claude-project", async () => {
    await seeded();
    const r = await post({ type: "email" }, "agent");
    expect(r.status).toBe(201);
    expect(r.json.event).toMatchObject({ type: "email", by: "claude-project", note: null });
  });

  it("an explicit at is stored normalized to UTC milliseconds", async () => {
    await seeded();
    const a = await post({ type: "call", at: "2026-10-01T09:30:00Z" });
    expect(a.json.event.at).toBe("2026-10-01T09:30:00.000Z");
    const b = await post({ type: "call", at: "2026-10-01T09:30:00-04:00" });
    expect(b.json.event.at).toBe("2026-10-01T13:30:00.000Z");
  });

  it.each(["scored", "materials-drafted", "email", "call", "interview", "take-home", "offer", "note"])(
    "type %s is accepted and does not change status",
    async (type) => {
      await seeded();
      const r = await post({ type });
      expect(r.status).toBe(201);
      expect(r.json.event.type).toBe(type);
      expect(r.json.record.status).toBe("watching");
      expect(evTypes(r.json.record)).toEqual([type, "discovered"].sort());
    },
  );

  describe("validation", () => {
    it.each([
      ["type missing", {}, "type"],
      ["type not in the enum", { type: "gossip" }, "type"],
      ["type status-change is server-only", { type: "status-change" }, "type"],
      ["type of the wrong kind", { type: 5 }, "type"],
      ["at not a datetime", { type: "note", at: "yesterday" }, "at"],
      ["at is a bare date", { type: "note", at: "2026-10-01" }, "at"],
      ["status not in the enum", { type: "note", status: "flying" }, "status"],
      ["next_action_due not a date", { type: "note", next_action_due: "soon" }, "next_action_due"],
      ["note of the wrong kind", { type: "note", note: 3 }, "note"],
    ])("%s -> 400 naming %s and nothing is written", async (_n, body, path) => {
      await seeded();
      const r = await post(body);
      expectEnvelope(r, 400, "bad_request");
      expect(detailPaths(r.json)).toContain(path);
      expect(await h!.db.select().from(events)).toHaveLength(1);
    });

    it("a non-JSON body is 400", async () => {
      await seeded();
      expectEnvelope(await h!.call("POST", url, { raw: "nope" }), 400, "bad_request");
    });

    it("an unknown id is 404 and writes nothing", async () => {
      await seeded();
      const r = await h!.call("POST", "/applications/nope--nope--2026-10-07/events", { body: { type: "note" } });
      expectEnvelope(r, 404, "not_found");
      expect(await h!.db.select().from(events)).toHaveLength(1);
    });
  });

  describe("with status", () => {
    it("a different status changes it, adds the client event and a status-change event, and sets applied_at", async () => {
      await seeded();
      const r = await post({ type: "applied", note: "Submitted", status: "applied" });
      expect(r.status).toBe(201);
      expect(r.json.event).toMatchObject({ type: "applied", note: "Submitted", from_status: null, to_status: null });
      const rec = r.json.record;
      expect(rec.status).toBe("applied");
      expect(rec.applied_at).toBe("2026-10-07");
      expect(rec.closed_at).toBeNull();
      expect(evTypes(rec)).toEqual(["applied", "discovered", "status-change"]);
      const sc = rec.events.find((e: Json) => e.type === "status-change");
      expect(sc).toMatchObject({
        application_id: ACME_ID,
        note: "watching → applied",
        by: "dakota",
        from_status: "watching",
        to_status: "applied",
      });
      expect(rec.updated_at).toBe(LATER_ISO);
      expect(rec.updated_by).toBe("dakota");
      expect(await h!.db.select().from(events).where(eq(events.application_id, ACME_ID))).toHaveLength(3);
    });

    it("the status-change event is attributed to the agent when the agent posts", async () => {
      await seeded();
      const r = await post({ type: "note", status: "screen" }, "agent");
      const sc = r.json.record.events.find((e: Json) => e.type === "status-change");
      expect(sc).toMatchObject({ by: "claude-project", from_status: "watching", to_status: "screen", note: "watching → screen" });
      expect(r.json.record.updated_by).toBe("claude-project");
    });

    it("the same status adds no status-change event", async () => {
      await seeded();
      const r = await post({ type: "note", status: "watching" });
      expect(r.status).toBe(201);
      expect(evTypes(r.json.record)).toEqual(["discovered", "note"]);
      expect(r.json.record.status).toBe("watching");
    });

    it.each(["rejected", "withdrawn", "closed"])("moving to %s sets closed_at to today", async (status) => {
      await seeded();
      const r = await post({ type: "note", status });
      expect(r.json.record.status).toBe(status);
      expect(r.json.record.closed_at).toBe("2026-10-07");
    });

    it("existing applied_at and closed_at are not overwritten", async () => {
      await seeded({ status: "preparing", applied_at: "2026-09-01", closed_at: "2026-09-02" });
      const a = await post({ type: "note", status: "applied" });
      expect(a.json.record.applied_at).toBe("2026-09-01");
      const b = await post({ type: "note", status: "rejected" });
      expect(b.json.record.closed_at).toBe("2026-09-02");
    });

    it("an explicit at on the event does not change the date used for A.7", async () => {
      await seeded();
      const r = await post({ type: "applied", status: "applied", at: "2026-09-20T12:00:00Z" });
      expect(r.json.event.at).toBe("2026-09-20T12:00:00.000Z");
      expect(r.json.record.applied_at).toBe("2026-10-07");
    });
  });

  describe("next action", () => {
    it("next_action and next_action_due are updated on the record, and null clears them", async () => {
      await seeded({ next_action: "old", next_action_due: "2026-10-01" });
      const r = await post({ type: "email", next_action: "Send follow-up", next_action_due: "2026-10-14" });
      expect(r.status).toBe(201);
      expect(r.json.record.next_action).toBe("Send follow-up");
      expect(r.json.record.next_action_due).toBe("2026-10-14");
      expect(r.json.record.updated_at).toBe(LATER_ISO);
      expect((await h!.get(ACME_ID)).next_action).toBe("Send follow-up");
      const cleared = await post({ type: "note", next_action: null, next_action_due: null });
      expect(cleared.json.record.next_action).toBeNull();
      expect(cleared.json.record.next_action_due).toBeNull();
    });

    it("omitted next_action fields are left alone", async () => {
      await seeded({ next_action: "keep", next_action_due: "2026-10-01" });
      const r = await post({ type: "note", note: "x" });
      expect(r.json.record.next_action).toBe("keep");
      expect(r.json.record.next_action_due).toBe("2026-10-01");
    });
  });

  describe("never conflicts", () => {
    it("is not 412 after another write, with no If-Match, or with a stale one", async () => {
      const rec = await seeded();
      await h!.patch(ACME_ID, { notes: "somebody else wrote" }, rec.updated_at);
      const plain = await post({ type: "note", note: "one" });
      expect(plain.status).toBe(201);
      const stale = await h!.call("POST", url, {
        body: { type: "note", note: "two" },
        headers: { "If-Match": rec.updated_at },
      });
      expect(stale.status).toBe(201);
      expect(stale.json.record.notes).toBe("somebody else wrote");
      expect(evTypes(stale.json.record)).toEqual(["discovered", "note", "note"]);
    });

    it("an event does not clobber a concurrent field edit", async () => {
      const rec = await seeded();
      const edited = await h!.patch(ACME_ID, { location: "Troy, MI" }, rec.updated_at);
      const r = await post({ type: "note", next_action: "x" });
      expect(r.json.record.location).toBe("Troy, MI");
      expect(edited.location).toBe("Troy, MI");
    });
  });
});
