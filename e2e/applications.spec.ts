import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { AGENT_KEY } from "./support/env.ts";

const HOME = "/job-tracker/";
const pathOf = (page: { url(): string }) => new URL(page.url()).pathname;

async function signInViaUi(page: Page) {
  await page.goto(HOME);
  await page.getByTestId("signin").click();
  await expect.poll(() => pathOf(page)).toBe(HOME);
  await expect(page.getByTestId("user-login")).toBeVisible();
}

/** Letters and digits only, so the slug is predictable. */
const unique = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const detroitToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Detroit" });
const agent = { Authorization: `Bearer ${AGENT_KEY}`, "Content-Type": "application/json" };

async function apiCreate(request: APIRequestContext, body: Record<string, unknown>) {
  const res = await request.post("/job-tracker/api/applications", { headers: agent, data: body });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function apiGet(request: APIRequestContext, id: string) {
  const res = await request.get(`/job-tracker/api/applications/${id}`, { headers: agent });
  expect(res.status()).toBe(200);
  return (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Fills an input or picks a select option, whichever the control is. */
async function setField(scope: Locator, name: string, value: string) {
  const el = scope.locator(`[name="${name}"]`);
  await expect(el, `field ${name}`).toHaveCount(1);
  const tag = await el.evaluate((n) => n.tagName.toLowerCase());
  if (tag === "select") await el.selectOption(value);
  else await el.fill(value);
}

const newApp = (company: string, extra: Record<string, unknown> = {}) => ({
  company,
  role_title: "Staff Engineer",
  work_arrangement: "remote",
  status: "watching",
  ...extra,
});

test("create through the form: the application appears on the board in its status column", async ({ page, request }) => {
  await signInViaUi(page);
  const company = unique("Formco");
  const role = "Platform Engineer";
  await page.goto("/job-tracker/applications/new");
  const form = page.getByTestId("app-form");
  await expect(form).toBeVisible();
  await setField(form, "company", company);
  await setField(form, "role_title", role);
  await setField(form, "work_arrangement", "hybrid");
  await setField(form, "status", "shortlisted");
  await setField(form, "location", "Ann Arbor, MI");
  await setField(form, "comp_max", "165000");
  await setField(form, "track", "devex-platform");
  await setField(form, "next_action", "Tailor resume");
  await page.getByTestId("app-form-submit").click();

  const id = `${slug(company)}--${slug(role)}--${detroitToday()}`;
  await page.goto(HOME);
  const column = page.getByTestId("board-column-shortlisted");
  const card = column.getByTestId("app-card").and(page.locator(`[data-id="${id}"]`));
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(company);
  // and it is only in that column
  await expect(page.getByTestId("board-column-watching").locator(`[data-id="${id}"]`)).toHaveCount(0);

  const rec = await apiGet(request, id);
  expect(rec).toMatchObject({
    id,
    company,
    role_title: role,
    work_arrangement: "hybrid",
    status: "shortlisted",
    location: "Ann Arbor, MI",
    comp_max: 165000,
    meets_floor: true,
    track: "devex-platform",
    next_action: "Tailor resume",
    updated_by: "dakota",
  });
});

test("an application created by the agent appears on the board after a reload", async ({ page, request }) => {
  await signInViaUi(page);
  await expect(page.getByTestId("board")).toBeVisible();
  const company = unique("Agentco");
  const rec = await apiCreate(request, newApp(company, { status: "preparing" }));
  expect(rec.updated_by).toBe("claude-project");
  await expect(page.locator(`[data-id="${rec.id}"]`)).toHaveCount(0);
  await page.reload();
  const card = page.getByTestId("board-column-preparing").locator(`[data-id="${rec.id}"]`);
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(company);
});

test("detail page: shows the record, logs an event with a status change, and edits a field", async ({ page, request }) => {
  await signInViaUi(page);
  const company = unique("Detailco");
  const rec = await apiCreate(request, newApp(company, { location: "Troy, MI" }));
  await page.goto(`/job-tracker/applications/${rec.id}`);

  const detail = page.getByTestId("app-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute("data-id", rec.id);
  await expect(page.getByTestId("detail-status")).toHaveText(/^\s*watching\s*$/i);
  await expect(page.getByTestId("detail-field-location")).toContainText("Troy, MI");
  await expect(page.getByTestId("detail-field-company")).toContainText(company);
  await expect(page.getByTestId("event-list").getByTestId("event-item")).toHaveCount(1);
  await expect(page.getByTestId("event-item")).toHaveAttribute("data-type", "discovered");

  // log an event that also moves the status
  const form = page.getByTestId("event-form");
  await setField(form, "type", "applied");
  await setField(form, "note", "Submitted through the careers site");
  await setField(form, "status", "applied");
  await setField(form, "next_action", "Follow up with recruiter");
  await setField(form, "next_action_due", "2026-12-01");
  await page.getByTestId("event-submit").click();

  await expect(page.getByTestId("detail-status")).toHaveText(/^\s*applied\s*$/i);
  const items = page.getByTestId("event-list").getByTestId("event-item");
  await expect(items).toHaveCount(3);
  await expect(items.and(page.locator('[data-type="applied"]'))).toHaveCount(1);
  await expect(items.and(page.locator('[data-type="status-change"]'))).toHaveCount(1);
  await expect(items.and(page.locator('[data-type="discovered"]'))).toHaveCount(1);
  await expect(page.getByTestId("detail-field-next_action")).toContainText("Follow up with recruiter");

  const after = await apiGet(request, rec.id);
  expect(after.status).toBe("applied");
  expect(after.applied_at).toBe(detroitToday());
  expect(after.next_action_due).toBe("2026-12-01");
  expect(after.events.map((e: { type: string }) => e.type).sort()).toEqual(["applied", "discovered", "status-change"]);

  // edit a field through the edit form
  await page.getByTestId("edit-button").click();
  const edit = page.getByTestId("app-form");
  await expect(edit).toBeVisible();
  await setField(edit, "location", "Royal Oak, MI");
  await page.getByTestId("app-form-submit").click();
  await expect(page.getByTestId("detail-field-location")).toContainText("Royal Oak, MI");
  expect((await apiGet(request, rec.id)).location).toBe("Royal Oak, MI");
  await page.reload();
  await expect(page.getByTestId("detail-field-location")).toContainText("Royal Oak, MI");
  await expect(page.getByTestId("detail-status")).toHaveText(/^\s*applied\s*$/i);
});

test("conflict: an edit from a stale page shows the conflict banner, and a reload shows the latest data", async ({
  page,
  request,
}) => {
  await signInViaUi(page);
  const rec = await apiCreate(request, newApp(unique("Conflictco"), { location: "Original place" }));
  await page.goto(`/job-tracker/applications/${rec.id}`);
  await expect(page.getByTestId("app-detail")).toHaveAttribute("data-id", rec.id);
  await expect(page.getByTestId("detail-field-location")).toContainText("Original place");
  await expect(page.getByTestId("conflict-banner")).toHaveCount(0);

  // somebody else changes the record while the page is open
  const patched = await request.patch(`/job-tracker/api/applications/${rec.id}`, {
    headers: { ...agent, "If-Match": rec.updated_at },
    data: { location: "Changed elsewhere" },
  });
  expect(patched.status()).toBe(200);

  await page.getByTestId("edit-button").click();
  const edit = page.getByTestId("app-form");
  await setField(edit, "notes", "my stale edit");
  await page.getByTestId("app-form-submit").click();
  await expect(page.getByTestId("conflict-banner")).toBeVisible();

  const stored = await apiGet(request, rec.id);
  expect(stored.notes).toBeNull();
  expect(stored.location).toBe("Changed elsewhere");

  await page.reload();
  await expect(page.getByTestId("app-detail")).toHaveAttribute("data-id", rec.id);
  await expect(page.getByTestId("detail-field-location")).toContainText("Changed elsewhere");
  await expect(page.getByTestId("conflict-banner")).toHaveCount(0);
});

test("filters: text search, work arrangement and meets floor narrow the board", async ({ page, request }) => {
  await signInViaUi(page);
  const tokenA = unique("Alphafilter");
  const tokenB = unique("Betafilter");
  const a = await apiCreate(request, newApp(tokenA, { work_arrangement: "remote", comp_max: 200000 }));
  const b = await apiCreate(request, newApp(tokenB, { work_arrangement: "onsite", comp_max: 90000 }));
  await page.goto(HOME);
  const cardA = page.locator(`[data-testid="app-card"][data-id="${a.id}"]`);
  const cardB = page.locator(`[data-testid="app-card"][data-id="${b.id}"]`);
  await expect(cardA).toHaveCount(1);
  await expect(cardB).toHaveCount(1);

  // text search, case-insensitive, matches company
  await page.getByTestId("filter-q").fill(tokenA.toUpperCase());
  await expect(cardA).toHaveCount(1);
  await expect(cardB).toHaveCount(0);
  await expect(page.getByTestId("app-card")).toHaveCount(1);
  await page.getByTestId("filter-q").fill("");
  await expect(cardA).toHaveCount(1);
  await expect(cardB).toHaveCount(1);

  // work arrangement
  await page.getByTestId("filter-work-arrangement").selectOption("onsite");
  await expect(cardB).toHaveCount(1);
  await expect(cardA).toHaveCount(0);
  await page.getByTestId("filter-work-arrangement").selectOption("remote");
  await expect(cardA).toHaveCount(1);
  await expect(cardB).toHaveCount(0);
  await page.getByTestId("filter-work-arrangement").selectOption({ index: 0 });
  await expect(cardA).toHaveCount(1);
  await expect(cardB).toHaveCount(1);

  // meets floor
  await page.getByTestId("filter-meets-floor").check();
  await expect(cardA).toHaveCount(1);
  await expect(cardB).toHaveCount(0);
  await page.getByTestId("filter-meets-floor").uncheck();
  await expect(cardB).toHaveCount(1);
});

test("an API error shows the error banner, never the empty state", async ({ page }) => {
  await signInViaUi(page);
  await page.route(
    (url) => url.pathname === "/job-tracker/api/applications",
    (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "internal", message: "board-failure-marker" } }),
          })
        : route.continue(),
  );
  await page.goto(HOME);
  await expect(page.getByTestId("error-banner")).toBeVisible();
  await expect(page.getByTestId("error-banner")).toContainText("board-failure-marker");
  await expect(page.getByTestId("board-empty")).toHaveCount(0);
});

test("filters: track, Detroit metro and fit >= 80 narrow the board", async ({ page, request }) => {
  await signInViaUi(page);
  const a = await apiCreate(
    request,
    newApp(unique("Hitrack"), { track: "ai-engineer", detroit_metro: true, fit: { total: 90 } }),
  );
  const b = await apiCreate(
    request,
    newApp(unique("Lotrack"), { track: "other", detroit_metro: false, fit: { total: 50 } }),
  );
  await page.goto(HOME);
  const cardA = page.locator(`[data-testid="app-card"][data-id="${a.id}"]`);
  const cardB = page.locator(`[data-testid="app-card"][data-id="${b.id}"]`);
  await expect(cardA).toHaveCount(1);
  await expect(cardB).toHaveCount(1);

  await page.getByTestId("filter-track").selectOption("ai-engineer");
  await expect(cardA).toHaveCount(1);
  await expect(cardB).toHaveCount(0);
  await page.getByTestId("filter-track").selectOption("other");
  await expect(cardB).toHaveCount(1);
  await expect(cardA).toHaveCount(0);
  await page.getByTestId("filter-track").selectOption({ index: 0 });
  await expect(cardA).toHaveCount(1);
  await expect(cardB).toHaveCount(1);

  await page.getByTestId("filter-detroit-metro").check();
  await expect(cardA).toHaveCount(1);
  await expect(cardB).toHaveCount(0);
  await page.getByTestId("filter-detroit-metro").uncheck();
  await expect(cardB).toHaveCount(1);

  await page.getByTestId("filter-min-fit-80").check();
  await expect(cardA).toHaveCount(1);
  await expect(cardB).toHaveCount(0);
  await page.getByTestId("filter-min-fit-80").uncheck();
  await expect(cardB).toHaveCount(1);
});

test("delete: dismissing the confirm keeps the record; accepting removes it and returns to the board", async ({
  page,
  request,
}) => {
  await signInViaUi(page);
  const rec = await apiCreate(request, newApp(unique("Deleteco")));
  await page.goto(`/job-tracker/applications/${rec.id}`);
  await expect(page.getByTestId("app-detail")).toHaveAttribute("data-id", rec.id);

  page.once("dialog", (d) => void d.dismiss());
  await page.getByTestId("delete-button").click();
  await expect(page.getByTestId("app-detail")).toHaveAttribute("data-id", rec.id);
  expect(pathOf(page)).toBe(`/job-tracker/applications/${rec.id}`);
  expect((await request.get(`/job-tracker/api/applications/${rec.id}`, { headers: agent })).status()).toBe(200);

  page.once("dialog", (d) => void d.accept());
  await page.getByTestId("delete-button").click();
  await expect.poll(() => pathOf(page).replace(/\/$/, "")).toBe("/job-tracker");
  await expect(page.getByTestId("board")).toBeVisible();
  await expect(page.locator(`[data-id="${rec.id}"]`)).toHaveCount(0);
  expect((await request.get(`/job-tracker/api/applications/${rec.id}`, { headers: agent })).status()).toBe(404);
});

test("creating a duplicate through the form shows form-error with a link to the existing record", async ({
  page,
  request,
}) => {
  await signInViaUi(page);
  const company = unique("Dupeco");
  const rec = await apiCreate(request, newApp(company));
  await page.goto("/job-tracker/applications/new");
  const form = page.getByTestId("app-form");
  await setField(form, "company", company);
  await setField(form, "role_title", "Staff Engineer");
  await setField(form, "work_arrangement", "remote");
  await setField(form, "status", "watching");
  await page.getByTestId("app-form-submit").click();
  const err = page.getByTestId("form-error");
  await expect(err).toBeVisible();
  const link = err.locator(`a[href="/job-tracker/applications/${rec.id}"]`);
  await expect(link).toHaveCount(1);
  expect(pathOf(page)).toBe("/job-tracker/applications/new");
  await link.click();
  await expect(page.getByTestId("app-detail")).toHaveAttribute("data-id", rec.id);
});

test("an empty create submit shows form-error and creates nothing", async ({ page }) => {
  await signInViaUi(page);
  await page.goto("/job-tracker/applications/new");
  await page.getByTestId("app-form-submit").click();
  await expect(page.getByTestId("form-error")).toBeVisible();
  expect(pathOf(page)).toBe("/job-tracker/applications/new");
});

test("a filter with no match shows board-empty and no error banner", async ({ page }) => {
  await signInViaUi(page);
  await page.goto(HOME);
  await page.getByTestId("filter-q").fill(unique("nomatch"));
  await expect(page.getByTestId("board-empty")).toBeVisible();
  await expect(page.getByTestId("error-banner")).toHaveCount(0);
});

test("the detail page of an unknown id shows the error banner, not the record", async ({ page }) => {
  await signInViaUi(page);
  await page.goto("/job-tracker/applications/nope--nope--2026-01-01");
  await expect(page.getByTestId("error-banner")).toBeVisible();
  await expect(page.getByTestId("app-detail")).toHaveCount(0);
});

test("editing: typed edits survive an event logged meanwhile, and the event's next_action is not reverted", async ({
  page,
  request,
}) => {
  await signInViaUi(page);
  const rec = await apiCreate(request, newApp(unique("Keep"), { location: "Troy, MI" }));
  await page.goto(`/job-tracker/applications/${rec.id}`);
  await page.getByTestId("edit-button").click();
  const form = page.getByTestId("app-form");
  await setField(form, "notes", "typed before the event");
  const ev = page.getByTestId("event-form");
  await setField(ev, "note", "call");
  await setField(ev, "next_action", "From the event");
  await setField(ev, "next_action_due", "2026-12-24");
  await page.getByTestId("event-submit").click();
  await expect(page.getByTestId("event-list").getByTestId("event-item")).toHaveCount(2);
  await expect(page.getByTestId("detail-field-next_action")).toContainText("From the event");
  await expect(form.locator('[name="notes"]')).toHaveValue("typed before the event");
  await page.getByTestId("app-form-submit").click();
  await expect(page.getByTestId("detail-field-notes")).toContainText("typed before the event");
  await expect(page.getByTestId("conflict-banner")).toHaveCount(0);
  const after = await apiGet(request, rec.id);
  expect(after.notes).toBe("typed before the event");
  expect(after.next_action).toBe("From the event");
  expect(after.next_action_due).toBe("2026-12-24");
  expect(after.location).toBe("Troy, MI");
});

test("editing: an untouched status is not sent after an in-page status change; a touched field wins", async ({
  page,
  request,
}) => {
  await signInViaUi(page);
  const rec = await apiCreate(request, newApp(unique("Touch"), { location: "Old" }));
  await page.goto(`/job-tracker/applications/${rec.id}`);
  await page.getByTestId("edit-button").click();
  await setField(page.getByTestId("app-form"), "location", "New");
  await setField(page.getByTestId("event-form"), "status", "applied");
  await page.getByTestId("event-submit").click();
  await expect(page.getByTestId("detail-status")).toHaveText(/applied/i);
  await page.getByTestId("app-form-submit").click();
  await expect(page.getByTestId("detail-field-location")).toContainText("New");
  await expect(page.getByTestId("conflict-banner")).toHaveCount(0);
  const after = await apiGet(request, rec.id);
  expect(after.status).toBe("applied");
  expect(after.location).toBe("New");
  expect(after.events.filter((e: { type: string }) => e.type === "status-change")).toHaveLength(1);
});

test("editing: an external change while editing shows the conflict banner, and a retry saves", async ({
  page,
  request,
}) => {
  await signInViaUi(page);
  const rec = await apiCreate(request, newApp(unique("Retry"), { location: "Start" }));
  await page.goto(`/job-tracker/applications/${rec.id}`);
  await page.getByTestId("edit-button").click();
  await setField(page.getByTestId("app-form"), "notes", "first try");
  const ext = await request.patch(`/job-tracker/api/applications/${rec.id}`, {
    headers: { ...agent, "If-Match": rec.updated_at },
    data: { location: "External" },
  });
  expect(ext.status()).toBe(200);
  await page.getByTestId("app-form-submit").click();
  await expect(page.getByTestId("conflict-banner")).toBeVisible();
  await expect(page.getByTestId("detail-field-location")).toContainText("External");
  expect((await apiGet(request, rec.id)).notes).toBeNull();

  await page.getByTestId("edit-button").click();
  await setField(page.getByTestId("app-form"), "notes", "second try");
  await page.getByTestId("app-form-submit").click();
  await expect(page.getByTestId("detail-field-notes")).toContainText("second try");
  const after = await apiGet(request, rec.id);
  expect(after.notes).toBe("second try");
  expect(after.location).toBe("External");
});
