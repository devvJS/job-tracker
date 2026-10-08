// Applications API (spec D, Applications). Authentication and the 415 check are
// app-level middleware and run before these handlers; the business rules live
// in service.ts.
import { type Context, Hono } from "hono";
import { type AppEnv, jsonError } from "../../context.ts";
import { parseObjectBody } from "./input.ts";
import {
  ApplicationError,
  addEvent,
  createApplication,
  deleteApplication,
  getApplication,
  listApplications,
  updateApplication,
} from "./service.ts";

const applicationsApi = new Hono<AppEnv>();

/** Maps a refused request to the error envelope; anything else goes to the app's 500 handler. */
applicationsApi.onError((err, c) => {
  if (err instanceof ApplicationError) {
    return jsonError(c, err.status, err.message, { details: err.details, record: err.record });
  }
  throw err;
});

async function readBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const body = parseObjectBody(await c.req.text());
  if (!body.ok) throw new ApplicationError(400, body.message);
  return body.value;
}

applicationsApi.get("/applications", async (c) => {
  const items = await listApplications(c.get("deps").db, c.req.query());
  return c.json({ items, count: items.length });
});

applicationsApi.post("/applications", async (c) => {
  const body = await readBody(c);
  const deps = c.get("deps");
  return c.json(await createApplication(deps.db, deps, c.get("actor"), body), 201);
});

applicationsApi.get("/applications/:id", async (c) => {
  const id = c.req.param("id");
  const record = await getApplication(c.get("deps").db, id);
  if (!record) return jsonError(c, 404, `No application with id ${id}`);
  return c.json(record);
});

applicationsApi.patch("/applications/:id", async (c) => {
  // If-Match is checked before the body is read (428 before 400).
  const ifMatch = c.req.header("if-match");
  if (ifMatch === undefined || ifMatch.trim() === "") {
    return jsonError(c, 428, "PATCH requires an If-Match header with the record's updated_at");
  }
  const body = await readBody(c);
  const deps = c.get("deps");
  return c.json(await updateApplication(deps.db, deps, c.get("actor"), { id: c.req.param("id"), ifMatch, body }));
});

applicationsApi.post("/applications/:id/events", async (c) => {
  const body = await readBody(c);
  const deps = c.get("deps");
  return c.json(await addEvent(deps.db, deps, c.get("actor"), { id: c.req.param("id"), body }), 201);
});

applicationsApi.delete("/applications/:id", async (c) => {
  if (c.get("authVia") !== "session") return jsonError(c, 403, "Hard delete is available to the signed-in owner only");
  const deps = c.get("deps");
  await deleteApplication(deps.db, deps, c.get("actor"), { id: c.req.param("id"), confirm: c.req.query("confirm") });
  return c.body(null, 204);
});

export default applicationsApi;
