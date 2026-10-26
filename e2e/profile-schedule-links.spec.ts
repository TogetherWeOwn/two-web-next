// Both real SSR twins and the shipped island, offline. The destination page is
// only a native-navigation witness: schedule filtering has its own acceptance.
import { existsSync, readFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  profileScheduleFixture,
  SCHEDULE_PROFILE_ORIGIN as ORIGIN,
  SCHEDULE_PROFILE_OWNER as OWNER,
  type ScheduleProfileRenderer,
} from "../test/helpers/profile-schedule-links";

async function open(
  browser: Browser,
  renderer: ScheduleProfileRenderer,
  width: number,
  options: { own?: boolean; javaScriptEnabled?: boolean; catalogUnavailable?: boolean } = {},
) {
  const fixture = await profileScheduleFixture(options);
  const context = await browser.newContext({
    javaScriptEnabled: options.javaScriptEnabled ?? true,
    viewport: { width, height: width === 390 ? 844 : 800 },
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const writes: { method: string; status: number }[] = [];
  const unexpectedFetches: string[] = [];
  const transport = {
    mode: "normal" as "normal" | "pending" | "failure" | "refuse",
    pending: false,
    release: () => {},
  };
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) {
      if (["fetch", "xhr"].includes(request.resourceType())) unexpectedFetches.push(url.pathname);
      await route.abort();
      return;
    }
    if (
      (/^\/islands\/[\w-]+\.js$/.test(url.pathname) ||
        ["/styles.css", "/theme.css", "/profile-theme.css"].includes(url.pathname)) &&
      existsSync(`public${url.pathname}`)
    ) {
      await route.fulfill({
        contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript",
        body: readFileSync(`public${url.pathname}`, "utf8"),
      });
      return;
    }
    if (url.pathname === "/events") {
      await route.fulfill({
        contentType: "text/html",
        body: "<main><h1>Schedule destination witness</h1></main>",
      });
      return;
    }
    if (request.method() === "PATCH" && url.pathname === `/members/${OWNER}`) {
      if (transport.mode === "failure") {
        writes.push({ method: "PATCH", status: 0 });
        await route.abort("failed");
        return;
      }
      if (transport.mode === "pending") {
        transport.pending = true;
        await new Promise<void>((resolve) => {
          transport.release = resolve;
        });
      }
    } else if (["fetch", "xhr"].includes(request.resourceType()))
      unexpectedFetches.push(url.pathname);
    let forwardedBody = request.postData() ?? undefined;
    if (request.method() === "PATCH" && transport.mode === "refuse") {
      // Trigger the real server 422 after client validation has passed. A
      // browser-invalid timezone would only exercise client-side refusal.
      forwardedBody = JSON.stringify({ ...JSON.parse(forwardedBody!), timezone: "Mars/Olympus" });
    }
    const response = await fixture.request(renderer, url.pathname + url.search, {
      method: request.method(),
      headers: request.headers(),
      body: forwardedBody,
    });
    if (!["GET", "HEAD"].includes(request.method()))
      writes.push({ method: request.method(), status: response.status });
    let body = await response.text();
    if (response.headers.get("content-type")?.includes("text/html")) {
      // Exercise real write admission without a five-second test sleep.
      body = body.replace(/(name="formOpenedAt" value=")[^"]+/, `$1${Date.now() - 5000}`);
    }
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body,
    });
  });
  await page.goto(ORIGIN + fixture.path);
  return { ...fixture, context, page, writes, unexpectedFetches, transport };
}

const games = (page: Page) => page.getByTestId("profile-games");
async function editGames(page: Page, value: string) {
  await page.locator('[name="games_text"]').fill(value);
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Save", exact: true }).click();
}
async function gameLinks(page: Page) {
  return games(page)
    .locator("li")
    .evaluateAll((items) =>
      items.map((item) => ({
        label: Array.from(item.childNodes)
          .filter(
            (node) =>
              !(node instanceof Element && node.matches('[data-testid="profile-shared-marker"]')),
          )
          .map((node) => node.textContent)
          .join("")
          .trim(),
        links: Array.from(item.querySelectorAll("a")).map((link) => ({
          label: link.textContent,
          href: link.getAttribute("href"),
        })),
      })),
    );
}

for (const renderer of ["Hono", "Kit"] as const) {
  for (const width of [1280, 390]) {
    test(`${renderer} ${width}px: known/shared/unknown/hostile interests are native no-JS links or text`, async ({
      browser,
    }) => {
      const f = await open(browser, renderer, width, { javaScriptEnabled: false });
      try {
        const items = await gameLinks(f.page);
        expect(items[0]!.links).toEqual([
          { label: "Deep Rock Galactic", href: "/events?game=Deep+Rock+Galactic" },
        ]);
        expect(items[1]!.links).toEqual([
          { label: "  dEeP rOcK gAlAcTiC  ", href: "/events?game=Deep+Rock+Galactic" },
        ]);
        expect(items[6]!.links).toEqual([]);
        expect(await games(f.page).getByTestId("profile-shared-marker").count()).toBe(3);
        expect(await games(f.page).locator("img,script,iframe").count()).toBe(0);
        const link = games(f.page)
          .getByRole("link", { name: "Deep Rock Galactic", exact: true })
          .first();
        for (let i = 0; i < 80; i++) {
          await f.page.keyboard.press("Tab");
          if (await link.evaluate((element) => element === document.activeElement)) break;
        }
        expect(await link.evaluate((element) => element === document.activeElement)).toBe(true);
        await f.page.keyboard.press("Enter");
        await f.page.waitForURL(ORIGIN + "/events?game=Deep+Rock+Galactic");
        expect(f.writes).toEqual([]);
        expect(f.unexpectedFetches).toEqual([]);
      } finally {
        await f.context.close();
      }
    });

    test(`${renderer} ${width}px: catalog unavailable still renders every interest without misleading links`, async ({
      browser,
    }) => {
      const f = await open(browser, renderer, width, {
        javaScriptEnabled: false,
        catalogUnavailable: true,
      });
      try {
        expect(await games(f.page).locator("li").count()).toBe(8);
        expect(await games(f.page).locator("a").count()).toBe(0);
        expect(await games(f.page).getByTestId("profile-shared-marker").count()).toBe(3);
        expect(f.writes).toEqual([]);
        expect(f.unexpectedFetches).toEqual([]);
      } finally {
        await f.context.close();
      }
    });

    test(`${renderer} ${width}px: accepted save reconstructs safe links from the original snapshot only`, async ({
      browser,
    }) => {
      const f = await open(browser, renderer, width, { own: true });
      try {
        // A catalog change after render must not be fetched by the island/write.
        f.catalog.push("New after render");
        await f.page.evaluate(() => {
          const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!;
          const state = window as unknown as { unsafeGameHtmlWrites: number };
          state.unsafeGameHtmlWrites = 0;
          Object.defineProperty(Element.prototype, "innerHTML", {
            ...descriptor,
            set(value) {
              if (
                ["LI", "UL", "A"].includes(this.tagName) ||
                this.matches('[data-testid="profile-games"]')
              )
                state.unsafeGameHtmlWrites++;
              descriptor.set!.call(this, value);
            },
          });
        });
        await editGames(
          f.page,
          'bALDUR\'S gATE 3\nNew after render\n<img src=x onerror="window.gameLabelExecuted=true">',
        );
        await save(f.page);
        await f.page.getByTestId("profile-saved").waitFor({ state: "visible" });
        expect(f.page.url()).toBe(ORIGIN + f.path);
        expect(f.writes).toEqual([{ method: "PATCH", status: 200 }]);
        expect(await gameLinks(f.page)).toEqual([
          {
            label: "bALDUR'S gATE 3",
            links: [{ label: "bALDUR'S gATE 3", href: "/events?game=Baldur%27s+Gate+3" }],
          },
          { label: "New after render", links: [] },
          {
            label: '<img src=x onerror="window.gameLabelExecuted=true">',
            links: [
              {
                label: '<img src=x onerror="window.gameLabelExecuted=true">',
                href: "/events?game=%3Cimg+src%3Dx+onerror%3D%22window.gameLabelExecuted%3Dtrue%22%3E",
              },
            ],
          },
        ]);
        expect(await games(f.page).locator("img,script,iframe").count()).toBe(0);
        expect(
          await f.page.evaluate(() => ({
            unsafe: (window as unknown as { unsafeGameHtmlWrites: number }).unsafeGameHtmlWrites,
            executed: "gameLabelExecuted" in window,
          })),
        ).toEqual({ unsafe: 0, executed: false });
        expect(f.queries).toHaveLength(1);
        expect(f.unexpectedFetches).toEqual([]);
        await f.page.getByTestId("profile-edit-again").click();
        await editGames(f.page, "Discard this draft");
        await f.page.getByRole("button", { name: "Cancel", exact: true }).click();
        expect(await f.page.locator('[name="games_text"]').inputValue()).toContain(
          "bALDUR'S gATE 3",
        );
      } finally {
        await f.context.close();
      }
    });

    test(`${renderer} ${width}px CONTROL: saving without a catalog snapshot keeps even known interests plain`, async ({
      browser,
    }) => {
      const f = await open(browser, renderer, width, { own: true, catalogUnavailable: true });
      try {
        await editGames(f.page, "Baldur's Gate 3\nUnlisted game");
        await save(f.page);
        await f.page.getByTestId("profile-saved").waitFor({ state: "visible" });
        expect(await gameLinks(f.page)).toEqual([
          { label: "Baldur's Gate 3", links: [] },
          { label: "Unlisted game", links: [] },
        ]);
        expect(f.writes).toEqual([{ method: "PATCH", status: 200 }]);
        expect(f.queries.length).toBeLessThanOrEqual(1);
        expect(f.unexpectedFetches).toEqual([]);
      } finally {
        await f.context.close();
      }
    });

    test(`${renderer} ${width}px CONTROL: pending save and a newer draft never replace the committed Games list early`, async ({
      browser,
    }) => {
      const f = await open(browser, renderer, width, { own: true });
      try {
        const committed = await gameLinks(f.page);
        f.transport.mode = "pending";
        await editGames(f.page, "Baldur's Gate 3");
        await save(f.page);
        await expect.poll(() => f.transport.pending).toBe(true);
        expect(await gameLinks(f.page)).toEqual(committed);
        await editGames(f.page, "Keep this newer draft");
        expect(await gameLinks(f.page)).toEqual(committed);
        f.transport.release();
        await expect.poll(() => f.writes.length).toBe(1);
        await expect.poll(async () => (await gameLinks(f.page))[0]!.label).toBe("Baldur's Gate 3");
        expect(await f.page.locator('[name="games_text"]').inputValue()).toBe(
          "Keep this newer draft",
        );
        expect(f.unexpectedFetches).toEqual([]);
      } finally {
        f.transport.release();
        await f.context.close();
      }
    });

    test(`${renderer} ${width}px CONTROL: 422 keeps the rejected draft separate from committed Games`, async ({
      browser,
    }) => {
      const f = await open(browser, renderer, width, { own: true });
      try {
        const committed = await gameLinks(f.page);
        await editGames(f.page, "Baldur's Gate 3");
        f.transport.mode = "refuse";
        await save(f.page);
        await f.page.getByTestId("profile-error").waitFor({ state: "visible" });
        expect(f.writes).toEqual([{ method: "PATCH", status: 422 }]);
        expect(await gameLinks(f.page)).toEqual(committed);
        expect(await f.page.locator('[name="games_text"]').inputValue()).toBe("Baldur's Gate 3");
        expect(f.operations.filter(({ method }) => method === "save")).toEqual([]);
        expect(f.unexpectedFetches).toEqual([]);
      } finally {
        await f.context.close();
      }
    });

    test(`${renderer} ${width}px CONTROL: failed transport never commits or clears the unsent draft`, async ({
      browser,
    }) => {
      const f = await open(browser, renderer, width, { own: true });
      try {
        const committed = await gameLinks(f.page);
        f.transport.mode = "failure";
        await editGames(f.page, "Baldur's Gate 3");
        await save(f.page);
        await f.page.getByTestId("profile-save-failed").waitFor({ state: "visible" });
        expect(await gameLinks(f.page)).toEqual(committed);
        expect(await f.page.locator('[name="games_text"]').inputValue()).toBe("Baldur's Gate 3");
        expect(f.operations.filter(({ method }) => method === "save")).toEqual([]);
        expect(f.writes).toEqual([{ method: "PATCH", status: 0 }]);
      } finally {
        await f.context.close();
      }
    });

    test(`${renderer} ${width}px: clicking a known game warns on dirty departure, never normalizes or saves the draft`, async ({
      browser,
    }) => {
      const f = await open(browser, renderer, width, { own: true });
      try {
        const draft = "  Keep My Unsent Draft  ";
        await editGames(f.page, draft);
        const link = games(f.page)
          .getByRole("link", { name: "Deep Rock Galactic", exact: true })
          .first();
        expect(await link.count()).toBe(1);
        const departure = f.page.waitForEvent("dialog");
        const click = link.click();
        const dialog = await departure;
        expect(dialog.type()).toBe("beforeunload");
        await dialog.dismiss();
        await click;
        expect(f.page.url()).toBe(ORIGIN + f.path);
        expect(await f.page.locator('[name="games_text"]').inputValue()).toBe(draft);
        expect(f.writes).toEqual([]);
        await f.page.getByRole("button", { name: "Cancel", exact: true }).click();
        await link.click();
        await f.page.waitForURL(ORIGIN + "/events?game=Deep+Rock+Galactic");
        expect(f.writes).toEqual([]);
        expect(f.unexpectedFetches).toEqual([]);
      } finally {
        await f.context.close();
      }
    });
  }
}
