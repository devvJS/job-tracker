// Seed records (source spec §8, spec A.1, slices S5 frozen facts). They are written through the
// applications service as `tracker-app`, so they get the same validation, meets_floor and
// `discovered` event as any other create. Idempotent: a 409 (the record already exists) is skipped.
//
// Run directly: `node db/seed.ts` (npm run seed). It reads DATABASE_URL and TRACKER_TIMEZONE
// (default America/Detroit), applies migrations, seeds, and prints one line.
import { ApplicationError, createApplication, type ServiceDeps } from "../server/features/applications/service.ts";
import { createDb, migrate, type Db } from "../server/db.ts";
import { applicationId } from "../server/records.ts";

const FORD_AI_URL = "https://www.careers.ford.com/job/dearborn/ai-engineer-agentic-ai-solutions/48560/99130196528";
const FORD_SR_URL = "https://www.careers.ford.com/job/dearborn/sr-software-engineer-ai-specialist/48560/95859749568";

/** The six seed inputs, in seed order. Fields not listed are null. */
export const SEED_APPLICATIONS: ReadonlyArray<Record<string, unknown>> = [
  {
    company: "Gynger",
    role_title: "Senior Software Engineer (Remote)",
    work_arrangement: "remote",
    status: "applied",
    source: "linkedin",
    referral: "none",
    discovered_at: "2026-09-15",
    applied_at: "2026-09-15",
    notes: "Found on LinkedIn, Sept 2026. No connection or referral. Discovered and applied dates are approximate.",
  },
  {
    company: "Pinterest",
    role_title: "Software Engineer II, Fullstack",
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
  {
    company: "Ford",
    role_title: "AI Engineer, Agentic AI Solutions",
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
  {
    company: "Ford",
    role_title: "Sr. Software Engineer, AI Specialist",
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
  {
    company: "Rocket Companies",
    role_title: "Senior Software Engineer, Agentic AI Applications",
    work_arrangement: "onsite",
    location: "Detroit, MI",
    detroit_metro: true,
    status: "watching",
    posting_status: "removed",
    fit: { gaps: ["C#", "Python depth"] },
    notes: "Posting removed 2026-08-11; the role family gets reposted.",
    discovered_at: "2026-10-07",
  },
  {
    company: "Credit Acceptance",
    role_title: "Staff/Senior Staff, Enterprise AI Enablement",
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
];

/**
 * Creates each seed application as `tracker-app`, in order. A 409 means the record already
 * exists, so it is skipped (listed by the seed input's id). Any other error is thrown.
 */
export async function seed(db: Db, deps: ServiceDeps): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const input of SEED_APPLICATIONS) {
    try {
      const record = await createApplication(db, deps, "tracker-app", { ...input });
      created.push(record.id);
    } catch (err) {
      if (!(err instanceof ApplicationError) || err.status !== 409) throw err;
      skipped.push(applicationId(String(input.company), String(input.role_title), String(input.discovered_at)));
    }
  }
  return { created, skipped };
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const value = (name: string) => {
    const v = process.env[name];
    return v === undefined || v === "" ? undefined : v;
  };
  const databaseUrl = value("DATABASE_URL");
  const timezone = value("TRACKER_TIMEZONE") ?? "America/Detroit";
  const problems: string[] = [];
  if (!databaseUrl) problems.push("DATABASE_URL is required");
  if (!validTimezone(timezone)) problems.push("TRACKER_TIMEZONE must be an IANA time zone");
  if (problems.length > 0 || !databaseUrl) {
    console.error(`seed: ${problems.join("; ")}`);
    process.exitCode = 1;
    return;
  }

  let close: (() => Promise<void>) | undefined;
  try {
    const handle = await createDb(databaseUrl);
    close = handle.close;
    await migrate(handle.db);
    const result = await seed(handle.db, { config: { timezone }, now: () => new Date() });
    console.log(`seed: created ${result.created.length}, skipped ${result.skipped.length} (already present)`);
  } catch (err) {
    const details = err instanceof ApplicationError && err.details ? ` ${JSON.stringify(err.details)}` : "";
    console.error(`seed failed: ${err instanceof Error ? err.message : String(err)}${details}`);
    process.exitCode = 1;
  } finally {
    if (close) {
      await close().catch((err: unknown) => {
        console.error(`seed: closing the database failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      });
    }
  }
}

if (import.meta.main) await main();
