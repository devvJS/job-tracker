// Contacts API (spec D, Contacts): GET /contacts, GET /contacts/:id,
// POST /contacts and PATCH /contacts/:id. Authentication and the 415 check
// are app-level middleware and run before these handlers.
import { Hono } from "hono";
import { contactCreateSchema, contactPatchSchema, dateTimeSchema } from "../../../shared/schemas.ts";
import { type AppEnv, jsonError } from "../../context.ts";
import { slugify } from "../../records.ts";
import { issueDetails, parseObjectBody, splitContactInput } from "./input.ts";
import { createContact, getContact, listContacts, updateContact } from "./service.ts";

const contactsApi = new Hono<AppEnv>();

/**
 * The instant an If-Match header names. The header carries updated_at as the
 * API returned it; surrounding quotes (ETag style) are tolerated. Anything that
 * is not an ISO 8601 datetime can never match, so it gives null.
 */
function ifMatchInstant(header: string): Date | null {
  const value = header.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
  if (!dateTimeSchema.safeParse(value).success) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

contactsApi.get("/contacts", async (c) => {
  const items = await listContacts(c.get("deps").db, c.req.query("q"));
  return c.json({ items, count: items.length });
});

contactsApi.get("/contacts/:id", async (c) => {
  const id = c.req.param("id");
  const record = await getContact(c.get("deps").db, id);
  if (!record) return jsonError(c, 404, `No contact with id ${id}`);
  return c.json(record);
});

contactsApi.post("/contacts", async (c) => {
  const body = parseObjectBody(await c.req.text());
  if (!body.ok) return jsonError(c, 400, body.message);

  const { known, extra } = splitContactInput(body.value);
  const parsed = contactCreateSchema.safeParse(known);
  if (!parsed.success) return jsonError(c, 400, "Invalid contact", { details: issueDetails(parsed.error) });
  if (slugify(parsed.data.name) === "") {
    return jsonError(c, 400, "Invalid contact", {
      details: [{ path: "name", message: "Name needs at least one letter or digit to form an id" }],
    });
  }

  const { db, now } = c.get("deps");
  const result = await createContact(db, { fields: parsed.data, extra }, c.get("actor"), now());
  if (result.kind === "conflict") {
    return jsonError(c, 409, `A contact with id ${result.record.id} already exists`, { record: result.record });
  }
  return c.json(result.record, 201);
});

contactsApi.patch("/contacts/:id", async (c) => {
  const id = c.req.param("id");
  const header = c.req.header("if-match");
  if (header === undefined || header.trim() === "") {
    return jsonError(c, 428, "PATCH requires an If-Match header with the record's updated_at");
  }

  const body = parseObjectBody(await c.req.text());
  if (!body.ok) return jsonError(c, 400, body.message);
  const { known, extra } = splitContactInput(body.value);
  const parsed = contactPatchSchema.safeParse(known);
  if (!parsed.success) return jsonError(c, 400, "Invalid contact", { details: issueDetails(parsed.error) });

  const { db, now } = c.get("deps");
  const result = await updateContact(db, id, ifMatchInstant(header), { fields: parsed.data, extra }, c.get("actor"), now());
  switch (result.kind) {
    case "not_found":
      return jsonError(c, 404, `No contact with id ${id}`);
    case "stale":
      return jsonError(c, 412, "The contact has changed since If-Match was read", { record: result.record });
    case "updated":
      return c.json(result.record);
  }
});

export default contactsApi;
