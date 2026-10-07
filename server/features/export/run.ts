// runExport (spec D, Export): writes the dump to the data repo as one commit
// through the Git Data API, or makes no commit when the tree is unchanged.
import type { Db } from "../../db.ts";
import { buildExport, type ExportDump } from "./build.ts";
import { createGitClient, type GitHubTarget, type TreeEntry } from "./git.ts";
import { compareCodeUnits } from "./util.ts";

export type RunExportOptions = { db: Db; now: () => Date; github: GitHubTarget };
export type RunExportResult = { committed: boolean; commitSha?: string; files: number };

/** Above this many bytes of inline tree request body, files go up as blobs first (spec D, amended). */
export const MAX_INLINE_TREE_BODY_BYTES = 5_000_000;

const SAFE_ID = /^[a-z0-9-]+$/;

const jsonFile = (x: unknown) => JSON.stringify(x, null, 2) + "\n";

/** Ids become file names; anything outside [a-z0-9-] could escape its folder, so it stops the export. */
function safeId(kind: string, id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`export: ${kind} id ${JSON.stringify(id)} is not [a-z0-9-]+; nothing was written`);
  return id;
}

/**
 * The data repo's files: applications/<id>.json, contacts/<id>.json,
 * jd/<id>.md for each jd_snapshot that is not null, empty or only whitespace
 * (spec A.3), and exported_at.txt. Sorted by path so the tree request is
 * deterministic. Throws on an unsafe id before anything is sent.
 */
export function exportFiles(dump: ExportDump): Map<string, string> {
  const files = new Map<string, string>();
  for (const app of dump.applications) {
    const id = safeId("application", app.id);
    files.set(`applications/${id}.json`, jsonFile(app));
    const jd = app.jd_snapshot;
    if (typeof jd === "string" && jd.trim() !== "") files.set(`jd/${id}.md`, jd);
  }
  for (const contact of dump.contacts) {
    files.set(`contacts/${safeId("contact", contact.id)}.json`, jsonFile(contact));
  }
  files.set("exported_at.txt", `${dump.exported_at}\n`);
  return new Map([...files].sort(([a], [b]) => compareCodeUnits(a, b)));
}

export async function runExport(opts: RunExportOptions): Promise<RunExportResult> {
  const git = createGitClient(opts.github);
  const dump = await buildExport(opts.db, opts.now);
  const files = exportFiles(dump);

  const head = await git.getBranchHead();
  const currentTree = await git.getCommitTree(head);

  let entries: TreeEntry[] = [...files].map(([path, content]) => ({ path, mode: "100644", type: "blob", content }));
  if (Buffer.byteLength(JSON.stringify({ tree: entries })) > MAX_INLINE_TREE_BODY_BYTES) {
    // Too large for one inline request: upload every file as a blob, then reference the shas.
    // Sequential on purpose; GitHub discourages concurrent content-creating requests.
    const withSha: TreeEntry[] = [];
    for (const [path, content] of files) {
      withSha.push({ path, mode: "100644", type: "blob", sha: await git.createBlob(content) });
    }
    entries = withSha;
  }

  const tree = await git.createTree(entries);
  if (tree === currentTree) return { committed: false, files: files.size };

  const commitSha = await git.createCommit(`Export ${dump.exported_at}`, tree, [head]);
  await git.updateBranch(commitSha);
  return { committed: true, commitSha, files: files.size };
}
