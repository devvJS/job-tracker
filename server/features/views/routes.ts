// Views API (spec D, Views): GET /due and GET /summary. Auth is enforced by the
// app-level middleware before these handlers run.
import { Hono } from "hono";
import { type AppEnv, jsonError } from "../../context.ts";
import { todayIn } from "../../records.ts";
import type { ErrorDetail } from "../../../shared/errors.ts";
import { listDue } from "./due.ts";
import { MIN_DATE, addDays } from "./dates.ts";
import { parseDateParam } from "./params.ts";
import { buildSummary } from "./summary.ts";

const views = new Hono<AppEnv>();

views.get("/due", async (c) => {
  const { db, config, now } = c.get("deps");
  const date = parseDateParam("date", c.req.query("date"));
  if (!date.ok) return jsonError(c, 400, "Invalid query parameters", { details: [date.detail] });
  return c.json(await listDue(db, date.value ?? todayIn(config.timezone, now())));
});

views.get("/summary", async (c) => {
  const { db, config, now } = c.get("deps");
  const from = parseDateParam("from", c.req.query("from"));
  const to = parseDateParam("to", c.req.query("to"));
  const details: ErrorDetail[] = [];
  if (!from.ok) details.push(from.detail);
  if (!to.ok) details.push(to.detail);
  if (!from.ok || !to.ok) return jsonError(c, 400, "Invalid query parameters", { details });

  const end = to.value ?? todayIn(config.timezone, now());
  const start = from.value ?? addDays(end, -6);
  if (start === null) {
    return jsonError(c, 400, "Invalid query parameters", {
      details: [{ path: "to", message: `The default window (to − 6 days) would start before ${MIN_DATE}; pass from` }],
    });
  }
  if (start > end) {
    return jsonError(c, 400, "Invalid query parameters", {
      details: [{ path: "from", message: `from (${start}) must be on or before to (${end})` }],
    });
  }
  return c.json(await buildSummary(db, config.timezone, start, end));
});

export default views;
