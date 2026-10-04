import type { APIRequestContext } from "@playwright/test";
import { expect, memberStorageState, moderatorStorageState, stagingOrigin, test } from "./fixtures";
import { loginQaIdentities } from "./qa-login";

// Fresh sessions per file: event pages rotate the bearer on read, so a stored
// token is single-use across files — and across tests sharing one file, so
// the waitlist journey below re-signs inside the test. Member + moderator:
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

// Fixture orphaned by that flake; the waitlist journey cancels it best-effort
// if it is still live. ULID-shaped, not a credential (see .gitleaks.toml).
const ORPHAN_EVENT_KEY = "01M41G95P1M3EWP30VWZPFYSG9";

// Moderator owns the journey: a draft is created, published for the RSVP, and
// cancelled in `finally` so the fixture never lingers. Publishing and RSVP
// writes enqueue sync-event carriers (src/events/sync.ts), but with no
// SYNC_EVENT_QUEUE consumer pointed at the live guild there is no Discord
// write-back; the cancelled fixture doubles as the 410 case.
test("staging member RSVPs going on a fixture, then withdraws", async ({ browser }) => {
  const moderator = await browser.newContext({ storageState: moderatorStorageState });
  const member = await browser.newContext({ storageState: memberStorageState });
  let eventKey: string | undefined;
  try {
    const admin = await moderator.newPage();
    await admin.goto("/admin/events");
    await admin.getByRole("link", { name: "New event", exact: true }).click();
    const stem = `Staging E2E RSVP ${Date.now()}`;
    await admin.getByLabel("Title", { exact: true }).fill(stem);
    await admin.getByLabel("Game", { exact: true }).fill("Minecraft");
    await admin
      .getByLabel("Description", { exact: true })
      .fill("Created by the post-deploy staging suite; cancelled after the run.");
    await admin.getByLabel("Starts (local wall time, YYYY-MM-DD HH:mm)").fill("2099-03-01 18:00");
    await admin.getByLabel("Ends (local wall time, YYYY-MM-DD HH:mm)").fill("2099-03-01 20:00");
    await admin.getByLabel("Timezone", { exact: true }).fill("UTC");
    await admin.getByLabel("Location", { exact: true }).fill("Staging lounge");
    await admin.getByLabel("Capacity (empty = unlimited)").fill("10");
    await admin.getByRole("button", { name: "Create draft", exact: true }).click();
    await expect(admin).toHaveURL(/\/admin\/events\/[0-9A-HJKMNP-TV-Z]{26}$/);
    eventKey = new URL(admin.url()).pathname.split("/").at(-1);
    expect(eventKey).toBeDefined();
    await expect(admin.getByRole("heading", { name: "Status: draft", exact: true })).toBeVisible();
    await admin.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(
      admin.getByRole("heading", { name: "Status: published", exact: true }),
    ).toBeVisible();

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
    if (eventKey) {
      expect(await cancelFixtureViaApi(moderator.request, eventKey)).toBe(303);
    }
    await member.close();
    await moderator.close();
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
    await admin.goto("/admin/events");
    await admin.getByRole("link", { name: "New event", exact: true }).click();
    const stem = `Staging E2E Waitlist ${Date.now()}`;
    await admin.getByLabel("Title", { exact: true }).fill(stem);
    await admin.getByLabel("Game", { exact: true }).fill("Minecraft");
    await admin
      .getByLabel("Description", { exact: true })
      .fill("Created by the post-deploy staging suite; cancelled after the run.");
    await admin.getByLabel("Starts (local wall time, YYYY-MM-DD HH:mm)").fill("2099-03-01 18:00");
    await admin.getByLabel("Ends (local wall time, YYYY-MM-DD HH:mm)").fill("2099-03-01 20:00");
    await admin.getByLabel("Timezone", { exact: true }).fill("UTC");
    await admin.getByLabel("Location", { exact: true }).fill("Staging lounge");
    await admin.getByLabel("Capacity (empty = unlimited)").fill("1");
    await admin.getByRole("button", { name: "Create draft", exact: true }).click();
    await expect(admin).toHaveURL(/\/admin\/events\/[0-9A-HJKMNP-TV-Z]{26}$/);
    eventKey = new URL(admin.url()).pathname.split("/").at(-1);
    expect(eventKey).toBeDefined();
    await expect(admin.getByRole("heading", { name: "Status: draft", exact: true })).toBeVisible();
    await admin.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(
      admin.getByRole("heading", { name: "Status: published", exact: true }),
    ).toBeVisible();

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
    // API-only cleanup: the DELETEs are quiet 204s with or without a row and
    // cancel is idempotent, so cleanup holds on every path out of the journey.
    // The orphan below is best-effort — a previous flaked cleanup left it live
    // and this test does not own it, so its outcome is never asserted.
    if (eventKey) {
      await member.request.delete(`/events/${eventKey}/rsvp`, {
        headers: { Origin: stagingOrigin },
      });
      await moderator.request.delete(`/events/${eventKey}/rsvp`, {
        headers: { Origin: stagingOrigin },
      });
      expect(await cancelFixtureViaApi(moderator.request, eventKey)).toBe(303);
      await cancelFixtureViaApi(moderator.request, ORPHAN_EVENT_KEY);
    }
    await member.close();
    await moderator.close();
  }
});
