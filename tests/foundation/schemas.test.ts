import { describe, expect, it } from "vitest";
import {
  ACTORS,
  CLOSED_REASONS,
  COMPANY_STAGES,
  COMP_SOURCES,
  EVENT_TYPES,
  MOVE_TIMING,
  POSTING_STATUSES,
  PRIORITIES,
  REFERRALS,
  RELATIONSHIPS,
  SOURCES,
  STATUSES,
  TERMINAL_STATUSES,
  TRACKS,
  WORK_ARRANGEMENTS,
  applicationCreateSchema,
  applicationPatchSchema,
  contactCreateSchema,
  contactPatchSchema,
  eventCreateSchema,
  fitSchema,
  materialsSchema,
} from "../../shared/schemas.ts";

const base = { company: "Acme", role_title: "Engineer", work_arrangement: "remote", status: "watching" };

function failedPaths(r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }): string[] {
  return r.success ? [] : r.error!.issues.map((i) => i.path.map(String).join("."));
}

describe("enum constants", () => {
  it("STATUSES are in pipeline order, terminal last", () => {
    expect([...STATUSES]).toEqual([
      "watching", "shortlisted", "preparing", "applied", "screen", "interviewing", "offer", "accepted",
      "rejected", "withdrawn", "closed",
    ]);
    expect([...TERMINAL_STATUSES]).toEqual(["rejected", "withdrawn", "closed"]);
  });

  it("other enums hold the source-spec values", () => {
    expect([...WORK_ARRANGEMENTS]).toEqual(["remote", "hybrid", "onsite"]);
    expect([...POSTING_STATUSES].sort()).toEqual(["live", "removed", "unverified"]);
    expect([...MOVE_TIMING].sort()).toEqual(["no", "unknown", "yes"]);
    expect([...COMP_SOURCES].sort()).toEqual(["estimate", "posting", "recruiter"]);
    expect([...TRACKS].sort()).toEqual(["ai-engineer", "devex-platform", "other", "senior-frontend", "senior-fullstack"]);
    expect([...SOURCES].sort()).toEqual([
      "builtin", "community", "company-site", "linkedin", "other", "recruiter-inbound", "referral",
    ]);
    expect([...REFERRALS].sort()).toEqual(["asked", "none", "submitted"]);
    expect([...PRIORITIES].sort()).toEqual(["high", "low", "medium"]);
    expect([...ACTORS].sort()).toEqual(["claude-project", "dakota", "tracker-app"]);
    expect([...EVENT_TYPES].sort()).toEqual([
      "applied", "call", "discovered", "email", "interview", "materials-drafted", "note", "offer",
      "rejected", "scored", "status-change", "take-home", "withdrew",
    ]);
  });
});

describe("applicationCreateSchema", () => {
  it("accepts the four required fields", () => {
    const r = applicationCreateSchema.safeParse(base);
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject(base);
  });

  it.each(["company", "role_title", "work_arrangement", "status"])("rejects a missing %s", (field) => {
    const input: Record<string, unknown> = { ...base };
    delete input[field];
    const r = applicationCreateSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(failedPaths(r)).toEqual([field]);
  });

  it("rejects a wrong-typed company", () => {
    const r = applicationCreateSchema.safeParse({ ...base, company: 42 });
    expect(failedPaths(r)).toEqual(["company"]);
  });

  it.each([
    ["status", "bogus"],
    ["work_arrangement", "moon"],
    ["track", "wizard"],
    ["priority", "urgent"],
    ["source", "billboard"],
    ["posting_status", "gone"],
  ])("rejects %s = %s", (field, value) => {
    const r = applicationCreateSchema.safeParse({ ...base, [field]: value });
    expect(failedPaths(r)).toEqual([field]);
  });

  it("accepts a valid enum value for track", () => {
    expect(applicationCreateSchema.safeParse({ ...base, track: "ai-engineer" }).success).toBe(true);
  });

  it("accepts a real calendar date and rejects an impossible one", () => {
    expect(applicationCreateSchema.safeParse({ ...base, discovered_at: "2026-10-07" }).success).toBe(true);
    expect(applicationCreateSchema.safeParse({ ...base, discovered_at: "2028-02-29" }).success).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "2026-10-7", "10/07/2026", "2026-10-07T00:00:00Z", "2027-02-29"]) {
      const r = applicationCreateSchema.safeParse({ ...base, discovered_at: bad });
      expect(failedPaths(r), bad).toEqual(["discovered_at"]);
    }
  });

  it("validates every date field", () => {
    for (const f of ["next_action_due", "follow_up_date", "applied_at", "closed_at", "posting_verified_at"]) {
      expect(failedPaths(applicationCreateSchema.safeParse({ ...base, [f]: "2026-02-30" })), f).toEqual([f]);
      expect(applicationCreateSchema.safeParse({ ...base, [f]: "2026-10-07" }).success, f).toBe(true);
    }
  });

  it("requires integer comp values", () => {
    expect(applicationCreateSchema.safeParse({ ...base, comp_min: 150000, comp_max: 180000 }).success).toBe(true);
    expect(failedPaths(applicationCreateSchema.safeParse({ ...base, comp_min: 150000.5 }))).toEqual(["comp_min"]);
    expect(failedPaths(applicationCreateSchema.safeParse({ ...base, comp_max: "180000" }))).toEqual(["comp_max"]);
  });

  it("accepts absolute http(s) URLs only", () => {
    expect(applicationCreateSchema.safeParse({ ...base, posting_url: "https://example.com/jobs/1" }).success).toBe(true);
    expect(applicationCreateSchema.safeParse({ ...base, posting_url: "http://example.com/jobs/1" }).success).toBe(true);
    for (const bad of ["not a url", "/relative/path", "ftp://example.com/x", "javascript:alert(1)"]) {
      expect(failedPaths(applicationCreateSchema.safeParse({ ...base, posting_url: bad })), bad).toEqual(["posting_url"]);
    }
  });

  it("accepts null for optional fields", () => {
    const r = applicationCreateSchema.safeParse({ ...base, posting_url: null, location: null, comp_min: null, fit: null });
    expect(r.success).toBe(true);
  });

  it("reports nested fit errors with a dotted path", () => {
    const r = applicationCreateSchema.safeParse({ ...base, fit: { total: 101 } });
    expect(failedPaths(r)).toEqual(["fit.total"]);
  });

  it("mission_interest is a free string array", () => {
    const r = applicationCreateSchema.safeParse({ ...base, mission_interest: ["art", "something-new"] });
    expect(r.success).toBe(true);
    expect(r.data?.mission_interest).toEqual(["art", "something-new"]);
    expect(applicationCreateSchema.safeParse({ ...base, mission_interest: "art" }).success).toBe(false);
  });
});

describe("fitSchema", () => {
  it("accepts integers 0 and 100 on every score", () => {
    for (const k of ["skills", "experience", "industry", "growth", "total"]) {
      expect(fitSchema.safeParse({ [k]: 0 }).success, `${k}=0`).toBe(true);
      expect(fitSchema.safeParse({ [k]: 100 }).success, `${k}=100`).toBe(true);
    }
  });

  it.each([-1, 101, 50.5, "50", null, Number.NaN])("rejects total = %s", (v) => {
    expect(fitSchema.safeParse({ total: v }).success).toBe(false);
  });

  it("keeps unknown keys", () => {
    const input = {
      total: 82,
      weights: { skills: 0.35, experience: 0.3, industry: 0.15, growth: 0.2 },
      biggest_risk: "8+ yrs",
      gaps: ["GCP"],
      scored_at: "2026-10-07",
      custom_score: 7,
    };
    const r = fitSchema.safeParse(input);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(input);
  });

  it("keeps unknown keys when nested in a create body", () => {
    const r = applicationCreateSchema.safeParse({ ...base, fit: { total: 80, custom_score: 7 } });
    expect(r.data?.fit).toEqual({ total: 80, custom_score: 7 });
  });
});

describe("materialsSchema", () => {
  it("keeps unknown keys alongside known ones", () => {
    const input = {
      resume: "https://drive.example/r",
      portfolio_links: ["https://devvjs.dev"],
      checklist: [{ item: "proofread", done: true }],
      linkedin_message: "hello",
    };
    const r = materialsSchema.safeParse(input);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(input);
  });

  it("rejects a wrong-typed known key", () => {
    expect(materialsSchema.safeParse({ resume: 5 }).success).toBe(false);
  });
});

describe("applicationPatchSchema", () => {
  it("accepts a partial body and an empty body", () => {
    expect(applicationPatchSchema.safeParse({ notes: "hello" }).success).toBe(true);
    expect(applicationPatchSchema.safeParse({}).success).toBe(true);
  });

  it("accepts null to clear an optional field", () => {
    const r = applicationPatchSchema.safeParse({ notes: null, next_action_due: null });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ notes: null, next_action_due: null });
  });

  it("rejects nulling a required field", () => {
    for (const f of ["company", "role_title", "work_arrangement", "status"]) {
      expect(failedPaths(applicationPatchSchema.safeParse({ [f]: null })), f).toEqual([f]);
    }
  });

  it("rejects a bad enum and a bad date", () => {
    expect(failedPaths(applicationPatchSchema.safeParse({ status: "bogus" }))).toEqual(["status"]);
    expect(failedPaths(applicationPatchSchema.safeParse({ applied_at: "2026-02-30" }))).toEqual(["applied_at"]);
  });
});

describe("eventCreateSchema", () => {
  it("accepts a type alone", () => {
    expect(eventCreateSchema.safeParse({ type: "note" }).success).toBe(true);
  });

  it("accepts the optional fields", () => {
    const body = {
      type: "email",
      note: "sent follow-up",
      at: "2026-10-07T14:03:22.123Z",
      status: "applied",
      next_action: "wait",
      next_action_due: "2026-10-14",
    };
    const r = eventCreateSchema.safeParse(body);
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject(body);
  });

  it("rejects type status-change (server-only)", () => {
    const r = eventCreateSchema.safeParse({ type: "status-change" });
    expect(r.success).toBe(false);
    expect(failedPaths(r)).toEqual(["type"]);
  });

  it("rejects a missing or unknown type", () => {
    expect(failedPaths(eventCreateSchema.safeParse({}))).toEqual(["type"]);
    expect(failedPaths(eventCreateSchema.safeParse({ type: "bogus" }))).toEqual(["type"]);
  });

  it("rejects a bad status, at, and next_action_due", () => {
    expect(failedPaths(eventCreateSchema.safeParse({ type: "note", status: "bogus" }))).toEqual(["status"]);
    expect(failedPaths(eventCreateSchema.safeParse({ type: "note", at: "yesterday" }))).toEqual(["at"]);
    expect(failedPaths(eventCreateSchema.safeParse({ type: "note", next_action_due: "2026-02-30" }))).toEqual([
      "next_action_due",
    ]);
  });
});

describe("contactCreateSchema", () => {
  it("requires name", () => {
    expect(contactCreateSchema.safeParse({ name: "Jane Doe" }).success).toBe(true);
    expect(failedPaths(contactCreateSchema.safeParse({}))).toEqual(["name"]);
  });

  it("validates relationship against RELATIONSHIPS", () => {
    expect(contactCreateSchema.safeParse({ name: "Jane", relationship: RELATIONSHIPS[0] }).success).toBe(true);
    expect(failedPaths(contactCreateSchema.safeParse({ name: "Jane", relationship: "nemesis-of-doom" }))).toEqual([
      "relationship",
    ]);
  });
});

describe("gap coverage", () => {
  it("COMPANY_STAGES and CLOSED_REASONS hold the source-spec values", () => {
    expect([...COMPANY_STAGES].sort()).toEqual(["consultancy", "enterprise", "public-product", "scaleup", "startup"]);
    expect([...CLOSED_REASONS].sort()).toEqual([
      "accepted", "declined-offer", "no-response", "posting-removed", "rejected", "withdrew",
    ]);
  });

  it("validates company_stage and closed_reason", () => {
    for (const v of COMPANY_STAGES) {
      expect(applicationCreateSchema.safeParse({ ...base, company_stage: v }).success, v).toBe(true);
    }
    for (const v of CLOSED_REASONS) {
      expect(applicationCreateSchema.safeParse({ ...base, closed_reason: v }).success, v).toBe(true);
    }
    expect(failedPaths(applicationCreateSchema.safeParse({ ...base, company_stage: "megacorp" }))).toEqual(["company_stage"]);
    expect(failedPaths(applicationCreateSchema.safeParse({ ...base, closed_reason: "ghosted" }))).toEqual(["closed_reason"]);
  });

  it("contactPatchSchema: {} ok, name null rejected, company null ok", () => {
    expect(contactPatchSchema.safeParse({}).success).toBe(true);
    const r = contactPatchSchema.safeParse({ name: null });
    expect(r.success).toBe(false);
    expect(failedPaths(r)).toEqual(["name"]);
    const ok = contactPatchSchema.safeParse({ company: null });
    expect(ok.success).toBe(true);
    expect(ok.data).toMatchObject({ company: null });
  });

  it("applies the century leap rule", () => {
    expect(applicationCreateSchema.safeParse({ ...base, discovered_at: "2000-02-29" }).success).toBe(true);
    expect(failedPaths(applicationCreateSchema.safeParse({ ...base, discovered_at: "2100-02-29" }))).toEqual(["discovered_at"]);
  });
});
