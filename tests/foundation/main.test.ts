import { spawn } from "node:child_process";
import { createServer, type AddressInfo, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

let blocker: Server | undefined;

afterEach(async () => {
  const b = blocker;
  blocker = undefined;
  if (b) await new Promise<void>((resolve) => b.close(() => resolve()));
});

function occupyPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      blocker = srv;
      resolve((srv.address() as AddressInfo).port);
    });
  });
}

function runMain(port: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    const child = spawn(process.execPath, ["server/main.ts"], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        PORT: String(port),
        DATABASE_URL: "pglite://memory",
        PUBLIC_URL: `http://localhost:${port}`,
        SESSION_SECRET: "s".repeat(32),
        TRACKER_AGENT_KEY: "k".repeat(32),
        GITHUB_CLIENT_ID: "dummy-id",
        GITHUB_CLIENT_SECRET: "dummy-secret",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, 15_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

describe("server/main.ts when the port is in use", () => {
  it("exits non-zero with a one-line message naming the port and PORT, and no stack trace", async () => {
    const port = await occupyPort();
    const r = await runMain(port);

    expect(r.timedOut).toBe(false);
    expect(r.code).not.toBe(0);
    expect(r.code).not.toBeNull();
    expect(r.stderr).toContain(String(port));
    expect(r.stderr).toContain("PORT");
    expect(r.stderr).not.toMatch(/^\s+at /m);
    expect(r.stderr).not.toContain("node:events");
    expect(r.stderr).not.toContain("Emitted 'error' event");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
  }, 30_000);
});
