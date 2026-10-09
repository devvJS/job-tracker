import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { AGENT_KEY } from "./support/env.ts";

const HOME = "/job-tracker/";
const pathOf = (page: { url(): string }) => new URL(page.url()).pathname;

async function signInViaUi(page: Page) {
  await page.goto(HOME);
  await page.getByTestId("signin").click();
  await expect.poll(() => pathOf(page)).toBe(HOME);
  await expect(page.getByTestId("user-login")).toBeVisible();
}

const unique = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const detroitToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Detroit", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(),
  );
const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const agent = { Authorization: `Bearer ${AGENT_KEY}`, "Content-Type": "application/json" };

type Rec = { id: string };
type DueItem = { id: string; overdue: boolean };
type Summary = {
  applied: number;
  responses: number;
  interviews: number;
  by_status: Record<string, number>;
  by_source: { source: string }[];
};

async function apiCreate(request: APIRequestContext, body: Record<string, unknown>) {
  const res = await request.post("/job-tracker/api/applications", {
    headers: agent,
    data: { role_title: "Staff Engineer", work_arrangement: "remote", status: "watching", ...body },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as Rec;
}

async function apiDue(request: APIRequestContext, date: string) {
  const res = await request.get(`/job-tracker/api/due?date=${date}`, { headers: agent });
  expect(res.status()).toBe(200);
  return (await res.json()) as { date: string; items: DueItem[] };
}

async function apiSummary(request: APIRequestContext) {
  const res = await request.get("/job-tracker/api/summary", { headers: agent });
  expect(res.status()).toBe(200);
  return (await res.json()) as Summary;
}

const fail500 = (page: Page, path: string, marker: string) =>
  page.route(
    (url) => url.pathname === path,
    (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "internal", message: marker } }),
      }),
  );

const item = (page: Page, id: string) => page.locator(`[data-testid="due-item"][data-id="${id}"]`);
const exactNumber = (n: number) => new RegExp(`^\\s*${n}\\s*$`);

test("due page: overdue, due-today, future and rejected items", async ({ page, request }) => {
  await signInViaUi(page);
  const today = detroitToday();
  const overdue = await apiCreate(request, { company: unique("Overdue"), next_action_due: addDays(today, -1) });
  const dueToday = await apiCreate(request, { company: unique("Today"), next_action_due: today });
  const tomorrow = await apiCreate(request, { company: unique("Tomorrow"), next_action_due: addDays(today, 1) });
  const rejected = await apiCreate(request, {
    company: unique("Rejected"),
    status: "rejected",
    next_action_due: addDays(today, -1),
  });

  await page.getByTestId("nav-due").click();
  await expect.poll(() => pathOf(page)).toBe("/job-tracker/due");
  await expect(page.getByTestId("due-list")).toBeVisible();
  await expect(item(page, overdue.id)).toHaveCount(1);
  await expect(item(page, overdue.id)).toHaveAttribute("data-overdue", "true");
  await expect(item(page, dueToday.id)).toHaveCount(1);
  await expect(item(page, dueToday.id)).toHaveAttribute("data-overdue", "false");
  await expect(item(page, tomorrow.id)).toHaveCount(0);
  await expect(item(page, rejected.id)).toHaveCount(0);
  await expect(page.getByTestId("due-empty")).toHaveCount(0);
});

test("due page: changing due-date shows later items, and a date with nothing due shows due-empty", async ({ page, request }) => {
  await signInViaUi(page);
  const today = detroitToday();
  const tomorrow = await apiCreate(request, { company: unique("Later"), next_action_due: addDays(today, 1) });
  await page.goto("/job-tracker/due");
  await expect(page.getByTestId("due-list")).toBeVisible();
  await expect(item(page, tomorrow.id)).toHaveCount(0);

  await page.getByTestId("due-date").fill(addDays(today, 1));
  await expect(item(page, tomorrow.id)).toHaveCount(1);
  await expect(item(page, tomorrow.id)).toHaveAttribute("data-overdue", "false");

  await page.getByTestId("due-date").fill("2000-01-01");
  await expect(page.getByTestId("due-empty")).toBeVisible();
  await expect(page.getByTestId("due-item")).toHaveCount(0);
  await expect(page.getByTestId("error-banner")).toHaveCount(0);
});

test("due page: item order matches the API order", async ({ page, request }) => {
  await signInViaUi(page);
  const today = detroitToday();
  await apiCreate(request, { company: unique("Ordc"), next_action_due: today });
  await apiCreate(request, { company: unique("Ordb"), next_action_due: addDays(today, -3) });
  await apiCreate(request, { company: unique("Orda"), next_action_due: addDays(today, -3) });
  await apiCreate(request, { company: unique("Ordd"), next_action_due: addDays(today, -1) });
  await apiCreate(request, { company: unique("Orde"), status: "applied", follow_up_date: addDays(today, -2) });

  await page.goto("/job-tracker/due");
  const items = page.getByTestId("due-item");
  await expect(items.first()).toBeVisible();
  const expected = (await apiDue(request, today)).items.map((i) => i.id);
  expect(expected.length).toBeGreaterThanOrEqual(5);
  await expect(items).toHaveCount(expected.length);
  const ids = await items.evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
  expect(ids).toEqual(expected);
});

test("due page: a 500 from the API shows error-banner and not due-empty", async ({ page }) => {
  await signInViaUi(page);
  await fail500(page, "/job-tracker/api/due", "due-failure-marker");
  await page.goto("/job-tracker/due");
  await expect(page.getByTestId("error-banner")).toBeVisible();
  await expect(page.getByTestId("error-banner")).toContainText("due-failure-marker");
  await expect(page.getByTestId("due-empty")).toHaveCount(0);
  await expect(page.getByTestId("due-item")).toHaveCount(0);
});

test("summary page: counts and source rows match the API", async ({ page, request }) => {
  await signInViaUi(page);
  const today = detroitToday();
  await apiCreate(request, { company: unique("Sumco"), status: "applied", applied_at: today, source: "linkedin" });
  await page.getByTestId("nav-summary").click();
  await expect.poll(() => pathOf(page)).toBe("/job-tracker/summary");
  await expect(page.getByTestId("summary")).toBeVisible();
  await expect(page.getByTestId("summary-source-row").first()).toBeVisible();

  const summary = await apiSummary(request);
  expect(summary.by_source.length).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("summary-applied")).toHaveText(exactNumber(summary.applied));
  await expect(page.getByTestId("summary-responses")).toHaveText(exactNumber(summary.responses));
  await expect(page.getByTestId("summary-interviews")).toHaveText(exactNumber(summary.interviews));
  const rows = page.getByTestId("summary-source-row");
  await expect(rows).toHaveCount(summary.by_source.length);
  const sources = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-source")));
  expect(sources).toEqual(summary.by_source.map((s) => s.source));
});

test("summary page: a new applied application increments applied and adds a referral row", async ({ page, request }) => {
  await signInViaUi(page);
  await page.goto("/job-tracker/summary");
  await expect(page.getByTestId("summary")).toBeVisible();
  const before = (await apiSummary(request)).applied;
  await expect(page.getByTestId("summary-applied")).toHaveText(exactNumber(before));

  await apiCreate(request, { company: unique("Refco"), status: "applied", applied_at: detroitToday(), source: "referral" });
  await page.reload();
  await expect(page.getByTestId("summary-applied")).toHaveText(exactNumber(before + 1));
  await expect(page.locator('[data-testid="summary-source-row"][data-source="referral"]')).toHaveCount(1);
});

test("summary page: a 500 from the API shows error-banner", async ({ page }) => {
  await signInViaUi(page);
  await fail500(page, "/job-tracker/api/summary", "summary-failure-marker");
  await page.goto("/job-tracker/summary");
  await expect(page.getByTestId("error-banner")).toBeVisible();
  await expect(page.getByTestId("error-banner")).toContainText("summary-failure-marker");
  await expect(page.getByTestId("summary-applied")).toHaveCount(0);
});

async function apiEvent(request: APIRequestContext, id: string, body: Record<string, unknown>) {
  const res = await request.post(`/job-tracker/api/applications/${id}/events`, { headers: agent, data: body });
  expect(res.status(), await res.text()).toBeLessThan(300);
}

test("due page: a slow default-date response never overwrites a newer chosen date", async ({ page, request }) => {
  await signInViaUi(page);
  const seeded = await apiCreate(request, { company: unique("Racer"), next_action_due: detroitToday() });
  await page.route(
    (url) => url.pathname === "/job-tracker/api/due" && !url.searchParams.has("date"),
    async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue().catch(() => undefined);
    },
  );
  await page.goto("/job-tracker/due");
  await page.getByTestId("due-date").fill("2000-01-01");
  await expect(page.getByTestId("due-empty")).toBeVisible();
  await page.waitForTimeout(3500);
  await expect(page.getByTestId("due-empty")).toBeVisible();
  await expect(page.getByTestId("due-item")).toHaveCount(0);
  await expect(page.getByTestId("due-date")).toHaveValue("2000-01-01");
  await expect(item(page, seeded.id)).toHaveCount(0);
});

test("summary page: responses and interviews are rendered in their own slots", async ({ page, request }) => {
  await signInViaUi(page);
  const rec = await apiCreate(request, {
    company: unique("Slotco"),
    status: "applied",
    applied_at: detroitToday(),
    source: "linkedin",
  });
  await apiEvent(request, rec.id, { type: "note", status: "screen" });
  for (let i = 0; i < 3; i++) await apiEvent(request, rec.id, { type: "interview", note: `round ${i}` });
  // make the three counts pairwise distinct whatever else is in the shared database
  for (let i = 0; i < 12; i++) {
    const s = await apiSummary(request);
    if (new Set([s.applied, s.responses, s.interviews]).size === 3) break;
    await apiEvent(request, rec.id, { type: "interview", note: `extra ${i}` });
  }
  await page.goto("/job-tracker/summary");
  await expect(page.getByTestId("summary")).toBeVisible();
  const s = await apiSummary(request);
  expect(new Set([s.applied, s.responses, s.interviews]).size).toBe(3);
  expect(s.responses).toBeGreaterThanOrEqual(1);
  expect(s.interviews).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("summary-applied")).toHaveText(exactNumber(s.applied));
  await expect(page.getByTestId("summary-responses")).toHaveText(exactNumber(s.responses));
  await expect(page.getByTestId("summary-interviews")).toHaveText(exactNumber(s.interviews));
});

test("due page: the row links to the application detail page", async ({ page, request }) => {
  await signInViaUi(page);
  const rec = await apiCreate(request, { company: unique("Linkco"), next_action_due: addDays(detroitToday(), -1) });
  await page.goto("/job-tracker/due");
  const row = item(page, rec.id);
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("href", `/job-tracker/applications/${rec.id}`);
  await row.click();
  await expect(page.getByTestId("app-detail")).toHaveAttribute("data-id", rec.id);
  expect(pathOf(page)).toBe(`/job-tracker/applications/${rec.id}`);
});

test("due page: clearing the date input goes back to today with no date param", async ({ page, request }) => {
  await signInViaUi(page);
  const seeded = await apiCreate(request, { company: unique("Clearer"), next_action_due: detroitToday() });
  await page.goto("/job-tracker/due");
  await expect(page.getByTestId("due-list")).toBeVisible();
  await page.getByTestId("due-date").fill("2000-01-01");
  await expect(page.getByTestId("due-empty")).toBeVisible();
  const requested = page.waitForRequest(
    (r) => new URL(r.url()).pathname === "/job-tracker/api/due" && !new URL(r.url()).searchParams.has("date"),
  );
  await page.getByTestId("due-date").fill("");
  await requested;
  await expect(page.getByTestId("due-date")).toHaveValue(detroitToday());
  await expect(page.getByTestId("due-list")).toBeVisible();
  await expect(item(page, seeded.id)).toHaveCount(1);
  await expect(page.getByTestId("due-empty")).toHaveCount(0);
});

test("summary page: response rate is a percent and every status is listed", async ({ page, request }) => {
  await signInViaUi(page);
  const source = "community";
  const today = detroitToday();
  await apiCreate(request, { company: unique("Ratea"), status: "applied", applied_at: today, source });
  const b = await apiCreate(request, { company: unique("Rateb"), status: "applied", applied_at: today, source });
  await apiEvent(request, b.id, { type: "note", status: "screen" });
  await page.goto("/job-tracker/summary");
  const row = page.locator(`[data-testid="summary-source-row"][data-source="${source}"]`);
  await expect(row).toHaveCount(1);
  const summary = await apiSummary(request);
  const apiRow = (summary.by_source as { source: string; response_rate: number }[]).find((r) => r.source === source);
  expect(apiRow).toBeDefined();
  expect(apiRow!.response_rate).toBeGreaterThan(0);
  expect(apiRow!.response_rate).toBeLessThanOrEqual(1);
  await expect(row).toContainText(`${Math.round(apiRow!.response_rate * 100)}%`);
  const statuses = Object.keys(summary.by_status);
  expect(statuses).toHaveLength(11);
  for (const status of statuses) await expect(page.getByTestId("summary")).toContainText(status);
});

test("due page: exactly one due item does not show due-empty", async ({ page, request }) => {
  await signInViaUi(page);
  const rec = await apiCreate(request, { company: unique("Solo"), next_action_due: "2001-01-01" });
  await page.goto("/job-tracker/due");
  await page.getByTestId("due-date").fill("2001-01-01");
  await expect(page.getByTestId("due-item")).toHaveCount(1);
  await expect(item(page, rec.id)).toHaveCount(1);
  await expect(page.getByTestId("due-empty")).toHaveCount(0);
});
