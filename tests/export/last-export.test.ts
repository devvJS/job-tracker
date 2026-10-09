import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { settings } from "../../db/schema.ts";
import { runExport } from "../../server/features/export/run.ts";
import { createDb, migrate, type Db } from "../../server/db.ts";
import { createTestDb } from "../helpers/db.ts";
import { createFakeGit, type FakeGit } from "./helpers/fake-git.ts";
import { serveFetch } from "./helpers/http.ts";
import { seedData } from "./helpers/fixtures.ts";

const TOKEN = "ghp_SECRET_lastexport_token_0123456789";
const REPO = "devvJS/job-tracker-data";
const BRANCH = "main";
const API = "https://git.fake.test";
const T1 = new Date("2026-10-08T03:00:00.000Z");
const T2 = new Date("2026-10-09T03:00:00.000Z");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function readLast(db: Db): Promise<unknown> {
  const rows = await db.select().from(settings).where(eq(settings.key, "last_export_at"));
  return rows.length === 0 ? undefined : rows[0].value;
}

async function setup() {
  const handle = await createTestDb();
  cleanups.push(handle.close);
  await seedData(handle.db);
  const git = createFakeGit({ apiUrl: API, repo: REPO, branch: BRANCH, token: TOKEN });
  const run = (now: Date) =>
    runExport({ db: handle.db, now: () => now, github: { token: TOKEN, repo: REPO, branch: BRANCH, apiUrl: API, fetch: git.fetch } });
  return { db: handle.db, git, run };
}

describe("runExport records last_export_at", () => {
  it("nothing is recorded before any run", async () => {
    const { db } = await setup();
    expect(await readLast(db)).toBeUndefined();
  });

  it("a committed run records the run's exported_at as a JSON string", async () => {
    const { db, git, run } = await setup();
    const result = await run(T1);
    expect(result.committed).toBe(true);
    expect(await readLast(db)).toBe("2026-10-08T03:00:00.000Z");
    expect(git.headFiles()["exported_at.txt"]).toBe("2026-10-08T03:00:00.000Z\n");
  });

  it("an unchanged run (committed:false) also records its time", async () => {
    const { db, git, run } = await setup();
    await run(T1);
    await db.delete(settings).where(eq(settings.key, "last_export_at"));
    expect(await readLast(db)).toBeUndefined();
    const second = await run(T1); // same exported_at and data -> same tree
    expect(second.committed).toBe(false);
    expect(git.createdCommits).toHaveLength(1);
    expect(await readLast(db)).toBe("2026-10-08T03:00:00.000Z");
  });

  it("two successful runs with no data change: the second is committed or not per the tree, and last_export_at advances", async () => {
    const { db, run } = await setup();
    await run(T1);
    expect(await readLast(db)).toBe(T1.toISOString());
    const second = await run(T2);
    // exported_at.txt carries the new time, so the tree changes only through that file; the
    // dump must not add anything else (checked in the next test). last_export_at advances either way.
    expect(second.files).toBe(6);
    expect(await readLast(db)).toBe(T2.toISOString());
  });

  it("with no data change and the same clock instant the second run is committed:false and last_export_at stays that instant", async () => {
    const { db, run } = await setup();
    const first = await run(T1);
    await db.delete(settings).where(eq(settings.key, "last_export_at"));
    const second = await run(T1);
    expect(first.committed).toBe(true);
    expect(second.committed).toBe(false);
    expect(await readLast(db)).toBe(T1.toISOString());
  });

  it("a failed run leaves last_export_at unchanged (still absent after a first failure)", async () => {
    const { db, git, run } = await setup();
    git.fail("POST trees", 500);
    await expect(run(T1)).rejects.toThrow();
    expect(await readLast(db)).toBeUndefined();
  });

  it("a failed run after a good one keeps the earlier value", async () => {
    const { db, git, run } = await setup();
    await run(T1);
    git.fail("PATCH ref", 409);
    await expect(run(T2)).rejects.toThrow();
    expect(await readLast(db)).toBe(T1.toISOString());
  });

  it("a failure to read GitHub (GET ref 500) records nothing", async () => {
    const { db, git, run } = await setup();
    git.fail("GET ref", 500);
    await expect(run(T1)).rejects.toThrow();
    expect(await readLast(db)).toBeUndefined();
  });

  it("a recording failure after a landed commit rejects with a message saying the commit succeeded", async () => {
    const { db, git } = await setup();
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "insert") {
          return (table: unknown) => {
            if (table === settings) throw new Error("settings write refused");
            return (target.insert as (t: unknown) => unknown)(table);
          };
        }
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as Db;
    const err = await runExport({
      db: failing,
      now: () => T1,
      github: { token: TOKEN, repo: REPO, branch: BRANCH, apiUrl: API, fetch: git.fetch },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(git.createdCommits).toHaveLength(1);
    expect(git.headSha()).toBe(git.createdCommits[0].sha);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/committed [0-9a-f]+ but recording last_export_at failed/);
    expect(await readLast(db)).toBeUndefined();
  });

  it("the committed files never mention last_export_at, even when it is already recorded", async () => {
    const { db, git, run } = await setup();
    await run(T1);
    await run(T2);
    expect(await readLast(db)).toBe(T2.toISOString());
    const files = git.headFiles();
    expect(Object.keys(files).sort()).toHaveLength(6);
    for (const [path, content] of Object.entries(files)) {
      expect(content, path).not.toContain("last_export_at");
    }
  });

  it("recording does not change the tree: a run with the same instant after a recorded run is a no-op", async () => {
    const { db, git, run } = await setup();
    await run(T1);
    const head = git.headSha();
    await db.delete(settings).where(eq(settings.key, "last_export_at"));
    const again = await run(T1);
    expect(again.committed).toBe(false);
    expect(git.headSha()).toBe(head);
    expect(await readLast(db)).toBe(T1.toISOString());
  });
});

describe("scripts/export.ts records last_export_at", () => {
  const SCRIPT = join(import.meta.dirname, "../../scripts/export.ts");
  const ROOT = join(import.meta.dirname, "../..");

  async function scriptSetup() {
    const dir = await mkdtemp(join(tmpdir(), "export-last-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const handle = await createDb(`pglite://${dir}`);
    await migrate(handle.db);
    await seedData(handle.db);
    await handle.close();
    const holder: { git?: FakeGit } = {};
    const server = await serveFetch(() => (holder.git as FakeGit).fetch);
    cleanups.push(server.stop);
    const git = createFakeGit({ apiUrl: server.url, repo: REPO, branch: BRANCH, token: TOKEN });
    holder.git = git;
    const env = { DATABASE_URL: `pglite://${dir}`, EXPORT_GITHUB_TOKEN: TOKEN, EXPORT_REPO: REPO, EXPORT_BRANCH: BRANCH, GITHUB_API_URL: server.url };
    const run = () =>
      new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const full: Record<string, string | undefined> = { ...process.env };
        for (const k of Object.keys(env)) delete full[k];
        const child = spawn(process.execPath, [SCRIPT], { cwd: ROOT, env: { ...full, ...env } as NodeJS.ProcessEnv });
        let stderr = "";
        child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, stderr });
        });
      });
    const read = async () => {
      const h = await createDb(`pglite://${dir}`);
      try {
        return await readLast(h.db);
      } finally {
        await h.close();
      }
    };
    return { git, run, read };
  }

  it("a successful script run records last_export_at equal to the committed exported_at", async () => {
    const { git, run, read } = await scriptSetup();
    const r = await run();
    expect(r.code).toBe(0);
    const exportedAt = git.headFiles()["exported_at.txt"].trim();
    expect(exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(await read()).toBe(exportedAt);
  }, 90_000);

  it("a failing script run (GitHub 500) exits non-zero and records nothing", async () => {
    const { git, run, read } = await scriptSetup();
    git.fail("POST trees", 500);
    const r = await run();
    expect(r.code).not.toBe(0);
    expect(await read()).toBeUndefined();
  }, 90_000);
});
