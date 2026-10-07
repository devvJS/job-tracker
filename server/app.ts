// The Hono app factory (spec B, D, E and F). Everything is served under /job-tracker.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createRateLimiter } from "./auth/agent.ts";
import { apiAuth, htmlGate } from "./auth/middleware.ts";
import { API_PATH, AUTH_PATH, BASE_PATH, HEALTHZ_PATH, isApiPath, isAuthPath, looksLikeFile } from "./auth/paths.ts";
import authRoutes from "./auth/routes.ts";
import { type AppDeps, type AppEnv, jsonError } from "./context.ts";
import applicationRoutes from "./features/applications/routes.ts";
import contactRoutes from "./features/contacts/routes.ts";
import exportRoutes from "./features/export/routes.ts";
import openapiRoutes from "./features/openapi/routes.ts";
import viewRoutes from "./features/views/routes.ts";

export type { AppDeps } from "./context.ts";
export { API_PATH, BASE_PATH } from "./auth/paths.ts";

const BODY_METHODS = new Set(["POST", "PATCH", "PUT"]);

function isJsonContentType(header: string | undefined): boolean {
  if (!header) return false;
  return header.split(";")[0].trim().toLowerCase() === "application/json";
}

/** Vite build output: `/job-tracker/assets/<name>-<hash>.<ext>`, the hash being 8+ base64url characters. */
const HASHED_ASSET = new RegExp(`^${BASE_PATH}/assets/[^/]+-[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9]+$`);

const NO_STORE = "no-store";
const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * The Cache-Control a response under /job-tracker gets, or undefined to leave it alone.
 * - HTML (index.html, the SPA fallback, /login) and temporary redirects (the auth gate, OAuth):
 *   no-store, so a browser never replays a signed-out page or a stale redirect.
 * - /api: no-store, since every response depends on the session or key.
 * - Hashed build assets: cached for a year, immutable (a new build gets new names).
 * Anything else (non-hashed files, healthz, the permanent /job-tracker redirect) keeps the default.
 */
function cacheControlFor(path: string, res: Response): string | undefined {
  if (path !== BASE_PATH && !path.startsWith(`${BASE_PATH}/`)) return undefined;
  if (isApiPath(path)) return NO_STORE;
  if ([302, 303, 307].includes(res.status)) return NO_STORE;
  if ((res.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) return NO_STORE;
  if (res.status === 200 && HASHED_ASSET.test(path)) return IMMUTABLE;
  return undefined;
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Per-request deps (now and fetch always present), noindex on every response (including
  // errors, redirects and static files), and the Cache-Control policy (see cacheControlFor).
  app.use("*", async (c, next) => {
    c.set("deps", { ...deps, now: deps.now ?? (() => new Date()), fetch: deps.fetch ?? fetch });
    await next();
    c.header("X-Robots-Tag", "noindex");
    const cacheControl = cacheControlFor(c.req.path, c.res);
    if (cacheControl !== undefined) c.header("Cache-Control", cacheControl);
  });

  // Authentication, registered with app.use on this app so every /api route (including any added
  // after createApp) sits behind it. The public auth routes (login, callback, logout) skip it.
  // The rate limiter lives with this app instance.
  app.use("*", apiAuth(createRateLimiter()));

  // HTML pages need a session; the login page and static assets are public.
  app.use("*", htmlGate());

  // 415 after auth and before routing, so unknown routes get it too. Auth routes are exempt.
  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (
      isApiPath(path) &&
      BODY_METHODS.has(c.req.method) &&
      !isAuthPath(path) &&
      !isJsonContentType(c.req.header("content-type"))
    ) {
      return jsonError(c, 415, "Content-Type must be application/json");
    }
    await next();
  });

  app.get(HEALTHZ_PATH, async (c) => {
    await c.get("deps").db.execute(sql`select 1`);
    return c.json({ ok: true });
  });

  app.get(BASE_PATH, (c) => c.redirect(`${BASE_PATH}/${new URL(c.req.url).search}`, 301));

  app.route(AUTH_PATH, authRoutes);
  app.route(API_PATH, applicationRoutes);
  app.route(API_PATH, contactRoutes);
  app.route(API_PATH, viewRoutes);
  app.route(API_PATH, exportRoutes);
  app.route(API_PATH, openapiRoutes);

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
