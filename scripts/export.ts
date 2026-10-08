// Nightly export (npm run export): writes the database to the data repo.
// Reads only its own variables, so it runs without the app's OAuth or session
// secrets. Prints one line on success; exits non-zero with a message on failure.
// The token is never printed.
import { createDb } from "../server/db.ts";
import { runExport } from "../server/features/export/run.ts";
import { redact as redactSecret } from "../server/features/export/util.ts";

const env = process.env;
const value = (name: string) => {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
};

const problems: string[] = [];
const databaseUrl = value("DATABASE_URL");
const token = value("EXPORT_GITHUB_TOKEN");
const repo = value("EXPORT_REPO");
const branch = value("EXPORT_BRANCH") ?? "main";
const apiUrl = (value("GITHUB_API_URL") ?? "https://api.github.com").replace(/\/+$/, "");

if (!databaseUrl) problems.push("DATABASE_URL is required");
if (!token) problems.push("EXPORT_GITHUB_TOKEN is required");
if (!repo) problems.push("EXPORT_REPO is required (owner/name)");
else if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) problems.push("EXPORT_REPO must look like owner/name");
if (!/^https?:\/\/[^/]+/.test(apiUrl)) problems.push("GITHUB_API_URL must be an http(s) URL");

if (problems.length > 0 || !databaseUrl || !token || !repo) {
  console.error(`export: ${problems.join("; ")}`);
  process.exit(1);
}

const redact = (s: string) => redactSecret(s, token);

let close: (() => Promise<void>) | undefined;
try {
  const handle = await createDb(databaseUrl);
  close = handle.close;
  const result = await runExport({
    db: handle.db,
    now: () => new Date(),
    github: { token, repo, branch, apiUrl, fetch: globalThis.fetch },
  });
  console.log(
    result.committed
      ? `export: committed ${result.commitSha} to ${repo}@${branch} (${result.files} files)`
      : `export: no changes in ${repo}@${branch} (${result.files} files)`,
  );
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`export failed: ${redact(message)}`);
  process.exitCode = 1;
} finally {
  if (close) {
    await close().catch((err: unknown) => {
      console.error(`export: closing the database failed: ${redact(err instanceof Error ? err.message : String(err))}`);
      process.exitCode = 1;
    });
  }
}
