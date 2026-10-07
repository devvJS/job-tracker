import { createApp } from "../../server/app.ts";
import type { Config } from "../../server/config.ts";
import { TEST_NOW, testConfig } from "./config.ts";
import { createTestDb } from "./db.ts";

export type BuildAppOptions = {
  config?: Partial<Config>;
  /** A fixed Date or a clock function. Defaults to TEST_NOW. */
  now?: Date | (() => Date);
  /** Defaults to a fetch that throws, so no test touches the network by accident. */
  fetch?: typeof fetch;
};

const forbiddenFetch: typeof fetch = async (input) => {
  throw new Error(`unexpected network call in test: ${String(input)}`);
};

/** Builds the real app on a fresh migrated in-memory DB. Call `close()` in afterEach/afterAll. */
export async function buildTestApp(opts: BuildAppOptions = {}) {
  const { db, close } = await createTestDb();
  const config = testConfig(opts.config);
  const nowOpt = opts.now ?? TEST_NOW;
  const now: () => Date = typeof nowOpt === "function" ? nowOpt : () => nowOpt;
  const app = createApp({ db, config, now, fetch: opts.fetch ?? forbiddenFetch });
  return { app, db, config, now, close };
}
