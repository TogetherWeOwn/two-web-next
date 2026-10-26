// Independent, unconditional Chromium acceptance. Local memory routes only:
// node --import tsx --test ci/profile-review-changes-browser.test.mjs
// Builder must wire this command into browser-enabled CI and its TAP execution
// verifier. No environment-dependent skips and no production implementation here.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium } from "playwright";
import { PROFILE_SAVE_DEADLINE_MS } from "../src/islands/contracts.ts";
import { ORIGIN, OWNER, participationFixture } from "../test/helpers/profile-participation.ts";

const original = {
  bio: "A member who likes board games.",
  games_text: "Chess",
  timezone: "Europe/London",
  leaderboard_opt_out: true,
};
const evidence = process.env.PROFILE_REVIEW_EVIDENCE_DIR;
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
  if (evidence) await mkdir(evidence, { recursive: true });
});
after(async () => browser?.close());

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function open(t, renderer, width, options = {}) {
  const f = await participationFixture(options.presentation ?? "completed owner");
  if (options.optOut !== undefined) f.store.rows.get(OWNER).leaderboardOptOut = options.optOut;
  const context = await browser.newContext({
    javaScriptEnabled: options.javaScriptEnabled !== false,
    viewport: { width, height: width === 390 ? 844 : 800 },
    locale: "en-GB",
    timezoneId: "UTC",
    serviceWorkers: "block",
  });
  const releases = [];
  t.after(async () => {
    releases.forEach((release) => release());
    await context.close();
  });
  const page = await context.newPage();
  if (options.unabortable)
    await page.addInitScript(() => {
      // Exercise the existing no-AbortController path: the late response must
      // be fenced by request ownership, not merely suppressed by transport abort.
      window.AbortController = undefined;
    });
  const requests = [];
  const forbidden = [];
  let nextPatch = null;
  await page.addInitScript(() => {
    window.reviewAudit = { storage: [], logs: [], beacons: [] };
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      window.reviewAudit.storage.push(String(key) + ":" + String(value));
      return set.call(this, key, value);
    };
    for (const name of ["log", "info", "warn", "error", "debug"]) {
      const original = console[name];
      console[name] = function (...args) {
        window.reviewAudit.logs.push(args.map(String).join(" "));
        return original.apply(this, args);
      };
    }
    navigator.sendBeacon = function (url, data) {
      window.reviewAudit.beacons.push(String(url) + ":" + String(data));
      return false;
    };
  });
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== ORIGIN) {
      if (["fetch", "xhr"].includes(req.resourceType())) forbidden.push(req.url());
      await route.abort();
      return;
    }
    // Serve only this page's reviewed static dependencies. Other islands are
    // outside the fixture, not replaced by fabricated implementations.
    const asset =
      /^\/(?:styles|theme|theme-tokens|profile-theme)\.css$/.test(url.pathname) ||
      /^\/islands\/(?:member-profile|avatar|local-time-compare)\.js$/.test(url.pathname) ||
      /^\/fonts\/[a-z0-9-]+\.woff2$/.test(url.pathname) ||
      url.pathname === "/logo.svg";
    if (asset && existsSync(`public${url.pathname}`)) {
      await route.fulfill({
        contentType: url.pathname.endsWith(".js")
          ? "text/javascript"
          : url.pathname.endsWith(".css")
            ? "text/css"
            : url.pathname.endsWith(".svg")
              ? "image/svg+xml"
              : "font/woff2",
        body:
          options.holdIsland && url.pathname === "/islands/member-profile.js"
            ? ""
            : readFileSync(`public${url.pathname}`),
      });
      return;
    }
    if (req.resourceType() === "script") {
      await route.abort();
      return;
    }
    const observed = {
      path: url.pathname + url.search,
      method: req.method(),
      body: req.postData(),
    };
    requests.push(observed);
    if (url.pathname === "/events") {
      await route.fulfill({ contentType: "text/html", body: "<h1>Local events destination</h1>" });
      return;
    }
    if (!["/profile", `/members/${OWNER}`].includes(url.pathname)) {
      forbidden.push(url.pathname);
      await route.abort();
      return;
    }
    const held = req.method() === "PATCH" ? nextPatch : null;
    if (held) nextPatch = null;
    let response = held?.status
      ? Response.json(held.body ?? {}, { status: held.status })
      : await f.request(renderer, url.pathname + url.search, {
          method: req.method(),
          headers: req.headers(),
          body: req.postData() ?? undefined,
        });
    if (held) {
      held.started.resolve();
      await held.gate.promise;
      if (held.transport) {
        await route.abort("failed");
        return;
      }
    }
    observed.status = response.status;
    // Browser interception does not re-intercept redirect hops. Follow the
    // real native 303 locally, retaining its status/location as witnesses.
    if (response.status === 303) {
      const target = new URL(response.headers.get("location"), ORIGIN);
      assert.equal(
        target.origin,
        ORIGIN,
        "PRV_REDIRECT_BOUNDARY: never follow an external redirect",
      );
      assert.equal(target.pathname, `/members/${OWNER}`);
      observed.followed = target.pathname;
      response = await f.request(renderer, target.pathname, { method: "GET" });
      assert.equal(response.status, 200);
    }
    let body = await response.text();
    if (response.headers.get("content-type")?.includes("text/html"))
      body = body.replace(/(name="formOpenedAt" value=")[^"]+/, `$1${Date.now() - 5000}`);
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body,
    });
  });
  await page.goto(ORIGIN + f.path);
  return {
    ...f,
    page,
    requests,
    forbidden,
    holdNext(reply = {}) {
      const gate = deferred();
      const started = deferred();
      nextPatch = { ...reply, gate, started };
      const release = () => gate.resolve();
      releases.push(release);
      return { started: started.promise, release };
    },
    async shot(state) {
      if (evidence)
        await page.screenshot({
          path: join(evidence, `${renderer}-${width}-${state}.png`),
          fullPage: true,
        });
    },
  };
}

const field = (page, key) =>
  key === "leaderboard_opt_out"
    ? page.locator("#profile-leaderboard-opt-out")
    : page.locator(`[name="${key}"]`);
async function enter(page, values) {
  for (const [key, value] of Object.entries(values)) {
    if (key === "leaderboard_opt_out") await field(page, key).setChecked(value);
    else await field(page, key).fill(value);
  }
}
async function values(page) {
  return {
    bio: await field(page, "bio").inputValue(),
    games_text: await field(page, "games_text").inputValue(),
    timezone: await field(page, "timezone").inputValue(),
    leaderboard_opt_out: await field(page, "leaderboard_opt_out").isChecked(),
  };
}
async function display(page) {
  return Promise.all(
    ["profile-bio", "profile-games", "profile-timezone"].map((id) =>
      page.getByTestId(id).textContent(),
    ),
  );
}
async function dirty(page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}
async function review(page) {
  const control = page.locator("button, summary").filter({ hasText: /^review changes$/i });
  assert.equal(
    await control.count(),
    1,
    "PRV_REVIEW_MISSING: expose the optional owner Review changes control",
  );
  if (await page.getByTestId("profile-form").isHidden())
    await page.getByTestId("profile-edit-again").click();
  const panel = page.getByTestId("profile-review");
  await control.focus();
  if (!(await panel.isVisible())) {
    await control.press("Enter");
  }
  await panel.waitFor({ state: "visible" });
  return panel;
}
async function unchangedOthers(panel, changed = []) {
  const rows = panel.locator("[data-review-field]");
  const keys = await rows.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-review-field")),
  );
  assert.equal(new Set(keys).size, keys.length, "PRV_DUPLICATE_FIELD: compare each field once");
  for (const key of keys) {
    assert.ok(
      ["bio", "games_text", "timezone", "leaderboard_opt_out"].includes(key),
      "PRV_FIELD_SCOPE: review only the four editable profile fields",
    );
    if (changed.includes(key)) continue;
    const row = panel.locator(`[data-review-field="${key}"]`);
    assert.equal(
      (await row.locator("[data-review-saved]").textContent()).trim(),
      (await row.locator("[data-review-draft]").textContent()).trim(),
      "PRV_UNCHANGED_FIELD: unchanged rows may be shown but must not invent differences",
    );
  }
}
async function clean(panel) {
  assert.match(
    await panel.textContent(),
    /no (?:unsaved )?changes|up to date/i,
    "PRV_CLEAN_STATE: distinguish a clean form from an empty/broken review",
  );
  await unchangedOthers(panel);
}
async function comparison(panel, key, saved, draft) {
  const row = panel.locator(`[data-review-field="${key}"]`);
  assert.equal(
    await row.count(),
    1,
    `PRV_FIELD_MISSING: review ${key} against its accepted baseline`,
  );
  assert.match(await panel.textContent(), /saved/i);
  assert.match(await panel.textContent(), /unsaved|draft/i);
  const read = async (kind) => {
    const cell = row.locator(`[data-review-${kind}]`);
    assert.equal(
      await cell.count(),
      1,
      `PRV_VALUE_ASSOCIATION: identify the ${kind} value for ${key}`,
    );
    return (await cell.textContent()).trim();
  };
  const savedText = await read("saved");
  const draftText = await read("draft");
  const check = (actual, expected) =>
    expected instanceof RegExp ? assert.match(actual, expected) : assert.equal(actual, expected);
  check(savedText, saved);
  check(draftText, draft);
  return { row, savedText, draftText };
}
const choice = (hidden) =>
  hidden ? /hidden|hide|opted out|excluded/i : /shown|show|visible|opted in|included/i;
const writes = (f) => f.requests.filter((req) => req.method !== "GET");
const saves = (f) => f.operations.filter((operation) => operation.method === "save");
const browserTurn = (page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));

for (const renderer of ["Hono", "Kit"]) {
  for (const width of [1280, 390]) {
    describe(`${renderer} ${width}px profile review changes`, () => {
      test("PRV-B01 clean review is keyboard reachable and does not submit, read or mutate", async (t) => {
        const f = await open(t, renderer, width);
        const before = {
          values: await values(f.page),
          display: await display(f.page),
          requests: [...f.requests],
          operations: [...f.operations],
        };
        await f.shot("clean-before");
        const panel = await review(f.page);
        await clean(panel);
        assert.equal(await dirty(f.page), false);
        assert.deepEqual(await values(f.page), before.values);
        assert.deepEqual(await display(f.page), before.display);
        assert.deepEqual(f.requests, before.requests);
        assert.deepEqual(f.operations, before.operations);
        assert.deepEqual(f.forbidden, []);
        assert.equal(await f.page.evaluate(() => document.activeElement === document.body), false);
        await f.shot("clean-review");
      });

      for (const [key, next] of [
        ["bio", "Draft for review"],
        ["games_text", "  Go  \nChess\nGo"],
        ["timezone", "America/New_York"],
      ]) {
        // Break: a field is omitted, values are swapped, or opening review normalizes the live draft.
        test(`PRV-B02 ${key} alone compares raw draft with saved value without saving`, async (t) => {
          const f = await open(t, renderer, width);
          const persisted = await display(f.page);
          await enter(f.page, { [key]: next });
          const before = [...f.requests];
          await f.shot(`changed-${key}-before`);
          const panel = await review(f.page);
          await comparison(panel, key, original[key], next.trim());
          await unchangedOthers(panel, [key]);
          assert.equal(await field(f.page, key).inputValue(), next);
          assert.equal(await dirty(f.page), true);
          assert.deepEqual(await display(f.page), persisted);
          assert.deepEqual(f.requests, before);
          assert.deepEqual(saves(f), []);
          assert.equal(await f.page.getByTestId("profile-error").count(), 0);
          assert.equal(f.page.url(), ORIGIN + f.path);
          await f.shot(`changed-${key}-review`);
        });
      }

      for (const saved of [false, true]) {
        test(`PRV-B03 leaderboard ${saved} to ${!saved} has human wording, not a boolean`, async (t) => {
          const f = await open(t, renderer, width, { optOut: saved });
          await enter(f.page, { leaderboard_opt_out: !saved });
          const panel = await review(f.page);
          await comparison(panel, "leaderboard_opt_out", choice(saved), choice(!saved));
          await unchangedOthers(panel, ["leaderboard_opt_out"]);
          assert.equal(await dirty(f.page), true);
          assert.deepEqual(writes(f), []);
          assert.equal(f.store.rows.get(OWNER).leaderboardOptOut, saved);
        });
      }

      test("PRV-B04 clearing every text field explicitly describes removal", async (t) => {
        const f = await open(t, renderer, width);
        const persisted = await display(f.page);
        await enter(f.page, { bio: "", games_text: "", timezone: "" });
        await f.shot("removal-before");
        const panel = await review(f.page);
        for (const key of ["bio", "games_text", "timezone"])
          await comparison(panel, key, original[key], /remov|clear|empty|not set|blank|none/i);
        await unchangedOthers(panel, ["bio", "games_text", "timezone"]);
        assert.deepEqual(await display(f.page), persisted);
        assert.deepEqual(writes(f), []);
        await f.shot("removal-review");
      });

      test("PRV-B05 hostile invalid text is literal, not markup, validation or a leak", async (t) => {
        const f = await open(t, renderer, width);
        const marker = '<img src=x onerror="window.prvInjected=1"> & prv-draft-only';
        await enter(f.page, {
          bio: marker,
          games_text: "<svg onload=window.prvInjected=2>\nGo",
          timezone: "prv-invalid-zone",
        });
        const before = [...f.requests];
        const panel = await review(f.page);
        await comparison(panel, "bio", original.bio, marker);
        await comparison(
          panel,
          "games_text",
          original.games_text,
          "<svg onload=window.prvInjected=2>\nGo",
        );
        await comparison(panel, "timezone", original.timezone, "prv-invalid-zone");
        assert.equal(
          await panel
            .locator("[data-review-saved], [data-review-draft]")
            .locator("img, svg, script, iframe, [onerror], [onload]")
            .count(),
          0,
        );
        assert.equal(await f.page.evaluate(() => window.prvInjected), undefined);
        assert.equal(await f.page.getByTestId("profile-error").count(), 0);
        assert.equal(await f.page.locator('[aria-invalid="true"]').count(), 0);
        const audit = await f.page.evaluate(() => window.reviewAudit);
        assert.equal(JSON.stringify(audit).includes("prv-draft-only"), false);
        assert.deepEqual(f.requests, before);
        assert.equal(f.page.url(), ORIGIN + f.path);
        assert.equal(await dirty(f.page), true);
      });

      test("PRV-B06 over-limit review is bounded but never truncates or validates the draft", async (t) => {
        const f = await open(t, renderer, width);
        const bio = "🙂".repeat(5000) + "prv-tail-not-for-review";
        const games = "G".repeat(5000) + "prv-tail-not-for-review";
        await enter(f.page, { bio, games_text: games });
        const panel = await review(f.page);
        const b = await comparison(panel, "bio", original.bio, /^🙂/u);
        const g = await comparison(panel, "games_text", original.games_text, /^G/);
        // Permit a short truncation indicator outside the field's content cap.
        assert.ok(
          Array.from(b.draftText).length <= 1016,
          "PRV_BIO_BOUND: cap review near the existing 1000-code-point limit",
        );
        assert.ok(
          Array.from(g.draftText).length <= 1716,
          "PRV_GAMES_BOUND: cap review near the existing 1700-code-point raw limit",
        );
        assert.equal((await panel.textContent()).includes("prv-tail-not-for-review"), false);
        assert.equal(await field(f.page, "bio").inputValue(), bio);
        assert.equal(await field(f.page, "games_text").inputValue(), games);
        assert.equal(await f.page.getByTestId("profile-error").count(), 0);
        assert.deepEqual(writes(f), []);
      });

      test("PRV-B07 native 422 saved-A/draft-B review survives reset to A", async (t) => {
        const f = await open(t, renderer, width, { holdIsland: true });
        await enter(f.page, {
          bio: "B".repeat(1001),
          games_text: "Go",
          timezone: "UTC",
          leaderboard_opt_out: false,
        });
        const rejected = f.page.waitForResponse(
          (response) => response.request().method() === "POST",
        );
        await f.page.getByTestId("profile-save").click();
        assert.equal((await rejected).status(), 422);
        await f.page.getByTestId("profile-error").waitFor();
        await f.page.addScriptTag({
          content: readFileSync("public/islands/member-profile.js", "utf8"),
        });
        assert.equal(await dirty(f.page), true);
        await f.shot("rejected-before");
        const panel = await review(f.page);
        await comparison(panel, "bio", original.bio, /^B+/);
        await comparison(panel, "games_text", original.games_text, "Go");
        await comparison(panel, "leaderboard_opt_out", choice(true), choice(false));
        assert.equal(await field(f.page, "bio").inputValue(), "B".repeat(1001));
        assert.equal((await display(f.page))[0], original.bio);
        assert.deepEqual(saves(f), []);
        assert.equal(writes(f).length, 1);
        await f.shot("rejected-review");
        await f.page.getByTestId("profile-cancel").click();
        await clean(await review(f.page));
        assert.deepEqual(await values(f.page), original);
        assert.equal(await dirty(f.page), false);
        assert.equal(writes(f).length, 1);
      });

      test("PRV-B08 an acknowledged normalized save becomes the next review/reset baseline", async (t) => {
        const f = await open(t, renderer, width);
        await enter(f.page, {
          bio: "  Accepted bio  ",
          games_text: " Chess \nGo\nChess\n\n",
          timezone: "UTC",
          leaderboard_opt_out: false,
        });
        const held = f.holdNext();
        await f.page.getByTestId("profile-save").click();
        await held.started;
        assert.equal((await display(f.page))[0], original.bio);
        held.release();
        await f.page.getByTestId("profile-saved").waitFor();
        if (await f.page.getByTestId("profile-form").isHidden())
          await f.page.getByTestId("profile-edit-again").click();
        await clean(await review(f.page));
        assert.deepEqual(await values(f.page), {
          bio: "Accepted bio",
          games_text: "Chess\nGo",
          timezone: "UTC",
          leaderboard_opt_out: false,
        });
        assert.equal(await dirty(f.page), false);
        await enter(f.page, { bio: "Next unsaved" });
        await comparison(await review(f.page), "bio", "Accepted bio", "Next unsaved");
        await f.page.getByTestId("profile-cancel").click();
        await clean(await review(f.page));
        assert.equal(await field(f.page, "bio").inputValue(), "Accepted bio");
        assert.equal(writes(f).length, 1);
        assert.equal(saves(f).length, 1);
      });

      for (const saved of [false, true]) {
        // Break: an older ack overwrites or cleans newer text/checkbox input,
        // or the review keeps comparing against the original SSR baseline.
        test(`PRV-B09 pending ack preserves newer text and ${saved} checkbox choice`, async (t) => {
          const f = await open(t, renderer, width, { optOut: saved });
          await enter(f.page, {
            bio: "Accepted one",
            games_text: "Go",
            timezone: "UTC",
            leaderboard_opt_out: !saved,
          });
          const held = f.holdNext();
          await f.page.getByTestId("profile-save").click();
          await held.started;
          await enter(f.page, {
            bio: "Newer two",
            games_text: "Hex",
            timezone: "America/New_York",
            leaderboard_opt_out: saved,
          });
          await f.page.getByTestId("profile-name").focus();
          await f.shot(`pending-${saved}-before`);
          const panel = await review(f.page);
          await comparison(panel, "bio", original.bio, "Newer two");
          assert.equal((await display(f.page))[0], original.bio);
          assert.equal(writes(f).length, 1);
          held.release();
          await f.page.getByTestId("profile-saved").waitFor();
          const acceptedPanel = await review(f.page);
          await comparison(acceptedPanel, "bio", "Accepted one", "Newer two");
          await comparison(acceptedPanel, "games_text", "Go", "Hex");
          await comparison(acceptedPanel, "timezone", "UTC", "America/New_York");
          await comparison(acceptedPanel, "leaderboard_opt_out", choice(!saved), choice(saved));
          assert.equal(await dirty(f.page), true);
          assert.equal((await display(f.page))[0], "Accepted one");
          assert.equal(await field(f.page, "bio").inputValue(), "Newer two");
          assert.equal(await field(f.page, "leaderboard_opt_out").isChecked(), saved);
          assert.equal(writes(f).length, 1);
          await f.shot(`pending-${saved}-review`);
          await f.page.getByTestId("profile-cancel").click();
          await clean(await review(f.page));
          assert.equal(await field(f.page, "bio").inputValue(), "Accepted one");
          assert.equal(await field(f.page, "leaderboard_opt_out").isChecked(), !saved);
          assert.equal(await dirty(f.page), false);
        });
      }

      for (const [status, body, notice] of [
        [422, { error: "invalid", fields: { bio: "Fixture refusal" } }, "profile-error"],
        [401, { error: "unauthenticated" }, "profile-session-expired"],
        [500, { error: "unavailable" }, "profile-save-failed"],
        [503, { error: "profile_save_uncertain" }, "profile-uncertain"],
        [200, { saved: false }, "profile-save-failed"],
      ]) {
        test(`PRV-B10 ${status}/${notice} retains review, dirty state and saved display`, async (t) => {
          const f = await open(t, renderer, width);
          await enter(f.page, { bio: "Unacknowledged draft", leaderboard_opt_out: false });
          const held = f.holdNext({ status, body });
          await f.page.getByTestId("profile-save").click();
          await held.started;
          held.release();
          await f.page.getByTestId(notice).waitFor();
          const panel = await review(f.page);
          await comparison(panel, "bio", original.bio, "Unacknowledged draft");
          await comparison(panel, "leaderboard_opt_out", choice(true), choice(false));
          assert.equal(await dirty(f.page), true);
          assert.equal((await display(f.page))[0], original.bio);
          assert.equal(await field(f.page, "bio").inputValue(), "Unacknowledged draft");
          assert.equal(writes(f).length, 1);
          assert.deepEqual(saves(f), []);
        });
      }

      test("PRV-B11 deadline expiry rejects a late saved ack without hiding differences", async (t) => {
        const f = await open(t, renderer, width, { unabortable: true });
        await f.page.clock.install();
        await enter(f.page, { bio: "Timed out draft" });
        const held = f.holdNext({ status: 200, body: { saved: true } });
        const late = f.page.waitForResponse((response) => response.request().method() === "PATCH");
        await f.page.getByTestId("profile-save").click();
        await held.started;
        await f.page.clock.fastForward(PROFILE_SAVE_DEADLINE_MS + 1);
        await f.page.getByTestId("profile-uncertain").waitFor();
        held.release();
        await (await late).finished();
        await browserTurn(f.page);
        const panel = await review(f.page);
        await comparison(panel, "bio", original.bio, "Timed out draft");
        assert.equal(await dirty(f.page), true);
        assert.equal((await display(f.page))[0], original.bio);
        assert.equal(await f.page.getByTestId("profile-saved").count(), 0);
        assert.equal(writes(f).length, 1);
        assert.deepEqual(saves(f), []);
      });

      test("PRV-B12 Cancel during pending save fences its eventual ack and review stays clean", async (t) => {
        const f = await open(t, renderer, width);
        await enter(f.page, { bio: "Cancelled draft", leaderboard_opt_out: false });
        const held = f.holdNext({ status: 200, body: { saved: true } });
        await f.page.getByTestId("profile-save").click();
        await held.started;
        await f.page.getByTestId("profile-cancel").click();
        held.release();
        await f.page.waitForFunction(
          () => !document.querySelector('[data-testid="profile-form"]').hasAttribute("aria-busy"),
        );
        await clean(await review(f.page));
        assert.deepEqual(await values(f.page), original);
        assert.equal(await dirty(f.page), false);
        assert.equal((await display(f.page))[0], original.bio);
        assert.equal(await f.page.getByTestId("profile-saved").count(), 0);
        assert.equal(writes(f).length, 1);
      });

      test("PRV-B13 viewing review does not silence a real dirty-departure dialog", async (t) => {
        const f = await open(t, renderer, width);
        await enter(f.page, { bio: "Stay until explicitly saved" });
        await review(f.page);
        const dialog = f.page.waitForEvent("dialog");
        const navigation = f.page.goto(ORIGIN + "/events").catch(() => null);
        const warning = await dialog;
        assert.equal(warning.type(), "beforeunload");
        await warning.dismiss();
        await navigation;
        assert.equal(await field(f.page, "bio").inputValue(), "Stay until explicitly saved");
        assert.equal(f.page.url(), ORIGIN + f.path);
        assert.deepEqual(writes(f), []);
        await f.page.getByTestId("profile-cancel").click();
        assert.equal(await dirty(f.page), false);
        await f.page.goto(ORIGIN + "/events");
        assert.match(await f.page.locator("h1").textContent(), /Local events/);
      });

      test("PRV-B14 focused raw text acknowledged by the server is clean despite normalized defaults", async (t) => {
        const f = await open(t, renderer, width);
        await enter(f.page, { bio: "  Accepted raw bio  " });
        const held = f.holdNext();
        await f.page.getByTestId("profile-save").click();
        await held.started;
        await field(f.page, "bio").focus();
        held.release();
        await f.page.getByTestId("profile-saved").waitFor();
        assert.equal(await field(f.page, "bio").inputValue(), "  Accepted raw bio  ");
        assert.equal((await display(f.page))[0], "Accepted raw bio");
        assert.equal(await dirty(f.page), false);
        await clean(await review(f.page));
        await field(f.page, "bio").fill("  Accepted raw bio newer  ");
        const panel = await review(f.page);
        await comparison(panel, "bio", "Accepted raw bio", "Accepted raw bio newer");
        assert.equal(await dirty(f.page), true);
        assert.equal(writes(f).length, 1);
      });

      test("PRV-B15 an open review follows input/reset and ignores non-profile hidden fields", async (t) => {
        const f = await open(t, renderer, width);
        const panel = await review(f.page);
        await clean(panel);
        await field(f.page, "bio").fill("Live unsaved difference");
        await comparison(panel, "bio", original.bio, "Live unsaved difference");
        await field(f.page, "bio").fill("");
        await comparison(panel, "bio", original.bio, /remov|clear|empty|not set|blank|none/i);
        await field(f.page, "bio").fill(original.bio);
        await clean(panel);
        await f.page.evaluate(() => {
          const form = document.querySelector('[data-testid="profile-form"]');
          form.elements.website.value = "prv-honeypot-not-profile-content";
          form.elements.formOpenedAt.value = "1";
          form.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await clean(panel);
        assert.equal((await panel.textContent()).includes("prv-honeypot"), false);
        assert.deepEqual(writes(f), []);
        assert.deepEqual(f.operations, [{ method: "find", args: [OWNER] }]);
      });

      // Positive controls run independently: no review assertion can hide a
      // broken renderer, browser, native-write route, or read-only boundary.
      test("PRV-C10 no-JS Save remains an ordinary complete form, with no review gate", async (t) => {
        const f = await open(t, renderer, width, { javaScriptEnabled: false });
        assert.equal(await f.page.getByTestId("profile-save").isVisible(), true);
        assert.equal(await f.page.getByTestId("profile-cancel").isVisible(), true);
        await enter(f.page, {
          bio: "Native saved bio",
          games_text: "Go",
          timezone: "UTC",
          leaderboard_opt_out: false,
        });
        const posted = f.page.waitForResponse((response) => response.request().method() === "POST");
        await f.page.getByTestId("profile-save").click();
        assert.equal((await posted).status(), 200);
        assert.equal(writes(f)[0].status, 303);
        assert.equal(writes(f)[0].followed, `/members/${OWNER}`);
        await f.page.waitForURL(ORIGIN + `/members/${OWNER}`);
        const saved = f.store.rows.get(OWNER);
        assert.deepEqual(
          {
            bio: saved.bio,
            games: saved.games,
            timezone: saved.timezone,
            leaderboardOptOut: saved.leaderboardOptOut,
          },
          {
            bio: "Native saved bio",
            games: ["Go"],
            timezone: "UTC",
            leaderboardOptOut: false,
          },
        );
        assert.equal(writes(f).length, 1);
        assert.equal(saves(f).length, 1);
        assert.deepEqual(f.forbidden, []);
      });

      test("PRV-C11 ordinary Save without opening review still sends exactly one PATCH", async (t) => {
        const f = await open(t, renderer, width);
        await enter(f.page, { bio: "Explicit saved bio" });
        await f.page.getByTestId("profile-save").click();
        await f.page.getByTestId("profile-saved").waitFor();
        assert.equal(writes(f).length, 1);
        assert.equal(writes(f)[0].method, "PATCH");
        assert.equal(saves(f).length, 1);
        assert.equal((await display(f.page))[0], "Explicit saved bio");
        assert.equal(await dirty(f.page), false);
      });

      test("PRV-C12 another member has no editor/review and retains one audited read", async (t) => {
        const f = await open(t, renderer, width, { presentation: "other member" });
        assert.equal(await f.page.getByTestId("profile-form").count(), 0);
        assert.equal(await f.page.getByTestId("profile-review").count(), 0);
        assert.equal(await f.page.locator("[data-saved-bio]").count(), 0);
        assert.deepEqual(f.operations, [{ method: "find", args: [OWNER] }]);
        assert.equal(f.audit.length, 1);
        assert.deepEqual(writes(f), []);
      });
    });
  }
}
