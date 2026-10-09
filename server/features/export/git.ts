// A minimal GitHub Git Data API client for the export (spec D, Export).
// Every request goes through the given fetch. Errors name the step and the HTTP
// status only: GitHub's response body is never copied into a message, and the
// token is redacted from anything else that is.
import { redact as redactSecret } from "./util.ts";

export type GitHubTarget = { token: string; repo: string; branch: string; apiUrl: string; fetch: typeof fetch };

/** A tree entry with inline content, or one that points at a blob created first. */
export type TreeEntry =
  | { path: string; mode: "100644"; type: "blob"; content: string }
  | { path: string; mode: "100644"; type: "blob"; sha: string };

export class GitHubError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Encodes each segment of a slash-separated name, keeping the slashes. */
const encodeSegments = (s: string) => s.split("/").map(encodeURIComponent).join("/");

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function shaAt(v: unknown, ...path: string[]): string | undefined {
  let cur: unknown = v;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return typeof cur === "string" && cur !== "" ? cur : undefined;
}

/** The error's message plus its cause's code (e.g. ECONNREFUSED), when there is one. */
function networkReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? err.cause : undefined;
  const code = isRecord(cause) && typeof cause.code === "string" ? cause.code : undefined;
  return code ? `${message}; cause ${code}` : message;
}

export function createGitClient(target: GitHubTarget) {
  if (!REPO_PATTERN.test(target.repo)) throw new GitHubError(`Invalid repo "${target.repo}": expected "owner/name"`);
  if (target.branch === "") throw new GitHubError("The export branch must not be empty");
  if (target.token === "") throw new GitHubError("The GitHub token must not be empty");

  const base = `${target.apiUrl.replace(/\/+$/, "")}/repos/${encodeSegments(target.repo)}/git`;
  const branchPath = encodeSegments(target.branch);
  const redact = (s: string) => redactSecret(s, target.token);

  async function request(step: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${target.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "job-tracker-export",
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await target.fetch(`${base}${path}`, init);
    } catch (err) {
      throw new GitHubError(`GitHub ${step} failed: network error (${redact(networkReason(err))})`);
    }

    // Read the body either way so the connection is released; on failure it is discarded.
    const text = await res.text().catch(() => "");
    if (!res.ok) return { status: res.status, data: undefined };
    try {
      return { status: res.status, data: text === "" ? undefined : (JSON.parse(text) as unknown) };
    } catch {
      throw new GitHubError(`GitHub ${step} failed: the response was not JSON`, res.status);
    }
  }

  const fail = (step: string, status: number) => new GitHubError(`GitHub ${step} failed: HTTP ${status}`, status);
  const malformed = (step: string) => new GitHubError(`GitHub ${step} failed: unexpected response shape`);

  return {
    /** The commit sha the branch points at. A missing branch (404) gets its own message (spec A.12). */
    async getBranchHead(): Promise<string> {
      const step = `get ref heads/${target.branch} in ${target.repo}`;
      const { status, data } = await request(step, "GET", `/ref/heads/${branchPath}`);
      // 404: no such branch, or the token can't see the repo. 409: GitHub's answer for an empty repo.
      if (status === 404 || status === 409) {
        throw new GitHubError(
          `Branch "${target.branch}" was not found in repo "${target.repo}" (HTTP ${status}). ` +
            "The repo needs an initial commit on that branch (e.g. a README), or the token cannot see the repo.",
          status,
        );
      }
      if (status < 200 || status >= 300) throw fail(step, status);
      const sha = shaAt(data, "object", "sha");
      if (!sha) throw malformed(step);
      return sha;
    },

    /** The tree sha of a commit. */
    async getCommitTree(commitSha: string): Promise<string> {
      const step = `get commit ${commitSha}`;
      const { status, data } = await request(step, "GET", `/commits/${encodeURIComponent(commitSha)}`);
      if (status < 200 || status >= 300) throw fail(step, status);
      const sha = shaAt(data, "tree", "sha");
      if (!sha) throw malformed(step);
      return sha;
    },

    /** Creates a blob from UTF-8 text and returns its sha. */
    async createBlob(content: string): Promise<string> {
      const step = "create blob";
      const { status, data } = await request(step, "POST", "/blobs", { content, encoding: "utf-8" });
      if (status < 200 || status >= 300) throw fail(step, status);
      const sha = shaAt(data, "sha");
      if (!sha) throw malformed(step);
      return sha;
    },

    /** Creates a whole tree with no base_tree, so files absent here are deleted. */
    async createTree(entries: TreeEntry[]): Promise<string> {
      const step = "create tree";
      const { status, data } = await request(step, "POST", "/trees", { tree: entries });
      if (status < 200 || status >= 300) throw fail(step, status);
      const sha = shaAt(data, "sha");
      if (!sha) throw malformed(step);
      return sha;
    },

    async createCommit(message: string, treeSha: string, parents: string[]): Promise<string> {
      const step = "create commit";
      const { status, data } = await request(step, "POST", "/commits", { message, tree: treeSha, parents });
      if (status < 200 || status >= 300) throw fail(step, status);
      const sha = shaAt(data, "sha");
      if (!sha) throw malformed(step);
      return sha;
    },

    /** Moves the branch to the commit. Not forced: a concurrent push makes GitHub refuse it. */
    async updateBranch(commitSha: string): Promise<void> {
      const step = `update ref heads/${target.branch}`;
      const { status } = await request(step, "PATCH", `/refs/heads/${branchPath}`, { sha: commitSha, force: false });
      if (status < 200 || status >= 300) throw fail(step, status);
    },
  };
}
