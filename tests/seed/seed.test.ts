import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { applications } from "../../db/schema.ts";
import { createDb } from "../../server/db.ts";
import { createApplication } from "../../server/features/applications/service.ts";
import { applicationId } from "../../server/records.ts";
import { buildTestApp } from "../helpers/app.ts";
import { agentHeaders } from "../helpers/auth.ts";
import { loadSeed, SEED_PATH } from "./seed-module.ts";

const run = promisify(execFile);
const BASE = "/job-tracker/api";

type Built = Awaited<ReturnType<typeof buildTestApp>>;
let built: Built | undefined;
let tmp: string | undefined;
afterEach(async () => {
  await built?.close();
  built = undefined;
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const FORD_AI_URL = "https://www.careers.ford.com/job/dearborn/ai-engineer-agentic-ai-solutions/48560/99130196528";
const FORD_SR_URL = "https://www.careers.ford.com/job/dearborn/sr-software-engineer-ai-specialist/48560/95859749568";

type Expected = { company: string; role: string; discovered: string; fields: Record<string, unknown>; floor: boolean | null };

// The frozen seed facts (.swarm/slices.md S5), in seed order.
const EXPECTED: Expected[] = [
  {
    company: "Gynger",
    role: "Senior Software Engineer (Remote)",
    discovered: "2026-09-15",
    floor: null,
    fields: {
      work_arrangement: "remote",
      status: "applied",
      source: "linkedin",
      referral: "none",
      discovered_at: "2026-09-15",
      applied_at: "2026-09-15",
      notes: "Found on LinkedIn, Sept 2026. No connection or referral. Discovered and applied dates are approximate.",
    },
  },
  {
    company: "Pinterest",
    role: "Software Engineer II, Fullstack",
    discovered: "2026-09-15",
    floor: null,
    fields: {
      work_arrangement: "remote",
      remote_scope: "US remote",
      onsite_requirement: "1–2 in-office visits every 6 months",
      status: "applied",
      source: "linkedin",
      referral: "none",
      discovered_at: "2026-09-15",
      applied_at: "2026-09-15",
      notes:
        "Found on LinkedIn, Sept 2026. No connection. 1–2 in-office visits every 6 months is acceptable. Discovered and applied dates are approximate.",
    },
  },
  {
    company: "Ford",
    role: "AI Engineer, Agentic AI Solutions",
    discovered: "2026-10-07",
    floor: true,
    fields: {
      work_arrangement: "hybrid",
      location: "Dearborn, MI",
      detroit_metro: true,
      onsite_requirement: "4+ days/week",
      status: "watching",
      posting_status: "live",
      posting_verified_at: "2026-10-07",
      posting_url: FORD_AI_URL,
      comp_min: 85400,
      comp_max: 192900,
      comp_source: "posting",
      fit: { gaps: ["GCP/Vertex AI"] },
      discovered_at: "2026-10-07",
    },
  },
  {
    company: "Ford",
    role: "Sr. Software Engineer, AI Specialist",
    discovered: "2026-10-07",
    floor: null,
    fields: {
      work_arrangement: "hybrid",
      location: "Dearborn, MI",
      detroit_metro: true,
      status: "watching",
      posting_status: "live",
      posting_verified_at: "2026-10-07",
      posting_url: FORD_SR_URL,
      fit: { gaps: ["8+ yrs required"] },
      notes: "8+ yrs required (stretch).",
      discovered_at: "2026-10-07",
    },
  },
  {
    company: "Rocket Companies",
    role: "Senior Software Engineer, Agentic AI Applications",
    discovered: "2026-10-07",
    floor: null,
    fields: {
      work_arrangement: "onsite",
      location: "Detroit, MI",
      detroit_metro: true,
      status: "watching",
      posting_status: "removed",
      fit: { gaps: ["C#", "Python depth"] },
      notes: "Posting removed 2026-08-11; the role family gets reposted.",
      discovered_at: "2026-10-07",
    },
  },
  {
    company: "Credit Acceptance",
    role: "Staff/Senior Staff, Enterprise AI Enablement",
    discovered: "2026-10-07",
    floor: true,
    fields: {
      work_arrangement: "remote",
      status: "watching",
      posting_status: "removed",
      comp_min: 155000,
      comp_max: 268000,
      comp_source: "posting",
      fit: { gaps: ["8+ yrs required"] },
      notes: "Posting removed 2026-08-17. 8+ yrs required (stretch). Watch for senior full-stack roles.",
      discovered_at: "2026-10-07",
    },
  },
];

const EXPECTED_IDS = EXPECTED.map((e) => applicationId(e.company, e.role, e.discovered));
const deps = (b: Built) => ({ config: b.config, now: b.now });

async function getApp(b: Built, id: string): Promise<Record<string, unknown>> {
  const res = await b.app.request(`${BASE}/applications/${id}`, { headers: agentHeaders() });
  expect(res.status, `GET ${id}`).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("SEED_APPLICATIONS", () => {
  it("has the six seed inputs", async () => {
    const mod = await loadSeed();
    expect(mod.SEED_APPLICATIONS).toHaveLength(6);
    expect(mod.SEED_APPLICATIONS.map((a) => [a.company, a.role_title])).toEqual(EXPECTED.map((e) => [e.company, e.role]));
  });
});

describe("seed(db, deps)", () => {
  it("creates the six records on a fresh database and skips none", async () => {
    const mod = await loadSeed();
    built = await buildTestApp();
    const result = await mod.seed(built.db, deps(built));
    expect(EXPECTED_IDS).toHaveLength(6);
    expect(result).toEqual({ created: EXPECTED_IDS, skipped: [] });
    expect(await built.db.select().from(applications)).toHaveLength(6);
  });

  it("is idempotent: a second run creates nothing and skips all six", async () => {
    const mod = await loadSeed();
    built = await buildTestApp();
    await mod.seed(built.db, deps(built));
    const second = await mod.seed(built.db, deps(built));
    expect(second).toEqual({ created: [], skipped: EXPECTED_IDS });
    expect(await built.db.select().from(applications)).toHaveLength(6);
  });

  it("stores the frozen field values, every other field null, as tracker-app", async () => {
    const mod = await loadSeed();
    built = await buildTestApp();
    await mod.seed(built.db, deps(built));
    const exempt = new Set([
      "id", "created_at", "updated_at", "updated_by", "meets_floor", "events", "contacts", "contact_ids", "jd_snapshot",
    ]);
    for (const [i, e] of EXPECTED.entries()) {
      const rec = await getApp(built, EXPECTED_IDS[i]);
      expect(rec, e.role).toMatchObject({ ...e.fields, company: e.company, role_title: e.role, updated_by: "tracker-app" });
      const unlisted = Object.entries(rec).filter(([k]) => !exempt.has(k) && !(k in e.fields) && k !== "company" && k !== "role_title");
      expect(unlisted.filter(([, v]) => v !== null), `${e.role}: unlisted fields must be null`).toEqual([]);
    }
  });

  it("records a single discovered event by tracker-app on each", async () => {
    const mod = await loadSeed();
    built = await buildTestApp();
    await mod.seed(built.db, deps(built));
    for (const id of EXPECTED_IDS) {
      const rec = await getApp(built, id);
      const events = rec.events as Array<Record<string, unknown>>;
      expect(events, id).toHaveLength(1);
      expect(events[0]).toMatchObject({ application_id: id, type: "discovered", by: "tracker-app" });
    }
  });

  it("computes meets_floor: true for Ford AI and Credit Acceptance, null for the rest", async () => {
    const mod = await loadSeed();
    built = await buildTestApp();
    await mod.seed(built.db, deps(built));
    const floors: unknown[] = [];
    for (const id of EXPECTED_IDS) floors.push((await getApp(built, id)).meets_floor);
    expect(floors).toEqual(EXPECTED.map((e) => e.floor));
  });

  it("keeps applied_at 2026-09-15 for Gynger and Pinterest, not the automatic date", async () => {
    const mod = await loadSeed();
    // The clock is 2026-10-07, so an automatic applied_at would be that day.
    built = await buildTestApp();
    await mod.seed(built.db, deps(built));
    for (const id of EXPECTED_IDS.slice(0, 2)) {
      const rec = await getApp(built, id);
      expect(rec.applied_at).toBe("2026-09-15");
      expect(rec.discovered_at).toBe("2026-09-15");
    }
    for (const id of EXPECTED_IDS.slice(2)) expect((await getApp(built, id)).applied_at).toBeNull();
  });
});

describe("seed(db, deps) posting_url collision", () => {
  it("skips a seed item whose posting_url is held by another record and lists its own id", async () => {
    const mod = await loadSeed();
    built = await buildTestApp();
    // A different company, role and discovered date give a different id, but the URL is Ford AI's.
    const holder = await createApplication(built.db, deps(built), "dakota", {
      company: "Other Co",
      role_title: "Holder",
      work_arrangement: "remote",
      status: "watching",
      posting_url: FORD_AI_URL,
      discovered_at: "2026-09-01",
    });
    expect(holder.id).not.toBe(EXPECTED_IDS[2]);
    const result = await mod.seed(built.db, deps(built));
    expect(result).toEqual({
      created: EXPECTED_IDS.filter((_, i) => i !== 2),
      skipped: [EXPECTED_IDS[2]],
    });
    expect(await built.db.select().from(applications)).toHaveLength(6);
  });
});

describe("node db/seed.ts", () => {
  it("seeds a pglite directory, twice, exiting 0 both times, leaving 6 rows", async () => {
    expect(SEED_PATH.pathname.endsWith("/db/seed.ts")).toBe(true);
    tmp = await mkdtemp(join(tmpdir(), "seed-"));
    const url = `pglite://${join(tmp, "data")}`;
    const env = { PATH: process.env.PATH ?? "", DATABASE_URL: url, TRACKER_TIMEZONE: "America/Detroit" };
    const script = fileURLToPath(SEED_PATH);
    const exec = () => run(process.execPath, [script], { env, timeout: 90_000 });
    const first = await exec();
    expect(first.stdout.trim().split("\n")).toHaveLength(1);
    const second = await exec();
    expect(second.stdout.trim().split("\n")).toHaveLength(1);
    const { db, close } = await createDb(url);
    try {
      expect(await db.select().from(applications)).toHaveLength(6);
    } finally {
      await close();
    }
  }, 180_000);
});
