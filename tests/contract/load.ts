// Slice-local helpers for the contract tests.
import { parse } from "./yaml.ts";
import { type buildTestApp } from "../helpers/app.ts";
import { agentHeaders } from "../helpers/auth.ts";

export const API = "/job-tracker/api";

export type Built = Awaited<ReturnType<typeof buildTestApp>>;
export type Doc = {
  openapi: string;
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: Record<string, Record<string, unknown>>; securitySchemes: Record<string, Record<string, unknown>> };
};

export const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** Fetches /openapi.yaml with the agent key and parses it. Fails with the response text when it is not a 200. */
export async function fetchDoc(built: Built): Promise<Doc> {
  const res = await built.app.request(`${API}/openapi.yaml`, { headers: agentHeaders() });
  if (res.status !== 200) throw new Error(`GET openapi.yaml answered ${res.status}: ${await res.text()}`);
  return (await parse(await res.text())) as Doc;
}

/** Documented operations as "METHOD /path" with the API prefix removed, as written in the doc's paths. */
export function documentedOperations(doc: Doc): string[] {
  const out: string[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.includes(method)) out.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return out.sort();
}

/** Operations the real app serves under /job-tracker/api: "METHOD /path", :param written as {param}. */
export function servedOperations(built: Built): string[] {
  const out = new Set<string>();
  for (const r of built.app.routes) {
    if (r.method === "ALL") continue;
    if (!r.path.startsWith(`${API}/`)) continue;
    out.add(`${r.method} ${r.path.slice(API.length).replace(/:([A-Za-z_]+)/g, "{$1}")}`);
  }
  return [...out].sort();
}

export type Node = Record<string, unknown>;

/** Follows a local $ref ("#/a/b/c") to the node it names; returns non-refs unchanged. */
export function deref(doc: Doc, node: unknown): Node | undefined {
  let cur = node as Node | undefined;
  for (let i = 0; i < 20 && cur && typeof cur.$ref === "string"; i++) {
    let target: unknown = doc;
    for (const part of cur.$ref.replace(/^#\//, "").split("/")) target = (target as Node | undefined)?.[part];
    cur = target as Node | undefined;
  }
  return cur;
}

/** The operation object for "METHOD /path" in the doc. */
export function operation(doc: Doc, method: string, path: string): Node {
  const op = doc.paths[path]?.[method.toLowerCase()];
  if (!op) throw new Error(`${method} ${path} is not documented`);
  return op as Node;
}

/** Operation parameters (own plus path-level), refs resolved. */
export function parametersOf(doc: Doc, method: string, path: string): Node[] {
  const own = (operation(doc, method, path).parameters ?? []) as unknown[];
  const shared = ((doc.paths[path] as unknown as Node).parameters ?? []) as unknown[];
  return [...shared, ...own].map((p) => deref(doc, p) ?? {});
}

/** Every property of a schema, merging allOf members (refs resolved). */
export function schemaProperties(doc: Doc, schema: unknown): Node {
  const s = deref(doc, schema) ?? {};
  const out: Node = { ...((s.properties as Node | undefined) ?? {}) };
  for (const part of (s.allOf as unknown[] | undefined) ?? []) Object.assign(out, schemaProperties(doc, part));
  return out;
}

/** True when the schema, or an allOf member, lists `name` under required. */
export function requires(doc: Doc, schema: unknown, name: string): boolean {
  const s = deref(doc, schema) ?? {};
  if (((s.required as string[] | undefined) ?? []).includes(name)) return true;
  return ((s.allOf as unknown[] | undefined) ?? []).some((part) => requires(doc, part, name));
}

/** The JSON schema of a documented response (response refs resolved). */
export function responseSchema(doc: Doc, method: string, path: string, status: string): unknown {
  const responses = operation(doc, method, path).responses as Node;
  const res = deref(doc, responses[status]);
  if (!res) throw new Error(`${method} ${path} documents no ${status}`);
  return ((res.content as Node | undefined)?.["application/json"] as Node | undefined)?.schema;
}
