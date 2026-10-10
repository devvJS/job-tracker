// The time of the last successful export run, kept in the settings table under
// last_export_at (a JSON string, the run's exported_at). It lives outside the
// dump on purpose: putting it in the data repo would change the tree on every run.
import { eq } from "drizzle-orm";
import { settings } from "../../../db/schema.ts";
import type { Db } from "../../db.ts";

export const LAST_EXPORT_KEY = "last_export_at";

/** Records `exportedAt` (ISO 8601 UTC) as the last successful export, replacing any earlier value. */
export async function recordLastExport(db: Db, exportedAt: string): Promise<void> {
  await db
    .insert(settings)
    .values({ key: LAST_EXPORT_KEY, value: exportedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value: exportedAt } });
}

/** The last successful export's time, or null when none is recorded. Throws when the database does. */
export async function readLastExport(db: Db): Promise<string | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, LAST_EXPORT_KEY));
  return typeof row?.value === "string" ? row.value : null;
}
