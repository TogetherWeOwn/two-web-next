import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import frames from "./fixtures/kit-live-frames.json" with { type: "json" };
import { compileKitFixture } from "./kit-hydration-harness.mjs";

const fixture = fileURLToPath(
  new URL("../test/fixtures/kit-live-topic-browser.svelte", import.meta.url),
);
const origin = "https://live-client-fixture.test";
const time = new Date("2026-11-21T12:00:00Z");
const guest = { audience: "guest", snapshot: null };
const command = (type) => ({ v: 1, type, topics: ["voice"] });

function waitForGuestPollFailure(page) {
  return page.waitForEvent("requestfailed", {
    predicate: (request) => request.url() === `${origin}/__fixture_guest_projection__`,
    timeout: 5_000,
  });
}

async function withProjection(view, exercise) {
  const { body, js } = await compileKitFixture({ fixture, props: { view } });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const websocket = `wss://live-client-fixture.test${
      view.audience === "guest" ? "/api/discord-live/v1" : "/__fixture_member_socket__"
    }`;
    const pollUrl = `${origin}/__fixture_${view.audience}_projection__`;
    const sockets = [];
    const polls = [];
    const unexpected = [];
    const errors = [];
    let documents = 0;
    page.on("pageerror", (error) => errors.push(error.message));

    // Complete each request inside Chromium. An unlisted request fails the test.
    await context.routeWebSocket("**/*", (route) => {
      if (route.url() !== websocket || route.protocols().length !== 0) {
        unexpected.push(route.url());
        return route.close();
      }
      const messages = [];
      const closes = [];
      route.onMessage((message) => messages.push(message));
      route.onClose((code) => closes.push(code));
      sockets.push({
        route,
        messages,
        closes,
        send: (frame) => route.send(JSON.stringify(frame)),
      });
    });
    await context.route("**/*", (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        switch (request.url()) {
          case `${origin}/`:
            documents++;
            return route.fulfill({
              contentType: "text/html",
              headers: {
                "content-security-policy": `default-src 'none'; script-src 'self'; connect-src ${pollUrl} ${websocket}`,
              },
              body: `<!doctype html><html lang="en"><meta charset="utf-8"><title>Live client fixture</title><div id="fixture">${body}</div><script src="/fixture.js"></script></html>`,
            });
          case `${origin}/fixture.js`:
            return route.fulfill({ contentType: "text/javascript", body: js });
          case pollUrl:
            polls.push(route);
            return;
        }
      }
      unexpected.push(request.url());
      return route.abort();
    });
    await context.addInitScript(() => {
      // Fixed jitter makes the cooldown and reconnect boundaries deterministic.
      Math.random = () => 0;
    });
    await page.clock.install({ time });
    await page.clock.pauseAt(new Date(time.getTime() + 60_000));
    const response = await page.goto(origin);
    expect(response.ok()).toBe(true);
    const html = await response.text();
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");

    const connection = async (index) => {
      await expect.poll(() => sockets.length).toBe(index + 1);
      const socket = sockets[index];
      await expect
        .poll(() => socket.messages.map((value) => JSON.parse(value)))
        .toEqual([view.audience === "guest" ? command("subscribe") : { type: "subscribe" }]);
      return socket;
    };
    const poll = async (index, response) => {
      await expect.poll(() => polls.length).toBe(index + 1);
      await polls[index].fulfill(response);
    };
    const status = page.getByRole("status");
    await expect(status).toHaveAttribute("data-source", "ssr");
    await exercise({ page, html, status, connection, sockets, polls, poll });
    await context.close();
    expect(documents).toBe(1);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}

test("guest hydrates the closed public count and clears invalid frames", async () => {
  await withProjection(guest, async ({ page, html, status, connection }) => {
    expect(html).toContain("Voice unavailable");
    const count = page.getByTestId("guest-count");
    const withheld = page.getByText("Voice count withheld");
    const first = await connection(0);
    first.send(frames.initial);
    await expect(status).toHaveAttribute("data-source", "live");
    await expect(withheld).toBeVisible();
    await expect(count).toHaveCount(0);
    first.send(frames.five);
    await expect(count).toHaveText("5 in voice");
    first.send(frames.suppressed);
    await expect(withheld).toBeVisible();
    await expect(count).toHaveCount(0);

    const invalid = [
      { ...frames.five, seq: 4, value: { count: 0 } },
      { ...frames.five, value: { count: 4 } },
      { ...frames.five, value: { count: 5, rooms: ["Synthetic private room"] } },
      { ...frames.withdrawal, seq: 2 },
    ];
    for (const [index, frame] of invalid.entries()) {
      const socket = index === 0 ? first : await connection(index);
      if (index > 0) {
        socket.send(frames.initial);
        await expect(withheld).toBeVisible();
      }
      socket.send(frame);
      await expect(status).toHaveAttribute("data-source", "stale");
      await expect(status).toHaveText("Voice unavailable");
      await expect(count).toHaveCount(0);
      await expect(withheld).toHaveCount(0);
      await expect.poll(() => socket.closes.length).toBe(1);
      if (index + 1 < invalid.length) await page.clock.runFor(1_000);
    }
  });
});

test("guest recovers on the original socket immediately and after explicit resync", async () => {
  await withProjection(guest, async ({ page, status, connection, sockets, polls, poll }) => {
    const count = page.getByTestId("guest-count");
    const socket = await connection(0);
    socket.send(frames.initial);
    await expect(status).toHaveAttribute("data-source", "live");
    socket.send(frames.withdrawal);
    await expect(status).toHaveAttribute("data-source", "stale");
    const rejected = waitForGuestPollFailure(page);
    await poll(0, { status: 302, headers: { location: "https://unexpected-fixture.test/" } });
    await rejected;
    socket.send(frames.covering);
    await expect(count).toHaveText("5 in voice");

    socket.send({ ...frames.five, seq: 6 });
    await expect(status).toHaveAttribute("data-source", "stale");
    socket.send(frames.withdrawal);
    await expect(status).toHaveText("Voice unavailable");
    await expect(count).toHaveCount(0);
    // Keep the rejected snapshots last so no subsequent gap can hide a rendered count.
    socket.send({ ...frames.five, seq: 7 });
    socket.send(frames.covering);
    socket.send({ ...frames.covering, seq: 5, value: { count: 6 } });
    await page.clock.runFor(1_999);
    expect(socket.messages).toHaveLength(1);
    await page.clock.runFor(1);
    await expect
      .poll(() => socket.messages.map((value) => JSON.parse(value)))
      .toEqual([command("subscribe"), command("resync")]);
    await expect(status).toHaveAttribute("data-source", "stale");
    await expect(count).toHaveCount(0);

    // Model the installed hub's unavailable control ahead of the covering pull.
    socket.send(frames.withdrawal);
    await page.clock.runFor(5_000);
    await expect(status).toHaveAttribute("data-source", "stale");
    await expect(count).toHaveCount(0);
    expect(socket.messages).toHaveLength(2);
    socket.send(frames.warm);
    await expect(count).toHaveText("5 in voice");
    await expect(status).toHaveAttribute("data-source", "live");
    const pollsAtRecovery = polls.length;
    await page.clock.runFor(31_000);
    await expect(count).toHaveText("5 in voice");
    expect(polls).toHaveLength(pollsAtRecovery);
    expect(socket.closes).toEqual([]);
    expect(sockets).toHaveLength(1);
    socket.send(frames.withdrawal);
    await expect(status).toHaveText("Voice unavailable");
    expect(socket.closes).toEqual([]);
  });
});

test("guest retires an exhausted resync without sending a second command", async () => {
  await withProjection(guest, async ({ page, status, connection, polls }) => {
    const socket = await connection(0);
    socket.send(frames.initial);
    await expect(status).toHaveAttribute("data-source", "live");
    socket.send(frames.withdrawal);
    await expect(status).toHaveAttribute("data-source", "stale");
    await page.clock.runFor(2_000);
    await expect
      .poll(() => socket.messages.map((value) => JSON.parse(value)))
      .toEqual([command("subscribe"), command("resync")]);
    await expect.poll(() => polls.length).toBe(1);
    await page.clock.runFor(1_000);
    // The abort confirms the late control reached the client before the original deadline.
    const aborted = waitForGuestPollFailure(page);
    socket.send(frames.withdrawal);
    await aborted;
    await page.clock.runFor(13_999);
    expect(socket.closes).toEqual([]);
    expect(socket.messages).toHaveLength(2);
    await page.clock.runFor(1);
    await expect.poll(() => socket.closes.length).toBe(1);
    await page.clock.runFor(1_000);
    const next = await connection(1);
    next.send(frames.initial);
    await expect(status).toHaveAttribute("data-source", "live");
    await expect(page.getByText("Voice count withheld")).toBeVisible();
  });
});

test("guest policy Close clears the baseline and uses only projected fallback", async () => {
  await withProjection(guest, async ({ page, status, connection, polls, poll }) => {
    const count = page.getByTestId("guest-count");
    const socket = await connection(0);
    socket.send(frames.initial);
    socket.send(frames.five);
    await expect(count).toHaveText("5 in voice");
    await socket.route.close({ code: 1008, reason: "Fixture lease expired" });
    await expect(status).toHaveAttribute("data-source", "stale");
    await expect(count).toHaveCount(0);
    await poll(0, { json: { count: null } });
    await expect(status).toHaveAttribute("data-source", "poll");
    await expect(status).toHaveText("Voice data may be a few seconds old");
    await expect(page.getByText("Voice count withheld")).toBeVisible();

    await page.clock.runFor(1_000);
    const next = await connection(1);
    await page.clock.runFor(8_999);
    expect(polls).toHaveLength(1);
    await page.clock.runFor(1);
    await poll(1, { json: { count: 5, rooms: ["Synthetic private room"] } });
    await expect(status).toHaveAttribute("data-source", "stale");
    await expect(page.getByText("Voice count withheld")).toHaveCount(0);
    await expect(count).toHaveCount(0);

    next.send({ ...frames.initial, value: { count: 6 } });
    await expect(count).toHaveText("6 in voice");
    await expect(status).toHaveAttribute("data-source", "live");
    await page.clock.runFor(10_000);
    expect(polls).toHaveLength(2);
  });
});

const otherRoom = "Other viewer’s synthetic room";
const projectMember = (viewer, ...occupants) => {
  const byViewer = {
    viewer: [{ name: "Visible synthetic room", count: occupants.length, occupants }],
    other: [{ name: otherRoom, count: 1, occupants: ["Other synthetic occupant"] }],
  };
  return { rooms: byViewer[viewer] };
};

test("member renders observed zero and replaces only its synthetic room projection", async () => {
  const projection = (...occupants) => projectMember("viewer", ...occupants);
  await withProjection(
    { audience: "member", snapshot: projection() },
    async ({ page, html, status, connection, poll }) => {
      const visible = page.getByRole("list", { name: "Visible rooms" });
      expect(html).toContain("Visible synthetic room (0)");
      expect(html).not.toContain(otherRoom);
      await expect(status).toHaveText("Voice observed");
      await expect(visible).toHaveText("Visible synthetic room (0)");
      const socket = await connection(0);
      socket.send({ kind: "snapshot", seq: 1, value: projection("Synthetic occupant") });
      await expect(visible).toHaveText("Visible synthetic room (1): Synthetic occupant");
      socket.send({ kind: "patch", seq: 2, value: projection() });
      await expect(visible).toHaveText("Visible synthetic room (0)");

      await socket.route.close({ code: 1012, reason: "Fixture restart" });
      await expect(status).toHaveAttribute("data-source", "stale");
      await expect(visible).toHaveCount(0);
      await poll(0, { json: projection("Synthetic projected occupant") });
      await expect(status).toHaveAttribute("data-source", "poll");
      await expect(visible).toHaveText("Visible synthetic room (1): Synthetic projected occupant");
      await expect(page.getByRole("main")).not.toContainText(otherRoom);
    },
  );
});
