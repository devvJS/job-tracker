import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { applications } from "../../db/schema.ts";
import type { Db } from "../../server/db.ts";
import { createTestDb } from "../helpers/db.ts";
import { createFakeGit, type Endpoint } from "./helpers/fake-git.ts";
import {
  APP_ALPHA,
  APP_ZETA,
  CONTACT_BOB,
  CONTACT_JANE,
  JD_TEXT,
  deleteApplication,
  expectedRecords,
  fileText,
  seedData,
} from "./helpers/fixtures.ts";

type RunExport = (opts: {
  db: Db;
  now: () => Date;
  github: { token: string; repo: string; branch: string; apiUrl: string; fetch: typeof fetch };
}) => Promise<{ committed: boolean; commitSha?: string; files: number }>;

// Loaded lazily so each test fails on its own (and typechecks) while the module is missing.
const RUN_MODULE = new URL("../../server/features/export/run.ts", import.meta.url).href;
async function loadRunExport(): Promise<RunExport> {
  const mod = (await import(/* @vite-ignore */ RUN_MODULE)) as { runExport: RunExport };
  return mod.runExport;
}

const TOKEN = "ghp_SECRET_export_token_0123456789";
const REPO = "devvJS/job-tracker-data";
const BRANCH = "export-branch";
const API = "https://git.fake.test";
const NOW = new Date("2026-10-08T03:00:00.000Z");
const EXPORTED_AT = "2026-10-08T03:00:00.000Z";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup(opts: { missingBranch?: boolean; emptyRepo?: boolean; seed?: boolean; maxTreeBodyBytes?: number } = {}) {
  const handle = await createTestDb();
  close = handle.close;
  if (opts.seed !== false) await seedData(handle.db);
  const git = createFakeGit({ apiUrl: API, repo: REPO, branch: BRANCH, token: TOKEN, missingBranch: opts.missingBranch, emptyRepo: opts.emptyRepo, maxTreeBodyBytes: opts.maxTreeBodyBytes });
  const runExport = await loadRunExport();
  const run = (now: Date = NOW) =>
    runExport({
      db: handle.db,
      now: () => now,
      github: { token: TOKEN, repo: REPO, branch: BRANCH, apiUrl: API, fetch: git.fetch },
    });
  return { db: handle.db, git, run };
}

describe("runExport: files", () => {
  it("commits exactly the expected files with canonical content", async () => {
    const { db, git, run } = await setup();
    const { apps, cons } = await expectedRecords(db);
    const result = await run();

    const files = git.headFiles();
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
    expect(result.files).toBe(6);
    for (const a of apps) expect(files[`applications/${a.id}.json`]).toBe(fileText(a));
    for (const c of cons) expect(files[`contacts/${c.id}.json`]).toBe(fileText(c));
    expect(files[`jd/${APP_ZETA}.md`]).toBe(JD_TEXT);
    expect(files["exported_at.txt"].trim()).toBe(EXPORTED_AT);
  });

  it("application files carry events and contact_ids, never contacts objects; extras are flattened", async () => {
    const { db, git, run } = await setup();
    await run();
    const zeta = JSON.parse(git.headFiles()[`applications/${APP_ZETA}.json`]) as Record<string, unknown>;
    expect("contacts" in zeta).toBe(false);
    expect("extra" in zeta).toBe(false);
    expect(zeta.contact_ids).toEqual([CONTACT_BOB, CONTACT_JANE]);
    expect(zeta.custom_flag).toBe("yes");
    expect((zeta.events as { id: string }[]).map((e) => e.id)).toEqual([
      "00000000-0000-4000-8000-0000000000b2",
      "00000000-0000-4000-8000-0000000000a1",
    ]);
    const [storedZeta] = await db.select().from(applications).where(eq(applications.id, APP_ZETA));
    const tail = ["jd_snapshot", ...Object.keys(storedZeta.extra), "contact_ids", "events"];
    expect(Object.keys(zeta).slice(-tail.length)).toEqual(tail);
    // 2-space indentation and a trailing newline
    const text = git.headFiles()[`applications/${APP_ZETA}.json`];
    expect(text.startsWith('{\n  "id": "zeta-co--staff-engineer--2026-10-01",\n  "company": "Zeta Co",\n')).toBe(true);
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("writes jd/<id>.md only for records with a non-null jd_snapshot", async () => {
    const { git, run } = await setup();
    await run();
    const jdFiles = Object.keys(git.headFiles()).filter((p) => p.startsWith("jd/"));
    expect(jdFiles).toEqual([`jd/${APP_ZETA}.md`]);
  });

  it("an empty database still commits exported_at.txt alone", async () => {
    const { git, run } = await setup({ seed: false });
    const result = await run();
    expect(result.committed).toBe(true);
    expect(result.files).toBe(1);
    expect(Object.keys(git.headFiles())).toEqual(["exported_at.txt"]);
  });
});

describe("runExport: Git Data API flow", () => {
  it("makes the five calls in order, all to the given apiUrl and repo, all carrying the token", async () => {
    const { git, run } = await setup();
    const parent = git.headSha();
    await run();
    expect(git.callSequence()).toEqual([
      `GET /repos/${REPO}/git/ref/heads/${BRANCH}`,
      `GET /repos/${REPO}/git/commits/${parent}`,
      `POST /repos/${REPO}/git/trees`,
      `POST /repos/${REPO}/git/commits`,
      `PATCH /repos/${REPO}/git/refs/heads/${BRANCH}`,
    ]);
    for (const c of git.calls) {
      expect(c.url.startsWith(`${API}/repos/${REPO}/git/`)).toBe(true);
      expect(c.headers["authorization"]).toMatch(new RegExp(`^(Bearer|token) ${TOKEN}$`));
    }
  });

  it("creates the tree with inline content and no base_tree", async () => {
    const { git, run } = await setup();
    await run();
    const treeCall = git.calls.find((c) => c.endpoint === "POST trees");
    const body = treeCall?.body as { tree: Record<string, unknown>[] } & Record<string, unknown>;
    expect("base_tree" in body).toBe(false);
    expect(body.tree.map((e) => e.path).sort()).toEqual(Object.keys(git.headFiles()).sort());
    for (const e of body.tree) {
      expect(e.mode).toBe("100644");
      expect(e.type).toBe("blob");
      expect(typeof e.content).toBe("string");
    }
  });

  it("commits 'Export <exported_at>' on top of the current head, moves the ref, returns the sha", async () => {
    const { git, run } = await setup();
    const parent = git.headSha();
    const result = await run();
    expect(git.createdCommits).toHaveLength(1);
    const commit = git.createdCommits[0];
    expect(commit.message).toBe(`Export ${EXPORTED_AT}`);
    expect(commit.parents).toEqual([parent]);
    expect(git.refUpdates).toEqual([commit.sha]);
    expect(git.headSha()).toBe(commit.sha);
    expect(result).toEqual({ committed: true, commitSha: commit.sha, files: 6 });
    const patch = git.calls.find((c) => c.endpoint === "PATCH ref");
    expect(patch?.body?.sha).toBe(commit.sha);
    expect(patch?.body?.force).not.toBe(true);
    expect(git.createdBlobs).toHaveLength(0);
  });
});

describe("runExport: unchanged and deleted data", () => {
  it("a second run with identical data makes no commit and no ref update", async () => {
    const { git, run } = await setup();
    const first = await run();
    const headAfterFirst = git.headSha();
    const callsAfterFirst = git.calls.length;
    const second = await run();
    expect(second.committed).toBe(false);
    expect(second.commitSha).toBeUndefined();
    expect(second.files).toBe(first.files);
    expect(git.createdCommits).toHaveLength(1);
    expect(git.refUpdates).toHaveLength(1);
    expect(git.headSha()).toBe(headAfterFirst);
    const secondCalls = git.calls.slice(callsAfterFirst).map((c) => c.endpoint);
    expect(secondCalls).not.toContain("POST commits");
    expect(secondCalls).not.toContain("PATCH ref");
  });

  it("changed data commits again with the previous commit as parent", async () => {
    const { db, git, run } = await setup();
    await run();
    const firstHead = git.headSha();
    await db.update(applications).set({ notes: "changed" }).where(eq(applications.id, APP_ALPHA));
    const second = await run();
    expect(second.committed).toBe(true);
    expect(git.createdCommits).toHaveLength(2);
    expect(git.createdCommits[1].parents).toEqual([firstHead]);
    expect(JSON.parse(git.headFiles()[`applications/${APP_ALPHA}.json`]).notes).toBe("changed");
  });

  it("a record deleted since the last export disappears from the new tree", async () => {
    const { db, git, run } = await setup();
    await run();
    expect(Object.keys(git.headFiles())).toContain(`applications/${APP_ZETA}.json`);
    expect(Object.keys(git.headFiles())).toContain(`jd/${APP_ZETA}.md`);
    await deleteApplication(db, APP_ZETA);
    const second = await run(new Date("2026-10-09T03:00:00.000Z"));
    expect(second.committed).toBe(true);
    expect(Object.keys(git.headFiles()).sort()).toEqual(
      [
        `applications/${APP_ALPHA}.json`,
        `contacts/${CONTACT_BOB}.json`,
        `contacts/${CONTACT_JANE}.json`,
        "exported_at.txt",
      ].sort(),
    );
    expect(second.files).toBe(4);
    expect(git.headFiles()["exported_at.txt"].trim()).toBe("2026-10-09T03:00:00.000Z");
    const treeCalls = git.calls.filter((c) => c.endpoint === "POST trees");
    expect(treeCalls).toHaveLength(2);
    expect("base_tree" in (treeCalls[1].body ?? {})).toBe(false);
  });
});

describe("runExport: errors", () => {
  it("throws a clear error naming the repo or branch when the branch ref is missing (empty repo)", async () => {
    const { git, run } = await setup({ missingBranch: true });
    const err = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message.includes(BRANCH) || message.includes(REPO)).toBe(true);
    expect(message).not.toContain(TOKEN);
    expect(message).toMatch(/token/i);
    expect(git.callSequence()).toEqual([`GET /repos/${REPO}/git/ref/heads/${BRANCH}`]);
    expect(git.createdCommits).toHaveLength(0);
  });

  const endpoints: [Endpoint, number][] = [
    ["GET ref", 500],
    ["GET ref", 401],
    ["GET commit", 403],
    ["POST trees", 422],
    ["POST commits", 500],
    ["PATCH ref", 409],
  ];
  it.each(endpoints)("%s answering %i makes runExport throw without leaking the token", async (endpoint, status) => {
    const { git, run } = await setup();
    git.fail(endpoint, status);
    const err = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.length).toBeGreaterThan(0);
    expect((err as Error).message).not.toContain(TOKEN);
    expect(String((err as Error).stack ?? "")).not.toContain(TOKEN);
    if (endpoint !== "PATCH ref") expect(git.refUpdates).toHaveLength(0);
    expect(git.headSha()).toBe(git.initialCommitSha);
  });

  it("a network failure rejects instead of resolving", async () => {
    const { db } = await setup();
    const runExport = await loadRunExport();
    const failing: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(
      runExport({ db, now: () => NOW, github: { token: TOKEN, repo: REPO, branch: BRANCH, apiUrl: API, fetch: failing } }),
    ).rejects.toThrow();
  });
});

describe("runExport: more errors and redaction", () => {
  it("a network error whose message contains the token is redacted and keeps the cause code", async () => {
    const { db } = await setup();
    const runExport = await loadRunExport();
    const failing: typeof fetch = async () => {
      throw new Error(`proxy said: Authorization: Bearer ${TOKEN}`, { cause: { code: "ECONNREFUSED" } });
    };
    const err = await runExport({
      db,
      now: () => NOW,
      github: { token: TOKEN, repo: REPO, branch: BRANCH, apiUrl: API, fetch: failing },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).toContain("ECONNREFUSED");
  });

  it("an empty repo (GET ref answers 409) throws naming repo and branch and the initial commit", async () => {
    const { git, run } = await setup({ emptyRepo: true });
    const err = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain(BRANCH);
    expect(message).toContain(REPO);
    expect(message).toMatch(/initial commit/i);
    expect(message).not.toContain(TOKEN);
    expect(git.callSequence()).toEqual([`GET /repos/${REPO}/git/ref/heads/${BRANCH}`]);
  });

  it("an id that is not [a-z0-9-]+ throws and writes nothing", async () => {
    const { db, git, run } = await setup();
    await db.insert(applications).values({
      id: "../evil",
      company: "Evil",
      role_title: "Path",
      work_arrangement: "remote",
      status: "watching",
      discovered_at: "2026-10-01",
      created_at: new Date("2026-10-01T00:00:00.000Z"),
      updated_at: new Date("2026-10-01T00:00:00.000Z"),
      updated_by: "tracker-app",
    });
    await expect(run()).rejects.toThrow();
    const writes = git.calls.map((c) => c.endpoint).filter((e) => e !== "GET ref" && e !== "GET commit");
    expect(writes).toEqual([]);
    expect(git.headSha()).toBe(git.initialCommitSha);
  });
});

describe("runExport: jd snapshots that are empty", () => {
  it("empty or whitespace-only jd_snapshot writes no jd file", async () => {
    const { db, git, run } = await setup();
    await db.update(applications).set({ jd_snapshot: "" }).where(eq(applications.id, APP_ALPHA));
    await db.update(applications).set({ jd_snapshot: " \n\t " }).where(eq(applications.id, APP_ZETA));
    const result = await run();
    expect(result.committed).toBe(true);
    expect(Object.keys(git.headFiles()).sort()).toEqual(
      [
        `applications/${APP_ALPHA}.json`,
        `applications/${APP_ZETA}.json`,
        `contacts/${CONTACT_BOB}.json`,
        `contacts/${CONTACT_JANE}.json`,
        "exported_at.txt",
      ].sort(),
    );
    expect(result.files).toBe(5);
  });
});

describe("runExport: large exports", () => {
  const BIG = "line of job description\n".repeat(105_000); // 2.5 MB, and it appears twice in the inline body (jd file plus the record), so about 5.2 MB

  it("above 5,000,000 bytes of inline tree body, every file goes through POST /git/blobs and the tree uses sha", async () => {
    const { db, git, run } = await setup({ maxTreeBodyBytes: 5_000_000 });
    await db.update(applications).set({ jd_snapshot: BIG }).where(eq(applications.id, APP_ZETA));
    const parent = git.headSha();
    const result = await run();

    expect(result.committed).toBe(true);
    expect(result.files).toBe(6);
    const files = git.headFiles();
    expect(files[`jd/${APP_ZETA}.md`]).toBe(BIG);
    expect(Object.keys(files)).toHaveLength(6);

    expect(git.createdBlobs).toHaveLength(6);
    expect(git.createdBlobs.map((b) => b.content).sort()).toEqual(Object.values(files).sort());
    for (const b of git.createdBlobs) expect(b.encoding).toBe("utf-8");
    for (const c of git.calls.filter((c) => c.endpoint === "POST blobs")) {
      expect(Object.keys(c.body ?? {}).sort()).toEqual(["content", "encoding"]);
    }

    const treeCall = git.calls.find((c) => c.endpoint === "POST trees");
    const entries = (treeCall?.body as { tree: Record<string, unknown>[] }).tree;
    expect(treeCall?.bodyBytes).toBeLessThan(100_000);
    const shaByPath = new Map(entries.map((e) => [e.path as string, e.sha]));
    for (const e of entries) {
      expect(e.mode).toBe("100644");
      expect(e.type).toBe("blob");
      expect("content" in e).toBe(false);
      expect(typeof e.sha).toBe("string");
    }
    expect([...shaByPath.keys()].sort()).toEqual(Object.keys(files).sort());
    expect(git.createdBlobs.map((b) => b.sha).sort()).toEqual([...shaByPath.values()].sort());

    // all blobs exist before the tree is created, and the commit still lands
    const order = git.calls.map((c) => c.endpoint);
    expect(order.lastIndexOf("POST blobs")).toBeLessThan(order.indexOf("POST trees"));
    expect(order.slice(order.indexOf("POST trees"))).toEqual(["POST trees", "POST commits", "PATCH ref"]);
    expect(git.createdCommits).toHaveLength(1);
    expect(git.createdCommits[0].parents).toEqual([parent]);
    expect(git.refUpdates).toEqual([result.commitSha]);
    expect(git.headSha()).toBe(result.commitSha);
  });

  it("a second identical large run makes no commit", async () => {
    const { db, git, run } = await setup({ maxTreeBodyBytes: 5_000_000 });
    await db.update(applications).set({ jd_snapshot: BIG }).where(eq(applications.id, APP_ZETA));
    const first = await run();
    expect(first.committed).toBe(true);
    const second = await run();
    expect(second.committed).toBe(false);
    expect(second.files).toBe(6);
    expect(git.createdCommits).toHaveLength(1);
    expect(git.refUpdates).toHaveLength(1);
  });
});
