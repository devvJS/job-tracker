import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PATH = new URL("../../AGENTS.md", import.meta.url);
const text = (): string => readFileSync(PATH, "utf8");

describe("AGENTS.md (source spec 6.7)", () => {
  it("exists at the repo root and is not empty", () => {
    expect(text().trim().length).toBeGreaterThan(200);
  });

  it("gives the base URL", () => {
    expect(text()).toContain("https://devvjs.dev/job-tracker/api");
  });

  it("says to authenticate with Authorization: Bearer using TRACKER_AGENT_KEY", () => {
    expect(text()).toMatch(/Authorization:\s*Bearer/);
    expect(text()).toContain("TRACKER_AGENT_KEY");
  });

  it("says to read openapi.yaml", () => {
    expect(text()).toMatch(/read[^\n]*openapi\.yaml/i);
  });

  it("says to check GET applications?q= before creating", () => {
    expect(text()).toMatch(/GET\s+\/?applications\?q=/);
    expect(text()).toMatch(/before\s+(creating|you create|create)/i);
  });

  it("prefers POST .../events for updates", () => {
    expect(text()).toMatch(/POST\s+\/?applications\/(\{id\}|:id|<id>)\/events/);
    expect(text()).toMatch(/prefer[^\n]*events/i);
  });

  it("says to include project_thread_url when logging from a thread", () => {
    expect(text()).toMatch(/project_thread_url/);
    expect(text()).toMatch(/thread/i);
  });

  it("explains If-Match on PATCH and the 412, 409 and 428 responses", () => {
    const t = text();
    expect(t).toMatch(/If-Match/);
    expect(t).toMatch(/PATCH/);
    for (const code of ["412", "409", "428"]) expect(t).toContain(code);
  });

  it("says the agent has no hard delete", () => {
    expect(text()).toMatch(/(no|not|never|cannot|can't)[^\n]*(hard[- ]delete|delete)/i);
  });

  it("states the rate limit as 60 requests per minute", () => {
    expect(text()).toMatch(/\b60\s+requests?\s+per\s+minute/i);
  });

  it("says moving to applied sets applied_at only when it is empty, and does not say it is never set", () => {
    const t = text();
    expect(t).toMatch(/applied[^\n]{0,80}applied_at[^.\n]{0,80}\b(if|when|only)\b[^.\n]*\b(empty|unset|not set|null)\b/i);
    expect(t).not.toMatch(/never\s+(touch|set|fill)\w*\s+`?applied_at/i);
    expect(t).not.toMatch(/overwrit(es|e|ing)\s+`?applied_at/i);
  });

  it("says POST events answers { event, record } and the next If-Match is record.updated_at", () => {
    const t = text();
    expect(t).toMatch(/\{\s*"?event"?\s*,\s*"?record"?\s*\}/);
    expect(t).toMatch(/`?record\.updated_at`?/);
  });

  it("says closed_reason is set with PATCH /applications/{id}, in the same paragraph", () => {
    const paragraphs = text().split(/\n\s*\n/);
    const hits = paragraphs.filter((p) => /closed_reason/.test(p) && /PATCH\s+`?\/?applications\/(\{id\}|:id|<id>)/.test(p));
    expect(hits.length).toBeGreaterThan(0);
  });
});
