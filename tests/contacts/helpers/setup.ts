// Slice-local helpers for the contacts API tests.
import { applicationContacts, applications, contacts } from "../../../db/schema.ts";
import { buildTestApp } from "../../helpers/app.ts";
import { BASE, agentHeaders, signIn } from "../../helpers/auth.ts";
import { createFakeGithub } from "../../helpers/github.ts";

export const API = `${BASE}/api`;
export const CONTACTS = `${API}/contacts`;
export const JSON_HEADERS = { "Content-Type": "application/json" };

export type Built = Awaited<ReturnType<typeof buildTestApp>>;

export type Harness = Built & {
  /** Headers for a signed-in session (actor dakota). */
  session: Record<string, string>;
  /** Headers for the agent key (actor claude-project). */
  agent: Record<string, string>;
};

/** A real app on a fresh DB, with a real session obtained through the OAuth flow and the agent key. */
export async function setup(opts: { now?: Date | (() => Date) } = {}): Promise<Harness> {
  const gh = createFakeGithub();
  const built = await buildTestApp({ fetch: gh.fetch, now: opts.now });
  const s = await signIn(built.app);
  return { ...built, session: s.headers, agent: agentHeaders() };
}

export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function send(
  h: Harness,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; raw?: string } = {},
): Promise<{ res: Response; json: Json }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.body !== undefined) {
    headers["Content-Type"] ??= "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await h.app.request(`${API}${path}`, { method, headers, body });
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { _raw: text };
  }
  return { res, json };
}

export const post = (h: Harness, body: unknown, headers: Record<string, string> = h.session) =>
  send(h, "POST", "/contacts", { body, headers });
export const get = (h: Harness, path: string, headers: Record<string, string> = h.session) =>
  send(h, "GET", path, { headers });
export const patch = (
  h: Harness,
  id: string,
  body: unknown,
  ifMatch: string | null,
  headers: Record<string, string> = h.session,
) => send(h, "PATCH", `/contacts/${id}`, { body, headers: { ...headers, ...(ifMatch === null ? {} : { "If-Match": ifMatch }) } });

/** Inserts an application row directly (S1's API is built in parallel). */
export async function insertApplication(h: Harness, id: string): Promise<void> {
  const at = new Date("2026-10-01T12:00:00.000Z");
  await h.db.insert(applications).values({
    id,
    company: "Direct Co",
    role_title: "Engineer",
    work_arrangement: "remote",
    status: "watching",
    discovered_at: "2026-10-01",
    created_at: at,
    updated_at: at,
    updated_by: "tracker-app",
  });
}

export async function linkContact(h: Harness, applicationId: string, contactId: string): Promise<void> {
  await h.db.insert(applicationContacts).values({ application_id: applicationId, contact_id: contactId });
}

/** The key order of a record, for pinning the canonical field order. */
export const keysOf = (o: Json) => Object.keys(o);

/** Inserts a contact row directly, so read tests do not depend on POST. */
export async function insertContact(
  h: Harness,
  row: { id: string; name: string; company?: string | null; extra?: Record<string, unknown> },
): Promise<void> {
  const at = new Date("2026-10-02T08:00:00.000Z");
  await h.db.insert(contacts).values({
    id: row.id,
    name: row.name,
    company: row.company ?? null,
    extra: row.extra ?? {},
    created_at: at,
    updated_at: at,
    updated_by: "dakota",
  });
}
