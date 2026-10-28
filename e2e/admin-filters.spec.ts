import type { Page } from "@playwright/test";
import { expect, localOrigin, qaLogin, test } from "./fixtures";

// Moderator admin event-list journey against local wrangler dev + disposable
// Postgres: create two fixtures (a draft with RSVPs open by default, and a
// second draft that is published below), prove the publish path the old
// admin.spec pinned (draft hidden from guest with 403, published guest view
// 200, public calendar navigation), pause the published fixture's RSVPs, then
// prove the Status and RSVPs filters each show only matching rows through
// the frozen filter controls (src/admin/pages/events-list.tsx): Status
// select, RSVPs select (Open = rsvp_open=1, Paused = rsvp_open=0), Filter
// button, events-table / events-empty testids. The run ends with the
// event-cancel finale the old admin.spec pinned (JSON cancel, guest 410
// notice, refused RSVP write, STATUS:CANCELLED feed) on the published
// fixture. Guest-redirect and member-403 are unit-pinned and not re-proven
// here. This file subsumes the create/publish/calendar/cancel journey so the
// sequential smoke holds its 10/min shared `qa-login` throttle budget (one
// login here, none elsewhere added): POST /auth/qa/:identity is throttled at
// 10/min per runner IP (src/throttle.ts), so a separate create/publish spec
// file would push the run to 11 logins and 429 the late profile journeys.
// Fixtures are cancelled in `finally` through the request API (cancel is
// terminal, so the journey-cancelled fixture needs no cleanup); the local
// teardown sweep is the backstop.

async function createDraft(
  page: Page,
  title: string,
  accessibilityNotes?: string,
): Promise<string> {
  await page.goto("/admin/events");
  await page.getByRole("link", { name: "New event", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Game", { exact: true }).fill("Minecraft");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Created by the local CI browser suite; cancelled before the run ends.");
  await page.getByLabel("Starts (local wall time, YYYY-MM-DD HH:mm)").fill("2099-03-01 18:00");
  await page.getByLabel("Ends (local wall time, YYYY-MM-DD HH:mm)").fill("2099-03-01 20:00");
  await page.getByLabel("Timezone", { exact: true }).fill("UTC");
  await page.getByLabel("Location", { exact: true }).fill("Community voice");
  await page.getByLabel("Capacity (empty = unlimited)").fill("10");
  if (accessibilityNotes !== undefined)
    await page.getByLabel("Accessibility notes", { exact: true }).fill(accessibilityNotes);
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/events\/[0-9A-HJKMNP-TV-Z]{26}$/);
  const eventKey = new URL(page.url()).pathname.split("/").at(-1)!;
  expect(eventKey).toBeDefined();
  await expect(page.getByRole("heading", { name: "Status: draft", exact: true })).toBeVisible();
  return eventKey;
}

test("moderator publishes, filters and cancels an event; guests see the notice", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  await qaLogin(context, "qa-moderator");
  const stamp = Date.now();
  const draftTitle = `E2E Filter Draft ${stamp}`;
  const pausedTitle = `E2E Filter Paused ${stamp}`;
  const publishedNotes = "Step-free entrance; a quiet room is available.";
  let draftKey: string | undefined;
  let pausedKey: string | undefined;
  // Guest requests spend no QA-login budget: plain unauthenticated context.
  const guest = await context
    .browser()!
    .newContext({ baseURL: localOrigin, ignoreHTTPSErrors: true });
  try {
    // 1. Two fixtures with disjoint status + RSVP states: a draft (RSVPs
    // open by schema default) and a second draft published below.
    draftKey = await createDraft(page, draftTitle);
    pausedKey = await createDraft(page, pausedTitle, publishedNotes);

    // 2. Publish path (subsumes the old create/publish spec): the draft is
    // hidden from guests, publishing flips the status, and the published
    // event renders for guests and on the public calendar.
    const draft = await guest.request.get(`/e/${draftKey}`, { maxRedirects: 0 });
    expect(draft.status()).toBe(403);
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Status: published", exact: true }),
    ).toBeVisible();
    const published = await guest.request.get(`/e/${pausedKey}`, { maxRedirects: 0 });
    expect(published.status()).toBe(200);
    expect(await published.text()).toContain(pausedTitle);
    await page.goto("/events");
    await page.getByRole("link", { name: pausedTitle, exact: true }).first().click();
    await expect(page).toHaveURL(`/e/${pausedKey}`);
    await expect(page.getByRole("heading", { name: pausedTitle, exact: true })).toBeVisible();

    const guestEventPage = await guest.newPage();
    const publishedPage = await guestEventPage.goto(`/e/${pausedKey}`);
    expect(publishedPage?.status()).toBe(200);
    await expect(
      guestEventPage.getByRole("heading", { name: pausedTitle, exact: true }),
    ).toBeVisible();
    await expect(guestEventPage.getByText(/^Accessibility(?: notes)?$/i)).toBeVisible();
    await expect(guestEventPage.getByText(publishedNotes, { exact: true })).toBeVisible();

    // 3. Pause the published fixture's RSVPs from its edit screen. The
    // Reopen control proves the paused state stuck.
    await page.goto(`/admin/events/${pausedKey}`);
    await page.getByTestId("rsvp-pause-review").locator("summary").click();
    await page.getByRole("button", { name: "Pause RSVPs", exact: true }).click();
    await expect(page.getByRole("button", { name: "Reopen RSVPs", exact: true })).toBeVisible();

    const table = page.getByTestId("events-table");
    const rowFor = (title: string) => table.locator("tbody tr", { hasText: title });

    // 4. Status filter: drafts only.
    await page.goto("/admin/events");
    await page.getByLabel("Status", { exact: true }).selectOption("draft");
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await expect(page).toHaveURL(/status=draft/);
    await expect(table).toBeVisible();
    await expect(rowFor(draftTitle)).toHaveCount(1);
    await expect(rowFor(pausedTitle)).toHaveCount(0);

    // 5. Status filter: published only.
    await page.goto("/admin/events");
    await page.getByLabel("Status", { exact: true }).selectOption("published");
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await expect(page).toHaveURL(/status=published/);
    await expect(rowFor(pausedTitle)).toHaveCount(1);
    await expect(rowFor(draftTitle)).toHaveCount(0);

    // 6. RSVPs filter: Open shows the draft, hides the paused event.
    await page.goto("/admin/events");
    await page.getByLabel("RSVPs", { exact: true }).selectOption("1");
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await expect(page).toHaveURL(/rsvp_open=1/);
    await expect(rowFor(draftTitle)).toHaveCount(1);
    await expect(rowFor(pausedTitle)).toHaveCount(0);

    // 7. RSVPs filter: Paused shows the paused event, hides the draft.
    await page.goto("/admin/events");
    await page.getByLabel("RSVPs", { exact: true }).selectOption("0");
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await expect(page).toHaveURL(/rsvp_open=0/);
    await expect(rowFor(pausedTitle)).toHaveCount(1);
    await expect(rowFor(draftTitle)).toHaveCount(0);

    // 8. Cancel finale: the moderator cancels the published fixture through
    // the JSON transition (src/events/routes-writes.ts) and the run proves
    // the guest-visible cancellation contract on the same login — no second
    // login spends the shared 10/min qa-login budget (src/throttle.ts).
    const cancelledKey = pausedKey!;
    const cancel = await context.request.post(`/events/${cancelledKey}/cancel`, {
      headers: { Origin: localOrigin },
    });
    expect(cancel.status()).toBe(200);
    expect(((await cancel.json()) as { data: { status: string } }).data.status).toBe("cancelled");
    // Cancel is terminal, so the fixture needs no finally cleanup.
    pausedKey = undefined;

    // The guest now sees the cancelled notice (frozen testid) on the 410 page.
    const guestPage = await guest.newPage();
    const gone = await guestPage.goto(`/e/${cancelledKey}`);
    expect(gone?.status()).toBe(410);
    await expect(guestPage.getByTestId("event-cancelled")).toContainText("Cancelled");

    // The JSON show names the cancellation.
    const show = await context.request.get(`/events/${cancelledKey}`);
    expect(show.status()).toBe(410);
    expect(await show.json()).toEqual({
      reason: "event_cancelled",
      message: "This event was cancelled.",
      event_key: cancelledKey,
      status: "cancelled",
    });

    // RSVP writes against the cancelled event are refused: the PUT answers
    // 403 naming the cancellation (the JSON show above carries the
    // `event_cancelled` reason; the RSVP resource names the same closure as
    // `event_not_open` with `why: "cancelled"`).
    const rsvp = await context.request.put(`/events/${cancelledKey}/rsvp`, {
      data: { status: "going" },
      headers: { Origin: localOrigin },
    });
    expect(rsvp.status()).toBe(403);
    expect(await rsvp.json()).toMatchObject({ reason: "event_not_open", why: "cancelled" });

    // The per-event feed still downloads for a cancelled event and renders
    // the cancellation.
    const ics = await guest.request.get(`/events/${cancelledKey}.ics`);
    expect(ics.status()).toBe(200);
    const icsBody = await ics.text();
    expect(icsBody).toContain("STATUS:CANCELLED");
    expect(icsBody).toContain(`UID:${cancelledKey}@`);
  } finally {
    await guest.close().catch(() => {});
    // API-only cleanup: cancel is idempotent, so cleanup holds on every
    // path out of the journey. Same-origin guard needs the explicit
    // Origin; 303 = cancelled, 404 = already gone. Never throws.
    for (const eventKey of [draftKey, pausedKey]) {
      if (!eventKey) continue;
      try {
        const status = await page.request
          .post(`/admin/events/${eventKey}/cancel`, {
            headers: { Origin: localOrigin },
            maxRedirects: 0,
            timeout: 5_000,
          })
          .then((response) => response.status())
          .catch(() => -1);
        if (status !== 303 && status !== 404) {
          test.info().annotations.push({
            type: "fixture-cleanup",
            description: JSON.stringify({ eventKey, status }),
          });
        }
      } catch {
        test.info().annotations.push({
          type: "fixture-cleanup",
          description: `cancel request failed for ${eventKey}; the local teardown sweep is the backstop`,
        });
      }
    }
  }
});
