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

const app = createApp({ db, config });
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`job-tracker listening on http://localhost:${info.port}/job-tracker/`);
  // Warn only once listening, so a failed start prints just its one error line.
  if (!existsSync(resolve(config.staticDir))) {
    console.warn(`STATIC_DIR ${resolve(config.staticDir)} does not exist; the UI will not be served (run npm run build).`);
  }
});

/** One line for a listen failure, never a stack trace. */
function listenErrorMessage(err: NodeJS.ErrnoException, port: number): string {
  switch (err.code) {
    case "EADDRINUSE":
      return `job-tracker: port ${port} is already in use. Set PORT to a free port (and PUBLIC_URL to match).`;
    case "EACCES":
      return `job-tracker: no permission to listen on port ${port}. Set PORT to a port above 1023 (and PUBLIC_URL to match).`;
    default: {
      const detail = `${err.code ? `${err.code}: ` : ""}${err.message}`.replace(/\s+/g, " ").trim();
      return `job-tracker: could not listen on port ${port} (PORT): ${detail}`;
    }
  }
}

// Without this listener Node throws the 'error' event as an uncaught exception with a stack trace.
server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(listenErrorMessage(err, config.port));
  close()
    .catch((closeErr: unknown) => {
      console.error(`job-tracker: closing the database failed: ${(closeErr as Error).message ?? String(closeErr)}`);
    })
    .finally(() => process.exit(1));
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
