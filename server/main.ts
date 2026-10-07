// Server entry: config, database, migrations, then listen (npm start).
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { type Config, loadConfig } from "./config.ts";
import { createDb, migrate } from "./db.ts";

function readConfig(): Config {
  try {
    return loadConfig(process.env);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

const config = readConfig();

const { db, close } = await createDb(config.databaseUrl);
await migrate(db);

if (!existsSync(resolve(config.staticDir))) {
  console.warn(`STATIC_DIR ${resolve(config.staticDir)} does not exist; the UI will not be served (run npm run build).`);
}

const app = createApp({ db, config });
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`job-tracker listening on http://localhost:${info.port}/job-tracker/`);
});

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  // Do not hang on keep-alive connections forever.
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close(() => {
    close().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(err);
        process.exit(1);
      },
    );
  });
  if ("closeIdleConnections" in server) server.closeIdleConnections();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
