// GET /summary service: window counts plus all-time status and source breakdowns.
import { and, between, count, eq, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { applications, events } from "../../../db/schema.ts";
import type { Db } from "../../db.ts";
import { STATUSES } from "../../../shared/schemas.ts";
import type { Status } from "../../../shared/schemas.ts";
import { localDateFormatter } from "./dates.ts";

/** A status-change to one of these, inside the window, is a response. */
const RESPONSE_EVENT_STATUSES = ["screen", "interviewing", "offer", "rejected"];
/** An application has responded if its current status, or any status-change target, is one of these. */
const RESPONDED_STATUSES = ["screen", "interviewing", "offer", "accepted", "rejected"];
/** An application has interviewed if its current status, or any status-change target, is one of these. */
const INTERVIEWED_STATUSES = ["interviewing", "offer", "accepted"];

export type SourceRow = { source: string; applied: number; responded: number; interviewed: number; response_rate: number };

export type Summary = {
  from: string;
  to: string;
  applied: number;
  responses: number;
  interviews: number;
  by_status: Record<Status, number>;
  by_source: SourceRow[];
};

/** `n / d` rounded to 2 decimal places (one division keeps exact halves exact). */
function rate(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n * 100) / d) / 100;
}

/** SQL list literal for an `in (...)` inside raw sql fragments. */
function sqlList(values: string[]) {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

/**
 * Counts responses and interviews whose `at` falls on a local date in [from, to].
 * SQL narrows to a UTC window that safely covers every timezone offset (from − 1 day
 * to to + 2 days, as UTC midnights). The bounds are computed by Postgres date
 * arithmetic, so every accepted date works, including 0001-01-01 and 9999-12-31.
 * The exact local date of each timestamp then comes from Intl, which follows the
 * timezone's DST rules.
 */
async function windowEventCounts(
  db: Db,
  timezone: string,
  from: string,
  to: string,
): Promise<{ responses: number; interviews: number }> {
  const lower = sql`((${from}::date - 1)::timestamp at time zone 'UTC')`;
  const upper = sql`((${to}::date + 2)::timestamp at time zone 'UTC')`;
  // `at` is read as epoch milliseconds, not as timestamp text: the driver's text parse
  // fails on instants that print as BC in the session timezone (near 0001-01-01).
  const atMs = sql<number>`(extract(epoch from ${events.at}) * 1000)::float8`.mapWith(Number);
  const rows = await db
    .select({ application_id: events.application_id, at_ms: atMs, type: events.type })
    .from(events)
    .where(
      and(
        gte(events.at, lower),
        lt(events.at, upper),
        or(
          eq(events.type, "interview"),
          and(eq(events.type, "status-change"), inArray(events.to_status, RESPONSE_EVENT_STATUSES)),
        ),
      ),
    );

  const responded = new Set<string>();
  let interviews = 0;
  const localDate = localDateFormatter(timezone);
  for (const row of rows) {
    const local = localDate(new Date(row.at_ms));
    if (local === null || local < from || local > to) continue;
    if (row.type === "interview") interviews += 1;
    else responded.add(row.application_id);
  }
  return { responses: responded.size, interviews };
}

async function appliedInWindow(db: Db, from: string, to: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(applications)
    .where(between(applications.applied_at, from, to));
  return row.n;
}

async function byStatus(db: Db): Promise<Record<Status, number>> {
  const rows = await db
    .select({ status: applications.status, n: count() })
    .from(applications)
    .groupBy(applications.status);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const row of rows) {
    if (Object.hasOwn(counts, row.status)) counts[row.status as Status] = row.n;
  }
  return counts;
}

async function bySource(db: Db): Promise<SourceRow[]> {
  const source = sql<string>`coalesce(${applications.source}, 'unknown')`;
  const statusChangeTo = (statuses: string[]) => sql`exists (
    select 1 from ${events}
    where ${events.application_id} = ${applications.id}
      and ${events.type} = 'status-change'
      and ${events.to_status} in (${sqlList(statuses)})
  )`;
  const hasInterviewEvent = sql`exists (
    select 1 from ${events}
    where ${events.application_id} = ${applications.id} and ${events.type} = 'interview'
  )`;
  const responded = sql`${applications.status} in (${sqlList(RESPONDED_STATUSES)}) or ${statusChangeTo(RESPONDED_STATUSES)}`;
  const interviewed = sql`${applications.status} in (${sqlList(INTERVIEWED_STATUSES)}) or ${hasInterviewEvent} or ${statusChangeTo(INTERVIEWED_STATUSES)}`;

  const rows = await db
    .select({
      source,
      applied: sql<number>`count(*)`.mapWith(Number),
      responded: sql<number>`count(*) filter (where ${responded})`.mapWith(Number),
      interviewed: sql<number>`count(*) filter (where ${interviewed})`.mapWith(Number),
    })
    .from(applications)
    .where(isNotNull(applications.applied_at))
    .groupBy(source)
    .orderBy(sql`${source} collate "C"`);

  return rows.map((r) => ({
    source: r.source,
    applied: r.applied,
    responded: r.responded,
    interviewed: r.interviewed,
    response_rate: rate(r.responded, r.applied),
  }));
}

export async function buildSummary(db: Db, timezone: string, from: string, to: string): Promise<Summary> {
  const [applied, window, by_status, by_source] = await Promise.all([
    appliedInWindow(db, from, to),
    windowEventCounts(db, timezone, from, to),
    byStatus(db),
    bySource(db),
  ]);
  return {
    from,
    to,
    applied,
    responses: window.responses,
    interviews: window.interviews,
    by_status,
    by_source,
  };
}
