// Request-scoped types shared by the app and every feature router (spec B),
// plus the error-envelope responder every route uses (spec D).
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { errorCodeFor, errorEnvelope } from "../shared/errors.ts";
import type { ActorName } from "../shared/schemas.ts";

/** Who a write is recorded as (spec A.5). */
export type Actor = ActorName;

/** How the request authenticated. Set by the auth middleware (F2). */
export type AuthVia = "session" | "agent";

/** What createApp receives. `fetch` and `now` are optional and defaulted per request. */
export type AppDeps = { db: Db; config: Config; fetch?: typeof fetch; now?: () => Date };

/** AppDeps as handlers see them through c.get("deps"): `now` and `fetch` are always present. */
export type RequestDeps = AppDeps & { now: () => Date; fetch: typeof fetch };

export type AppVariables = {
  deps: RequestDeps;
  actor: Actor;
  authVia: AuthVia;
};

/** The Hono environment: `new Hono<AppEnv>()` gives typed c.get("deps"), c.get("actor") and c.get("authVia"). */
export type AppEnv = { Variables: AppVariables };

/**
 * Responds with the error envelope `{ error: { code, message, details? } }`.
 * The code comes from the status (400 bad_request, 404 not_found, ...) unless
 * `code` is given. 409 and 412 pass `record` to add the full current record.
 */
export function jsonError(
  c: Context,
  status: ContentfulStatusCode,
  message: string,
  opts: { details?: unknown; record?: unknown; code?: string } = {},
): Response {
  const body: Record<string, unknown> = { ...errorEnvelope(opts.code ?? errorCodeFor(status), message, opts.details) };
  if (opts.record !== undefined) body.record = opts.record;
  return c.json(body, status);
}
