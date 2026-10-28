import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { expect, localOrigin, qaLogin, test } from "./fixtures";

// Local pin for the event-pause journey, mirroring e2e/event-waitlist.spec.ts
// without its waitlist seam. Moderator publishes a fixture event, then pauses
// RSVPs through the admin detail form; a member RSVP attempt is refused with
// the paused-closed reason (403 `event_not_open`, `why: "paused"`) and no seat
// changes occur. Reopening restores RSVP, and both transitions persist across
// reload. Runs in the existing CI browser job with no workflow change:
// playwright.config.ts already matches every local spec. Fixture cleanup
// cancels through the request API (no cleanup page); a local-origin-only
// global teardown sweep is the backstop for leftovers.
//
// The refused attempt goes through the request API on purpose: while paused,
// the detail page renders only the paused notice for a member with no answer
// (src/events/rsvp-button.tsx renders no going control when `rsvpOpen` is
// false), so there is no browser control to click. The `why: "paused"`
// assertion below is the mutation pin: dropping the paused reason from the
// refused body turns this spec red.

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

// `finally` cleanup that never throws, so the moderator context below always
// closes. `withdraw` frees every seat first: the DELETEs are quiet 204s with
// or without a row.
async function cleanUpFixture(
  member: BrowserContext,
  moderator: BrowserContext,
  eventKey: string | undefined,
  withdraw: boolean,
): Promise<void> {
  const note = (description: string) =>
    test.info().annotations.push({ type: "fixture-cleanup", description });
  if (eventKey) {
    if (withdraw) {
      for (const context of [member, moderator]) {
        await context.request
          .delete(`/events/${eventKey}/rsvp`, { headers: { Origin: localOrigin } })
          .catch(() => note("rsvp withdraw failed; the cancel below still frees the seat"));
      }
    }
    try {
      const status = await cancelFixtureViaApi(moderator.request, eventKey);
      if (status !== 303)
        note(`cancel answered ${status}; the local teardown sweep is the backstop`);
    } catch {
      note("cancel request failed; the local teardown sweep is the backstop");
    }
  }
}

// Moderator drives the admin form. Split from publishing so the caller holds
// the key before the publish step: a failed publish still leaves the draft
// for the `finally` cleanup to cancel.
async function createDraft(admin: Page, stem: string, capacity: number): Promise<string> {
  await admin.goto("/admin/events");
  await admin.getByRole("link", { name: "New event", exact: true }).click();
  await admin.getByLabel("Title", { exact: true }).fill(stem);
  await admin.getByLabel("Game", { exact: true }).fill("Minecraft");
  await admin
    .getByLabel("Description", { exact: true })
    .fill("Created by the local CI browser suite; cancelled before the run ends.");
  await admin.getByLabel("Starts (local wall time, YYYY-MM-DD HH:mm)").fill("2099-03-01 18:00");
  await admin.getByLabel("Ends (local wall time, YYYY-MM-DD HH:mm)").fill("2099-03-01 20:00");
  await admin.getByLabel("Timezone", { exact: true }).fill("UTC");
  await admin.getByLabel("Location", { exact: true }).fill("Community voice");
  await admin.getByLabel("Capacity (empty = unlimited)").fill(String(capacity));
  await admin.getByRole("button", { name: "Create draft", exact: true }).click();
  await expect(admin).toHaveURL(/\/admin\/events\/[0-9A-HJKMNP-TV-Z]{26}$/);
  const eventKey = new URL(admin.url()).pathname.split("/").at(-1);
  expect(eventKey).toBeDefined();
  await expect(admin.getByRole("heading", { name: "Status: draft", exact: true })).toBeVisible();
  return eventKey as string;
}

async function publishDraft(admin: Page): Promise<void> {
  await admin.getByRole("button", { name: /\bPublish\b/ }).click();
  await expect(
    admin.getByRole("heading", { name: "Status: published", exact: true }),
  ).toBeVisible();
}

// Pause journey on a capacity-10 fixture: the moderator pauses through the
// admin form (303 back to the detail page, which then offers Reopen), the
// member sees the paused notice with no going control, a request-API RSVP
// attempt is refused with the paused-closed reason and the seat count is
// unchanged, then the moderator reopens and the member RSVPs going through
// the browser control. Pause semantics live in src/events/rsvp.ts (paused
// events take no new answers: `closedWhy` returns "paused" when `rsvpOpen`
// is false) and src/events/waitlist.ts (promotion freezes while paused).
test("paused event refuses RSVPs with the paused reason, then reopens", async ({
  page,
  context,
  browser,
}) => {
  // A full fixture lifecycle (two logins, draft, publish, pause, reopen, RSVP
  // writes, several reloads) needs more than the 30s default. Triples the
  // timeout to 90s.
  test.slow();
  // The member drives the browser journey on the default context (so the
  // network-isolation fixture covers it); the moderator works from a second
  // context because the two identities hold different sessions.
  await qaLogin(context, "qa-member");
  const moderator = await browser.newContext({
    baseURL: localOrigin,
    ignoreHTTPSErrors: true,
  });
  await qaLogin(moderator, "qa-moderator");
  let eventKey: string | undefined;
  try {
    const admin = await moderator.newPage();
    const stem = `E2E Pause ${Date.now()}`;
    eventKey = await createDraft(admin, stem, 10);
    await publishDraft(admin);

    await page.goto(`/e/${eventKey}`);
    await expect(page.getByRole("heading", { name: stem, exact: true })).toBeVisible();
    await expect(page.getByTestId("event-going-count")).toContainText("0 of 10 going");
    await expect(page.getByTestId("rsvp-going")).toBeVisible();
    await expect(page.getByTestId("rsvp-paused")).toHaveCount(0);

    // The moderator pauses through the admin review; the 303 lands back on
    // the detail page offering Reopen instead of Pause.
    await admin.getByTestId("rsvp-pause-review").locator("summary").click();
    await admin.getByTestId("rsvp-pause").click();
    await expect(
      admin.getByRole("heading", { name: "Status: published", exact: true }),
    ).toBeVisible();
    await expect(admin.getByTestId("rsvp-reopen")).toBeVisible();

    // The pause persists across reload: the member sees the paused notice and
    // no going control.
    await page.reload();
    await expect(page.getByTestId("rsvp-paused")).toContainText("RSVPs are paused for this event");
    await expect(page.getByTestId("rsvp-going")).toHaveCount(0);
    await expect(page.getByTestId("event-going-count")).toContainText("0 of 10 going");

    // The refused attempt: 403 with the paused-closed reason. The explicit
    // `why` assertion is the mutation pin for the closed reason.
    const refused = await context.request.put(`/events/${eventKey}/rsvp`, {
      data: { status: "going" },
      headers: { Origin: localOrigin },
    });
    expect(refused.status()).toBe(403);
    const refusedBody = (await refused.json()) as { reason: string; why: string };
    expect(refusedBody.reason).toBe("event_not_open");
    expect(refusedBody.why).toBe("paused");

    // No seat changes occurred: the count is unchanged after the refusal.
    await page.reload();
    await expect(page.getByTestId("event-going-count")).toContainText("0 of 10 going");
    await expect(page.getByTestId("rsvp-paused")).toBeVisible();

    // The moderator reopens through the admin form; the detail page offers
    // the pause review again (the final Pause submit stays hidden inside the
    // closed review until a moderator opens it).
    await admin.getByTestId("rsvp-reopen").click();
    await expect(
      admin.getByRole("heading", { name: "Status: published", exact: true }),
    ).toBeVisible();
    await expect(admin.getByTestId("rsvp-pause-review")).toBeVisible();

    // The reopen persists across reload: the paused notice is gone and the
    // going control is back.
    await page.reload();
    await expect(page.getByTestId("rsvp-paused")).toHaveCount(0);
    await expect(page.getByTestId("rsvp-going")).toBeVisible();

    // Resume restores RSVP through the browser control. 201 proves the refused
    // attempt above wrote no row: the first answer after reopening creates it.
    const going = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/events/${eventKey}/rsvp`) &&
        response.request().method() === "PUT",
    );
    await page.getByTestId("rsvp-going").click();
    expect((await going).status()).toBe(201);
    await expect(page.getByTestId("rsvp-confirmed")).toContainText("You're in");
    await expect(page.getByTestId("event-going-count")).toContainText("1 of 10 going");

    // The restored RSVP is stored, not a one-view render: it survives reload.
    await page.reload();
    await expect(page.getByTestId("rsvp-confirmed")).toContainText("You're in");
    await expect(page.getByTestId("event-going-count")).toContainText("1 of 10 going");
    await expect(page.getByTestId("rsvp-paused")).toHaveCount(0);
  } finally {
    // API-only cleanup: cancel is idempotent, so cleanup holds on every path
    // out of the journey (see cleanUpFixture).
    try {
      await cleanUpFixture(context, moderator, eventKey, true);
    } finally {
      await moderator.close().catch(() => {});
    }
  }
});
