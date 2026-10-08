// Calendar helpers for the views: day arithmetic and timestamp-to-local-date conversion.

/** The first and last dates the views accept. Postgres has no year 0000, and dates are 4-digit years. */
export const MIN_DATE = "0001-01-01";
export const MAX_DATE = "9999-12-31";

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/**
 * Calendar arithmetic on a `YYYY-MM-DD` string (no timezone involved). Exact for
 * every year; returns null when the result falls outside MIN_DATE..MAX_DATE.
 */
export function addDays(date: string, days: number): string | null {
  const [y, m, d] = date.split("-").map(Number);
  // setUTCFullYear, unlike Date.UTC, does not map years 0-99 to 1900-1999.
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d + days);
  const year = dt.getUTCFullYear();
  if (year < 1 || year > 9999) return null;
  return `${pad(year, 4)}-${pad(dt.getUTCMonth() + 1, 2)}-${pad(dt.getUTCDate(), 2)}`;
}

/**
 * A converter from an instant to its `YYYY-MM-DD` calendar date in `timezone`,
 * using Intl (so DST and historical offsets are honoured). One formatter is built
 * per call and reused for every timestamp. Dates before year 1 (BC, which Intl
 * would otherwise print as a positive year) give null.
 */
export function localDateFormatter(timezone: string): (at: Date) => string | null {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    era: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (at) => {
    const parts = format.formatToParts(at);
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
    if (get("era") !== "AD") return null;
    return `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}`;
  };
}
