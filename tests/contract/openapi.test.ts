import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers/app.ts";
import { agentHeaders, signIn } from "../helpers/auth.ts";
import { createFakeGithub } from "../helpers/github.ts";
import { APPLICATION_WRITABLE_FIELDS } from "../../server/records.ts";
import { API, type Built, type Doc, documentedOperations, fetchDoc, HTTP_METHODS, servedOperations } from "./load.ts";
import { parse } from "./yaml.ts";

let built: Built | undefined;
afterEach(async () => {
  await built?.close();
  built = undefined;
});

describe("GET /openapi.yaml", () => {
  it("serves YAML to the agent key with content-type application/yaml", async () => {
    built = await buildTestApp();
    const res = await built.app.request(`${API}/openapi.yaml`, { headers: agentHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")?.split(";")[0].trim()).toBe("application/yaml");
    const doc = (await parse(await res.text())) as Doc;
    expect(typeof doc).toBe("object");
    expect(doc.openapi).toMatch(/^3\./);
  });

  it("serves the same document to a signed-in session", async () => {
    const gh = createFakeGithub();
    built = await buildTestApp({ fetch: gh.fetch });
    const session = await signIn(built.app);
    const res = await built.app.request(`${API}/openapi.yaml`, { headers: session.headers });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")?.split(";")[0].trim()).toBe("application/yaml");
    const viaSession = (await parse(await res.text())) as Doc;
    const viaAgent = await fetchDoc(built);
    expect(viaSession).toEqual(viaAgent);
  });

  // The auth middleware answers 401 before routing, so these also require the route to exist (200 with the key).
  it("answers 401 without credentials, 200 with the key", async () => {
    built = await buildTestApp();
    expect((await built.app.request(`${API}/openapi.yaml`, { headers: agentHeaders() })).status).toBe(200);
    expect((await built.app.request(`${API}/openapi.yaml`)).status).toBe(401);
  });

  it("answers 401 for a wrong agent key, 200 with the right one", async () => {
    built = await buildTestApp();
    expect((await built.app.request(`${API}/openapi.yaml`, { headers: agentHeaders() })).status).toBe(200);
    expect((await built.app.request(`${API}/openapi.yaml`, { headers: agentHeaders("not-the-key") })).status).toBe(401);
  });
});

describe("document shape", () => {
  it("is OpenAPI 3.x with the production server URL", async () => {
    built = await buildTestApp();
    const doc = await fetchDoc(built);
    expect(doc.openapi).toMatch(/^3\.\d+\.\d+$/);
    expect(doc.servers.map((s) => s.url)).toContain("https://devvjs.dev/job-tracker/api");
  });

  it("declares a bearer scheme and the session cookie scheme", async () => {
    built = await buildTestApp();
    const doc = await fetchDoc(built);
    const schemes = Object.values(doc.components.securitySchemes);
    expect(schemes).toContainEqual(expect.objectContaining({ type: "http", scheme: "bearer" }));
    expect(schemes).toContainEqual(expect.objectContaining({ type: "apiKey", in: "cookie", name: "jt_session" }));
  });
});

describe("route parity", () => {
  it("documents every route the app serves", async () => {
    built = await buildTestApp();
    const doc = await fetchDoc(built);
    const served = servedOperations(built);
    const documented = documentedOperations(doc);
    // Sanity: the enumeration really sees the app (guards against a vacuous pass).
    expect(served).toEqual(
      expect.arrayContaining([
        "GET /applications",
        "POST /applications",
        "GET /applications/{id}",
        "PATCH /applications/{id}",
        "POST /applications/{id}/events",
        "DELETE /applications/{id}",
        "GET /contacts",
        "GET /due",
        "GET /summary",
        "GET /export",
        "GET /auth/login",
        "GET /auth/callback",
        "POST /auth/callback",
        "POST /auth/logout",
        "GET /auth/me",
        "GET /openapi.yaml",
      ]),
    );
    expect(served.filter((op) => !documented.includes(op))).toEqual([]);
  });

  it("serves every operation it documents", async () => {
    built = await buildTestApp();
    const doc = await fetchDoc(built);
    const served = servedOperations(built);
    expect(documentedOperations(doc).filter((op) => !served.includes(op))).toEqual([]);
  });
});

type Schema = { $ref?: string; properties?: Record<string, unknown>; [k: string]: unknown };

function resolve(doc: Doc, node: Schema | undefined): Schema | undefined {
  if (node?.$ref) {
    const name = node.$ref.replace("#/components/schemas/", "");
    return doc.components.schemas[name] as Schema | undefined;
  }
  return node;
}

describe("schemas", () => {
  it("gives every operation with a request body a schema reference", async () => {
    built = await buildTestApp();
    const doc = await fetchDoc(built);
    const withBody: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of Object.keys(item).filter((m) => HTTP_METHODS.includes(m))) {
        const body = item[method].requestBody as { content?: Record<string, { schema?: Schema }> } | undefined;
        if (!body) continue;
        withBody.push(`${method.toUpperCase()} ${path}`);
        const media = Object.values(body.content ?? {});
        expect(media.length, `${method} ${path} has a request body without content`).toBeGreaterThan(0);
        for (const m of media) {
          expect(m.schema?.$ref, `${method} ${path} body must $ref a schema`).toMatch(/^#\/components\/schemas\/\w+$/);
          expect(resolve(doc, m.schema), `${method} ${path} body $ref must resolve`).toBeDefined();
        }
      }
    }
    // The JSON write operations all have bodies.
    expect(withBody).toEqual(
      expect.arrayContaining([
        "POST /applications",
        "PATCH /applications/{id}",
        "POST /applications/{id}/events",
        "POST /contacts",
        "PATCH /contacts/{id}",
      ]),
    );
  });

  it("lists every section 3 field in the Application schema, exactly", async () => {
    built = await buildTestApp();
    const doc = await fetchDoc(built);
    const app = doc.components.schemas.Application as Schema | undefined;
    expect(app, "components.schemas.Application").toBeDefined();
    const props = Object.keys(app?.properties ?? {}).sort();
    // Writable fields plus the server-managed scalars. `extra` is flattened into the record and
    // never appears under its own name; `events` and `contacts` are the optional embedded lists.
    const required = [
      ...APPLICATION_WRITABLE_FIELDS,
      ...["id", "created_at", "updated_at", "updated_by", "meets_floor"],
    ].sort();
    expect(props.filter((p) => !required.includes(p) && p !== "events" && p !== "contacts")).toEqual([]);
    expect(required.filter((p) => !props.includes(p))).toEqual([]);
  });
});
