import { test, expect, localOrigin, qaLogin } from "./fixtures";

test("moderator publishes an event to the calendar, then cancels it and guests see the notice", async ({
  page,
  context,
}) => {
  await qaLogin(context, "qa-moderator");
  let eventKey: string | undefined;
  const guest = await context
    .browser()!
    .newContext({ baseURL: "https://localhost:8787", ignoreHTTPSErrors: true });
  try {
    await page.goto("/admin/events");
    await page.getByRole("link", { name: "New event", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("E2E Moderator Game Night");
    await page.getByLabel("Game", { exact: true }).fill("Minecraft");
    await page
      .getByLabel("Description", { exact: true })
      .fill("Created and published through the browser.");
    await page.getByLabel("Starts (local wall time, YYYY-MM-DD HH:mm)").fill("2099-02-01 18:00");
    await page.getByLabel("Ends (local wall time, YYYY-MM-DD HH:mm)").fill("2099-02-01 20:00");
    await page.getByLabel("Timezone", { exact: true }).fill("UTC");
    await page.getByLabel("Location", { exact: true }).fill("Community voice");
    await page.getByLabel("Capacity (empty = unlimited)").fill("10");
    await page.getByRole("button", { name: "Create draft", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/events\/[0-9A-HJKMNP-TV-Z]{26}$/);
    eventKey = new URL(page.url()).pathname.split("/").at(-1)!;
    await expect(page.getByRole("heading", { name: "Status: draft", exact: true })).toBeVisible();

    const draft = await guest.request.get(`/e/${eventKey}`, { maxRedirects: 0 });
    expect(draft.status()).toBe(403);
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Status: published", exact: true }),
    ).toBeVisible();
    const published = await guest.request.get(`/e/${eventKey}`, { maxRedirects: 0 });
    expect(published.status()).toBe(200);
    expect(await published.text()).toContain("E2E Moderator Game Night");
    await page.goto("/events");
    await page.getByRole("link", { name: "E2E Moderator Game Night", exact: true }).first().click();
    await expect(page).toHaveURL(`/e/${eventKey}`);
    await expect(
      page.getByRole("heading", { name: "E2E Moderator Game Night", exact: true }),
    ).toBeVisible();

    // Cancel finale: the moderator cancels through the JSON transition
    // (src/events/routes-writes.ts) and the run proves the guest-visible
    // cancellation contract on the same login — no second login spends the
    // shared 10/min qa-login budget (src/throttle.ts).
    const cancel = await context.request.post(`/events/${eventKey}/cancel`, {
      headers: { Origin: localOrigin },
    });
    expect(cancel.status()).toBe(200);
    expect(((await cancel.json()) as { data: { status: string } }).data.status).toBe("cancelled");

    // The guest now sees the cancelled notice (frozen testid) on the 410 page.
    const guestPage = await guest.newPage();
    const gone = await guestPage.goto(`/e/${eventKey}`);
    expect(gone?.status()).toBe(410);
    await expect(guestPage.getByTestId("event-cancelled")).toContainText("Cancelled");

    // The JSON show refuses with the exact legacy Gone body. The JSON show
    // requires a session (src/events/routes-shared.ts answers guests 401
    // before any read), so the moderator's own session proves it.
    const show = await context.request.get(`/events/${eventKey}`);
    expect(show.status()).toBe(410);
    expect(await show.json()).toEqual({
      reason: "event_cancelled",
      message: "This event was cancelled.",
      event_key: eventKey,
      status: "cancelled",
    });

    // RSVP writes against the cancelled event are refused: the PUT answers
    // 403 naming the cancellation (the JSON show above carries the
    // `event_cancelled` reason; the RSVP resource names the same closure as
    // `event_not_open` with `why: "cancelled"`).
    const rsvp = await context.request.put(`/events/${eventKey}/rsvp`, {
      data: { status: "going" },
      headers: { Origin: localOrigin },
    });
    expect(rsvp.status()).toBe(403);
    expect(await rsvp.json()).toMatchObject({ reason: "event_not_open", why: "cancelled" });

    // The per-event feed still downloads for a cancelled event and renders
    // the cancellation.
    const ics = await guest.request.get(`/events/${eventKey}.ics`);
    expect(ics.status()).toBe(200);
    const icsBody = await ics.text();
    expect(icsBody).toContain("STATUS:CANCELLED");
    expect(icsBody).toContain(`UID:${eventKey}@`);
  } finally {
    // API-only cleanup that never throws: cancel is terminal, so a 200 here
    // means the test died before the journey's own cancel and a 422 means it
    // already ran — either way no guest-visible draft or published row
    // remains.
    if (eventKey) {
      await context.request
        .post(`/events/${eventKey}/cancel`, { headers: { Origin: localOrigin } })
        .catch(() => {});
    }
    await guest.close().catch(() => {});
  }
});
