import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { expect, memberStorageState, moderatorStorageState, stagingOrigin, test } from "./fixtures";
import { loginQaIdentities } from "./qa-login";

// Fresh sessions per file: event pages rotate the bearer on read, so a stored
// token is single-use across files — and across tests sharing one file, so
// the waitlist journeys below re-sign inside the test. Member + moderator:
// two logins — the journeys need both identities.
test.beforeAll(async () => {
  await loginQaIdentities();
});

// Fixture cleanup cancels through the contexts' request API, never by opening
// a fresh page: a cleanup-time `newPage` flaked with `Protocol error
// Target.createTarget`, orphaning the fixture it was meant to cancel. The
// cancel form endpoint needs only the session cookie plus the explicit staging
// Origin the same-origin guard requires (the request API sends neither Origin
// nor Fetch Metadata on its own).
async function cancelFixtureViaApi(request: APIRequestContext, eventKey: string): Promise<number> {
  const response = await request.post(`/admin/events/${eventKey}/cancel`, {
    headers: { Origin: stagingOrigin },
    maxRedirects: 0,
  });
  return response.status();
}

// `finally` cleanup that never throws, so the contexts below always close.
// A test timeout closes both contexts before this runs, and every request then
// fails with `Failed to find browser context`; throwing there used to skip the
// close and orphan the fixture. A cancel that misses is recorded here and
// retried by the global teardown sweep (global-teardown.ts), which fails the
// run only if a fixture is still live after it. `withdraw` frees both seats
// first: the DELETEs are quiet 204s with or without a row.
async function cleanUpFixture(
  moderator: BrowserContext,
  member: BrowserContext,
  eventKey: string | undefined,
  withdraw: boolean,
): Promise<void> {
  const note = (description: string) =>
    test.info().annotations.push({ type: "fixture-cleanup", description });
  if (eventKey) {
    if (withdraw) {
      for (const context of [member, moderator]) {
        await context.request
          .delete(`/events/${eventKey}/rsvp`, { headers: { Origin: stagingOrigin } })
          .catch(() => note("rsvp withdraw failed; the cancel below still frees the seat"));
      }
    }
    try {
      const status = await cancelFixtureViaApi(moderator.request, eventKey);
      if (status !== 303) note(`cancel answered ${status}; global teardown sweeps the fixture`);
    } catch {
      note("cancel request failed; global teardown sweeps the fixture");
    }
  }
  await Promise.allSettled([member.close(), moderator.close()]);
}

// Moderator drives the admin form. Split from publishing so the caller holds the
// key before the publish step: a failed publish still leaves the draft for the
// `finally` cleanup to cancel.
async function createDraft(admin: Page, stem: string, capacity: number): Promise<string> {
  await admin.goto("/admin/events");
  await admin.getByRole("link", { name: "New event", exact: true }).click();
  await admin.getByLabel("Title", { exact: true }).fill(stem);
  await admin.getByLabel("Game", { exact: true }).fill("Minecraft");
  await admin
    .getByLabel("Description", { exact: true })
    .fill("Created by the post-deploy staging suite; cancelled after the run.");
  await admin.getByLabel("Starts (local wall time, YYYY-MM-DD HH:mm)").fill("2099-03-01 18:00");
  await admin.getByLabel("Ends (local wall time, YYYY-MM-DD HH:mm)").fill("2099-03-01 20:00");
  await admin.getByLabel("Timezone", { exact: true }).fill("UTC");
  await admin.getByLabel("Location", { exact: true }).fill("Staging lounge");
  await admin.getByLabel("Capacity (empty = unlimited)").fill(String(capacity));
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

// Moderator owns the journey: a draft is created, published for the RSVP, and
// cancelled in `finally` so the fixture never lingers. Publishing and RSVP
// writes enqueue sync-event carriers (src/events/sync.ts), but with no
// SYNC_EVENT_QUEUE consumer pointed at the live guild there is no Discord
// write-back; the cancelled fixture doubles as the 410 case.
test("staging member RSVPs going on a fixture, then withdraws", async ({ browser }) => {
  // Admin form, publish, RSVP, two reloads and a withdraw: run 37192224803 hit
  // the 30s default on a slow episode, which closed the contexts mid-journey
  // and orphaned the fixture. Triples the timeout to 90s.
  test.slow();
  const moderator = await browser.newContext({ storageState: moderatorStorageState });
  const member = await browser.newContext({ storageState: memberStorageState });
  let eventKey: string | undefined;
  try {
    const admin = await moderator.newPage();
    const stem = `Staging E2E RSVP ${Date.now()}`;
    eventKey = await createDraft(admin, stem, 10);
    await publishDraft(admin);

    const page = await member.newPage();
    await page.goto(`/e/${eventKey}`);
    await expect(page.getByRole("heading", { name: stem, exact: true })).toBeVisible();
    await expect(page.getByTestId("rsvp-going")).toBeVisible();
    const going = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/events/${eventKey}/rsvp`) &&
        response.request().method() === "PUT",
    );
    await page.getByTestId("rsvp-going").click();
    expect((await going).status()).toBe(201);
    await expect(page.getByTestId("rsvp-confirmed")).toContainText("You're in");
    await page.reload();
    await expect(page.getByTestId("rsvp-confirmed")).toContainText("You're in");
    const withdrawn = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/events/${eventKey}/rsvp`) &&
        response.request().method() === "DELETE",
    );
    await page.getByTestId("rsvp-withdraw").click();
    expect((await withdrawn).status()).toBe(204);
    await expect(page.getByTestId("rsvp-going")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("rsvp-going")).toBeVisible();
    await expect(page.getByTestId("rsvp-confirmed")).toHaveCount(0);
  } finally {
    await cleanUpFixture(moderator, member, eventKey, false);
  }
});

// Waitlist journey on a capacity-1 fixture: the moderator fills the single
// seat, the member joins the line at #1, then leaves it. Seat allocation runs
// through the server FIFO (src/events/rsvp.ts settles every new seat request
// through the line and promotes into free seats in the same transaction); the
// journey pins the member-visible states. Never published outside the fixture.
test("staging member joins then leaves the waitlist on a capacity-1 fixture", async ({
  browser,
}) => {
  // Slow staging needs more than the 30s default: the re-sign below launches
  // two browsers, then the journey drives a full fixture lifecycle. Triples
  // the timeout to 90s.
  test.slow();
  // The going/withdraw journey above already spent this file's stored bearers:
  // every authenticated event-page view rotates the session token server-side,
  // so the on-disk bearer is dead by now and the member page would render as a
  // guest with no waitlist controls. Re-sign both identities first (the earlier
  // contexts are closed); two extra hits stay under the 10/min QA-login budget.
  await loginQaIdentities();
  const moderator = await browser.newContext({ storageState: moderatorStorageState });
  const member = await browser.newContext({ storageState: memberStorageState });
  let eventKey: string | undefined;
  try {
    const admin = await moderator.newPage();
    const stem = `Staging E2E Waitlist ${Date.now()}`;
    eventKey = await createDraft(admin, stem, 1);
    await publishDraft(admin);

    // The moderator fills the single seat through the JSON resource — both QA
    // identities are members, so the moderator answers like one. 201: the
    // first answer creates the row, already holding the seat.
    const seat = await moderator.request.put(`/events/${eventKey}/rsvp`, {
      data: { status: "going" },
      headers: { Origin: stagingOrigin },
    });
    expect(seat.status()).toBe(201);
    expect(((await seat.json()) as { data: { status: string } }).data.status).toBe("going");

    const page = await member.newPage();
    await page.goto(`/e/${eventKey}`);
    await expect(page.getByRole("heading", { name: stem, exact: true })).toBeVisible();
    await expect(page.getByTestId("event-going-count")).toContainText("1 of 1 going");
    await expect(page.getByTestId("event-full")).toContainText("This one's full.");
    await expect(page.getByTestId("waitlist-join")).toBeVisible();
    const joined = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/events/${eventKey}/rsvp`) &&
        response.request().method() === "PUT",
    );
    await page.getByTestId("waitlist-join").click();
    const joinResponse = await joined;
    expect(joinResponse.status()).toBe(201);
    const joinBody = (await joinResponse.json()) as {
      data: { status: string; waitlist_position: number | null };
    };
    expect(joinBody.data.status).toBe("waitlisted");
    expect(joinBody.data.waitlist_position).toBe(1);
    await expect(page.getByTestId("waitlist-position")).toContainText("#1 in line");
    await expect(page.getByTestId("waitlist-leave")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("waitlist-position")).toContainText("#1 in line");
    await expect(page.getByTestId("waitlist-leave")).toBeVisible();
    await expect(page.getByTestId("waitlist-claim")).toHaveCount(0);

    const left = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/events/${eventKey}/rsvp`) &&
        response.request().method() === "DELETE",
    );
    await page.getByTestId("waitlist-leave").click();
    expect((await left).status()).toBe(204);
    await expect(page.getByTestId("waitlist-join")).toBeVisible();
    await expect(page.getByTestId("event-full")).toBeVisible();
    await expect(page.getByTestId("waitlist-position")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("waitlist-join")).toBeVisible();
    await expect(page.getByTestId("waitlist-position")).toHaveCount(0);
  } finally {
    // API-only cleanup: cancel is idempotent, so cleanup holds on every path
    // out of the journey (see cleanUpFixture).
    await cleanUpFixture(moderator, member, eventKey, true);
  }
});

// Promotion journey on a capacity-1 fixture: the moderator holds the single
// seat, the member queues at #1, the moderator withdraws, and the member's next
// page view shows the seat. Promotion is automatic: withdrawRsvp deals the freed
// seat to the FIFO head inside its own transaction (promoteWaitlist in
// src/events/rsvp.ts), so no claim control ever appears for the promoted
// member. The claim button only renders for a waitlisted row on a not-full
// event (src/events/rsvp-button.tsx), so its absence pins that the seat was
// dealt, not offered. Never published outside the fixture.
test("staging waitlisted member is promoted when the seat holder withdraws", async ({
  browser,
}) => {
  // Same cost as the join + leave journey: a re-sign that launches two
  // browsers, then a full fixture lifecycle. Triples the timeout to 90s.
  test.slow();
  // The earlier tests in this file spent the stored bearers (event-page views
  // rotate the session token), so re-sign both identities; two more hits stay
  // under the 10/min QA-login budget.
  await loginQaIdentities();
  const moderator = await browser.newContext({ storageState: moderatorStorageState });
  const member = await browser.newContext({ storageState: memberStorageState });
  let eventKey: string | undefined;
  try {
    const admin = await moderator.newPage();
    const stem = `Staging E2E Promotion ${Date.now()}`;
    eventKey = await createDraft(admin, stem, 1);
    await publishDraft(admin);

    // 201: the moderator's first answer creates the row, already holding the seat.
    const seat = await moderator.request.put(`/events/${eventKey}/rsvp`, {
      data: { status: "going" },
      headers: { Origin: stagingOrigin },
    });
    expect(seat.status()).toBe(201);
    expect(((await seat.json()) as { data: { status: string } }).data.status).toBe("going");

    const page = await member.newPage();
    await page.goto(`/e/${eventKey}`);
    await expect(page.getByRole("heading", { name: stem, exact: true })).toBeVisible();
    await expect(page.getByTestId("event-going-count")).toContainText("1 of 1 going");
    await expect(page.getByTestId("event-full")).toContainText("This one's full.");
    const joined = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/events/${eventKey}/rsvp`) &&
        response.request().method() === "PUT",
    );
    await page.getByTestId("waitlist-join").click();
    expect((await joined).status()).toBe(201);
    await expect(page.getByTestId("waitlist-position")).toContainText("#1 in line");
    await page.reload();
    await expect(page.getByTestId("waitlist-position")).toContainText("#1 in line");
    await expect(page.getByTestId("waitlist-claim")).toHaveCount(0);

    // The seat holder withdraws; the quiet 204 commits the promotion with it.
    const withdrawn = await moderator.request.delete(`/events/${eventKey}/rsvp`, {
      headers: { Origin: stagingOrigin },
    });
    expect(withdrawn.status()).toBe(204);

    // The member's page was rendered before the promotion; a reload shows the
    // seat as an ordinary confirmed RSVP, with the line, the claim control and
    // the full notice gone, and the seat count unchanged (1 seat, 1 going).
    await page.reload();
    await expect(page.getByTestId("rsvp-confirmed")).toContainText("You're in");
    await expect(page.getByTestId("rsvp-withdraw")).toBeVisible();
    await expect(page.getByTestId("event-going-count")).toContainText("1 of 1 going");
    await expect(page.getByTestId("waitlist-position")).toHaveCount(0);
    await expect(page.getByTestId("waitlist-claim")).toHaveCount(0);
    await expect(page.getByTestId("waitlist-join")).toHaveCount(0);
    await expect(page.getByTestId("waitlist-leave")).toHaveCount(0);
    await expect(page.getByTestId("event-full")).toHaveCount(0);
    // The promotion is stored, not a one-view render: it survives another load.
    await page.reload();
    await expect(page.getByTestId("rsvp-confirmed")).toContainText("You're in");
    await expect(page.getByTestId("waitlist-position")).toHaveCount(0);
  } finally {
    // API-only cleanup, as in the join + leave journey. The member now holds the
    // seat, so its DELETE is the one that frees it.
    await cleanUpFixture(moderator, member, eventKey, true);
  }
});
