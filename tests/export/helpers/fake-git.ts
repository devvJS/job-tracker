// An in-memory GitHub repo that implements the Git Data API endpoints runExport uses, and records calls.
import { createHash } from "node:crypto";

export type Endpoint = "GET ref" | "GET commit" | "POST trees" | "POST commits" | "PATCH ref" | "POST blobs";

export type GitCall = {
  endpoint: Endpoint;
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  /** Parsed JSON body, or undefined when there was none. */
  body: Record<string, unknown> | undefined;
  /** Size in bytes of the raw request body (0 when none). */
  bodyBytes: number;
};

type StoredCommit = { sha: string; tree: string; parents: string[]; message: string };

export type FakeGitOptions = {
  apiUrl: string;
  repo: string; // "owner/name"
  branch: string;
  token: string;
  /** Files of the initial commit (A.12: the repo already has one commit). */
  initialFiles?: Record<string, string>;
  /** When true the branch does not exist (an empty repo): GET ref answers 404. */
  missingBranch?: boolean;
  /** When true the repo has no commit at all: like real GitHub, GET ref answers 409 "Git Repository is empty.". */
  emptyRepo?: boolean;
  /** POST trees with a body larger than this many bytes answers 422 (GitHub documents 7 MB for inline content). */
  maxTreeBodyBytes?: number;
};

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/** Deterministic tree sha: a function of the sorted (path, content) pairs only. */
export function treeSha(files: Record<string, string>): string {
  const entries = Object.keys(files)
    .sort()
    .map((p) => [p, sha1(files[p])]);
  return sha1(JSON.stringify(entries));
}

/** Git's blob sha: content addressed. */
export const blobSha = (content: string) =>
  createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");

export function createFakeGit(opts: FakeGitOptions) {
  const calls: GitCall[] = [];
  const trees = new Map<string, Record<string, string>>();
  const commits = new Map<string, StoredCommit>();
  /** Every commit created through POST /git/commits, in order. */
  const createdCommits: StoredCommit[] = [];
  /** Every sha the ref was moved to through PATCH, in order. */
  const refUpdates: string[] = [];
  const blobs = new Map<string, string>();
  /** Every blob created through POST /git/blobs, in order. */
  const createdBlobs: { content: string; encoding: unknown; sha: string }[] = [];
  const maxTreeBody = opts.maxTreeBodyBytes ?? 7_000_000;
  const failures = new Map<Endpoint, number>();

  const initial = opts.initialFiles ?? { "README.md": "# job-tracker-data\n" };
  const initialTree = treeSha(initial);
  trees.set(initialTree, initial);
  const initialCommit: StoredCommit = {
    sha: sha1(`initial:${initialTree}`),
    tree: initialTree,
    parents: [],
    message: "Initial commit",
  };
  commits.set(initialCommit.sha, initialCommit);
  let head: string | null = opts.missingBranch || opts.emptyRepo ? null : initialCommit.sha;

  const base = opts.apiUrl.replace(/\/+$/, "");
  const prefix = `/repos/${opts.repo}/git`;
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

  const fakeFetch: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : undefined;
    const url = req ? req.url : String(input instanceof URL ? input.href : input);
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(req?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    let rawBody: string | undefined;
    if (typeof init?.body === "string") rawBody = init.body;
    else if (req && method !== "GET") rawBody = await req.clone().text();
    const bodyBytes = rawBody ? Buffer.byteLength(rawBody) : 0;
    let body: Record<string, unknown> | undefined;
    if (rawBody) body = JSON.parse(rawBody) as Record<string, unknown>;

    if (!url.startsWith(`${base}/`)) throw new Error(`fake git: request outside ${base}: ${method} ${url}`);
    const path = new URL(url).pathname;
    const rel = url.slice(base.length).split("?")[0];

    let endpoint: Endpoint | undefined;
    let sub = "";
    if (method === "GET" && rel === `${prefix}/ref/heads/${opts.branch}`) endpoint = "GET ref";
    else if (method === "GET" && rel.startsWith(`${prefix}/commits/`)) {
      endpoint = "GET commit";
      sub = rel.slice(`${prefix}/commits/`.length);
    } else if (method === "POST" && rel === `${prefix}/trees`) endpoint = "POST trees";
    else if (method === "POST" && rel === `${prefix}/blobs`) endpoint = "POST blobs";
    else if (method === "POST" && rel === `${prefix}/commits`) endpoint = "POST commits";
    else if (method === "PATCH" && rel === `${prefix}/refs/heads/${opts.branch}`) endpoint = "PATCH ref";
    if (!endpoint) throw new Error(`fake git: unexpected ${method} ${url}`);
    calls.push({ endpoint, method, url, path, headers, body, bodyBytes });

    const auth = headers["authorization"] ?? "";
    if (!auth.includes(opts.token)) return json({ message: "Bad credentials" }, 401);
    if (method !== "GET" && !(headers["content-type"] ?? "").includes("application/json")) {
      return json({ message: "Content-Type must be application/json" }, 415);
    }

    const failStatus = failures.get(endpoint);
    if (failStatus !== undefined) {
      // The error body echoes the Authorization header, so an implementation that copies it leaks the token.
      return json({ message: `injected failure; credentials were ${auth}`, documentation_url: "x" }, failStatus);
    }

    if (endpoint === "GET ref") {
      if (opts.emptyRepo) return json({ message: "Git Repository is empty.", status: "409" }, 409);
      if (head === null) return json({ message: "Not Found" }, 404);
      return json({ ref: `refs/heads/${opts.branch}`, object: { sha: head, type: "commit" } });
    }
    if (endpoint === "GET commit") {
      const c = commits.get(sub);
      if (!c) return json({ message: "Not Found" }, 404);
      return json({
        sha: c.sha,
        message: c.message,
        tree: { sha: c.tree },
        parents: c.parents.map((p) => ({ sha: p })),
      });
    }
    if (endpoint === "POST blobs") {
      if (typeof body?.content !== "string" || body.encoding !== "utf-8") {
        return json({ message: 'blob needs string content and encoding "utf-8"' }, 422);
      }
      const sha = blobSha(body.content);
      blobs.set(sha, body.content);
      createdBlobs.push({ content: body.content, encoding: body.encoding, sha });
      return json({ sha, url: `${base}${prefix}/blobs/${sha}` }, 201);
    }
    if (endpoint === "POST trees") {
      if (bodyBytes > maxTreeBody) return json({ message: "tree body too large" }, 422);
      if (body && "base_tree" in body) return json({ message: "base_tree is not allowed by this fake" }, 422);
      const entries = body?.tree;
      if (!Array.isArray(entries)) return json({ message: "tree must be an array" }, 422);
      const files: Record<string, string> = {};
      for (const e of entries as Record<string, unknown>[]) {
        if (typeof e.path !== "string") return json({ message: "each entry needs a string path" }, 422);
        if (e.mode !== "100644" || e.type !== "blob") {
          return json({ message: 'each entry needs mode "100644" and type "blob"' }, 422);
        }
        const hasContent = "content" in e;
        const hasSha = "sha" in e;
        if (hasContent === hasSha) return json({ message: "each entry needs exactly one of content and sha" }, 422);
        let content: string;
        if (hasContent) {
          if (typeof e.content !== "string" || e.content === "") {
            return json({ message: "inline content must be a non-empty string" }, 422);
          }
          content = e.content;
        } else {
          const known = typeof e.sha === "string" ? blobs.get(e.sha) : undefined;
          if (known === undefined) return json({ message: `unknown blob ${String(e.sha)}` }, 422);
          content = known;
        }
        if (e.path in files) return json({ message: `duplicate path ${e.path}` }, 422);
        files[e.path] = content;
      }
      const sha = treeSha(files);
      trees.set(sha, files);
      return json({ sha, tree: Object.keys(files).sort().map((p) => ({ path: p })) }, 201);
    }
    if (endpoint === "POST commits") {
      const tree = body?.tree;
      const parents = body?.parents;
      const message = body?.message;
      if (typeof tree !== "string" || !trees.has(tree)) return json({ message: "unknown tree" }, 422);
      if (!Array.isArray(parents) || typeof message !== "string") return json({ message: "bad commit" }, 422);
      const c: StoredCommit = {
        sha: sha1(JSON.stringify({ tree, parents, message })),
        tree,
        parents: parents as string[],
        message,
      };
      commits.set(c.sha, c);
      createdCommits.push(c);
      return json({ sha: c.sha, tree: { sha: tree }, message }, 201);
    }
    // PATCH ref
    const sha = body?.sha;
    if (typeof sha !== "string" || !commits.has(sha)) return json({ message: "unknown commit" }, 422);
    head = sha;
    refUpdates.push(sha);
    return json({ ref: `refs/heads/${opts.branch}`, object: { sha, type: "commit" } });
  };

  return {
    fetch: fakeFetch,
    calls,
    createdCommits,
    createdBlobs,
    refUpdates,
    initialCommitSha: initialCommit.sha,
    /** Make an endpoint answer with this HTTP status (the body echoes the Authorization header). */
    fail(endpoint: Endpoint, status: number) {
      failures.set(endpoint, status);
    },
    headSha: () => head,
    headCommit: () => (head ? commits.get(head) : undefined),
    /** Files of the tree the branch head points at. */
    headFiles(): Record<string, string> {
      const c = head ? commits.get(head) : undefined;
      return c ? (trees.get(c.tree) ?? {}) : {};
    },
    callSequence: () => calls.map((c) => `${c.method} ${c.path}`),
  };
}

export type FakeGit = ReturnType<typeof createFakeGit>;
