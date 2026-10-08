// Loads db/seed.ts through a variable specifier, so each test fails on its own when the file is missing
// and type checking does not depend on it existing.
import type { Db } from "../../server/db.ts";

export type SeedDeps = { config: { timezone: string }; now: () => Date };
export type SeedModule = {
  SEED_APPLICATIONS: Array<Record<string, unknown>>;
  seed: (db: Db, deps: SeedDeps) => Promise<{ created: string[]; skipped: string[] }>;
};

export const SEED_PATH = new URL("../../db/seed.ts", import.meta.url);

export async function loadSeed(): Promise<SeedModule> {
  const specifier: string = SEED_PATH.href;
  return (await import(/* @vite-ignore */ specifier)) as SeedModule;
}
