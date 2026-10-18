// Real Chromium proof for RSVP outcome focus. The shipped island and the real
// SSR markup run on a loopback server; the RSVP PUT is intercepted and held
// until the test answers it. No database, Discord or staging traffic.
// Run after the Chromium install: RSVP_FOCUS_BROWSER_TESTS=true node --test ci/rsvp-focus-browser.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";
import { AUDIT_BROWSER_OPTIONS } from "./a11y-lifecycle.mjs";

const EVENT_PATH = "/events/raid%2Fone/rsvp";

const event = {
  id: 42,
  eventKey: "raid/one",
  title: "Squad night",
  status: "published",
  startsAt: new Date("2030-01-01T20:00:00Z"),
  endsAt: new Date("2030-01-01T22:00:00Z"),
  timezone: "Europe/London",
  capacity: 4,
  goingCount: 1,
  rsvpOpen: true,
};

const pageHtml = (rsvp) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>RSVP focus proof</title></head>` +
  `<body><main>${rsvp}</main><p id="elsewhere">Event notes</p>` +
  `<label>Outside field <input id="outside" type="text"></label>` +
  `<script src="/islands/rsvp-button.js"></script></body></html>`;

describe("RSVP outcome focus in Chromium", {
  skip: process.env.RSVP_FOCUS_BROWSER_TESTS !== "true",
  timeout: 120000,
}, () => {
  let scratch;
  let server;
  let origin;
  let browser;
  let html;
  const holderPages = {};

  before(async () => {
    scratch = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "rsvp-focus-"));
    const bundled = await build({
      stdin: {
        contents: `import { RsvpButton } from ${JSON.stringify(resolve("src/events/rsvp-button.tsx"))};\nexport const renderRsvp = (props) => String(RsvpButton(props));`,
        loader: "ts",
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      jsx: "automatic",
      jsxImportSource: "hono/jsx",
      logLevel: "silent",
    });
    const renderer = join(scratch, "render.mjs");
    await writeFile(renderer, bundled.outputFiles[0].text);
    const { renderRsvp } = await import(pathToFileURL(renderer).href);
    html = pageHtml(
      renderRsvp({
        e: event,
        member: true,
        answer: null,
        returnTo: "/e/raid/one",
        now: new Date("2029-01-01T00:00:00Z"),
      }),
    );
    // Seat-holder variants for the withdraw paths: paused events render the
    // withdraw/leave control beside the paused status and no join control.
    const holder = (rsvpOpen, status) =>
      pageHtml(
        renderRsvp({
          e: { ...event, rsvpOpen },
          member: true,
          answer: { status, syncedToDiscordAt: null },
          returnTo: "/e/raid/one",
          waitlistPosition: status === "waitlisted" ? 2 : null,
          now: new Date("2029-01-01T00:00:00Z"),
        }),
      );
    holderPages["/paused-going"] = holder(false, "going");
    holderPages["/paused-waitlisted"] = holder(false, "waitlisted");
    holderPages["/open-going"] = holder(true, "going");
    server = createServer(async (req, res) => {
      const { pathname } = new URL(req.url, "http://localhost");
      if (pathname === "/" || holderPages[pathname]) {
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(holderPages[pathname] || html);
      } else if (pathname === "/islands/rsvp-button.js") {
        res
          .writeHead(200, { "content-type": "text/javascript; charset=utf-8" })
          .end(await readFile(resolve("public/islands/rsvp-button.js")));
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch(AUDIT_BROWSER_OPTIONS);
  });

  after(async () => {
    await browser?.close();
    await new Promise((closed) => server?.close(closed));
    await rm(scratch, { recursive: true, force: true });
  });

  async function openMember(path = "/") {
    const context = await browser.newContext();
    const page = await context.newPage();
    const writes = [];
    let arrive = Promise.withResolvers();
    await page.route(
      (url) => url.pathname === EVENT_PATH,
      (route) => {
        writes.push(route);
        arrive.resolve();
      },
    );
    await page.goto(`${origin}${path}`);
    const pending = async () => {
      await arrive.promise;
      arrive = Promise.withResolvers();
      return writes.shift();
    };
    const succeed = async (route) =>
      route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ data: { status: "going", synced_to_discord_at: null } }),
      });
    const focused = () =>
      page.evaluate(() => {
        const el = document.activeElement;
        return el ? el.id || el.getAttribute("data-testid") || el.tagName : null;
      });
    return { context, page, pending, succeed, focused };
  }

  it("keeps keyboard focus on the field the member tabbed to while the write is pending", async (t) => {
    const member = await openMember();
    t.after(() => member.context.close());
    const { page } = member;
    await page.getByTestId("rsvp-going").focus();
    await page.keyboard.press("Enter");
    const route = await member.pending();
    await page.keyboard.press("Tab");
    assert.equal(await member.focused(), "outside");
    await member.succeed(route);
    await page.getByTestId("rsvp-confirmed").waitFor();
    assert.equal(await page.getByTestId("rsvp-confirmed").getAttribute("role"), "status");
    assert.equal(await member.focused(), "outside");
  });

  it("moves focus to the confirmation when the member stays on the control", async (t) => {
    const member = await openMember();
    t.after(() => member.context.close());
    const { page } = member;
    await page.getByTestId("rsvp-going").focus();
    await page.keyboard.press("Enter");
    const route = await member.pending();
    await member.succeed(route);
    await page.getByTestId("rsvp-confirmed").waitFor();
    assert.equal(await member.focused(), "rsvp-confirmed");
  });

  for (const [status, body, noticeTestid] of [
    [500, "", "rsvp-failed"],
    [429, "", "rsvp-rate-limited"],
    [403, JSON.stringify({ error: "forbidden" }), "rsvp-failed"],
  ]) {
    it(`restores focus to the re-enabled control after a refused ${status} write`, async (t) => {
      const member = await openMember();
      t.after(() => member.context.close());
      const { page } = member;
      await page.getByTestId("rsvp-going").focus();
      await page.keyboard.press("Enter");
      const route = await member.pending();
      await route.fulfill({ status, contentType: "application/json", body });
      await page.getByTestId(noticeTestid).waitFor();
      assert.equal(await page.getByTestId("rsvp-going").isEnabled(), true);
      assert.equal(await member.focused(), "rsvp-going");
    });
  }

  it("does not steal focus back after a refused write when the member tabbed away", async (t) => {
    const member = await openMember();
    t.after(() => member.context.close());
    const { page } = member;
    await page.getByTestId("rsvp-going").focus();
    await page.keyboard.press("Enter");
    const route = await member.pending();
    await page.keyboard.press("Tab");
    assert.equal(await member.focused(), "outside");
    await route.fulfill({ status: 500, contentType: "application/json", body: "" });
    await page.getByTestId("rsvp-failed").waitFor();
    assert.equal(await member.focused(), "outside");
  });

  it("tabs from the focused 409 full notice to the waitlist button", async (t) => {
    const member = await openMember();
    t.after(() => member.context.close());
    const { page } = member;
    await page.getByTestId("rsvp-going").focus();
    await page.keyboard.press("Enter");
    const route = await member.pending();
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "event_full", capacity: 4 }),
    });
    await page.getByTestId("event-full").waitFor();
    assert.equal(await member.focused(), "event-full");
    await page.keyboard.press("Tab");
    assert.equal(await member.focused(), "waitlist-join");
  });

  it("keeps focus on the 409 full notice when a full capacity refresh lands after it", async (t) => {
    const member = await openMember();
    t.after(() => member.context.close());
    const { page } = member;
    await page.getByTestId("rsvp-going").focus();
    await page.keyboard.press("Enter");
    const route = await member.pending();
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "event_full", capacity: 4 }),
    });
    await page.getByTestId("event-full").waitFor();
    assert.equal(await member.focused(), "event-full");
    await page.evaluate(() => {
      document.dispatchEvent(
        new CustomEvent("going-count-refreshed", {
          detail: { eventKey: "raid/one", goingCount: 4, capacity: 4 },
        }),
      );
    });
    assert.equal(await member.focused(), "event-full");
    await page.keyboard.press("Tab");
    assert.equal(await member.focused(), "waitlist-join");
  });

  it("keeps focus off the confirmation after a pointer press outside the widget", async (t) => {
    const member = await openMember();
    t.after(() => member.context.close());
    const { page } = member;
    await page.getByTestId("rsvp-going").focus();
    await page.keyboard.press("Enter");
    const route = await member.pending();
    await page.locator("#elsewhere").click();
    await member.succeed(route);
    await page.getByTestId("rsvp-confirmed").waitFor();
    assert.equal(await member.focused(), "BODY");
  });

  // A paused event may render no join control after a withdraw, so the
  // paused status itself is the focus landing spot — never the body.
  for (const [path, control] of [
    ["/paused-going", "rsvp-withdraw"],
    ["/paused-waitlisted", "waitlist-leave"],
  ]) {
    it(`lands focus on the paused status after a keyboard withdraw at ${path}`, async (t) => {
      const member = await openMember(path);
      t.after(() => member.context.close());
      const { page } = member;
      await page.getByTestId(control).focus();
      await page.keyboard.press("Enter");
      const route = await member.pending();
      assert.equal(route.request().method(), "DELETE");
      await route.fulfill({ status: 204, body: "" });
      await page.getByTestId("rsvp-paused").waitFor();
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("data-testid") === "rsvp-paused",
        null,
        { timeout: 5000 },
      );
      assert.equal(await page.getByTestId("rsvp-paused").getAttribute("role"), "status");
      assert.equal(await page.getByTestId("rsvp-paused").getAttribute("tabindex"), "-1");
      assert.equal(await page.locator("[data-action]").count(), 0);
      assert.equal(await member.focused(), "rsvp-paused");
    });
  }

  it("still lands focus on the restored join control after an open-event withdraw", async (t) => {
    const member = await openMember("/open-going");
    t.after(() => member.context.close());
    const { page } = member;
    await page.getByTestId("rsvp-withdraw").focus();
    await page.keyboard.press("Enter");
    const route = await member.pending();
    assert.equal(route.request().method(), "DELETE");
    await route.fulfill({ status: 204, body: "" });
    await page.getByTestId("rsvp-going").waitFor();
    assert.equal(await member.focused(), "rsvp-going");
  });

  it("focuses the unknown-outcome notice when the write times out with focus held", async (t) => {
    const member = await openMember();
    t.after(() => member.context.close());
    const { page } = member;
    await page.getByTestId("rsvp-going").focus();
    await page.keyboard.press("Enter");
    await member.pending();
    await page.getByTestId("rsvp-unknown").waitFor({ timeout: 15000 });
    assert.equal(await page.getByTestId("rsvp-unknown").getAttribute("role"), "alert");
    assert.equal(await member.focused(), "rsvp-unknown");
  });

  it("keeps focus on the outside field when the write times out after tabbing away", async (t) => {
    const member = await openMember();
    t.after(() => member.context.close());
    const { page } = member;
    await page.getByTestId("rsvp-going").focus();
    await page.keyboard.press("Enter");
    await member.pending();
    await page.keyboard.press("Tab");
    assert.equal(await member.focused(), "outside");
    await page.getByTestId("rsvp-unknown").waitFor({ timeout: 15000 });
    assert.equal(await page.getByTestId("rsvp-unknown").getAttribute("role"), "alert");
    assert.equal(await member.focused(), "outside");
  });

  it("focuses the session-expired notice on a deferred 401 when focus stays", async (t) => {
    const member = await openMember();
    t.after(() => member.context.close());
    const { page } = member;
    await page.getByTestId("rsvp-going").focus();
    await page.keyboard.press("Enter");
    const route = await member.pending();
    await route.fulfill({ status: 401, contentType: "application/json", body: "" });
    await page.getByTestId("rsvp-session-expired").waitFor();
    assert.equal(await page.getByTestId("rsvp-session-expired").getAttribute("role"), "alert");
    assert.equal(await member.focused(), "rsvp-session-expired");
  });

  it("keeps focus on the outside field when a deferred 401 arrives after moving away", async (t) => {
    const member = await openMember();
    t.after(() => member.context.close());
    const { page } = member;
    await page.getByTestId("rsvp-going").focus();
    await page.keyboard.press("Enter");
    const route = await member.pending();
    await page.keyboard.press("Tab");
    assert.equal(await member.focused(), "outside");
    await route.fulfill({ status: 401, contentType: "application/json", body: "" });
    await page.getByTestId("rsvp-session-expired").waitFor();
    assert.equal(await page.getByTestId("rsvp-session-expired").getAttribute("role"), "alert");
    assert.equal(await member.focused(), "outside");
  });
});
