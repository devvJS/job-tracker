import { createDb, migrate } from "../../server/db.ts";

export type TestDb = Awaited<ReturnType<typeof createDb>>;

/** A fresh, migrated, isolated in-memory PGlite. Call `close()` in afterEach/afterAll. */
export async function createTestDb(): Promise<TestDb> {
  const handle = await createDb("pglite://memory");
  await migrate(handle.db);
  return handle;
}
