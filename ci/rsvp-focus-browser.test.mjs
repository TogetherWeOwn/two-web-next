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
    server = createServer(async (req, res) => {
      const { pathname } = new URL(req.url, "http://localhost");
      if (pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
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

  async function openMember() {
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
    await page.goto(`${origin}/`);
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
});
