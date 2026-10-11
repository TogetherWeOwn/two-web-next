import type { APIRequestContext, BrowserContext } from "@playwright/test";
import { expect, localOrigin, qaLogin, test } from "./fixtures";

// Local pin for the event-cancel journey: a moderator publishes a fixture
// event through the JSON resource, cancels it through the JSON transition
// (src/events/routes-writes.ts), and the run proves the guest-visible
// cancellation contract: the detail page renders the frozen `event-cancelled`
// notice (src/events/pages-gone.tsx), the JSON show refuses with
// `event_cancelled` (410, src/events/routes-detail.tsx), later RSVP writes
// are refused (403 `event_not_open` with `why: "cancelled"`,
// src/events/routes-rsvp.tsx), and the per-event ICS feed renders
// `STATUS:CANCELLED` (src/events/feeds.ts). Hermetic by construction: every
// step targets the local worker (https://localhost:8787 on the disposable CI
// Postgres); the network-isolation fixture fails the run on any Discord,
// staging or other external traffic. Fixture cleanup cancels through the
// request API in `finally`; the local-origin teardown sweep is the backstop
// for leftovers (e2e/local-fixture-sweep.mjs). Runs in the existing CI
// browser job with no workflow change: playwright.config.ts already matches
// every local spec.

// Create + publish through the moderator JSON resource so the cancel step
// exercises the exact transition the journey locks (not the admin form).
async function createPublishedFixture(request: APIRequestContext, stem: string): Promise<string> {
  const created = await request.post("/events", {
    data: {
      title: stem,
      game: "Minecraft",
      description: "Created by the local CI browser suite; cancelled before the run ends.",
      starts_at: "2099-03-01 18:00",
      ends_at: "2099-03-01 20:00",
      timezone: "UTC",
      location: "Community voice",
      capacity: 10,
    },
    headers: { Origin: localOrigin },
  });
  expect(created.status()).toBe(201);
  const key = ((await created.json()) as { data: { event_key: string; status: string } }).data;
  expect(key.status).toBe("draft");
  expect(key.event_key).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

  const published = await request.post(`/events/${key.event_key}/publish`, {
    headers: { Origin: localOrigin },
  });
  expect(published.status()).toBe(200);
  expect(((await published.json()) as { data: { status: string } }).data.status).toBe("published");
  return key.event_key;
}

// The JSON cancel transition needs only the session cookie plus the explicit
// local Origin the same-origin guard requires (the request API sends neither
// Origin nor Fetch Metadata on its own).
async function cancelFixtureViaApi(request: APIRequestContext, eventKey: string): Promise<number> {
  const response = await request.post(`/events/${eventKey}/cancel`, {
    headers: { Origin: localOrigin },
  });
  const status = response.status();
  console.info("event-fixture-cleanup", JSON.stringify({ eventKey, status }));
  return status;
}

// `finally` cleanup that never throws. Cancel is terminal: the journey's own
// cancel lands 200, so a cleanup retry answers 422 — both mean no
// guest-visible draft or published row remains.
async function cleanUpFixture(
  moderator: BrowserContext,
  eventKey: string | undefined,
): Promise<void> {
  const note = (description: string) =>
    test.info().annotations.push({ type: "fixture-cleanup", description });
  if (!eventKey) return;
  try {
    const status = await cancelFixtureViaApi(moderator.request, eventKey);
    if (status !== 200 && status !== 422)
      note(`cancel answered ${status}; the local teardown sweep is the backstop`);
  } catch {
    note("cancel request failed; the local teardown sweep is the backstop");
  }
}

test("moderator cancels a published event; guests see the notice and writes stay closed", async ({
  page,
  browser,
}) => {
  // Two logins plus a full fixture lifecycle (create, publish, cancel, RSVP
  // refusal, feed read, two guest page views) needs more than the 30s
  // default. Triples the timeout to 90s.
  test.slow();
  // The guest drives the default browser context (never signed in, so the
  // network-isolation fixture covers its page views); the moderator and the
  // member work from separate contexts because each identity holds its own
  // session.
  const moderator = await browser.newContext({
    baseURL: localOrigin,
    ignoreHTTPSErrors: true,
  });
  const member = await browser.newContext({
    baseURL: localOrigin,
    ignoreHTTPSErrors: true,
  });
  await qaLogin(moderator, "qa-moderator");
  await qaLogin(member, "qa-member");
  let eventKey: string | undefined;
  try {
    const stem = `E2E Cancel ${Date.now()}`;
    eventKey = await createPublishedFixture(moderator.request, stem);

    // Published and guest-visible before the cancel: the title renders with
    // no cancellation notice.
    await page.goto(`/e/${eventKey}`);
    await expect(page.getByRole("heading", { name: stem, exact: true })).toBeVisible();
    await expect(page.getByTestId("event-cancelled")).toHaveCount(0);

    // The moderator cancels through the JSON transition.
    const cancel = await moderator.request.post(`/events/${eventKey}/cancel`, {
      headers: { Origin: localOrigin },
    });
    expect(cancel.status()).toBe(200);
    expect(((await cancel.json()) as { data: { status: string } }).data.status).toBe("cancelled");

    // The guest now sees the cancelled notice (frozen testid) on the 410 page.
    const gone = await page.goto(`/e/${eventKey}`);
    expect(gone?.status()).toBe(410);
    await expect(page.getByTestId("event-cancelled")).toContainText("Cancelled");

    // The JSON show refuses with the exact legacy Gone body.
    const show = await page.request.get(`/events/${eventKey}`);
    expect(show.status()).toBe(410);
    expect(await show.json()).toEqual({
      reason: "event_cancelled",
      message: "This event was cancelled.",
      event_key: eventKey,
      status: "cancelled",
    });

    // RSVP writes against the cancelled event are refused: the member's PUT
    // answers 403 naming the cancellation (the JSON show above carries the
    // `event_cancelled` reason; the RSVP resource names the same closure as
    // `event_not_open` with `why: "cancelled"`).
    const rsvp = await member.request.put(`/events/${eventKey}/rsvp`, {
      data: { status: "going" },
      headers: { Origin: localOrigin },
    });
    expect(rsvp.status()).toBe(403);
    expect(await rsvp.json()).toMatchObject({ reason: "event_not_open", why: "cancelled" });

    // The per-event feed still downloads for a cancelled event and renders
    // the cancellation.
    const ics = await page.request.get(`/events/${eventKey}.ics`);
    expect(ics.status()).toBe(200);
    const icsBody = await ics.text();
    expect(icsBody).toContain("STATUS:CANCELLED");
    expect(icsBody).toContain(`UID:${eventKey}@`);
  } finally {
    // API-only cleanup: cancel is terminal, so cleanup holds on every path
    // out of the journey (see cleanUpFixture).
    try {
      await cleanUpFixture(moderator, eventKey);
    } finally {
      await member.close().catch(() => {});
      await moderator.close().catch(() => {});
    }
  }
});
