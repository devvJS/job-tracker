import { expect, test } from "@playwright/test";

test("the browser loads /job-tracker/ and renders the app shell", async ({ page }) => {
  // After F2 this redirects to /job-tracker/login, which also renders inside app-shell.
  await page.goto("/job-tracker/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  expect(new URL(page.url()).pathname).toMatch(/^\/job-tracker\/(login)?$/);
});

test("healthz returns {ok:true} with noindex", async ({ request }) => {
  const res = await request.get("/job-tracker/healthz");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(res.headers()["x-robots-tag"]).toBe("noindex");
});

test("the browser's own healthz request returns {ok:true}", async ({ page }) => {
  await page.goto("/job-tracker/");
  const body = await page.evaluate(async () => {
    const r = await fetch("/job-tracker/healthz");
    return { status: r.status, json: await r.json() };
  });
  expect(body).toEqual({ status: 200, json: { ok: true } });
});
