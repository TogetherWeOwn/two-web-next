// Real route/load HTML and shipped islands; no server, database or remote IO.
// Chromium owns the datalist popup. Assert its native association and keyboard
// editing/submission contract, not OS-specific popup pixels or implementation JS.
import { test, expect } from "@playwright/test";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import app from "../test/app";
import {
  ORIGIN,
  KEY,
  PUBLISHED,
  fixtureDb,
  fixtureEnv,
  compileSuggestionKit,
  outage,
} from "../test/helpers/game-input-suggestions.mjs";

let kit;
test.beforeAll(async () => {
  kit = await compileSuggestionKit();
});
const root = resolve(import.meta.dirname, "..");
const surfaces = [
  {
    surface: "board",
    path: "/leaderboards/members",
    name: "activity",
    action: "/leaderboards/members",
    method: "GET",
  },
  {
    surface: "create",
    path: "/admin/events/new",
    name: "game",
    action: "/admin/events",
    method: "POST",
  },
  {
    surface: "edit",
    path: `/admin/events/${KEY}`,
    name: "game",
    action: `/admin/events/${KEY}`,
    method: "POST",
  },
];

async function rendered(twin, surface, path, state = "normal", values) {
  const f = fixtureDb(state === "fallback" ? { catalogError: outage() } : {});
  const { env, cookie } = await fixtureEnv(f.db);
  if (state === "error" && surface.surface === "board") path += `?activity=${"x".repeat(101)}`;
  if (values) {
    // Both Kit form actions remain Hono-owned, including the native 422.
    const response = await app.request(
      surface.action,
      {
        method: "POST",
        headers: { cookie, origin: ORIGIN, accept: "text/html" },
        body: new URLSearchParams(values),
      },
      env,
    );
    return { status: response.status, html: await response.text() };
  }
  if (twin === "Hono") {
    const response = await app.request(path, { headers: { cookie, accept: "text/html" } }, env);
    return { status: response.status, html: await response.text() };
  }
  const { response, data } = await kit.request({ surface: surface.surface, env, path });
  if (state === "error" && surface.surface !== "board") {
    const patch = {
      errors: { game: "Game must be at most 100 characters" },
      hasErrors: true,
      isDraft: true,
    };
    const rejected =
      surface.surface === "create"
        ? { ...data, ...patch, values: { ...data.values, game: "  My unlisted 雪 draft  " } }
        : {
            ...data,
            view: {
              ...data.view,
              ...patch,
              values: { ...data.view.values, game: "  My unlisted 雪 draft  " },
            },
          };
    return {
      status: 422,
      html: kit
        .html(surface.surface, rejected)
        .replace("</head>", `<style>${kit.css}</style></head>`),
    };
  }
  return {
    status: response.status,
    html: (await response.text()).replace("</head>", `<style>${kit.css}</style></head>`),
  };
}

async function mount(context, twin, surface, state = "normal") {
  const navigations = [];
  const initial =
    state === "error" && twin === "Hono" && surface.surface !== "board"
      ? await rendered(twin, surface, surface.path, state, {
          title: "Draft",
          game: "  My unlisted 雪 draft  ",
          starts_at: "bad",
          ends_at: "bad",
          timezone: "UTC",
        })
      : await rendered(twin, surface, surface.path, state);
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== ORIGIN) return route.abort("blockedbyclient");
    const asset = resolve(root, "public", url.pathname.slice(1));
    if (
      (url.pathname.startsWith("/islands/") ||
        url.pathname.startsWith("/fonts/") ||
        url.pathname.startsWith("/icons/") ||
        url.pathname === "/logo.svg" ||
        url.pathname.endsWith(".css")) &&
      asset.startsWith(join(root, "public/")) &&
      existsSync(asset)
    )
      return route.fulfill({
        contentType: url.pathname.endsWith(".css")
          ? "text/css"
          : url.pathname.endsWith(".woff2")
            ? "font/woff2"
            : url.pathname.endsWith(".svg")
              ? "image/svg+xml"
              : url.pathname.endsWith(".png")
                ? "image/png"
                : "text/javascript",
        body: readFileSync(asset),
      });
    if (
      req.isNavigationRequest() &&
      req.method() === surface.method &&
      (req.method() === "POST" || url.search)
    ) {
      navigations.push({
        method: req.method(),
        path: url.pathname,
        values: Object.fromEntries(
          req.method() === "POST" ? new URLSearchParams(req.postData() ?? "") : url.searchParams,
        ),
      });
      // Leave an explicit native response, without following a live endpoint.
      return route.fulfill({ contentType: "text/html", body: initial.html });
    }
    if (url.pathname === surface.path)
      return route.fulfill({
        status: initial.status,
        contentType: "text/html",
        body: initial.html,
      });
    return route.fulfill({ status: 404, body: "No external fixture" });
  });
  return navigations;
}

async function shot(page, name) {
  const folder = process.env.U5_SCREENSHOTS;
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.screenshot({ path: join(folder, `${name}.png`) });
}

for (const twin of ["Hono", "Kit"])
  for (const surface of surfaces) {
    for (const javaScriptEnabled of [false, true]) {
      test(`U5-B01 ${twin} ${surface.surface} native keyboard/free text, JS=${javaScriptEnabled}`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          javaScriptEnabled,
          viewport: { width: 1280, height: 800 },
        });
        try {
          const navigations = await mount(context, twin, surface);
          const page = await context.newPage();
          await page.goto(ORIGIN + surface.path);
          const input = page.locator(`input[name="${surface.name}"]`);
          await expect(input).toBeVisible();
          await input.focus();
          await page.keyboard.press("ControlOrMeta+A");
          await page.keyboard.type("Chess");
          await page.keyboard.press("ArrowDown");
          await page.keyboard.press("Escape");
          expect(
            navigations,
            "U5_EXPLICIT_SUBMIT: input/selection must not submit or save",
          ).toEqual([]);
          await expect(input).toHaveValue("Chess");
          if (!javaScriptEnabled) {
            await shot(page, `${twin}-${surface.surface}-normal-desktop`);
            await page.setViewportSize({ width: 390, height: 844 });
            await shot(page, `${twin}-${surface.surface}-normal-mobile`);
          }
          const nativeList = await input.evaluate((el) => ({
            tag: el.list?.tagName,
            values: Array.from(el.list?.options ?? []).map((o) => o.value),
          }));
          for (const value of ["All", "  My unlisted 雪 draft  "]) {
            await input.fill(value);
            await page.keyboard.press("Tab");
            expect(navigations).toEqual([]);
            await expect(input).toHaveValue(value);
          }
          if (surface.surface !== "board") {
            await page.locator('input[name="title"]').fill("My game night");
            await page.locator('input[name="starts_at"]').fill("2099-06-01 18:00");
            await page.locator('input[name="ends_at"]').fill("2099-06-01 20:00");
          }
          const button =
            surface.surface === "board"
              ? page.getByRole("button", { name: "Show board" })
              : page.locator('[data-event-editor] button[type="submit"]');
          await button.focus();
          await page.keyboard.press("Enter");
          await expect.poll(() => navigations.length).toBe(1);
          expect(navigations[0]).toMatchObject({
            method: surface.method,
            path: surface.action,
            values: { [surface.name]: "  My unlisted 雪 draft  " },
          });
          expect(
            nativeList.tag,
            "U5_NATIVE_LIST_MISSING: wire the input's datalist without JavaScript",
          ).toBe("DATALIST");
          expect(nativeList.values.sort()).toEqual([...PUBLISHED].sort());
        } finally {
          await context.close();
        }
      });
    }

    for (const state of ["fallback", "error"]) {
      test(`U5-B02 ${twin} ${surface.surface} ${state} preserves editable drafts at both widths`, async ({
        browser,
      }) => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        try {
          const navigations = await mount(context, twin, surface, state);
          const page = await context.newPage();
          await page.goto(ORIGIN + surface.path);
          if (surface.surface === "board" && state === "error") {
            await expect(
              page.getByRole("heading", { name: "Check the board filters" }),
            ).toBeVisible();
            await expect(page.getByTestId("error-board")).toHaveAttribute(
              "href",
              "/leaderboards/members",
            );
            await shot(page, `${twin}-board-error-desktop`);
            await page.setViewportSize({ width: 390, height: 844 });
            await shot(page, `${twin}-board-error-mobile`);
            expect(navigations).toEqual([]);
            return;
          }
          const input = page.locator(`input[name="${surface.name}"]`);
          await expect(input).toBeVisible();
          await input.fill("  My unlisted 雪 draft  ");
          if (state === "error" && surface.surface !== "board") {
            // Exercise the shipped stale-session and pending-save islands without
            // sending a request. Neither is allowed to rewrite the visible draft.
            await page.evaluate(() => {
              window.dispatchEvent(
                new CustomEvent("two:session-expired", {
                  cancelable: true,
                  detail: { recoveryUrl: "/auth/recover?next=%2Fadmin%2Fevents%2Fnew" },
                }),
              );
              const form = document.querySelector("[data-event-editor]");
              form.addEventListener("submit", (event) => event.preventDefault());
              form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
            });
            await expect(input).toHaveValue("  My unlisted 雪 draft  ");
            await expect(page.getByTestId("admin-session-expired")).toBeVisible();
            await expect(page.locator("[data-event-editor]")).toHaveAttribute("aria-busy", "true");
          }
          expect(navigations).toEqual([]);
          await shot(page, `${twin}-${surface.surface}-${state}-desktop`);
          await page.setViewportSize({ width: 390, height: 844 });
          await shot(page, `${twin}-${surface.surface}-${state}-mobile`);
          await expect(input).toBeVisible();
          await expect(input).toHaveValue("  My unlisted 雪 draft  ");
          if (state === "fallback")
            expect(await input.evaluate((el) => el.list?.options.length ?? 0)).toBe(0);
        } finally {
          await context.close();
        }
      });
    }
  }
