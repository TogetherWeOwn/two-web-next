// Offline acceptance, automatically discovered by the existing browser journey
// config. A test-owned loopback server carries real native POST/303/GET hops;
// all responses are fixtures, with no database or live application writes.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  DIRTY_TARGET,
  REVIEW_ROOT,
  SAVED_TARGET,
  SURFACES,
  actionFor,
  compileKitReview,
  kitReviewData,
  pathFor,
  renderHonoReview,
  resultFor,
  type Presentation,
  type Surface,
} from "../test/helpers/admin-terminal-review";

let kit: Awaited<ReturnType<typeof compileKitReview>>;
test.beforeAll(async () => {
  kit = await compileKitReview();
});
test.afterAll(() => kit?.close());

type FixtureOptions = {
  javaScriptEnabled?: boolean;
  width?: number;
  height?: number;
  responseStatus?: number;
  rejectedSave?: boolean;
};

async function openFixture(
  browser: Browser,
  presentation: Presentation,
  surface: Surface,
  options: FixtureOptions = {},
) {
  // POST validation failures render Hono HTML even after a Kit editor GET.
  // In particular, the Kit featured loader/page has no error/draft contract.
  // Start rejected-Save cases with the real response owner's retained markup.
  const html =
    presentation === "hono" || options.rejectedSave
      ? renderHonoReview(surface, "published", options.rejectedSave)
      : kit.render(surface, await kitReviewData(surface));
  const mutations: { path: string; body: string }[] = [];
  const documents: string[] = [];
  const dialogs: string[] = [];
  let origin: string;
  const server = createServer(
    { requestTimeout: 5_000, headersTimeout: 5_000, keepAliveTimeout: 1_000 },
    async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", origin);
        if (req.method !== "GET" && req.method !== "HEAD") {
          let body = "";
          for await (const chunk of req) {
            body += chunk.toString();
            if (Buffer.byteLength(body) > 4_096) {
              res.writeHead(413).end("Fixture payload too large");
              return;
            }
          }
          mutations.push({ path: url.pathname, body });
          if (req.method !== "POST" || url.pathname !== actionFor(surface)) {
            res.writeHead(400).end("Unexpected mutation");
          } else if (options.responseStatus) {
            res.writeHead(options.responseStatus, { "Content-Type": "text/html" });
            res.end(`<h1>Fixture terminal refusal ${options.responseStatus}</h1>`);
          } else {
            res.writeHead(303, { Location: `${resultFor(surface)}?fixture=complete` }).end();
          }
          return;
        }
        if (req.headers["sec-fetch-dest"] === "document") {
          documents.push(url.pathname + url.search);
          if (url.pathname === resultFor(surface) && url.search === "?fixture=complete") {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<h1>Fixture terminal result</h1>");
          } else if (url.pathname === pathFor(surface) && !url.search) {
            res.writeHead(200, { "Content-Type": "text/html" }).end(html);
          } else {
            res.writeHead(404).end("Unexpected document");
          }
          return;
        }
        if (url.pathname.startsWith("/islands/") && /^\/[a-z0-9/.-]+\.js$/.test(url.pathname)) {
          res.writeHead(200, { "Content-Type": "application/javascript" });
          res.end(readFileSync(join(REVIEW_ROOT, "public", url.pathname), "utf8"));
        } else if (url.pathname.endsWith(".css") && /^\/[a-z0-9/.-]+\.css$/.test(url.pathname)) {
          res.writeHead(200, { "Content-Type": "text/css" });
          res.end(readFileSync(join(REVIEW_ROOT, "public", url.pathname), "utf8"));
        } else if (url.pathname === "/auth/status") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ authenticated: true }));
        } else {
          res.writeHead(404).end("Unexpected fixture request");
        }
      } catch (error) {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    },
  );
  const context = await browser.newContext({
    javaScriptEnabled: options.javaScriptEnabled ?? false,
    serviceWorkers: "block",
    viewport: { width: options.width ?? 1280, height: options.height ?? 800 },
  });
  const close = async () => {
    try {
      await context.close();
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      }
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    origin = `http://127.0.0.1:${address.port}`;
    // Only this loopback fixture may reach the network. Unlike route.fulfill,
    // the real server also receives Chromium's un-intercepted redirect hops.
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    let acceptDeparture = false;
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.type());
      if (acceptDeparture) await dialog.accept();
      else await dialog.dismiss();
    });
    await page.goto(origin + pathFor(surface));
    await expect(page.locator("h1")).toBeVisible();
    return {
      page,
      close,
      mutations,
      documents,
      dialogs,
      allowDeparture: () => {
        acceptDeparture = true;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function nativeReview(page: Page, surface: Surface) {
  const form = page.locator(`form[action="${actionFor(surface)}"]`);
  await expect(form).toHaveCount(1);
  const review = page.locator("details").filter({ has: form });
  // Immediate assertion failures, not selector timeouts, prove the baseline
  // lacks a native review while the positive controls prove rendering works.
  expect(await review.count(), "terminal form must be inside its native review").toBe(1);
  const summary = review.locator(":scope > summary");
  await expect(summary).toHaveCount(1);
  await expect(summary).toHaveAccessibleName(/review|cancel|delet/i);
  const final = form.getByRole("button", {
    includeHidden: true,
    name:
      surface === "featured-edit"
        ? /delete.*slot|confirm.*delet/i
        : /cancel.*event|confirm.*cancel/i,
  });
  await expect(final).toHaveCount(1);
  return { review, summary, final };
}

for (const presentation of ["hono", "kit"] as const) {
  for (const surface of SURFACES) {
    test(`${presentation} ${surface}: positive control renders safe real markup and existing POST`, async ({
      browser,
    }) => {
      const f = await openFixture(browser, presentation, surface);
      try {
        await expect(f.page.locator(`form[action="${actionFor(surface)}"]`)).toHaveCount(1);
        await expect(f.page.locator("form form")).toHaveCount(0);
        await expect(f.page.locator("img[onerror]")).toHaveCount(0);
        await expect(f.page.locator("body")).toContainText(SAVED_TARGET);
        if (surface !== "event-list") {
          await expect(f.page.locator('input[name="title"]')).toHaveValue(SAVED_TARGET);
        }
        expect(f.mutations).toEqual([]);
      } finally {
        await f.close();
      }
    });

    for (const viewport of [
      { label: "desktop", width: 1280, height: 800 },
      { label: "mobile", width: 390, height: 844 },
    ]) {
      test(`${presentation} ${surface}: no-JS ${viewport.label} keyboard review/abandon makes zero POSTs; final posts once`, async ({
        browser,
      }) => {
        const f = await openFixture(browser, presentation, surface, viewport);
        try {
          const { review, summary, final } = await nativeReview(f.page, surface);
          await expect(final).toBeHidden();
          await summary.focus();
          await expect(summary).toBeFocused();
          await summary.press("Enter");
          await expect(final).toBeVisible();
          await expect(review).toContainText(SAVED_TARGET);
          await expect(review.locator("img[onerror]")).toHaveCount(0);
          expect(f.mutations).toEqual([]);
          expect(f.documents).toEqual([pathFor(surface)]);
          await summary.press("Space");
          await expect(final).toBeHidden();
          await expect(summary).toBeFocused();
          expect(f.mutations).toEqual([]);
          expect(f.documents).toEqual([pathFor(surface)]);
          expect(f.dialogs).toEqual([]);
          await summary.press("Enter");
          await final.focus();
          await expect(final).toBeFocused();
          const submitted = f.page.waitForResponse(
            (response) =>
              response.request().method() === "POST" &&
              new URL(response.url()).pathname === actionFor(surface),
          );
          await final.press("Enter");
          expect((await submitted).status()).toBe(303);
          await expect(f.page.locator("h1")).toHaveText("Fixture terminal result");
          expect(f.documents).toEqual([pathFor(surface), `${resultFor(surface)}?fixture=complete`]);
          expect(f.mutations).toEqual([{ path: actionFor(surface), body: "" }]);
          expect(new URL(f.page.url()).pathname).toBe(resultFor(surface));
        } finally {
          await f.close();
        }
      });
    }

    for (const status of [403, 422, 503]) {
      test(`${presentation} ${surface}: no-JS final preserves a ${status} refusal without retry or success`, async ({
        browser,
      }) => {
        const f = await openFixture(browser, presentation, surface, { responseStatus: status });
        try {
          const { summary, final } = await nativeReview(f.page, surface);
          await summary.press("Enter");
          await final.press("Enter");
          await expect(f.page.locator("h1")).toHaveText(`Fixture terminal refusal ${status}`);
          expect(f.mutations).toEqual([{ path: actionFor(surface), body: "" }]);
          expect(new URL(f.page.url()).pathname).toBe(actionFor(surface));
        } finally {
          await f.close();
        }
      });
    }

    if (surface !== "event-list") {
      for (const rejectedSave of [false, true]) {
        test(`${presentation} ${surface}: ${rejectedSave ? "rejected Save" : "dirty draft"} survives abandon; final keeps departure protection`, async ({
          browser,
        }) => {
          const f = await openFixture(browser, presentation, surface, {
            javaScriptEnabled: true,
            rejectedSave,
          });
          try {
            const title = f.page.locator('input[name="title"]');
            if (rejectedSave) {
              await expect(f.page.getByTestId("form-errors")).toBeVisible();
              await expect(f.page.locator("form[data-event-editor]")).toHaveAttribute(
                "data-event-draft",
                "",
              );
            } else {
              await title.fill(DIRTY_TARGET);
            }
            const { review, summary, final } = await nativeReview(f.page, surface);
            await summary.press("Enter");
            await expect(review).toContainText(SAVED_TARGET);
            await expect(review).not.toContainText(DIRTY_TARGET);
            await summary.press("Space");
            await expect(final).toBeHidden();
            await expect(title).toHaveValue(DIRTY_TARGET);
            expect(f.mutations).toEqual([]);
            expect(f.documents).toEqual([pathFor(surface)]);
            expect(f.dialogs).toEqual([]);
            // A real deliberate final submit retains the existing dirty-draft
            // warning; opening or abandoning must not globally disarm it.
            f.allowDeparture();
            await summary.press("Enter");
            const submitted = f.page.waitForResponse(
              (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname === actionFor(surface),
            );
            await final.press("Enter");
            expect((await submitted).status()).toBe(303);
            await expect(f.page.locator("h1")).toHaveText("Fixture terminal result");
            expect(f.documents).toEqual([
              pathFor(surface),
              `${resultFor(surface)}?fixture=complete`,
            ]);
            expect(f.dialogs).toEqual(["beforeunload"]);
            expect(f.mutations).toEqual([{ path: actionFor(surface), body: "" }]);
          } finally {
            await f.close();
          }
        });
      }
    }
  }
}
