import type { APIRequestContext, Page } from "@playwright/test";
import { expect, localOrigin, qaLogin, test } from "./fixtures";

// Local calendar-month journey: two published fixtures in two months, then a
// real browser drive of /events?view=calendar&month=<non-default month>.
// Proves the chosen month's events render and the other month's do not, with
// the month state asserted before any screenshot/axe step (this spec takes
// neither). Follows the e2e/admin.spec.ts moderator create→publish pattern
// and the #647 finally-cleanup pattern from e2e/event-waitlist.spec.ts:
// fixtures are cancelled in `finally` through the request API, so no orphans
// on failure. Isolation comes from ./fixtures (local-origin route blocking +
// Worker outbound guard): only https://localhost:8787 is ever touched, every
// direct API helper disables redirects, and nothing reaches staging,
// production, Discord or any other non-local host.

// The cancel form endpoint needs only the session cookie plus the explicit
// local Origin the same-origin guard requires (the request API sends neither
// Origin nor Fetch Metadata on its own).
async function cancelFixtureViaApi(request: APIRequestContext, eventKey: string): Promise<number> {
  const response = await request.post(`/admin/events/${eventKey}/cancel`, {
    headers: { Origin: localOrigin },
    maxRedirects: 0,
  });
  const status = response.status();
  console.info("event-fixture-cleanup", JSON.stringify({ eventKey, status }));
  return status;
}

// Moderator drives the admin form. Split from publishing so the caller holds
// the key before the publish step: a failed publish still leaves the draft
// for the `finally` cleanup to cancel.
async function createDraft(
  admin: Page,
  title: string,
  starts: string,
  ends: string,
): Promise<string> {
  await admin.goto("/admin/events");
  await admin.getByRole("link", { name: "New event", exact: true }).click();
  await admin.getByLabel("Title", { exact: true }).fill(title);
  await admin.getByLabel("Game", { exact: true }).fill("Minecraft");
  await admin
    .getByLabel("Description", { exact: true })
    .fill("Created by the local CI browser suite; cancelled before the run ends.");
  await admin.getByLabel("Starts (local wall time, YYYY-MM-DD HH:mm)").fill(starts);
  await admin.getByLabel("Ends (local wall time, YYYY-MM-DD HH:mm)").fill(ends);
  await admin.getByLabel("Timezone", { exact: true }).fill("UTC");
  await admin.getByLabel("Location", { exact: true }).fill("Community voice");
  await admin.getByLabel("Capacity (empty = unlimited)").fill("10");
  await admin.getByRole("button", { name: "Create draft", exact: true }).click();
  await expect(admin).toHaveURL(/\/admin\/events\/[0-9A-HJKMNP-TV-Z]{26}$/);
  const eventKey = new URL(admin.url()).pathname.split("/").at(-1);
  expect(eventKey).toBeDefined();
  await expect(admin.getByRole("heading", { name: "Status: draft", exact: true })).toBeVisible();
  return eventKey as string;
}

async function publishDraft(admin: Page): Promise<void> {
  await admin.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(
    admin.getByRole("heading", { name: "Status: published", exact: true }),
  ).toBeVisible();
}

test("calendar month view shows the chosen month and hides the other month", async ({
  page,
  context,
}) => {
  // Two full fixture lifecycles (login, two drafts, two publishes, two month
  // renders) need more than the 30s default. Triples the timeout to 90s, like
  // the waitlist journeys.
  test.slow();
  await qaLogin(context, "qa-moderator");
  // Six-digit suffix keeps each title at 18 chars, so the grid renders it in
  // full (grid titles truncate past 18): the assertions below match exact
  // fixture titles, not shared prefixes.
  const suffix = String(Date.now()).slice(-6);
  const mayTitle = `E2E Cal May ${suffix}`;
  const junTitle = `E2E Cal Jun ${suffix}`;
  const eventKeys: string[] = [];
  try {
    // Mid-month UTC fixtures in two far-future months. The seeded E2E fixture
    // opens the default month on 2099-01, so 2099-05 is a non-default month;
    // mid-month dates never leak into a neighbour month's leading/trailing
    // grid days.
    eventKeys.push(await createDraft(page, mayTitle, "2099-05-15 18:00", "2099-05-15 20:00"));
    await publishDraft(page);
    eventKeys.push(await createDraft(page, junTitle, "2099-06-15 18:00", "2099-06-15 20:00"));
    await publishDraft(page);

    // The journey: drive the non-default month directly in a real browser.
    await page.goto("/events?view=calendar&month=2099-05");
    await expect(page.getByTestId("calendar-month")).toHaveText("May 2099");
    await expect(page.getByTestId("events-calendar")).toHaveAttribute("data-month", "2099-05");
    const grid = page.getByTestId("events-calendar-grid");
    await expect(grid).toBeVisible();
    // State first: the chosen month renders, the other month does not. No
    // screenshot or axe step runs before these assertions.
    await expect(grid).toContainText(mayTitle);
    await expect(grid).not.toContainText(junTitle);

    // The month param drives the render in both directions.
    await page.goto("/events?view=calendar&month=2099-06");
    await expect(page.getByTestId("calendar-month")).toHaveText("June 2099");
    await expect(page.getByTestId("events-calendar")).toHaveAttribute("data-month", "2099-06");
    const juneGrid = page.getByTestId("events-calendar-grid");
    await expect(juneGrid).toBeVisible();
    await expect(juneGrid).toContainText(junTitle);
    await expect(juneGrid).not.toContainText(mayTitle);
  } finally {
    // API-only cleanup: cancel is idempotent, so cleanup holds on every path
    // out of the journey. Never throws; the local teardown sweep stays
    // waitlist-only.
    const note = (description: string) =>
      test.info().annotations.push({ type: "fixture-cleanup", description });
    for (const eventKey of eventKeys) {
      try {
        const status = await cancelFixtureViaApi(context.request, eventKey);
        if (status !== 303)
          note(`cancel answered ${status} for ${eventKey}; disposable CI DB is the backstop`);
      } catch {
        note(`cancel request failed for ${eventKey}; disposable CI DB is the backstop`);
      }
    }
  }
});
