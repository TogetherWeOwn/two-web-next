import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { expect, localOrigin, qaLogin, test } from "./fixtures";

// Local pin for the capacity-1 waitlist journey, mirroring
// e2e/staging/event-rsvp.spec.ts without its staging seam (no storageState
// files, no re-sign: every test gets fresh contexts, and the ephemeral QA
// token has no per-minute budget locally). Moderator creates a capacity-1
// fixture event and fills the single seat through the JSON resource; the
// member drives the browser journey through the frozen RSVP testids
// (src/islands/contracts.ts): waitlist-join at #1 in line, leave returning
// the join control, and — on a second fixture — automatic promotion on
// seat-holder withdraw (no claim click, `You're in` + `1 of 1 going`,
// persisting across reload). Runs in the existing CI browser job with no
// workflow change: playwright.config.ts already matches every local spec.
// Fixture cleanup cancels through the request API (no cleanup page); a
// local-origin-only global teardown sweep is the backstop for leftovers.

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
// closes. `withdraw` frees both seats first: the DELETEs are quiet 204s with
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
  await admin.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(
    admin.getByRole("heading", { name: "Status: published", exact: true }),
  ).toBeVisible();
}

// Waitlist journey on a capacity-1 fixture: the moderator fills the single
// seat, the member joins the line at #1, then leaves it. Seat allocation runs
// through the server FIFO (src/events/rsvp.ts settles every new seat request
// through the line and promotes into free seats in the same transaction); the
// journey pins the member-visible states.
test("member joins then leaves the waitlist on a capacity-1 fixture", async ({
  page,
  context,
  browser,
}) => {
  // A full fixture lifecycle (two logins, draft, publish, RSVP writes, two
  // reloads) needs more than the 30s default. Triples the timeout to 90s.
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
    const stem = `E2E Waitlist ${Date.now()}`;
    eventKey = await createDraft(admin, stem, 1);
    await publishDraft(admin);

    // The moderator fills the single seat through the JSON resource — both QA
    // identities are members, so the moderator answers like one. 201: the
    // first answer creates the row, already holding the seat.
    const seat = await moderator.request.put(`/events/${eventKey}/rsvp`, {
      data: { status: "going" },
      headers: { Origin: localOrigin },
    });
    expect(seat.status()).toBe(201);
    expect(((await seat.json()) as { data: { status: string } }).data.status).toBe("going");

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
    try {
      await cleanUpFixture(context, moderator, eventKey, true);
    } finally {
      await moderator.close().catch(() => {});
    }
  }
});

// Promotion journey on a capacity-1 fixture: the moderator holds the single
// seat, the member queues at #1, the moderator withdraws, and the member's next
// page view shows the seat. Promotion is automatic: withdrawRsvp deals the freed
// seat to the FIFO head inside its own transaction (promoteWaitlist in
// src/events/rsvp.ts), so no claim control ever appears for the promoted
// member. The claim button only renders for a waitlisted row on a not-full
// event (src/events/rsvp-button.tsx), so its absence pins that the seat was
// dealt, not offered.
test("waitlisted member is promoted when the seat holder withdraws", async ({
  page,
  context,
  browser,
}) => {
  // Same cost as the join + leave journey: two logins, then a full fixture
  // lifecycle. Triples the timeout to 90s.
  test.slow();
  await qaLogin(context, "qa-member");
  const moderator = await browser.newContext({
    baseURL: localOrigin,
    ignoreHTTPSErrors: true,
  });
  await qaLogin(moderator, "qa-moderator");
  let eventKey: string | undefined;
  try {
    const admin = await moderator.newPage();
    const stem = `E2E Promotion ${Date.now()}`;
    eventKey = await createDraft(admin, stem, 1);
    await publishDraft(admin);

    // 201: the moderator's first answer creates the row, already holding the seat.
    const seat = await moderator.request.put(`/events/${eventKey}/rsvp`, {
      data: { status: "going" },
      headers: { Origin: localOrigin },
    });
    expect(seat.status()).toBe(201);
    expect(((await seat.json()) as { data: { status: string } }).data.status).toBe("going");

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
      headers: { Origin: localOrigin },
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
    try {
      await cleanUpFixture(context, moderator, eventKey, true);
    } finally {
      await moderator.close().catch(() => {});
    }
  }
});
