import { test, expect, qaLogin } from "./fixtures";

test("moderator creates a draft, publishes it and sees it in the public calendar", async ({ page, context }) => {
  await qaLogin(context, "qa-moderator");
  await page.goto("/admin/events");
  await page.getByRole("link", { name: "New event", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("E2E Moderator Game Night");
  await page.getByLabel("Game", { exact: true }).fill("Minecraft");
  await page.getByLabel("Description", { exact: true }).fill("Created and published through the browser.");
  await page.getByLabel("Starts (local wall time, YYYY-MM-DD HH:mm)").fill("2099-02-01 18:00");
  await page.getByLabel("Ends (local wall time, YYYY-MM-DD HH:mm)").fill("2099-02-01 20:00");
  await page.getByLabel("Timezone", { exact: true }).fill("UTC");
  await page.getByLabel("Location", { exact: true }).fill("Community voice");
  await page.getByLabel("Capacity (empty = unlimited)").fill("10");
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/events\/[0-9A-HJKMNP-TV-Z]{26}$/);
  const eventKey = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect(page.getByRole("heading", { name: "Status: draft", exact: true })).toBeVisible();

  const guest = await context.browser()!.newContext({ baseURL: "https://localhost:8787", ignoreHTTPSErrors: true });
  try {
    const draft = await guest.request.get(`/e/${eventKey}`);
    expect(draft.status()).toBe(403);
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Status: published", exact: true })).toBeVisible();
    const published = await guest.request.get(`/e/${eventKey}`);
    expect(published.status()).toBe(200);
    expect(await published.text()).toContain("E2E Moderator Game Night");
  } finally {
    await guest.close();
  }
  await page.goto("/events");
  await page.getByRole("link", { name: "E2E Moderator Game Night", exact: true }).first().click();
  await expect(page).toHaveURL(`/e/${eventKey}`);
  await expect(page.getByRole("heading", { name: "E2E Moderator Game Night", exact: true })).toBeVisible();
});
