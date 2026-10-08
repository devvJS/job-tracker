import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, migrate } from "../../server/db.ts";
import { createFakeGit, type FakeGit } from "./helpers/fake-git.ts";
import { serveFetch } from "./helpers/http.ts";
import { APP_ALPHA, APP_ZETA, CONTACT_BOB, CONTACT_JANE, seedData } from "./helpers/fixtures.ts";

const TOKEN = "ghp_SECRET_script_token_0123456789";
const REPO = "devvJS/job-tracker-data";
const BRANCH = "main";
const SCRIPT = join(import.meta.dirname, "../../scripts/export.ts");
const ROOT = join(import.meta.dirname, "../..");

let dir: string;
let stop: (() => Promise<void>) | undefined;
let git: FakeGit | undefined;
let apiUrl: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "export-script-"));
  const handle = await createDb(`pglite://${dir}`);
  await migrate(handle.db);
  await seedData(handle.db);
  await handle.close();
  const server = await serveFetch(() => (git as FakeGit).fetch);
  apiUrl = server.url;
  stop = server.stop;
  git = createFakeGit({ apiUrl, repo: REPO, branch: BRANCH, token: TOKEN });
});

afterEach(async () => {
  await stop?.();
  stop = undefined;
  git = undefined;
  await rm(dir, { recursive: true, force: true });
});

function runScript(env: Record<string, string | undefined>) {
  const full: Record<string, string | undefined> = { ...process.env };
  for (const k of ["DATABASE_URL", "EXPORT_GITHUB_TOKEN", "EXPORT_REPO", "EXPORT_BRANCH", "GITHUB_API_URL"]) delete full[k];
  Object.assign(full, env);
  for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k];
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { cwd: ROOT, env: full as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const goodEnv = () => ({
  DATABASE_URL: `pglite://${dir}`,
  EXPORT_GITHUB_TOKEN: TOKEN,
  EXPORT_REPO: REPO,
  EXPORT_BRANCH: BRANCH,
  GITHUB_API_URL: apiUrl,
});

describe("scripts/export.ts", () => {
  it("exports the database to the data repo as one commit, logs one line and exits 0", async () => {
    const r = await runScript(goodEnv());
    expect(r.stderr).not.toContain(TOKEN);
    expect(r.stdout).not.toContain(TOKEN);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    const g = git as FakeGit;
    expect(g.createdCommits).toHaveLength(1);
    expect(g.refUpdates).toEqual([g.createdCommits[0].sha]);
    expect(g.createdCommits[0].parents).toEqual([g.initialCommitSha]);
    expect(g.createdCommits[0].message).toMatch(/^Export \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const files = g.headFiles();
    expect(Object.keys(files).sort()).toEqual(
      [
        `applications/${APP_ALPHA}.json`,
        `applications/${APP_ZETA}.json`,
        `contacts/${CONTACT_BOB}.json`,
        `contacts/${CONTACT_JANE}.json`,
        `jd/${APP_ZETA}.md`,
        "exported_at.txt",
      ].sort(),
    );
    expect(g.createdCommits[0].message).toBe(`Export ${files["exported_at.txt"].trim()}`);
    expect((JSON.parse(files[`applications/${APP_ZETA}.json`]) as { id: string }).id).toBe(APP_ZETA);
    for (const c of g.calls) expect(c.headers["authorization"]).toMatch(new RegExp(`^(Bearer|token) ${TOKEN}$`));
  }, 90_000);

  it("defaults EXPORT_BRANCH to main", async () => {
    const env: Record<string, string | undefined> = { ...goodEnv(), EXPORT_BRANCH: undefined };
    const r = await runScript(env);
    expect(r.code).toBe(0);
    expect((git as FakeGit).callSequence()[0]).toBe(`GET /repos/${REPO}/git/ref/heads/main`);
    expect((git as FakeGit).createdCommits).toHaveLength(1);
  }, 90_000);

  it("without EXPORT_GITHUB_TOKEN exits non-zero, names the variable and calls nothing", async () => {
    const r = await runScript({ ...goodEnv(), EXPORT_GITHUB_TOKEN: undefined });
    expect(r.code).not.toBe(0);
    expect(r.code).not.toBeNull();
    expect(r.stderr).toContain("EXPORT_GITHUB_TOKEN");
    expect((git as FakeGit).calls).toHaveLength(0);
  }, 90_000);

  it("without EXPORT_REPO exits non-zero and names the variable", async () => {
    const r = await runScript({ ...goodEnv(), EXPORT_REPO: undefined });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("EXPORT_REPO");
    expect((git as FakeGit).calls).toHaveLength(0);
  }, 90_000);

  it("exits non-zero when GitHub fails, and never prints the token", async () => {
    (git as FakeGit).fail("POST trees", 500);
    const r = await runScript(goodEnv());
    expect((git as FakeGit).calls.map((c) => c.endpoint)).toEqual(["GET ref", "GET commit", "POST trees"]);
    expect(r.code).not.toBe(0);
    expect(r.code).not.toBeNull();
    expect(r.stderr).not.toContain(TOKEN);
    expect(r.stdout).not.toContain(TOKEN);
    expect((git as FakeGit).createdCommits).toHaveLength(0);
  }, 90_000);
});
