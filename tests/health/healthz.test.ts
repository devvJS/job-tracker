import { afterEach, describe, expect, it, vi } from "vitest";
import { settings } from "../../db/schema.ts";
import { buildTestApp } from "../helpers/app.ts";
import { BASE } from "../helpers/auth.ts";

type Built = Awaited<ReturnType<typeof buildTestApp>>;
let built: Built | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await built?.close();
  built = undefined;
});

const PATHS = [`${BASE}/healthz`, "/healthz"];
const STAMP = "2026-10-08T03:00:00.000Z";

describe("healthz reports the last export", () => {
  it.each(PATHS)("%s before any export -> 200 { ok: true, lastExportAt: null } and nothing else", async (path) => {
    built = await buildTestApp();
    const res = await built.app.request(path);
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ ok: true, lastExportAt: null });
  });

  it.each(PATHS)("%s after an export -> lastExportAt is the recorded ISO instant", async (path) => {
    built = await buildTestApp();
    await built.db.insert(settings).values({ key: "last_export_at", value: STAMP });
    const res = await built.app.request(path);
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ ok: true, lastExportAt: STAMP });
  });

  it.each([
    ["a number", 12345],
    ["an object", { at: STAMP }],
    ["an array", [STAMP]],
    ["a boolean", true],
  ])("a stored last_export_at that is %s is reported as null on both paths", async (_label, value) => {
    built = await buildTestApp();
    await built.db.insert(settings).values({ key: "last_export_at", value });
    for (const path of PATHS) {
      const res = await built.app.request(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toStrictEqual({ ok: true, lastExportAt: null });
    }
  });

  it.each(PATHS)("%s stays public (no credentials) and answers with the Cache-Control it has today", async (path) => {
    built = await buildTestApp();
    await built.db.insert(settings).values({ key: "last_export_at", value: STAMP });
    const res = await built.app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBeNull();
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
  });

  it.each(PATHS)("%s with a broken database still fails: 500 error envelope, no ok body", async (path) => {
    built = await buildTestApp();
    await built.db.insert(settings).values({ key: "last_export_at", value: STAMP });
    await built.close(); // the database is gone
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await built.app.request(path);
    built = undefined;
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: { code: expect.any(String), message: "Internal server error" } });
    expect(body).not.toHaveProperty("ok");
    expect(JSON.stringify(body)).not.toContain(STAMP);
  });
});
