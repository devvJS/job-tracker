import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers/app.ts";
import {
  ACTORS, CLIENT_EVENT_TYPES, CLOSED_REASONS, COMP_SOURCES, COMPANY_STAGES, EVENT_TYPES, MOVE_TIMING,
  POSTING_STATUSES, PRIORITIES, REFERRALS, RELATIONSHIPS, SOURCES, STATUSES, TRACKS, WORK_ARRANGEMENTS,
} from "../../shared/schemas.ts";
import { type Built, deref, fetchDoc, parametersOf, requires, responseSchema, schemaProperties } from "./load.ts";

let built: Built | undefined;
afterEach(async () => {
  await built?.close();
  built = undefined;
});

const ENUMS: Record<string, readonly string[]> = {
  Status: STATUSES,
  WorkArrangement: WORK_ARRANGEMENTS,
  PostingStatus: POSTING_STATUSES,
  MoveTiming: MOVE_TIMING,
  CompSource: COMP_SOURCES,
  Track: TRACKS,
  CompanyStage: COMPANY_STAGES,
  Source: SOURCES,
  Referral: REFERRALS,
  Priority: PRIORITIES,
  ClosedReason: CLOSED_REASONS,
  ClientEventType: CLIENT_EVENT_TYPES,
  EventType: EVENT_TYPES,
  Actor: ACTORS,
  Relationship: RELATIONSHIPS,
};

describe("openapi.yaml content", () => {
  it.each(Object.keys(ENUMS))("enum schema %s equals the exported array exactly", async (name) => {
    built = await buildTestApp();
    const doc = await fetchDoc(built);
    expect(doc.components.schemas[name]?.enum).toEqual([...ENUMS[name]]);
  });

  it.each(["/applications/{id}", "/contacts/{id}"])("PATCH %s has a required If-Match header parameter", async (path) => {
    built = await buildTestApp();
    const doc = await fetchDoc(built);
    const ifMatch = parametersOf(doc, "PATCH", path).filter((p) => p.name === "If-Match");
    expect(ifMatch).toHaveLength(1);
    expect(ifMatch[0]).toMatchObject({ in: "header", required: true });
  });

  it.each([
    ["POST", "/applications", "409"],
    ["POST", "/contacts", "409"],
    ["PATCH", "/applications/{id}", "412"],
    ["PATCH", "/contacts/{id}", "412"],
  ])("%s %s %s resolves to a schema requiring record", async (method, path, status) => {
    built = await buildTestApp();
    const doc = await fetchDoc(built);
    expect(requires(doc, responseSchema(doc, method, path, status), "record")).toBe(true);
  });

  it.each(["get", "post"])("%s /auth/callback marks code and state required", async (method) => {
    built = await buildTestApp();
    const doc = await fetchDoc(built);
    const params = parametersOf(doc, method, "/auth/callback").filter((p) => p.in === "query");
    expect(params.map((p) => p.name).sort()).toEqual(["code", "state"]);
    expect(params.map((p) => p.required)).toEqual([true, true]);
  });

  it("documents that contact_ids: null clears every link on the application patch schema", async () => {
    built = await buildTestApp();
    const doc = await fetchDoc(built);
    const prop = deref(doc, schemaProperties(doc, doc.components.schemas.ApplicationPatch).contact_ids);
    expect(String(prop?.description ?? "")).toMatch(/\bnull\b/);
    expect(String(prop?.description ?? "")).toMatch(/clear|remove/i);
  });

  it("EventResult requires both event and record", async () => {
    built = await buildTestApp();
    const doc = await fetchDoc(built);
    const schema = doc.components.schemas.EventResult;
    expect(requires(doc, schema, "event")).toBe(true);
    expect(requires(doc, schema, "record")).toBe(true);
  });
});
