// API calls and response types for the due and summary pages (spec D, Views).
import type { ApplicationRecord, Status } from "../../../shared/schemas.ts";
import { api } from "../../lib/api.ts";

/** A GET /due item: the list record plus the date it is due and whether that is before the asked date. */
export type DueItem = ApplicationRecord & { due_on: string; overdue: boolean };
export type DueResponse = { date: string; items: DueItem[] };

export type SourceRow = {
  source: string;
  applied: number;
  responded: number;
  interviewed: number;
  response_rate: number;
};

export type SummaryResponse = {
  from: string;
  to: string;
  applied: number;
  responses: number;
  interviews: number;
  by_status: Record<Status, number>;
  by_source: SourceRow[];
};

/** The timezone the tracker's "today" is in (the server's config.timezone default). */
export const LOCAL_TIMEZONE = "America/Detroit";

/** Today's date as YYYY-MM-DD in the tracker's timezone. */
export function localToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LOCAL_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** The GET /due query string: "" asks for the server's default date (today). */
export function dueQuery(date: string | null): string {
  return date === null ? "" : `?${new URLSearchParams({ date }).toString()}`;
}

export function getDue(query: string): Promise<DueResponse> {
  return api<DueResponse>(`/due${query}`);
}

/** GET /summary with the API's default window (the last 7 days, today included). */
export function getSummary(): Promise<SummaryResponse> {
  return api<SummaryResponse>("/summary");
}
