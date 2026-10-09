// Database connection and migrations (spec B).
// postgres:// and postgresql:// URLs use node-postgres; pglite:// URLs use PGlite.
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { is } from "drizzle-orm";
import { drizzle as drizzleNodePg, NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite, PgliteDatabase } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { Pool } from "pg";
import * as schema from "../db/schema.ts";

export type Schema = typeof schema;

/** A Drizzle database; the same type for node-postgres and PGlite. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../db/migrations", import.meta.url));

/**
 * Opens a database from a URL:
 * - `postgres://...` or `postgresql://...`: a node-postgres pool
 * - `pglite://memory`: a fresh in-memory PGlite
 * - `pglite://<dir>`: PGlite stored on disk in <dir> (absolute, or relative to the cwd);
 *   the directory and any missing parents are created, since PGlite makes only the leaf
 */
export async function createDb(url: string): Promise<{ db: Db; close: () => Promise<void> }> {
  if (/^postgres(ql)?:\/\//.test(url)) {
    const pool = new Pool({ connectionString: url });
    const db = drizzleNodePg(pool, { schema });
    return { db, close: () => pool.end() };
  }
  if (url.startsWith("pglite://")) {
    const location = url.slice("pglite://".length);
    if (location === "") throw new Error("pglite:// URL needs a location: pglite://memory or pglite://<dir>");
    let client: PGlite;
    if (location === "memory") {
      client = new PGlite();
    } else {
      const dir = resolve(location);
      await mkdir(dir, { recursive: true });
      client = new PGlite(dir);
    }
    await client.waitReady;
    const db = drizzlePglite(client, { schema });
    return { db, close: () => client.close() };
  }
  throw new Error("Unsupported database URL: expected postgres://, postgresql:// or pglite://");
}

/** Applies every pending migration in db/migrations. Safe to run repeatedly. */
export async function migrate(db: Db): Promise<void> {
  const config = { migrationsFolder: MIGRATIONS_FOLDER };
  if (is(db, PgliteDatabase)) {
    await migratePglite(db, config);
  } else if (is(db, NodePgDatabase)) {
    await migrateNodePg(db, config);
  } else {
    throw new Error("migrate: unsupported database driver");
  }
}
