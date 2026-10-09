// Live cross-tab sync (spec section I). One browser context, two pages: they share cookies and
// BroadcastChannel, like duplicated tabs. Run with E2E_PORT=4370.
import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { AGENT_KEY } from "./support/env.ts";

const HOME = "/job-tracker/";
/** How long a page may take to show another tab's write (BroadcastChannel). */
const SYNC = { timeout: 5000 };
/** Visibility refetch is throttled to once per 2 s; wait this long after load before relying on it. */
const THROTTLE_MS = 2300;

const pathOf = (page: { url(): string }) => new URL(page.url()).pathname;
const unique = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const agent = { Authorization: `Bearer ${AGENT_KEY}`, "Content-Type": "application/json" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = Record<string, any>;

async function signInViaUi(page: Page) {
  await page.goto(HOME);
  await page.getByTestId("signin").click();
  await expect.poll(() => pathOf(page)).toBe(HOME);
  await expect(page.getByTestId("user-login")).toBeVisible();
}

/** Two pages in one signed-in context. */
async function pair(context: BrowserContext) {
  const a = await context.newPage();
  await signInViaUi(a);
  const b = await context.newPage();
  return { a, b };
}

async function apiCreate(request: APIRequestContext, body: Record<string, unknown>): Promise<Rec> {
  const res = await request.post("/job-tracker/api/applications", { headers: agent, data: body });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}
async function apiGet(request: APIRequestContext, id: string): Promise<Rec> {
  const res = await request.get(`/job-tracker/api/applications/${id}`, { headers: agent });
  expect(res.status()).toBe(200);
  return res.json();
}

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

/** Opens the detail page on both tabs and waits until both rendered it. */
async function openBoth(a: Page, b: Page, id: string) {
  for (const p of [a, b]) {
    await p.goto(`/job-tracker/applications/${id}`);
    await expect(p.getByTestId("app-detail")).toHaveAttribute("data-id", id);
  }
}

async function editAndSave(p: Page, field: string, value: string) {
  await p.getByTestId("edit-button").click();
  await setField(p.getByTestId("app-form"), field, value);
  await p.getByTestId("app-form-submit").click();
}

test("detail, not editing: tab B shows tab A's saved notes without a reload and without any PATCH", async ({
  context,
  request,
}) => {
  const { a, b } = await pair(context);
  const rec = await apiCreate(request, newApp(unique("Sync1")));
  await openBoth(a, b, rec.id);
  const patches: string[] = [];
  b.on("request", (r) => {
    if (r.method() === "PATCH") patches.push(r.url());
  });
  await editAndSave(a, "notes", "written in tab A");
  await expect(a.getByTestId("detail-field-notes")).toContainText("written in tab A");
  await expect(b.getByTestId("detail-field-notes")).toContainText("written in tab A", SYNC);
  await expect(b.getByTestId("stale-banner")).toHaveCount(0);
  expect(patches).toEqual([]);
});

test("detail, editing: tab B keeps its typed notes and shows stale-banner; stale-reload loads A's change and drops the typing", async ({
  context,
  request,
}) => {
  const { a, b } = await pair(context);
  const rec = await apiCreate(request, newApp(unique("Sync2"), { location: "Original" }));
  await openBoth(a, b, rec.id);
  await b.getByTestId("edit-button").click();
  const bForm = b.getByTestId("app-form");
  await setField(bForm, "notes", "typed by B");
  await expect(b.getByTestId("stale-banner")).toHaveCount(0);

  await editAndSave(a, "location", "Changed by A");
  await expect(b.getByTestId("stale-banner")).toBeVisible(SYNC);
  await expect(b.getByTestId("stale-banner")).toContainText("Updated in another tab or by your agent");
  await expect(bForm.locator('[name="notes"]')).toHaveValue("typed by B");

  await b.getByTestId("stale-reload").click();
  await expect(b.getByTestId("stale-banner")).toHaveCount(0);
  await expect(b.getByTestId("detail-field-location")).toContainText("Changed by A");
  const typed = await b.locator('[name="notes"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  expect(typed).not.toContain("typed by B");
  expect((await apiGet(request, rec.id)).notes).toBeNull();
});

test("saving anyway from a stale tab gives the conflict banner and the API keeps A's change", async ({
  context,
  request,
}) => {
  const { a, b } = await pair(context);
  const rec = await apiCreate(request, newApp(unique("Sync3"), { location: "Original" }));
  await openBoth(a, b, rec.id);
  await b.getByTestId("edit-button").click();
  await setField(b.getByTestId("app-form"), "notes", "typed by B");
  await editAndSave(a, "location", "Changed by A");
  await expect(b.getByTestId("stale-banner")).toBeVisible(SYNC);

  await b.getByTestId("app-form-submit").click();
  await expect(b.getByTestId("conflict-banner")).toBeVisible();
  const after = await apiGet(request, rec.id);
  expect(after.location).toBe("Changed by A");
  expect(after.notes).toBeNull();
});

test("an agent write shows up when the tab becomes visible or focused again", async ({ context, request }) => {
  const { a, b } = await pair(context);
  const rec = await apiCreate(request, newApp(unique("Sync4"), { location: "Before agent" }));
  await openBoth(a, b, rec.id);
  await b.waitForTimeout(THROTTLE_MS);
  const res = await request.patch(`/job-tracker/api/applications/${rec.id}`, {
    headers: { ...agent, "If-Match": rec.updated_at },
    data: { location: "Set by the agent" },
  });
  expect(res.status()).toBe(200);
  await expect(b.getByTestId("detail-field-location")).toContainText("Before agent");
  await b.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  await expect(b.getByTestId("detail-field-location")).toContainText("Set by the agent", SYNC);
});

test("board: an application created in tab A appears in tab B without a reload", async ({ context }) => {
  const { a, b } = await pair(context);
  await b.goto(HOME);
  await expect(b.getByTestId("board")).toBeVisible();
  const company = unique("Sync5");
  await a.goto("/job-tracker/applications/new");
  const form = a.getByTestId("app-form");
  await setField(form, "company", company);
  await setField(form, "role_title", "Platform Engineer");
  await setField(form, "work_arrangement", "remote");
  await setField(form, "status", "shortlisted");
  await a.getByTestId("app-form-submit").click();
  await expect(a.getByTestId("app-detail")).toBeVisible();
  const id = (await a.getByTestId("app-detail").getAttribute("data-id")) ?? "";
  expect(id.startsWith(`${slug(company)}--platform-engineer--`)).toBe(true);
  const card = b.getByTestId("board-column-shortlisted").locator(`[data-testid="app-card"][data-id="${id}"]`);
  await expect(card).toHaveCount(1, SYNC);
});

test("contacts: an edit in tab A shows in tab B without a reload", async ({ context, request }) => {
  const { a, b } = await pair(context);
  const name = unique("Syncperson");
  const created = await request.post("/job-tracker/api/contacts", { headers: agent, data: { name, company: "Syncorp" } });
  expect(created.status(), await created.text()).toBe(201);
  const id = `${slug(name)}--syncorp`;
  for (const p of [a, b]) {
    await p.goto("/job-tracker/contacts");
    await expect(p.locator(`[data-testid="contact-item"][data-id="${id}"]`)).toHaveCount(1);
  }
  await a.locator(`[data-testid="contact-item"][data-id="${id}"]`).getByTestId("contact-edit").click();
  await setField(a.getByTestId("contact-form"), "role", "Recruiter Extraordinaire");
  await a.getByTestId("contact-submit").click();
  await expect(a.locator(`[data-testid="contact-item"][data-id="${id}"]`)).toContainText("Recruiter Extraordinaire");
  await expect(b.locator(`[data-testid="contact-item"][data-id="${id}"]`)).toContainText("Recruiter Extraordinaire", SYNC);
});

test("delete: tab B on the deleted record's detail page shows an error banner about the deletion", async ({
  context,
  request,
}) => {
  const { a, b } = await pair(context);
  const rec = await apiCreate(request, newApp(unique("Sync7")));
  await openBoth(a, b, rec.id);
  a.once("dialog", (d) => void d.accept());
  await a.getByTestId("delete-button").click();
  await expect(b.getByTestId("error-banner")).toBeVisible(SYNC);
  await expect(b.getByTestId("error-banner")).toContainText(/delet/i);
  expect((await request.get(`/job-tracker/api/applications/${rec.id}`, { headers: agent })).status()).toBe(404);
});

test("no self-reaction: tab A never shows stale-banner for its own save", async ({ context, request }) => {
  const { a, b } = await pair(context);
  const rec = await apiCreate(request, newApp(unique("Sync8")));
  await openBoth(a, b, rec.id);
  await editAndSave(a, "notes", "my own save");
  await expect(a.getByTestId("detail-field-notes")).toContainText("my own save");
  // proof the message was published and delivered: B received it
  await expect(b.getByTestId("detail-field-notes")).toContainText("my own save", SYNC);
  await a.waitForTimeout(1000);
  await expect(a.getByTestId("stale-banner")).toHaveCount(0);
  await expect(a.getByTestId("conflict-banner")).toHaveCount(0);

  // also while editing again: an own event does not mark the open form stale
  await a.getByTestId("edit-button").click();
  await setField(a.getByTestId("event-form"), "note", "own event");
  await a.getByTestId("event-submit").click();
  await expect(a.getByTestId("event-list").getByTestId("event-item")).toHaveCount(2);
  await a.waitForTimeout(1000);
  await expect(a.getByTestId("stale-banner")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Revision 1 (review-S7)
// ---------------------------------------------------------------------------

test("R1 race: a remote save that lands during tab A's own event POST still marks A's open form stale (or A's save is refused)", async ({
  context,
  request,
}) => {
  const { a, b } = await pair(context);
  const rec = await apiCreate(request, newApp(unique("Race"), { location: "Original" }));
  await openBoth(a, b, rec.id);

  // A: edit form open, location touched
  await a.getByTestId("edit-button").click();
  await setField(a.getByTestId("app-form"), "location", "A typed");

  // Hold A's POST /events until B has saved and the broadcast has had time to arrive.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await a.route(
    (u) => u.pathname === `/job-tracker/api/applications/${rec.id}/events`,
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await held;
      return route.continue();
    },
  );
  await setField(a.getByTestId("event-form"), "note", "slow event");
  await a.getByTestId("event-submit").click();

  // B saves while A's request is in flight
  await editAndSave(b, "location", "B saved");
  await expect(b.getByTestId("detail-field-location")).toContainText("B saved");
  expect((await apiGet(request, rec.id)).location).toBe("B saved");
  await a.waitForTimeout(1000); // BroadcastChannel delivery and A's refetch happen inside the in-flight window
  release();

  await expect(a.getByTestId("event-list").getByTestId("event-item")).toHaveCount(2);
  await a.waitForTimeout(1500);
  await expect(a.getByTestId("stale-banner")).toBeVisible();
  // saving anyway is refused: the PATCH carries the version the edit opened from
  const patchSent = a.waitForRequest((r) => r.method() === "PATCH" && r.url().endsWith(`/applications/${rec.id}`));
  const patchDone = a.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/applications/${rec.id}`));
  await a.getByTestId("app-form-submit").click();
  const sent = await patchSent;
  expect(sent.headers()["if-match"]).toBe(rec.updated_at);
  expect((await patchDone).status()).toBe(412);
  await expect(a.getByTestId("conflict-banner")).toBeVisible();
  expect((await apiGet(request, rec.id)).location).toBe("B saved");
});

test("M09: tab B sees tab A's event and status change without a reload", async ({ context, request }) => {
  const { a, b } = await pair(context);
  const rec = await apiCreate(request, newApp(unique("Sync9")));
  await openBoth(a, b, rec.id);
  const form = a.getByTestId("event-form");
  await setField(form, "type", "applied");
  await setField(form, "note", "applied from tab A");
  await setField(form, "status", "applied");
  await a.getByTestId("event-submit").click();
  await expect(a.getByTestId("detail-status")).toHaveText(/^\s*applied\s*$/i);
  await expect(b.getByTestId("detail-status")).toHaveText(/^\s*applied\s*$/i, SYNC);
  const items = b.getByTestId("event-list").getByTestId("event-item");
  await expect(items).toHaveCount(3, SYNC);
  await expect(items.and(b.locator('[data-type="applied"]'))).toHaveCount(1);
  await expect(items.and(b.locator('[data-type="status-change"]'))).toHaveCount(1);
});

test("M13: contacts, tab B editing a contact that tab A saves: stale-banner, typed value kept, stale-reload loads A's change", async ({
  context,
  request,
}) => {
  const { a, b } = await pair(context);
  const name = unique("Stalecontact");
  const created = await request.post("/job-tracker/api/contacts", { headers: agent, data: { name, company: "Stalecorp" } });
  expect(created.status(), await created.text()).toBe(201);
  const id = `${slug(name)}--stalecorp`;
  const item = (p: Page) => p.locator(`[data-testid="contact-item"][data-id="${id}"]`);
  for (const p of [a, b]) {
    await p.goto("/job-tracker/contacts");
    await expect(item(p)).toHaveCount(1);
  }
  await item(b).getByTestId("contact-edit").click();
  const bForm = b.getByTestId("contact-form");
  await setField(bForm, "notes", "typed by B");
  await expect(b.getByTestId("stale-banner")).toHaveCount(0);

  await item(a).getByTestId("contact-edit").click();
  await setField(a.getByTestId("contact-form"), "role", "Role from A");
  await a.getByTestId("contact-submit").click();
  await expect(item(a)).toContainText("Role from A");

  await expect(b.getByTestId("stale-banner")).toBeVisible(SYNC);
  await expect(bForm.locator('[name="notes"]')).toHaveValue("typed by B");
  await b.getByTestId("stale-reload").click();
  await expect(b.getByTestId("stale-banner")).toHaveCount(0);
  await expect(item(b)).toContainText("Role from A");
  const typed = await b.locator('[name="notes"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  expect(typed).not.toContain("typed by B");
});

test("M12: the due page refetches after another tab creates a due application", async ({ context }) => {
  const { a, b } = await pair(context);
  await b.goto("/job-tracker/due");
  await expect(b.getByTestId("due-date")).toBeVisible();
  await expect(b.getByText("Loading…")).toHaveCount(0);
  await a.goto("/job-tracker/applications/new");
  const form = a.getByTestId("app-form");
  await setField(form, "company", unique("Sync12due"));
  await setField(form, "role_title", "Due Engineer");
  await setField(form, "work_arrangement", "remote");
  await setField(form, "status", "watching");
  await setField(form, "next_action_due", "2020-01-01");
  await a.getByTestId("app-form-submit").click();
  await expect(a.getByTestId("app-detail")).toBeVisible();
  const id = (await a.getByTestId("app-detail").getAttribute("data-id")) ?? "";
  await expect(b.locator(`[data-testid="due-item"][data-id="${id}"]`)).toHaveCount(1, SYNC);
});

test("M12: the summary page refetches after another tab creates an applied application", async ({ context }) => {
  const { a, b } = await pair(context);
  await b.goto("/job-tracker/summary");
  const applied = b.getByTestId("summary-applied");
  await expect(applied).toBeVisible();
  const before = Number((await applied.textContent())?.trim());
  expect(Number.isInteger(before)).toBe(true);
  await a.goto("/job-tracker/applications/new");
  const form = a.getByTestId("app-form");
  await setField(form, "company", unique("Sync12sum"));
  await setField(form, "role_title", "Summary Engineer");
  await setField(form, "work_arrangement", "remote");
  await setField(form, "status", "applied");
  await a.getByTestId("app-form-submit").click();
  await expect(a.getByTestId("app-detail")).toBeVisible();
  await expect(applied).toHaveText(String(before + 1), SYNC);
});

test("M02b: a visibility/focus refetch with no remote change leaves the edit form alone: no stale-banner, typed value kept", async ({
  context,
  request,
}) => {
  const { a, b } = await pair(context);
  const rec = await apiCreate(request, newApp(unique("Quiet")));
  await openBoth(a, b, rec.id);
  await b.getByTestId("edit-button").click();
  await setField(b.getByTestId("app-form"), "notes", "typed by B");
  await b.waitForTimeout(THROTTLE_MS);
  const refetched = b.waitForRequest(
    (r) => r.method() === "GET" && new URL(r.url()).pathname === `/job-tracker/api/applications/${rec.id}`,
  );
  await b.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  await refetched;
  await b.waitForTimeout(1000);
  await expect(b.getByTestId("stale-banner")).toHaveCount(0);
  await expect(b.getByTestId("app-form").locator('[name="notes"]')).toHaveValue("typed by B");
});

test("nit: after tab B logs its own event while stale, the banner does not claim the save will be refused", async ({
  context,
  request,
}) => {
  const { a, b } = await pair(context);
  const rec = await apiCreate(request, newApp(unique("Nit2"), { location: "Original" }));
  await openBoth(a, b, rec.id);
  await b.getByTestId("edit-button").click();
  await setField(b.getByTestId("app-form"), "notes", "typed by B");
  await editAndSave(a, "location", "Changed by A");
  await expect(b.getByTestId("stale-banner")).toBeVisible(SYNC);

  await setField(b.getByTestId("event-form"), "note", "own event while stale");
  await b.getByTestId("event-submit").click();
  await expect(b.getByTestId("event-list").getByTestId("event-item")).toHaveCount(2);
  await b.waitForTimeout(500);
  const banner = b.getByTestId("stale-banner");
  if ((await banner.count()) > 0) {
    expect(await banner.textContent()).not.toMatch(/refused/i);
  }
});

test("nit: visibility refetches are throttled to one per 2 s, and an event inside the window is deferred, not dropped", async ({
  context,
  request,
}) => {
  const { a, b } = await pair(context);
  const rec = await apiCreate(request, newApp(unique("Throttle")));
  await openBoth(a, b, rec.id);
  await b.waitForTimeout(THROTTLE_MS);
  let gets = 0;
  b.on("request", (r) => {
    if (r.method() === "GET" && new URL(r.url()).pathname === `/job-tracker/api/applications/${rec.id}`) gets++;
  });
  const fire = () =>
    b.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
  await fire();
  await expect.poll(() => gets).toBe(1);
  await b.waitForTimeout(300);
  await fire(); // inside the 2 s window
  await b.waitForTimeout(600);
  expect(gets).toBe(1);
  await expect.poll(() => gets, { timeout: 4000 }).toBe(2); // deferred to the end of the window
  await b.waitForTimeout(500);
  expect(gets).toBe(2);
});

test("N7: a visibility refetch during the tab's own in-flight event shows no stale-banner, and the save then succeeds", async ({
  context,
  request,
}) => {
  const { a, b } = await pair(context);
  const rec = await apiCreate(request, newApp(unique("Own")));
  await openBoth(a, b, rec.id);
  await a.getByTestId("edit-button").click();
  await setField(a.getByTestId("app-form"), "notes", "typed by A");
  // the server commits the event, but the response is held for 1.5 s
  await a.route(
    (u) => u.pathname === `/job-tracker/api/applications/${rec.id}/events`,
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return route.fulfill({ response });
    },
  );
  await a.waitForTimeout(THROTTLE_MS);
  await setField(a.getByTestId("event-form"), "note", "own slow event");
  await a.getByTestId("event-submit").click();
  await a.waitForTimeout(300);
  await a.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  await a.waitForTimeout(600);
  await expect(a.getByTestId("stale-banner")).toHaveCount(0);
  await expect(a.getByTestId("event-list").getByTestId("event-item")).toHaveCount(2);
  await a.waitForTimeout(500);
  await expect(a.getByTestId("stale-banner")).toHaveCount(0);

  const patchDone = a.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/applications/${rec.id}`));
  await a.getByTestId("app-form-submit").click();
  expect((await patchDone).status()).toBe(200);
  await expect(a.getByTestId("conflict-banner")).toHaveCount(0);
  expect((await apiGet(request, rec.id)).notes).toBe("typed by A");
});

test("N4: a detail page showing 'deleted' returns to the record when the same id is re-created and the tab refetches", async ({
  context,
  request,
}) => {
  const { a, b } = await pair(context);
  const company = unique("Phoenix");
  const body = newApp(company, { discovered_at: "2026-01-15" });
  const rec = await apiCreate(request, body);
  await openBoth(a, b, rec.id);
  a.once("dialog", (d) => void d.accept());
  await a.getByTestId("delete-button").click();
  await expect(b.getByTestId("error-banner")).toContainText(/delet/i, SYNC);

  const again = await apiCreate(request, body);
  expect(again.id).toBe(rec.id);
  await b.waitForTimeout(THROTTLE_MS);
  await b.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  await expect(b.getByTestId("error-banner")).toHaveCount(0, SYNC);
  await expect(b.getByTestId("app-detail")).toHaveAttribute("data-id", rec.id);
});
