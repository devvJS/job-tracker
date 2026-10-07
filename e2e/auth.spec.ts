import { expect, test, type Page } from "@playwright/test";
import { FAKE_GITHUB_URL } from "./support/env.ts";

const LOGIN_PATH = "/job-tracker/login";
const HOME_PATH = "/job-tracker/";

const pathOf = (page: { url(): string }) => new URL(page.url()).pathname;

test("signing in: / redirects to the login page, GitHub sign-in lands on the app, sign out returns to login", async ({
  page,
}) => {
  await page.goto(HOME_PATH);
  await expect.poll(() => pathOf(page)).toBe(LOGIN_PATH);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("app-shell").getByTestId("login-page")).toBeVisible();
  const signin = page.getByTestId("app-shell").getByTestId("signin");
  await expect(signin).toBeVisible();
  await expect(signin).toHaveAttribute("href", "/job-tracker/api/auth/login");

  await signin.click();
  await expect.poll(() => pathOf(page)).toBe(HOME_PATH);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("login-page")).toHaveCount(0);

  await expect(page.getByTestId("nav")).toBeVisible();
  for (const id of ["nav-board", "nav-new", "nav-due", "nav-summary", "nav-contacts"]) {
    await expect(page.getByTestId(id), id).toBeVisible();
  }
  await expect(page.getByTestId("user-login")).toHaveText("devvJS");

  // a reload keeps the session
  await page.reload();
  await expect(page.getByTestId("user-login")).toHaveText("devvJS");
  expect(pathOf(page)).toBe(HOME_PATH);

  // visiting the login page while signed in goes to the app
  await page.goto(LOGIN_PATH);
  await expect.poll(() => pathOf(page)).toBe(HOME_PATH);

  await page.getByTestId("signout").click();
  await expect.poll(() => pathOf(page)).toBe(LOGIN_PATH);
  await expect(page.getByTestId("login-page")).toBeVisible();
  await expect(page.getByTestId("user-login")).toHaveCount(0);

  await page.goto(HOME_PATH);
  await expect.poll(() => pathOf(page)).toBe(LOGIN_PATH);
  await expect(page.getByTestId("login-page")).toBeVisible();
});

test("a deep link without a session redirects to login", async ({ page }) => {
  await page.goto("/job-tracker/due");
  await expect.poll(() => pathOf(page)).toBe(LOGIN_PATH);
  await expect(page.getByTestId("login-page")).toBeVisible();
});

test("a GitHub login that is not allowed is refused: no session, no app", async ({ page, request }) => {
  const set = await request.post(`${FAKE_GITHUB_URL}/__control/login`, { data: { login: "mallory" } });
  expect(set.status()).toBe(200);

  await page.goto(HOME_PATH);
  await expect(page.getByTestId("login-page")).toBeVisible();
  const [callback] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === "/job-tracker/api/auth/callback"),
    page.getByTestId("signin").click(),
  ]);
  expect(callback.status()).toBe(403);
  expect(((await callback.json()) as { error: { code: string } }).error.code).toBe("forbidden");

  await expect(page.getByTestId("board")).toHaveCount(0);
  await expect(page.getByTestId("user-login")).toHaveCount(0);

  // still no session: the app redirects to login
  await page.goto(HOME_PATH);
  await expect.poll(() => pathOf(page)).toBe(LOGIN_PATH);
  await expect(page.getByTestId("login-page")).toBeVisible();
  await expect(page.getByTestId("board")).toHaveCount(0);

  // the refusal was one shot: the next sign-in is for the default (allowed) login
  await page.getByTestId("signin").click();
  await expect.poll(() => pathOf(page)).toBe(HOME_PATH);
  await expect(page.getByTestId("user-login")).toHaveText("devvJS");
});

test("the API rejects an unauthenticated request from the browser context", async ({ request }) => {
  const res = await request.get("/job-tracker/api/applications");
  expect(res.status()).toBe(401);
  expect(res.headers()["www-authenticate"]).toBe("Bearer");
});

async function signInViaUi(page: Page) {
  await page.goto(HOME_PATH);
  await page.getByTestId("signin").click();
  await expect.poll(() => pathOf(page)).toBe(HOME_PATH);
  await expect(page.getByTestId("user-login")).toBeVisible();
}

test("a 401 from the API sends the SPA to the login page (api.ts)", async ({ page }) => {
  await signInViaUi(page);
  await page.route("**/job-tracker/api/auth/me", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unauthorized", message: "x" } }),
    }),
  );
  // The server still serves the shell (the cookie is valid), and it bounces a signed-in /login back
  // to /, so the proof of the client-side redirect is the navigation request to /login itself.
  const [loginRequest] = await Promise.all([
    page.waitForRequest((r) => r.isNavigationRequest() && new URL(r.url()).pathname === LOGIN_PATH),
    page.goto(HOME_PATH),
  ]);
  expect(new URL(loginRequest.url()).pathname).toBe(LOGIN_PATH);
});

test("a failed API call renders the error banner with the server message, and does not redirect", async ({ page }) => {
  await signInViaUi(page);
  await page.route("**/job-tracker/api/auth/me", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "internal", message: "banner-marker" } }),
    }),
  );
  await page.goto(HOME_PATH);
  await expect(page.getByTestId("error-banner")).toBeVisible();
  await expect(page.getByTestId("error-banner")).toHaveText("banner-marker");
  expect(pathOf(page)).toBe(HOME_PATH);
});

test("user-login shows the real GitHub login, not a constant", async ({ page, request }) => {
  const set = await request.post(`${FAKE_GITHUB_URL}/__control/login`, { data: { login: "DevvJS" } });
  expect(set.status()).toBe(200);
  await page.goto(HOME_PATH);
  await page.getByTestId("signin").click();
  await expect.poll(() => pathOf(page)).toBe(HOME_PATH);
  await expect(page.getByTestId("user-login")).toHaveText("DevvJS");
});
