// GET /openapi.yaml (spec D, OpenAPI): serves the repo-root openapi.yaml, the API contract agents
// read. Authentication (session or agent key) is the app-level middleware, which runs first.
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { AppEnv } from "../../context.ts";

/** Resolved from this module, not the working directory: server/features/openapi -> repo root. */
const OPENAPI_PATH = new URL("../../../openapi.yaml", import.meta.url);

// Read once at startup; a missing contract fails the server's start instead of a request.
const document = readFileSync(OPENAPI_PATH, "utf8");

const openapiRoutes = new Hono<AppEnv>();

openapiRoutes.get("/openapi.yaml", (c) => c.body(document, 200, { "Content-Type": "application/yaml; charset=utf-8" }));

export default openapiRoutes;
