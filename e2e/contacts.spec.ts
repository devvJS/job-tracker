import { expect, test, type Page } from "@playwright/test";
import { AGENT_KEY } from "./support/env.ts";

const HOME_PATH = "/job-tracker/";
const CONTACTS_PATH = "/job-tracker/contacts";
const API = "/job-tracker/api";

const pathOf = (page: { url(): string }) => new URL(page.url()).pathname;
const unique = () => Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, "z").padEnd(6, "z");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Signs in through the UI: login page, then the fake GitHub round trip, landing on the board. */
async function signInThroughUi(page: Page) {
  await page.goto(HOME_PATH);
  await expect.poll(() => pathOf(page)).toBe("/job-tracker/login");
  await page.getByTestId("signin").click();
  await expect.poll(() => pathOf(page)).toBe(HOME_PATH);
  await expect(page.getByTestId("user-login")).toHaveText("devvJS");
}

async function openContacts(page: Page) {
  await page.getByTestId("nav-contacts").click();
  await expect.poll(() => pathOf(page)).toBe(CONTACTS_PATH);
}

test("add a contact through the form, then edit it: both show in the list", async ({ page }) => {
  const u = unique();
  const name = `Ada Tester ${u}`;
  const company = `Acme ${u}`;
  const id = `${slug(name)}--${slug(company)}`;

  await signInThroughUi(page);
  await openContacts(page);
  await expect(page.getByTestId("contact-list")).toBeVisible();
  await expect(page.getByTestId("error-banner")).toHaveCount(0);

  const form = page.getByTestId("contact-form");
  await expect(form).toBeVisible();
  await form.locator('[name="name"]').fill(name);
  await form.locator('[name="company"]').fill(company);
  await form.locator('[name="role"]').fill("Recruiter");
  await form.locator('[name="relationship"]').selectOption("recruiter");
  await form.locator('[name="linkedin_url"]').fill(`https://www.linkedin.com/in/${slug(name)}`);
  await form.locator('[name="email"]').fill(`ada.${u}@acme.test`);
  await form.locator('[name="notes"]').fill(`Met via referral ${u}`);
  await page.getByTestId("contact-submit").click();

  const item = page.locator(`[data-testid="contact-item"][data-id="${id}"]`);
  await expect(item).toHaveCount(1);
  await expect(item).toContainText(name);
  await expect(item).toContainText(company);
  await expect(item).toContainText("Recruiter");
  await expect(page.getByTestId("error-banner")).toHaveCount(0);

  // it is persisted: a reload still lists it
  await page.reload();
  await expect(item).toHaveCount(1);
  await expect(item).toContainText(company);

  // edit it
  await item.getByTestId("contact-edit").click();
  const editForm = page.getByTestId("contact-form");
  await expect(editForm.locator('[name="name"]')).toHaveValue(name);
  await expect(editForm.locator('[name="company"]')).toHaveValue(company);
  await expect(editForm.locator('[name="role"]')).toHaveValue("Recruiter");
  await editForm.locator('[name="role"]').fill(`Director of Talent ${u}`);
  await page.getByTestId("contact-submit").click();

  await expect(item).toContainText(`Director of Talent ${u}`);
  await expect(item).not.toContainText("Recruiter");
  // the id is stable across the edit, and the list still has exactly this one item for it
  await expect(page.locator(`[data-testid="contact-item"][data-id="${id}"]`)).toHaveCount(1);

  // a second edit without reloading also saves: no conflict, no error
  await item.getByTestId("contact-edit").click();
  await expect(editForm.locator('[name="role"]')).toHaveValue(`Director of Talent ${u}`);
  await editForm.locator('[name="role"]').fill(`VP of People ${u}`);
  await page.getByTestId("contact-submit").click();
  await expect(item).toContainText(`VP of People ${u}`);
  await expect(page.getByTestId("error-banner")).toHaveCount(0);
  await expect(page.getByTestId("conflict-banner")).toHaveCount(0);

  // the edit reached the server
  await page.reload();
  await expect(item).toContainText(`VP of People ${u}`);
  const api = await page.request.get(`${API}/contacts/${id}`);
  expect(api.status()).toBe(200);
  expect(await api.json()).toMatchObject({
    id,
    name,
    company,
    role: `VP of People ${u}`,
    relationship: "recruiter",
    updated_by: "dakota",
  });
});

test("a contact created through the API with the agent key shows after a reload", async ({ page, request }) => {
  const u = unique();
  const name = `Agent Made ${u}`;
  const company = `Botco ${u}`;
  const id = `${slug(name)}--${slug(company)}`;

  await signInThroughUi(page);
  await openContacts(page);
  const item = page.locator(`[data-testid="contact-item"][data-id="${id}"]`);
  await expect(page.getByTestId("contact-list")).toBeVisible();
  await expect(item).toHaveCount(0);

  const created = await request.post(`${API}/contacts`, {
    headers: { Authorization: `Bearer ${AGENT_KEY}` },
    data: { name, company, role: "Hiring Manager", relationship: "hiring-manager" },
  });
  expect(created.status()).toBe(201);
  expect((await created.json()).updated_by).toBe("claude-project");

  await page.reload();
  await expect(item).toHaveCount(1);
  await expect(item).toContainText(name);
  await expect(item).toContainText(company);
  await expect(item).toContainText("Hiring Manager");
});

test("an API failure on GET /api/contacts shows the error banner", async ({ page }) => {
  await signInThroughUi(page);
  await page.route(/\/job-tracker\/api\/contacts(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "internal", message: "Internal server error" } }),
    });
  });
  await page.getByTestId("nav-contacts").click();
  await expect.poll(() => pathOf(page)).toBe(CONTACTS_PATH);
  await expect(page.getByTestId("error-banner")).toBeVisible();
  await expect(page.getByTestId("contact-item")).toHaveCount(0);
  // never an empty state after a failed fetch
  await expect(page.getByTestId("contact-list")).toHaveCount(0);
  await expect(page.getByText(/no contacts/i)).toHaveCount(0);
});

test("a contact with free-text email written by the agent can be edited and saved in the UI", async ({ page, request }) => {
  const u = unique();
  const name = `Free Email ${u}`;
  const company = `Textco ${u}`;
  const id = `${slug(name)}--${slug(company)}`;
  const created = await request.post(`${API}/contacts`, {
    headers: { Authorization: `Bearer ${AGENT_KEY}` },
    data: { name, company, email: "ask the recruiter", notes: "before" },
  });
  expect(created.status()).toBe(201);

  await signInThroughUi(page);
  await openContacts(page);
  const item = page.locator(`[data-testid="contact-item"][data-id="${id}"]`);
  await expect(item).toHaveCount(1);
  await item.getByTestId("contact-edit").click();
  const form = page.getByTestId("contact-form");
  await expect(form.locator('[name="email"]')).toHaveValue("ask the recruiter");
  await form.locator('[name="notes"]').fill(`after ${u}`);
  await page.getByTestId("contact-submit").click();

  await expect(item).toContainText(`after ${u}`);
  await expect(page.getByTestId("error-banner")).toHaveCount(0);
  const api = await page.request.get(`${API}/contacts/${id}`);
  expect(await api.json()).toMatchObject({ notes: `after ${u}`, email: "ask the recruiter", updated_by: "dakota" });
});

test("editing the name to whitespace only does not report success and keeps the name", async ({ page }) => {
  const u = unique();
  const name = `Keep Name ${u}`;
  const company = `Keepco ${u}`;
  const id = `${slug(name)}--${slug(company)}`;

  await signInThroughUi(page);
  await openContacts(page);
  const form = page.getByTestId("contact-form");
  await form.locator('[name="name"]').fill(name);
  await form.locator('[name="company"]').fill(company);
  await page.getByTestId("contact-submit").click();
  const item = page.locator(`[data-testid="contact-item"][data-id="${id}"]`);
  await expect(item).toHaveCount(1);

  await item.getByTestId("contact-edit").click();
  await form.locator('[name="name"]').fill("   ");
  await form.locator('[name="notes"]').fill(`should not save ${u}`);
  await page.getByTestId("contact-submit").click();

  await expect(page.getByTestId("error-banner")).toBeVisible();
  await page.reload();
  await expect(item).toContainText(name);
  await expect(item).not.toContainText(`should not save ${u}`);
  const api = await page.request.get(`${API}/contacts/${id}`);
  expect(await api.json()).toMatchObject({ name, notes: null });
});
