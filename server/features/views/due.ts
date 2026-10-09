// GET /due service: open applications with a next action or follow-up on or before a date.
import { and, asc, lte, notInArray, or, sql } from "drizzle-orm";
import { applications } from "../../../db/schema.ts";
import type { ApplicationRow } from "../../../db/schema.ts";
import type { Db } from "../../db.ts";
import { toApplicationRecord } from "../../records.ts";
import { TERMINAL_STATUSES } from "../../../shared/schemas.ts";
import type { ApplicationRecord } from "../../../shared/schemas.ts";

/** Statuses that never show as due: the terminal ones plus accepted. */
const NOT_DUE_STATUSES: string[] = [...TERMINAL_STATUSES, "accepted"];

export type DueItem = ApplicationRecord & { due_on: string; overdue: boolean };

/** The earliest non-null of the two dates (`YYYY-MM-DD` strings compare lexically). */
function dueOn(row: ApplicationRow): string {
  const dates = [row.next_action_due, row.follow_up_date].filter((d): d is string => d !== null);
  return dates.reduce((a, b) => (b < a ? b : a));
}

export async function listDue(db: Db, date: string): Promise<{ date: string; items: DueItem[] }> {
  const rows = await db
    .select()
    .from(applications)
    .where(
      and(
        notInArray(applications.status, NOT_DUE_STATUSES),
        or(lte(applications.next_action_due, date), lte(applications.follow_up_date, date)),
      ),
    )
    // least() skips nulls, so it is the earliest non-null date. Ids sort in byte order.
    .orderBy(
      asc(sql`least(${applications.next_action_due}, ${applications.follow_up_date})`),
      asc(sql`${applications.id} collate "C"`),
    );

  const items = rows.map((row) => {
    const due_on = dueOn(row);
    return { ...toApplicationRecord(row), due_on, overdue: due_on < date };
  });
  return { date, items };
}
