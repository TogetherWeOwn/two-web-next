import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { generateSignedCookie } from "hono/cookie";
import { chromium } from "playwright";
import postgres from "postgres";
import {
  PROFILE_MIN_FILL_MS,
  PROFILE_OPENED_AT_FIELD,
} from "../../src/islands/contracts-member-profile.ts";
import {
  parseRenderedPage,
  renderedAttribute,
  renderedElements,
  renderedText,
} from "../rendered-page.mjs";

const owner = "900000000000090810";
const moderator = "900000000000090811";
const outsider = "900000000000090812";
const viewers = [owner, moderator, outsider];
const profilePath = `/members/${owner}`;
const base = "Synthetic saved profile";
const draft = "Synthetic rejected draft <example>";
const updated = "Synthetic native-form save";
const fallbackBio = "Synthetic fallback form save";
const viewports = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

async function send(origin, path, { cookie, body, method, headers } = {}) {
  return fetch(origin + path, {
    redirect: "manual",
    method,
    body,
    headers: { origin, ...(cookie ? { cookie } : {}), ...headers },
    signal: AbortSignal.timeout(20_000),
  });
}

async function envelope(response) {
  const type = response.headers.get("content-type") ?? "";
  const requestId = response.headers.get("x-request-id");
  const body = type.includes("application/json")
    ? await response.json()
    : (await response.text()).replaceAll(requestId ?? "never-a-request-id", "[request-id]");
  if (typeof body === "object" && body?.request_id) {
    assert.equal(body.request_id, response.headers.get("x-request-id"));
    delete body.request_id;
  }
  return {
    status: response.status,
    body,
    headers: ["allow", "vary", "cache-control", "retry-after", "location"].map((name) => {
      const value = response.headers.get(name);
      // Cache-Control directive order has no wire meaning. Match Allow and Vary exactly.
      return name === "cache-control" && value
        ? value
            .split(",")
            .map((directive) => directive.trim())
            .sort()
            .join(", ")
        : value;
    }),
  };
}

async function nativeForm({ kit, off, cookie, moderatorCookie, readProfile, hasLiveOwnerSession }) {
  const directory = process.env.KIT_PROFILE_WRITE_EVIDENCE_DIR;
  if (directory) await mkdir(directory, { recursive: true });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    await context.route("**/*", (route) =>
      [kit, off].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort(),
    );
    const [name, value] = cookie.split(/=(.*)/s);
    await context.addCookies([
      {
        name,
        value,
        domain: new URL(kit).hostname,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const bio = page.locator("#profile-bio");
    const timezone = page.locator("#profile-timezone");
    const hide = page.locator("#profile-leaderboard-opt-out");
    const form = page.getByTestId("profile-form");
    const assertLiveBearer = async () => {
      const current = (await context.cookies()).find((candidate) => candidate.name === name);
      assert.ok(current, "the browser has a session cookie");
      assert.ok(
        await hasLiveOwnerSession(current.value.split(".")[0]),
        "the browser uses a live owner token outside predecessor grace",
      );
    };
    const submit = async (origin) => {
      const pending = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" && response.url() === origin + profilePath,
      );
      await page.getByTestId("profile-save").click();
      return pending;
    };
    const rejectDraft = async () => {
      await bio.fill(draft);
      await timezone.fill("Not/AZone");
      await hide.check();
      const invalid = await submit(kit);
      assert.equal(invalid.status(), 422);
      assert.equal(invalid.headers()["x-two-renderer"], "kit");
      assert.equal(invalid.headers()["cache-control"], "private, no-store");
      assert.equal(invalid.headers().vary, undefined);
    };
    const capture = async (state) => {
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (directory) {
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          await page.screenshot({
            path: join(directory, `${state}-${viewport.width}.png`),
            fullPage: true,
          });
        }
      }
    };
    const waitForFill = async () => {
      // Workerd and the fixture share the runner clock. Wait outside the no-JS browser.
      const opened = Number(await form.locator(`[name="${PROFILE_OPENED_AT_FIELD}"]`).inputValue());
      const now = Date.now();
      assert.ok(Number.isSafeInteger(opened) && opened > 0 && opened <= now);
      await delay(Math.max(0, opened + PROFILE_MIN_FILL_MS - now + 1));
    };
    const assertSaved = async (expectedBio) => {
      const row = await readProfile();
      const { bio, games, timezone, leaderboard_opt_out } = row;
      assert.deepEqual(
        { bio, games, timezone, leaderboard_opt_out },
        {
          bio: expectedBio,
          games: ["Chess", "Go"],
          timezone: "Europe/London",
          leaderboard_opt_out: true,
        },
      );
      return row;
    };

    const get = await page.goto(kit + profilePath);
    assert.equal(get.status(), 200);
    assert.equal(get.headers()["x-two-renderer"], undefined);
    assert.equal(await form.getAttribute("action"), profilePath);
    assert.equal(await form.locator('[name="_method"]').inputValue(), "PATCH");
    assert.equal(await bio.inputValue(), base);
    await capture("before");
    await rejectDraft();
    const summary = page.getByTestId("profile-error");
    const errorLink = summary.getByRole("link", { name: /valid IANA timezone/ });
    assert.equal(await errorLink.getAttribute("href"), "#profile-timezone");
    assert.equal(await timezone.getAttribute("aria-invalid"), "true");
    assert.match(await timezone.getAttribute("aria-describedby"), /\bprofile-timezone-error\b/);
    assert.equal(await bio.inputValue(), draft);
    assert.equal(await hide.isChecked(), true);
    assert.equal(await page.getByTestId("profile-edit").getAttribute("data-saved-bio"), base);
    assert.equal(
      await page.getByTestId("profile-edit").getAttribute("data-saved-leaderboard-opt-out"),
      "0",
    );
    assert.ok(!(await page.content()).includes(value));
    await capture("rejected");

    const cancel = page.getByTestId("profile-cancel");
    assert.equal(await cancel.getAttribute("href"), profilePath);
    await cancel.click();
    assert.equal(await bio.inputValue(), base);
    assert.equal(await timezone.inputValue(), "UTC");
    assert.equal(await hide.isChecked(), false);
    assert.equal(await summary.count(), 0);

    // Retry directly from a rejected document, with its retained checkbox.
    await rejectDraft();
    assert.equal(await bio.inputValue(), draft);
    assert.equal(await hide.isChecked(), true);
    await bio.fill(updated);
    await timezone.fill("Europe/London");
    await page.locator("#profile-games-text").fill("Chess\nGo\nChess");
    await waitForFill();
    const accepted = await submit(kit);
    assert.equal(accepted.status(), 303);
    assert.equal(accepted.headers()["x-two-renderer"], "kit");
    assert.equal(accepted.headers().location, profilePath);
    assert.equal(accepted.headers().vary, undefined);
    await page.waitForLoadState("load");
    assert.equal(await bio.inputValue(), updated);
    assert.equal(await hide.isChecked(), true);
    await capture("saved");
    await assertSaved(updated);

    // Both Workers share a loopback hostname. Keep the context's live bearer
    // through document rotations as the browser moves to the flag-off Worker.
    await assertLiveBearer();
    const fallbackPage = await page.goto(off + profilePath);
    assert.equal(fallbackPage.status(), 200);
    assert.equal(fallbackPage.headers()["x-two-renderer"], undefined);
    assert.equal(await bio.inputValue(), updated);
    assert.equal(await timezone.inputValue(), "Europe/London");
    assert.equal(await hide.isChecked(), true);
    await bio.fill(fallbackBio);
    await waitForFill();
    await assertLiveBearer();
    const fallback = await submit(off);
    assert.equal(fallback.status(), 303);
    assert.equal(fallback.headers()["x-two-renderer"], undefined);
    assert.equal(fallback.headers().location, profilePath);
    await page.waitForLoadState("load");
    assert.equal(page.url(), off + profilePath);
    assert.equal(
      await page.getByTestId("profile-edit").getAttribute("data-saved-bio"),
      fallbackBio,
    );
    const beforeDenial = await assertSaved(fallbackBio);

    const fallbackBody = fallback.request().postData();
    assert.ok(fallbackBody, "the fallback submitted a native form body");
    const deniedForm = new URLSearchParams(fallbackBody);
    deniedForm.set("bio", "Synthetic denied fallback draft");
    const denied = await send(off, profilePath, {
      method: "POST",
      body: deniedForm,
      headers: { accept: "text/html" },
      cookie: moderatorCookie,
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("x-two-renderer"), null);
    assert.equal(denied.headers.get("location"), null);
    assert.equal(denied.headers.get("vary"), "Accept");
    const denialPage = parseRenderedPage(await denied.text());
    const ownProfileLink = [...renderedElements(denialPage, { tag: "a" })].find(
      (link) => renderedAttribute(link, "data-testid") === "error-own-profile",
    );
    assert.ok(ownProfileLink, "fallback reached the owner-only denial");
    assert.equal(renderedAttribute(ownProfileLink, "href"), "/profile");
    assert.deepEqual(await readProfile(), beforeDenial);
    console.log(
      "PASS installed Kit native profile save, same-session Hono fallback and write denial",
    );
  } finally {
    await browser.close();
  }
}

/** The calling runner checks the disposable database URL and starts loopback Workers. */
export async function assertKitProfileWriteParity({ kit, off, hono, databaseUrl, secret }) {
  const sql = postgres(databaseUrl, { max: 1 });
  async function readProfile() {
    // The row version detects an update even if it would leave the same values.
    const [row] = await sql`select *, xmin::text as version from profiles where user_id = ${owner}`;
    return row;
  }
  async function hasLiveOwnerSession(token) {
    const hash = createHash("sha256").update(token).digest("hex");
    const [row] = await sql`
      select exists(select 1 from web_sessions
        where token_hash = ${hash} and user_id = ${owner} and expires_at > now()) as live`;
    return row.live;
  }
  async function session(id, { member = true, mod = false } = {}) {
    const token = `two_${randomBytes(32).toString("base64url")}`;
    const hash = createHash("sha256").update(token).digest("hex");
    await sql`
      insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at, roles_checked_at)
      values (${hash}, ${id}, 'Synthetic Profile', ${member}, ${mod}, now() + interval '10 minutes', now())`;
    const signed = await generateSignedCookie("__Host-two_session", token, secret, {
      path: "/",
      secure: true,
    });
    return signed.split(";")[0];
  }

  let seeded = false;
  try {
    await sql.begin(async (tx) => {
      const [existing] = await tx`
        select exists(
          select 1 from web_sessions where user_id in ${tx(viewers)}
          union all
          select 1 from web_session_grace where user_id in ${tx(viewers)}
        ) as occupied`;
      assert.equal(existing.occupied, false, "synthetic session identities must be unused");
      await tx`insert into users (id, username, member) values (${owner}, 'Synthetic Profile', true)`;
      await tx`
        insert into profiles (user_id, bio, games, timezone, leaderboard_opt_out)
        values (${owner}, ${base}, ${tx.json(["Chess"])}, 'UTC', false)`;
    });
    seeded = true;
    const cookie = await session(owner);
    const moderatorCookie = await session(moderator, { mod: true });
    const outsiderCookie = await session(outsider, { member: false });
    const json = { accept: "application/json", "content-type": "application/json" };
    const form = { accept: "text/html", "content-type": "application/x-www-form-urlencoded" };

    const methodCases = [
      [{ method: "POST", body: "{}", headers: json, cookie }, 405, "Accept", "GET, PATCH, POST"],
      [
        { method: "POST", body: "bio=refused", headers: form, cookie },
        405,
        "Accept",
        "GET, PATCH, POST",
      ],
      [{ method: "PATCH", body: "{", headers: json, cookie }, 400, "Accept", null],
      [{ method: "PATCH", body: "[]", headers: json, cookie }, 400, "Accept", null],
      [{ method: "PATCH", body: " ".repeat(65_537), headers: json, cookie }, 413, "Accept", null],
      [{ method: "PATCH", body: "{}", headers: json, cookie }, 422, null, null],
      [{ method: "PATCH", body: "{}", headers: json }, 401, "Cookie", null],
      [
        { method: "PATCH", body: "{}", headers: json, cookie: moderatorCookie },
        403,
        "Accept",
        null,
      ],
      [{ method: "PATCH", body: "{}", headers: json, cookie: outsiderCookie }, 403, "Accept", null],
    ];
    for (const [init, status, vary, allow] of methodCases) {
      const kitResponse = await send(kit, profilePath, init);
      assert.equal(kitResponse.headers.get("x-two-renderer"), "kit");
      assert.equal(kitResponse.headers.get("vary"), vary);
      assert.equal(kitResponse.headers.get("allow"), allow);
      assert.equal(kitResponse.status, status);
      assert.equal(kitResponse.headers.getSetCookie().length, 0);
      const [actual, legacy] = await Promise.all([
        envelope(kitResponse),
        send(hono, profilePath, init).then(envelope),
      ]);
      assert.deepEqual(actual, legacy);
    }
    for (const [path, accept] of [
      [profilePath, "*/*"],
      [`${profilePath}?/unknown`, "text/html"],
    ]) {
      const invalid = await send(kit, path, {
        method: "POST",
        body: new URLSearchParams({ _method: "PATCH", bio: draft, timezone: "Not/AZone" }),
        headers: { ...form, accept },
        cookie,
      });
      assert.equal(invalid.status, 422);
      assert.equal(invalid.headers.get("x-two-renderer"), "kit");
      assert.equal(invalid.headers.get("vary"), null);
      assert.match(invalid.headers.get("content-type"), /^text\/html/);
      const document = parseRenderedPage(await invalid.text());
      const editor = [...renderedElements(document, { tag: "form" })].find(
        (candidate) => renderedAttribute(candidate, "data-testid") === "profile-form",
      );
      assert.ok(editor, "fallback response contains a parsed editor form");
      assert.equal(renderedAttribute(editor, "method"), "post");
      assert.equal(renderedAttribute(editor, "action"), profilePath);
      const [bio] = renderedElements(editor, { tag: "textarea", id: "profile-bio" });
      assert.ok(bio);
      assert.equal(renderedText(bio), draft);
      const [timezone] = renderedElements(editor, { tag: "input", id: "profile-timezone" });
      assert.ok(timezone);
      assert.equal(renderedAttribute(timezone, "value"), "Not/AZone");
      assert.equal(renderedAttribute(timezone, "aria-invalid"), "true");
      assert.match(renderedText(document), /Choose a valid IANA timezone/);
    }
    for (const headers of [form, { ...form, accept: "application/json" }]) {
      const init = {
        method: "POST",
        body: "_method=PATCH",
        cookie,
        headers: { ...headers, origin: "https://outside.invalid" },
      };
      const [native, legacy] = await Promise.all(
        [kit, hono].map((origin) => send(origin, profilePath, init).then(envelope)),
      );
      assert.equal(native.status, 403);
      assert.equal(native.headers[1], "Accept");
      assert.deepEqual(native, legacy);
    }
    const disabled = await send(off, profilePath, {
      method: "PATCH",
      body: "{",
      headers: json,
      cookie,
    });
    assert.equal(disabled.headers.get("x-two-renderer"), null);
    assert.equal(disabled.status, 400);
    await disabled.body.cancel();

    for (const path of ["/members", "/members/"]) {
      for (const method of ["GET", "HEAD"]) {
        const results = await Promise.all(
          [kit, hono].map((origin) => send(origin, path, { method, cookie })),
        );
        for (const response of results) {
          assert.equal(response.status, 404);
          assert.equal(response.headers.get("x-two-renderer"), null);
          assert.equal(response.headers.getSetCookie().length, 0);
        }
        assert.deepEqual(await envelope(results[0]), await envelope(results[1]));
      }
    }

    await nativeForm({ kit, off, cookie, moderatorCookie, readProfile, hasLiveOwnerSession });
    // Document navigation rotates the browser's bearer. Issue a fresh token
    // for the independent PATCH probe so it cannot rely on predecessor grace.
    const patchCookie = await session(owner);
    const patch = {
      bio: "Synthetic island save",
      games_text: "Go\r\nGo",
      timezone: "UTC",
      leaderboard_opt_out: false,
      website: "",
      formOpenedAt: Date.now() - 2000,
    };
    const res = await send(kit, profilePath, {
      method: "PATCH",
      body: JSON.stringify(patch),
      headers: json,
      cookie: patchCookie,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-two-renderer"), "kit");
    const saved = await envelope(res);
    assert.equal(saved.body.saved, true);
    const trapped = await send(kit, profilePath, {
      method: "PATCH",
      body: JSON.stringify({
        ...patch,
        bio: "Swallowed synthetic draft",
        formOpenedAt: Date.now() + 2000,
      }),
      headers: json,
      cookie: patchCookie,
    });
    assert.deepEqual(await envelope(trapped), saved);
    const [persisted] = await sql`
      select bio, games, timezone, leaderboard_opt_out from profiles where user_id = ${owner}`;
    assert.deepEqual(persisted, {
      bio: patch.bio,
      games: ["Go"],
      timezone: "UTC",
      leaderboard_opt_out: false,
    });
    const [audit] = await sql`
      select count(*)::int as total from member_data_access_logs
      where viewer_discord_id in ${sql(viewers)}`;
    assert.equal(audit.total, 0);
    console.log(
      "PASS profile write flag, admission, wire parity, native drafts and editor payload",
    );
  } finally {
    try {
      await sql.begin(async (tx) => {
        if (seeded) {
          await tx`delete from web_session_grace where user_id in ${tx(viewers)}`;
          await tx`delete from web_sessions where user_id in ${tx(viewers)}`;
          await tx`delete from member_data_access_logs where viewer_discord_id in ${tx(viewers)}`;
          await tx`delete from profiles where user_id = ${owner}`;
          await tx`delete from users where id = ${owner}`;
          await tx`delete from web_throttle_hits where bucket in ${tx([`profile-write:${owner}`, `profile-write:${moderator}`])}`;
        }
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
}
