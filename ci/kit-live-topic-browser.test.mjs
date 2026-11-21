import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { compileKitFixture } from "./kit-hydration-harness.mjs";

const fixture = fileURLToPath(
  new URL("../test/fixtures/kit-live-topic-browser.svelte", import.meta.url),
);
const origin = "https://live-client-fixture.test";
const websocket = "wss://live-client-fixture.test/api/discord-live/v1";
const frame = (type, seq, value) => JSON.stringify({ v: 1, topic: "voice", type, seq, value });
const command = (type) => ({ v: 1, type, topics: ["voice"] });
const rooms = (name, occupant, ageMs = 0, freshness = "fresh") => ({
  ageMs,
  freshness,
  rooms: [{ name, count: 1, occupants: [occupant] }],
});

async function withProjection(view, exercise) {
  const { body, js } = await compileKitFixture({ fixture, props: { view } });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const sockets = [];
    const polls = [];
    const unexpected = [];
    const errors = [];
    let documents = 0;
    page.on("pageerror", (error) => errors.push(error.message));

    // Fulfill everything in Chromium. No server, Discord, database or deployed poll.
    await context.routeWebSocket("**/*", (route) => {
      if (route.url() !== websocket) {
        unexpected.push(route.url());
        return route.close();
      }
      const messages = [];
      route.onMessage((message) => messages.push(message));
      sockets.push({ route, messages });
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
                "content-security-policy": `default-src 'none'; script-src 'self'; connect-src 'self' ${websocket}`,
              },
              body: `<!doctype html><html lang="en"><meta charset="utf-8"><title>Live client fixture</title><div id="fixture">${body}</div><script src="/fixture.js"></script></html>`,
            });
          case `${origin}/fixture.js`:
            return route.fulfill({ contentType: "text/javascript", body: js });
          case `${origin}/__fixture_poll__`:
            if (view.audience === "member") {
              polls.push(route);
              return;
            }
            break;
        }
      }
      unexpected.push(request.url());
      return route.abort();
    });
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 60_000);
    const response = await page.goto(origin);
    expect(response.ok()).toBe(true);
    const html = await response.text();
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
    const connection = async (index) => {
      await expect.poll(() => sockets.length).toBe(index + 1);
      const { messages, route } = sockets[index];
      await expect
        .poll(() => messages.map((value) => JSON.parse(value)))
        .toEqual([command("subscribe")]);
      return { messages, route };
    };
    const status = page.getByRole("status");
    await expect(status).toHaveAttribute("data-source", "ssr");
    await exercise({ page, html, status, connection, polls });
    await context.close();
    expect(documents).toBe(1);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}

test("guest hydration distinguishes suppressed null from observed zero", async () => {
  await withProjection(
    { audience: "guest", snapshot: null },
    async ({ page, html, status, connection, polls }) => {
      expect(html).toContain("Voice unavailable");
      const count = page.getByTestId("guest-count");
      await expect(count).toHaveCount(0);
      const { route } = await connection(0);
      route.send(frame("snapshot", 1, { count: 0, ageMs: 0, freshness: "fresh" }));
      await expect(count).toHaveText("0 in voice");
      await expect(status).toHaveAttribute("data-source", "live");

      route.send(frame("patch", 2, rooms("Member room", "Synthetic occupant")));
      await expect(status).toHaveAttribute("data-source", "stale");
      await expect(status).toHaveText("Voice unavailable");
      await expect(count).toHaveCount(0);
      await expect(page.getByRole("main")).not.toContainText("Synthetic occupant");
      expect(polls).toHaveLength(0);
    },
  );
});

test("member patches, gap resync and reconnect update the hydrated page", async () => {
  await withProjection(
    { audience: "member", snapshot: rooms("SSR room", "SSR occupant", 3_000) },
    async ({ page, html, status, connection, polls }) => {
      expect(html).toContain("SSR room");
      expect(html).toContain("SSR occupant");
      await expect(status).toHaveText("Observed · 3 s old");
      const visible = page.getByRole("list", { name: "Visible rooms" });
      await expect(visible).toHaveText("SSR room (1): SSR occupant");
      const { route, messages } = await connection(0);
      route.send(frame("snapshot", 1, rooms("Live room", "Live occupant")));
      await expect(visible).toHaveText("Live room (1): Live occupant");
      route.send(frame("patch", 2, rooms("Patched room", "Patched occupant")));
      await expect(visible).toHaveText("Patched room (1): Patched occupant");
      await expect(status).toHaveAttribute("data-source", "live");

      route.send(frame("patch", 4, rooms("Gap room", "Gap occupant")));
      await expect
        .poll(() => messages.map((value) => JSON.parse(value)))
        .toEqual([command("subscribe"), command("resync")]);
      await expect(status).toHaveAttribute("data-source", "stale");
      await expect(status).toHaveText("Voice unavailable");
      await expect(visible).toHaveCount(0);
      await expect.poll(() => polls.length).toBe(1);
      await polls[0].fulfill({ status: 204 });
      await expect(visible).toHaveCount(0);
      route.send(frame("snapshot", 4, rooms("Resynced room", "Resynced occupant")));
      await expect(visible).toHaveText("Resynced room (1): Resynced occupant");

      await route.close({ code: 1012, reason: "Fixture restart" });
      await expect(status).toHaveAttribute("data-source", "stale");
      await expect(visible).toHaveCount(0);
      await expect.poll(() => polls.length).toBe(2);
      await polls[1].fulfill({ json: rooms("Poll room", "Poll occupant", 42_000, "frozen") });
      await expect(status).toHaveAttribute("data-source", "poll");
      await expect(status).toHaveText("Frozen · 42 s old");
      await expect(visible).toHaveText("Poll room (1): Poll occupant");

      await page.clock.runFor(1_000);
      const reconnected = await connection(1);
      reconnected.route.send(frame("snapshot", 1, rooms("New room", "New occupant")));
      await expect(status).toHaveAttribute("data-source", "live");
      await expect(visible).toHaveText("New room (1): New occupant");
      reconnected.route.send(frame("patch", 2, rooms("Updated room", "Updated occupant")));
      await expect(visible).toHaveText("Updated room (1): Updated occupant");
      await page.clock.runFor(10_000);
      expect(polls).toHaveLength(2);
    },
  );
});
