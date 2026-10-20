// Independent acceptance: device timezone is an explicit draft edit, never a
// location lookup or a save. Removing guidance, auto-applying detection, losing
// a reset baseline, or letting an old save own a newer choice must fail here.
// Run: npx vitest run test/profile-device-timezone.test.ts
// Chromium and the locked root/web development dependencies are required.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { serializeSigned } from "hono/utils/cookie";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { PROFILE_OPENED_AT_FIELD } from "../src/islands/contracts";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const ID = "100000000000000001";
const ORIGIN = "https://next.example.test";
const SAVED = {
  id: ID,
  username: "fixture-member",
  avatar: null,
  bio: "Synthetic saved bio",
  games: ["Synthetic game"],
  timezone: "Europe/London",
  leaderboardOptOut: true,
};
const DEVICE = "Asia/Tokyo";
const env = {
  APP_URL: ORIGIN,
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
} as Env;
const assets: Record<string, string> = {
  "/islands/member-profile.js": readFileSync("public/islands/member-profile.js", "utf8"),
  "/islands/avatar.js": readFileSync("public/islands/avatar.js", "utf8"),
};

type Detection =
  | "valid"
  | "missing"
  | "constructor-throws"
  | "options-throws"
  | "blank"
  | "malformed"
  | "unsupported"
  | "alias";

async function fixture(timezone = SAVED.timezone) {
  const sessions = createMemorySessionStore();
  const token = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: ID,
    username: SAVED.username,
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const cookie = (
    await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
  const store = createMemoryProfileStore([{ ...SAVED, timezone: timezone || null }]);
  const app = profilesApp({
    sessionStore: sessions,
    store,
    accessLog: async () => true,
    throttle: async () => ({ limited: false }),
  });
  return { app, store, cookie };
}

type Editor = "Hono" | "Kit";
type OpenOptions = {
  timezone?: string;
  detection?: Detection;
  javaScriptEnabled?: boolean;
  withholdIsland?: boolean;
  rejectedKitDraft?: boolean;
};
let renderKit: (props: Record<string, unknown>) => string;
let browser: Browser;
let contexts: BrowserContext[] = [];
beforeAll(async () => {
  const worktree = fileURLToPath(new URL("../", import.meta.url).href);
  const scratchRoot =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
    process.env.PAPERCLIP_SCRATCH_DIR ??
    process.env.RUNNER_TEMP ??
    process.env.TMPDIR;
  if (!scratchRoot)
    throw new Error("Set TMPDIR to an owned scratch directory for the SSR compilation fixture.");
  const scratch = mkdtempSync(join(scratchRoot, "device-timezone-ssr-"));
  const entry = join(scratch, "entry.mjs");
  const outfile = join(scratch, "view.mjs");
  const webRequire = createRequire(new URL("../web/package.json", import.meta.url).href);
  const { compile } = webRequire("svelte/compiler");
  writeFileSync(
    entry,
    `import { render } from 'svelte/server';
import View from ${JSON.stringify(join(worktree, "web/src/lib/ProfileView.svelte"))};
export function renderKit(props) { const { body, head } = render(View, { props }); return '<!doctype html><html><head>' + head + '</head><body>' + body + '</body></html>'; }`,
  );
  try {
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: worktree,
      nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
      plugins: [
        {
          name: "device-timezone-real-kit-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, (args) => ({
              contents: compile(readFileSync(args.path, "utf8"), {
                generate: "server",
                dev: false,
                filename: args.path,
              }).js.code,
              loader: "js",
              resolveDir: dirname(args.path),
            }));
          },
        },
      ],
    });
    ({ renderKit } = await import(pathToFileURL(outfile).href));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true });
});
afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  contexts = [];
});
afterAll(async () => {
  await browser?.close();
});

async function openProfileFor(editor: Editor, options: OpenOptions = {}) {
  const data = await fixture(options.timezone);
  const context = await browser.newContext({
    javaScriptEnabled: options.javaScriptEnabled ?? true,
    serviceWorkers: "block",
  });
  contexts.push(context);
  const separator = data.cookie.indexOf("=");
  await context.addCookies([
    {
      name: data.cookie.slice(0, separator),
      value: data.cookie.slice(separator + 1),
      url: ORIGIN,
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await context.addInitScript(`(() => {
    const mode = ${JSON.stringify(options.detection ?? "valid")};
    const Native = Intl.DateTimeFormat;
    const zone = mode === 'blank' ? '' : mode === 'malformed' ? 'Europe/../London' : mode === 'unsupported' ? 'Mars/Olympus' : mode === 'alias' ? 'US/Eastern' : 'Asia/Tokyo';
    if (mode === 'missing') Intl.DateTimeFormat = undefined;
    else {
      function Fixed(locales, options) {
        if (mode === 'constructor-throws') throw new Error('Unavailable Intl');
        const result = new Native(locales, options);
        if (!options || !('timeZone' in options)) result.resolvedOptions = () => {
          if (mode === 'options-throws') throw new Error('Unavailable options');
          return { timeZone: zone };
        };
        return result;
      }
      Fixed.prototype = Native.prototype;
      Fixed.supportedLocalesOf = Native.supportedLocalesOf.bind(Native);
      Intl.DateTimeFormat = Fixed;
    }
    window.deviceEffects = { geolocation: 0, beacon: 0, storage: 0, cookies: 0 };
    for (const name of ['getCurrentPosition', 'watchPosition']) Object.defineProperty(navigator.geolocation, name, { configurable: true, value: () => { window.deviceEffects.geolocation++; } });
    navigator.sendBeacon = () => { window.deviceEffects.beacon++; return true; };
    for (const name of ['setItem', 'removeItem', 'clear']) {
      const original = Storage.prototype[name];
      Storage.prototype[name] = function(...args) { window.deviceEffects.storage++; return original.apply(this, args); };
    }
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    Object.defineProperty(document, 'cookie', { get() { return cookie.get.call(this); }, set(value) { window.deviceEffects.cookies++; cookie.set.call(this, value); } });
  })()`);
  const requests: { method: string; path: string; body: string | null }[] = [];
  let withholdIsland = options.withholdIsland ?? false;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) {
      requests.push({ method: request.method(), path: url.href, body: request.postData() });
      return route.abort();
    }
    if (url.pathname in assets) {
      return route.fulfill({
        status: url.pathname.includes("member-profile") && withholdIsland ? 404 : 200,
        contentType: "text/javascript",
        body: assets[url.pathname],
      });
    }
    if (url.pathname !== "/profile" && !url.pathname.startsWith("/members/"))
      return route.fulfill({ status: 204 });
    requests.push({ method: request.method(), path: url.pathname, body: request.postData() });
    const headers = await request.allHeaders();
    let response = await data.app.request(
      url.href,
      { method: request.method(), headers, body: request.postData() ?? undefined },
      env,
    );
    // Fulfilled synthetic origins have no DNS. Follow only this native-save
    // redirect through the real router, not the network; the loopback controls
    // separately cover the browser's redirect mechanics.
    if (response.status === 302 || response.status === 303) {
      const target = new URL(response.headers.get("location")!, ORIGIN);
      expect(target.origin).toBe(ORIGIN);
      expect(target.pathname).toBe(`/members/${ID}`);
      response = await data.app.request(target.href, { headers: { cookie: data.cookie } }, env);
      expect(response.status).toBe(200);
    }
    let body = await response.text();
    if (editor === "Kit" && request.method() === "GET" && url.pathname === "/profile") {
      // Compile the real server component; do not create a second mutation flow.
      // Native POSTs and JSON PATCHes still dispatch to the real Hono routes.
      body = renderKit({
        member: await data.store.find(ID),
        stats: null,
        isOwner: true,
        isModerator: false,
        appUrl: ORIGIN,
        joinResult: null,
        ...(options.rejectedKitDraft
          ? {
              errors: { timezone: "Choose a valid IANA timezone, e.g. Europe/London." },
              values: {
                bio: SAVED.bio,
                games_text: SAVED.games[0],
                timezone: "Mars/Olympus",
                leaderboard_opt_out: true,
              },
            }
          : {}),
      });
    }
    if (response.headers.get("content-type")?.includes("text/html")) {
      body = body.replace(
        new RegExp(`(name="${PROFILE_OPENED_AT_FIELD}" value=")[^"]+`),
        (_, prefix) => prefix + String(Date.now() - 5000),
      );
    }
    if (request.method() !== "GET") withholdIsland = false;
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body,
    });
  });
  const page = await context.newPage();
  const scriptErrors: string[] = [];
  page.on("pageerror", (error) => scriptErrors.push(error.message));
  await page.goto(`${ORIGIN}/profile`);
  if (options.javaScriptEnabled !== false) await settle(page);
  if (!(await timezoneField(page).isVisible())) await page.getByTestId("profile-edit").click();
  expect(scriptErrors).toEqual([]);
  return { ...data, context, page, requests, scriptErrors };
}

const timezoneField = (page: Page) => page.locator('[name="timezone"]').first();
const helper = (page: Page) => page.getByRole("button", { name: /use this device.s time\s*zone/i });
async function activate(page: Page) {
  // Assert absence directly instead of timing out on a missing feature.
  expect(await helper(page).count(), "an explicit device-timezone control is offered").toBe(1);
  expect(await helper(page).isVisible()).toBe(true);
  expect(await helper(page).isEnabled()).toBe(true);
  await helper(page).click();
  await settle(page);
}
async function settle(page: Page) {
  await page.evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
}
async function state(page: Page) {
  return {
    timezone: await timezoneField(page).inputValue(),
    bio: await page.locator('[name="bio"]').inputValue(),
    games: await page.locator('[name="games_text"]').inputValue(),
    leaderboard: await page.locator("#profile-leaderboard-opt-out").isChecked(),
    dirty: await page.evaluate<boolean>(
      "(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })()",
    ),
  };
}
async function noPrivateEffects(page: Page) {
  expect(await page.evaluate("window.deviceEffects")).toEqual({
    geolocation: 0,
    beacon: 0,
    storage: 0,
    cookies: 0,
  });
}
async function guidance(page: Page) {
  const field = timezoneField(page);
  expect(await field.isEditable()).toBe(true);
  expect(await page.getByRole("textbox", { name: /timezone/i }).count()).toBe(1);
  // Inspect rendered content, not the renderer's source or a particular help id.
  const text = await page.getByTestId("profile-form").textContent();
  expect(text).toMatch(/IANA/i);
  expect(text).toMatch(/Europe\/London|Asia\/Tokyo|America\/New_York/);
  expect(text).toMatch(/blank|empty|optional/i);
}

// Both renderers must share this lifecycle. Kit cases are registered below via
// the same browser harness, with its actual server component as the GET body.
describe.each<Editor>(["Hono", "Kit"])("%s device timezone acceptance", (editor) => {
  const openProfile = (options: OpenOptions = {}) => openProfileFor(editor, options);
  for (const timezone of ["", SAVED.timezone]) {
    it(`detection is inert for ${timezone || "a blank profile"} until explicitly activated`, async () => {
      const { page, requests, store } = await openProfile({ timezone });
      expect(await state(page)).toEqual({
        timezone,
        bio: SAVED.bio,
        games: SAVED.games[0],
        leaderboard: true,
        dirty: false,
      });
      expect(requests).toEqual([{ method: "GET", path: "/profile", body: null }]);
      await noPrivateEffects(page);
      expect((await store.find(ID))?.timezone).toBe(timezone || null);
    });
    it(`activation changes only the timezone draft for ${timezone || "a blank profile"}`, async () => {
      const { page, requests, store } = await openProfile({ timezone });
      await page.evaluate(
        "window.timezoneEvents = []; for (const type of ['input', 'change']) document.querySelector('[name=timezone]').addEventListener(type, e => window.timezoneEvents.push(e.type));",
      );
      await activate(page);
      expect(await state(page)).toEqual({
        timezone: DEVICE,
        bio: SAVED.bio,
        games: SAVED.games[0],
        leaderboard: true,
        dirty: true,
      });
      expect(await page.evaluate("window.timezoneEvents.length")).toBeGreaterThan(0);
      expect(requests).toEqual([{ method: "GET", path: "/profile", body: null }]);
      expect((await store.find(ID))?.timezone).toBe(timezone || null);
      await noPrivateEffects(page);
    });
  }
  it("activation preserves other unsaved field and leaderboard choices", async () => {
    const { page, requests, store } = await openProfile();
    await page.locator('[name="bio"]').fill("An unsaved bio");
    await page.locator('[name="games_text"]').fill("Unsaved game");
    await page.locator("#profile-leaderboard-opt-out").uncheck();
    await activate(page);
    expect(await state(page)).toEqual({
      timezone: DEVICE,
      bio: "An unsaved bio",
      games: "Unsaved game",
      leaderboard: false,
      dirty: true,
    });
    expect(await store.find(ID)).toMatchObject(SAVED);
    expect(requests).toHaveLength(1);
    await noPrivateEffects(page);
  });
  it("keeps ordinary manual entry and blank native saves usable without JavaScript", async () => {
    const { page, store, requests } = await openProfile({ javaScriptEnabled: false });
    expect(await timezoneField(page).isEditable()).toBe(true);
    expect(await helper(page).isVisible()).toBe(false);
    await timezoneField(page).fill("");
    await Promise.all([page.waitForNavigation(), page.getByTestId("profile-save").click()]);
    expect((await store.find(ID))?.timezone).toBeNull();
    expect(
      requests.filter((request) => request.method !== "GET").map((request) => request.method),
    ).toEqual(["POST"]);
  });
  it("explains the format and optional blank value in server-rendered no-JS content", async () => {
    const { page } = await openProfile({ javaScriptEnabled: false });
    await guidance(page);
  });
  for (const detection of [
    "missing",
    "constructor-throws",
    "options-throws",
    "blank",
    "malformed",
    "unsupported",
  ] as const) {
    it(`does not offer a usable helper for ${detection} detection; manual input still works`, async () => {
      const { page, requests } = await openProfile({ detection });
      const control = helper(page);
      if (await control.count())
        expect((await control.isVisible()) && (await control.isEnabled())).toBe(false);
      await timezoneField(page).fill("America/New_York");
      expect((await state(page)).timezone).toBe("America/New_York");
      expect((await state(page)).dirty).toBe(true);
      expect(requests).toHaveLength(1);
      await noPrivateEffects(page);
    });
  }
  it("does not overwrite an existing typed draft during helper setup", async () => {
    const { page, requests } = await openProfile({ withholdIsland: true });
    await timezoneField(page).fill("America/New_York");
    await page.addScriptTag({ content: assets["/islands/member-profile.js"] });
    await settle(page);
    expect(await timezoneField(page).inputValue()).toBe("America/New_York");
    expect(requests).toHaveLength(1);
    await noPrivateEffects(page);
  });
  for (const action of ["cancel", "reset"] as const) {
    it(`${action} restores the saved baseline after a device draft, not the detected timezone`, async () => {
      const { page, requests } = await openProfile();
      await activate(page);
      if (action === "cancel") await page.getByTestId("profile-cancel").click();
      else
        await timezoneField(page).evaluate((element) =>
          (element as unknown as { form: { reset(): void } }).form.reset(),
        );
      await settle(page);
      expect(await state(page)).toEqual({
        timezone: SAVED.timezone,
        bio: SAVED.bio,
        games: SAVED.games[0],
        leaderboard: true,
        dirty: false,
      });
      expect(requests).toHaveLength(1);
    });
  }
  it("clears a device draft manually and saves blank through the existing PATCH path", async () => {
    const { page, store, requests } = await openProfile();
    await activate(page);
    await timezoneField(page).fill("");
    await page.getByTestId("profile-save").click();
    await page.getByTestId("profile-saved").waitFor();
    expect((await store.find(ID))?.timezone).toBeNull();
    expect(
      requests
        .filter((request) => request.method !== "GET")
        .map((request) => ({ method: request.method, path: request.path })),
    ).toEqual([{ method: "PATCH", path: `/members/${ID}` }]);
    await page.getByTestId("profile-edit-again").click();
    expect((await state(page)).dirty).toBe(false);
    await activate(page);
    await page.getByTestId("profile-cancel").click();
    expect(await timezoneField(page).inputValue()).toBe("");
  });
  it("native 422 retains the rejected draft and error association; helper correction and Cancel use the saved baseline", async () => {
    const { page, store } = await openProfile({ withholdIsland: true });
    await timezoneField(page).fill("Mars/Olympus");
    await Promise.all([page.waitForNavigation(), page.getByTestId("profile-save").click()]);
    await settle(page);
    expect(await timezoneField(page).inputValue()).toBe("Mars/Olympus");
    expect(await timezoneField(page).getAttribute("aria-invalid")).toBe("true");
    const describedBy =
      (await timezoneField(page).getAttribute("aria-describedby"))?.split(/\s+/) ?? [];
    expect(describedBy).toContain("profile-timezone-error");
    for (const id of describedBy) expect(await page.locator(`[id="${id}"]`).count()).toBe(1);
    expect((await state(page)).dirty).toBe(true);
    await activate(page);
    expect(await timezoneField(page).inputValue()).toBe(DEVICE);
    expect((await store.find(ID))?.timezone).toBe(SAVED.timezone);
    await page.getByTestId("profile-cancel").click();
    expect((await state(page)).timezone).toBe(SAVED.timezone);
    expect((await state(page)).dirty).toBe(false);
  });
  it("saves an explicit choice only after Save and makes that successful choice the next Cancel baseline", async () => {
    const { page, store, requests } = await openProfile();
    await activate(page);
    await page.getByTestId("profile-save").click();
    await page.getByTestId("profile-saved").waitFor();
    expect(await store.find(ID)).toMatchObject({
      timezone: DEVICE,
      bio: SAVED.bio,
      games: SAVED.games,
      leaderboardOptOut: true,
    });
    const writes = requests.filter((request) => request.method !== "GET");
    expect(writes).toHaveLength(1);
    const write = writes[0]!;
    expect(write).toMatchObject({ method: "PATCH", path: `/members/${ID}` });
    expect(JSON.parse(write.body!)).toMatchObject({ timezone: DEVICE });
    await page.getByTestId("profile-edit-again").click();
    expect((await state(page)).dirty).toBe(false);
    await timezoneField(page).fill("America/New_York");
    await page.getByTestId("profile-cancel").click();
    expect((await state(page)).timezone).toBe(DEVICE);
    expect((await state(page)).dirty).toBe(false);
  });
  for (const status of [200, 422]) {
    it(`an older ${status} save of a device draft cannot replace or clear a newer timezone choice`, async () => {
      const { page, store } = await openProfile();
      let release!: () => void;
      let arrived!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const seen = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      await page.route("**/members/*", async (route) => {
        if (route.request().method() !== "PATCH") return route.fallback();
        arrived();
        await gate;
        if (status === 200) return route.fallback();
        return route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ errors: { timezone: "Choose a valid IANA timezone." } }),
        });
      });
      try {
        // Check the feature before entering a held request, so absence is a
        // behavior assertion rather than a timeout waiting for the save seam.
        await activate(page);
        await page.getByTestId("profile-save").click();
        await seen;
        await timezoneField(page).fill("America/New_York");
        const response = page.waitForResponse(
          (response) => response.request().method() === "PATCH",
        );
        release();
        await response;
        await settle(page);
        expect((await state(page)).timezone).toBe("America/New_York");
        expect((await state(page)).dirty).toBe(true);
        expect(await timezoneField(page).isVisible()).toBe(true);
        expect((await state(page)).leaderboard).toBe(true);
        expect((await store.find(ID))?.timezone).toBe(status === 200 ? DEVICE : SAVED.timezone);
        await page.getByTestId("profile-cancel").click();
        expect((await state(page)).timezone).toBe(status === 200 ? DEVICE : SAVED.timezone);
        expect((await state(page)).dirty).toBe(false);
      } finally {
        release();
      }
    });
  }
  it("positive control: a manual edit saves through PATCH and becomes the Cancel baseline", async () => {
    const { page, store, requests } = await openProfile();
    await timezoneField(page).fill("America/New_York");
    await page.getByTestId("profile-save").click();
    await page.getByTestId("profile-saved").waitFor();
    expect(await store.find(ID)).toMatchObject({
      timezone: "America/New_York",
      bio: SAVED.bio,
      games: SAVED.games,
      leaderboardOptOut: true,
    });
    expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
    await page.getByTestId("profile-edit-again").click();
    expect((await state(page)).dirty).toBe(false);
    await timezoneField(page).fill("Europe/Paris");
    await page.getByTestId("profile-cancel").click();
    expect((await state(page)).timezone).toBe("America/New_York");
    expect((await state(page)).dirty).toBe(false);
  });
  if (editor === "Kit") {
    it("Kit rejected-draft SSR preserves the error association and saved baseline when the shared island loads", async () => {
      const { page, requests } = await openProfile({ rejectedKitDraft: true });
      expect(await timezoneField(page).inputValue()).toBe("Mars/Olympus");
      expect(await timezoneField(page).getAttribute("aria-invalid")).toBe("true");
      expect((await timezoneField(page).getAttribute("aria-describedby"))?.split(/\s+/)).toContain(
        "profile-timezone-error",
      );
      expect((await state(page)).dirty).toBe(true);
      await activate(page);
      expect((await state(page)).timezone).toBe(DEVICE);
      await page.getByTestId("profile-cancel").click();
      expect((await state(page)).timezone).toBe(SAVED.timezone);
      expect((await state(page)).dirty).toBe(false);
      expect(requests).toHaveLength(1);
    });
  }
  it("keeps a server-rejected detected alias as an editable rejected draft instead of normalizing it", async () => {
    const { page, store } = await openProfile({ detection: "alias" });
    await activate(page);
    expect(await timezoneField(page).inputValue()).toBe("US/Eastern");
    await page.route("**/members/*", (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            status: 422,
            contentType: "application/json",
            body: JSON.stringify({ errors: { timezone: "Choose a valid IANA timezone." } }),
          })
        : route.fallback(),
    );
    await page.getByTestId("profile-save").click();
    await page.getByTestId("profile-error").waitFor();
    expect(await timezoneField(page).inputValue()).toBe("US/Eastern");
    expect(await timezoneField(page).getAttribute("aria-invalid")).toBe("true");
    expect((await state(page)).dirty).toBe(true);
    expect((await store.find(ID))?.timezone).toBe(SAVED.timezone);
  });
});
