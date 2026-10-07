// The Hono app factory (spec B, D and F). Everything is served under /job-tracker.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type AppDeps, type AppEnv, jsonError } from "./context.ts";
import applicationRoutes from "./features/applications/routes.ts";
import contactRoutes from "./features/contacts/routes.ts";
import exportRoutes from "./features/export/routes.ts";
import openapiRoutes from "./features/openapi/routes.ts";
import viewRoutes from "./features/views/routes.ts";

export type { AppDeps } from "./context.ts";

export const BASE_PATH = "/job-tracker";
export const API_PATH = `${BASE_PATH}/api`;

const BODY_METHODS = new Set(["POST", "PATCH", "PUT"]);

function isApiPath(path: string): boolean {
  return path === API_PATH || path.startsWith(`${API_PATH}/`);
}

/** Auth routes (F2) take OAuth redirects and form posts, so they skip the media-type check. */
function isAuthPath(path: string): boolean {
  return path === `${API_PATH}/auth` || path.startsWith(`${API_PATH}/auth/`);
}

function isJsonContentType(header: string | undefined): boolean {
  if (!header) return false;
  return header.split(";")[0].trim().toLowerCase() === "application/json";
}

/** A path whose last segment contains a dot names a file (asset), never an SPA route. */
function looksLikeFile(path: string): boolean {
  const last = path.slice(path.lastIndexOf("/") + 1);
  return last.includes(".");
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Per-request deps (now and fetch always present), and noindex on every response,
  // including errors, redirects and static files.
  app.use("*", async (c, next) => {
    c.set("deps", { ...deps, now: deps.now ?? (() => new Date()), fetch: deps.fetch ?? fetch });
    await next();
    c.header("X-Robots-Tag", "noindex");
  });

  // 415 before routing, so unknown routes get it too.
  app.use(`${API_PATH}/*`, async (c, next) => {
    if (BODY_METHODS.has(c.req.method) && !isAuthPath(c.req.path) && !isJsonContentType(c.req.header("content-type"))) {
      return jsonError(c, 415, "Content-Type must be application/json");
    }
    await next();
  });

  app.get(`${BASE_PATH}/healthz`, async (c) => {
    await c.get("deps").db.execute(sql`select 1`);
    return c.json({ ok: true });
  });

  app.get(BASE_PATH, (c) => c.redirect(`${BASE_PATH}/${new URL(c.req.url).search}`, 301));

  for (const routes of [applicationRoutes, contactRoutes, viewRoutes, exportRoutes, openapiRoutes]) {
    app.route(API_PATH, routes);
  }

  // Static UI build with SPA fallback. /api paths never reach it.
  const root = resolve(deps.config.staticDir);
  if (existsSync(root)) {
    const files = serveStatic<AppEnv>({
      root,
      rewriteRequestPath: (path) => path.slice(BASE_PATH.length) || "/",
    });
    const spaIndex = serveStatic<AppEnv>({ root, path: "index.html" });
    app.get(`${BASE_PATH}/*`, (c, next) => (isApiPath(c.req.path) ? next() : files(c, next)));
    app.get(`${BASE_PATH}/*`, (c, next) =>
      isApiPath(c.req.path) || looksLikeFile(c.req.path) ? next() : spaIndex(c, next),
    );
  }

  app.notFound((c) => jsonError(c, 404, "Not found"));

  app.onError((err, c) => {
    if (err instanceof HTTPException && err.status >= 400 && err.status < 500) {
      return jsonError(c, err.status as ContentfulStatusCode, err.message || "Request failed");
    }
    console.error(err);
    return jsonError(c, 500, "Internal server error");
  });

  return app;
}
