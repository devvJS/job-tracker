// Export API (spec D, Export): GET /export returns the full dump. Auth (session
// or agent key) is enforced by the app-level middleware before this runs.
import { Hono } from "hono";
import type { AppEnv } from "../../context.ts";
import { buildExport } from "./build.ts";

const exportRoutes = new Hono<AppEnv>();

exportRoutes.get("/export", async (c) => {
  const { db, now } = c.get("deps");
  return c.json(await buildExport(db, now));
});

export default exportRoutes;
