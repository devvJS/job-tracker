// Slice-local helpers for the applications API tests. Everything goes through the real app.
import { expect } from "vitest";
import { sql } from "drizzle-orm";
import { applicationContacts, applications, contacts, events } from "../../../db/schema.ts";
import { buildTestApp } from "../../helpers/app.ts";
import { BASE, agentHeaders, createClock, signIn } from "../../helpers/auth.ts";
import { TEST_NOW } from "../../helpers/config.ts";
import { createFakeGithub } from "../../helpers/github.ts";

// Responses are inspected loosely on purpose; every assertion pins concrete values.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export type As = "session" | "agent" | "none";

export type CallOpts = {
  as?: As;
  /** JSON-encoded unless `raw` is set. */
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
  /** Omit Content-Type entirely. */
  noContentType?: boolean;
};

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function setup(start: Date = TEST_NOW) {
  const gh = createFakeGithub();
  const clock = createClock(start);
  const built = await buildTestApp({ fetch: gh.fetch, now: clock.now });
  const session = await signIn(built.app);

  async function call(method: string, path: string, o: CallOpts = {}) {
    const as = o.as ?? "session";
    const headers: Record<string, string> = {};
    if (as === "session") Object.assign(headers, session.headers);
    if (as === "agent") Object.assign(headers, agentHeaders());
    const hasBody = o.body !== undefined || o.raw !== undefined;
    if (hasBody && !o.noContentType) headers["Content-Type"] = "application/json";
    Object.assign(headers, o.headers);
    const res = await built.app.request(`${BASE}/api${path}`, {
      method,
      headers,
      body: o.raw !== undefined ? o.raw : o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    const text = await res.text();
    let json: Json = null;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  /** POST /applications and require 201. */
  async function create(body: Record<string, unknown>, as: As = "session"): Promise<Json> {
    const r = await call("POST", "/applications", { as, body });
    expect(r.status, `create ${JSON.stringify(body)} -> ${r.text}`).toBe(201);
    return r.json;
  }

  /** PATCH with the record's current updated_at (or the given one) and require 200. */
  async function patch(id: string, body: Record<string, unknown>, ifMatch: string, as: As = "session"): Promise<Json> {
    const r = await call("PATCH", `/applications/${id}`, { as, body, headers: { "If-Match": ifMatch } });
    expect(r.status, `patch ${id} ${JSON.stringify(body)} -> ${r.text}`).toBe(200);
    return r.json;
  }

  async function get(id: string, as: As = "session"): Promise<Json> {
    const r = await call("GET", `/applications/${id}`, { as });
    expect(r.status, `get ${id} -> ${r.text}`).toBe(200);
    return r.json;
  }

  async function addContact(id: string, name = id) {
    const at = clock.now();
    await built.db.insert(contacts).values({ id, name, created_at: at, updated_at: at, updated_by: "tracker-app" });
  }

  async function counts() {
    const n = async (t: typeof applications | typeof events | typeof applicationContacts | typeof contacts) =>
      Number((await built.db.select({ n: sql<number>`count(*)` }).from(t))[0].n);
    return {
      applications: await n(applications),
      events: await n(events),
      links: await n(applicationContacts),
      contacts: await n(contacts),
    };
  }

  return { ...built, gh, clock, session, call, create, patch, get, addContact, counts };
}

export type Harness = Awaited<ReturnType<typeof setup>>;

/** The minimum valid create body. Slug id (discovered 2026-10-07): acme-corp--senior-engineer--2026-10-07. */
export const base = (o: Record<string, unknown> = {}) => ({
  company: "Acme Corp",
  role_title: "Senior Engineer",
  work_arrangement: "remote",
  status: "watching",
  ...o,
});

export const ACME_ID = "acme-corp--senior-engineer--2026-10-07";

/** Every nullable known field of a record, null. Spread over it to build an expected record. */
export const NULL_FIELDS = {
  posting_url: null,
  job_id: null,
  posting_status: null,
  posting_verified_at: null,
  jd_snapshot_path: null,
  jd_snapshot: null,
  location: null,
  detroit_metro: null,
  onsite_requirement: null,
  remote_scope: null,
  move_timing_ok: null,
  comp_min: null,
  comp_max: null,
  comp_source: null,
  meets_floor: null,
  equity_bonus_notes: null,
  track: null,
  company_archetype: null,
  company_stage: null,
  industry: null,
  mission_interest: null,
  fit: null,
  source: null,
  source_detail: null,
  connection: null,
  referral: null,
  priority: null,
  next_action: null,
  next_action_due: null,
  follow_up_date: null,
  applied_at: null,
  closed_at: null,
  closed_reason: null,
  materials: null,
  notes: null,
  project_thread_url: null,
};

export const minutes = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);

/** Error details paths of a 400 body. */
export const detailPaths = (json: Json): string[] =>
  (json.error.details as { path: string }[]).map((d) => d.path).sort();

export function expectEnvelope(r: { status: number; json: Json }, status: number, code: string) {
  expect(r.status).toBe(status);
  expect(r.json.error.code).toBe(code);
  expect(typeof r.json.error.message).toBe("string");
}
