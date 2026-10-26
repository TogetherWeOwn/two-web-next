/// <reference lib="dom" />
// Independent acceptance. Only clipboard/fetch boundaries are controlled; both
// renderers and the shipped calendar/copy controllers execute without substitutes.
import { test, expect, type Page } from "@playwright/test";
import {
  committedView,
  fixtureOrigin,
  fixturePage,
  fixtureState,
  sharedSearch,
  sharingHtml,
  viewLabel,
  type CopyProbe,
  type Target,
} from "../test/schedule-sharing.fixtures";

type HeldRead = { path: string; resolve: (response: Response) => void };
declare global {
  interface Window {
    copyProbe: CopyProbe;
    sharingReads: HeldRead[];
    retiredStatuses: HTMLElement[];
  }
}
const view = (page: Page) =>
  page.locator("[data-copy-link]").filter({ hasText: new RegExp(`^${viewLabel}$`) });
const feed = (page: Page) => page.locator("[data-copy-feed]");
const statuses = (page: Page) => page.locator("[data-copy-toast]");
const feedStatus = (page: Page) => page.getByTestId("subscription-copy-status");
const scheduleStatuses = (page: Page) =>
  page.locator('[data-copy-toast]:not([data-testid="subscription-copy-status"])');
const expectedView = fixtureOrigin + committedView;
const expectedFeed = fixtureOrigin + "/events.ics?game=Catan";

async function reveal(page: Page) {
  // Native details may contain the fallback/action. Do not unhide copy buttons
  // or inject a missing schedule control: enhancement itself must reveal them.
  for (const summary of await page.locator("details:not([open]) > summary").all())
    await summary.click();
}
async function requireView(page: Page) {
  await expect(view(page), "the schedule has its own copy action").toHaveCount(1, {
    timeout: 1000,
  });
  await reveal(page);
  await expect(view(page)).toBeVisible();
}
async function copies(page: Page) {
  return page.evaluate(() => window.copyProbe.calls);
}
async function clickView(page: Page) {
  await view(page).evaluate((node: HTMLElement) => node.click());
}
async function holdReads(page: Page) {
  await page.evaluate(() => {
    window.sharingReads = [];
    const native = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (new Headers(init?.headers).get("x-two-island") !== "events-calendar")
        return native(input, init);
      // Intentionally disregard AbortSignal: an obsolete response must be
      // rejected by the real controller even when the transport finishes late.
      return new Promise<Response>((resolve) =>
        window.sharingReads.push({ path: String(input), resolve }),
      );
    };
  });
}
async function readPath(page: Page, index: number) {
  await expect.poll(() => page.evaluate(() => window.sharingReads.length)).toBe(index + 1);
  return page.evaluate((i) => window.sharingReads[i]!.path, index);
}
async function answer(
  page: Page,
  target: Target,
  index: number,
  mode: "ok" | "failed" | "invalid" = "ok",
) {
  const path = await page.evaluate((i) => window.sharingReads[i]!.path, index);
  const body =
    mode === "ok"
      ? await sharingHtml(target, fixtureState(new URL(path, fixtureOrigin)), fixtureOrigin, path)
      : mode === "invalid"
        ? '<link rel="canonical" href="https://untrusted.example.test/events"><section data-island="events-calendar"></section>'
        : "Unavailable";
  await page.evaluate(
    ({ index, body, mode }) =>
      window.sharingReads[index]!.resolve(
        new Response(body, { status: mode === "failed" ? 503 : 200 }),
      ),
    { index, body, mode },
  );
  await page.evaluate(() => new Promise<void>((done) => setTimeout(done, 0)));
}
async function changeGame(page: Page, value: string) {
  await page.locator('select[name="game"]').selectOption(value);
  await page.locator('form[role="search"] button[type="submit"]').click();
}

for (const target of ["hono", "kit"] as const) {
  test.describe(`${target}: committed schedule sharing`, () => {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      test(`native selectable view at ${viewport.width}px without JavaScript`, async ({
        browser,
      }, info) => {
        const { context, page } = await fixturePage(browser, target, {
          javaScriptEnabled: false,
          viewport,
          path: sharedSearch,
        });
        try {
          await reveal(page);
          await page.screenshot({ path: info.outputPath("native.png"), fullPage: true });
          const wanted = fixtureOrigin + sharedSearch;
          const field = page
            .locator("input[readonly], textarea[readonly]")
            .filter({ visible: true });
          const values = await field.evaluateAll((nodes) =>
            nodes.map((node) => (node as HTMLInputElement).value),
          );
          expect(values, "view and feed remain different native values").toContain(wanted);
          expect(values).toContain(fixtureOrigin + "/events.ics?game=Catan+%26+Co");
          const manual = page
            .locator("input[readonly], textarea[readonly]")
            .filter({ visible: true });
          const selected = await manual.evaluateAll((nodes, value) => {
            const node = (nodes as HTMLInputElement[]).find((n) => n.value === value)!;
            node.focus();
            node.select();
            return [node.selectionStart, node.selectionEnd, node.value.length, node.disabled];
          }, wanted);
          expect(selected).toEqual([0, wanted.length, wanted.length, false]);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth + 1,
            ),
          ).toBe(true);
        } finally {
          await context.close();
        }
      });
    }

    test("copies view and feed independently with native button Enter and Space", async ({
      browser,
    }, info) => {
      const { context, page } = await fixturePage(browser, target);
      try {
        await requireView(page);
        await clickView(page);
        await expect.poll(() => copies(page)).toEqual([expectedView]);
        await expect(scheduleStatuses(page)).toContainText(/(?:schedule|view).*copied/i);
        await expect(feedStatus(page)).toBeEmpty();
        const viewFeedback = await scheduleStatuses(page).allTextContents();
        await feed(page).focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => copies(page)).toEqual([expectedView, expectedFeed]);
        await page.keyboard.press("Space");
        await expect.poll(() => copies(page)).toEqual([expectedView, expectedFeed, expectedFeed]);
        await expect(feedStatus(page)).toHaveText("Calendar feed URL copied.");
        expect(await scheduleStatuses(page).allTextContents()).toEqual(viewFeedback);
        await page.screenshot({ path: info.outputPath("success.png"), fullPage: true });
      } finally {
        await context.close();
      }
    });

    for (const mode of ["reject", "throw", "absent"] as const) {
      test(`honest selectable manual view fallback when clipboard is ${mode}`, async ({
        browser,
      }, info) => {
        const { context, page } = await fixturePage(browser, target);
        try {
          await requireView(page);
          await page.evaluate((mode) => {
            window.copyProbe.mode = mode;
            if (mode === "absent")
              Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: undefined,
              });
          }, mode);
          await clickView(page);
          await expect(scheduleStatuses(page)).toContainText(/select|manual/i);
          expect((await scheduleStatuses(page).allTextContents()).join(" ")).not.toMatch(
            /\bcopied\b|address bar|calendar app/i,
          );
          await expect(feedStatus(page)).toBeEmpty();
          expect(
            await page
              .locator("input[readonly], textarea[readonly]")
              .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value)),
          ).toContain(expectedView);
          await page.screenshot({ path: info.outputPath(`manual-${mode}.png`), fullPage: true });
        } finally {
          await context.close();
        }
      });
    }

    test("pending then deadline never claims success, and late promises cannot replace newer feedback", async ({
      browser,
    }, info) => {
      const { context, page } = await fixturePage(browser, target);
      try {
        await requireView(page);
        await page.clock.install();
        await page.evaluate(() => {
          window.copyProbe.mode = "pending";
        });
        await clickView(page);
        expect(await copies(page)).toEqual([expectedView]);
        expect((await scheduleStatuses(page).allTextContents()).join(" ")).not.toMatch(/copied/i);
        await page.screenshot({ path: info.outputPath("pending.png"), fullPage: true });
        let elapsed = 0;
        while (
          elapsed < 10000 &&
          !(await scheduleStatuses(page).allTextContents()).some((s) => /select|manual/i.test(s))
        ) {
          await page.clock.runFor(1000);
          elapsed += 1000;
        }
        expect(elapsed).toBeLessThanOrEqual(10000);
        expect((await scheduleStatuses(page).allTextContents()).join(" ")).toMatch(
          /select|manual/i,
        );
        await page.evaluate(() => {
          window.copyProbe.mode = "reject";
        });
        await clickView(page);
        const manual = await scheduleStatuses(page).allTextContents();
        await page.evaluate(() => window.copyProbe.pending[0]!.resolve());
        expect(await scheduleStatuses(page).allTextContents()).toEqual(manual);
        await page.clock.runFor(10000);
        expect((await statuses(page).allTextContents()).join("")).toBe("");
      } finally {
        await context.close();
      }
    });

    for (const outcome of ["resolve", "reject"] as const) {
      test(`out-of-order ${outcome} owns only its control and newest attempt`, async ({
        browser,
      }) => {
        const { context, page } = await fixturePage(browser, target);
        try {
          await requireView(page);
          await page.evaluate(() => {
            window.copyProbe.mode = "pending";
          });
          await clickView(page);
          await clickView(page);
          await feed(page).click();
          expect(await copies(page)).toEqual([expectedView, expectedView, expectedFeed]);
          await page.evaluate(() => window.copyProbe.pending[1]!.resolve());
          await expect(scheduleStatuses(page)).toContainText(/(?:schedule|view).*copied/i);
          await expect(feedStatus(page)).toBeEmpty();
          const current = await scheduleStatuses(page).allTextContents();
          await page.evaluate((outcome) => window.copyProbe.pending[0]![outcome](), outcome);
          expect(await scheduleStatuses(page).allTextContents()).toEqual(current);
          await page.evaluate(() => window.copyProbe.pending[2]!.resolve());
          await expect(feedStatus(page)).toHaveText("Calendar feed URL copied.");
          expect(await scheduleStatuses(page).allTextContents()).toEqual(current);
        } finally {
          await context.close();
        }
      });
    }

    for (const mode of ["failed", "invalid"] as const) {
      test(`${mode} navigation and unsent draft retain the committed value`, async ({
        browser,
      }) => {
        const { context, page } = await fixturePage(browser, target);
        try {
          await requireView(page);
          await holdReads(page);
          const search = page.locator('input[name="q"]');
          await search.evaluate((input: HTMLInputElement) => {
            input.value = "unsent private draft";
          });
          await clickView(page);
          expect(await copies(page)).toEqual([expectedView]);
          expect(await page.evaluate(() => window.sharingReads.length)).toBe(0);
          await search.fill('café "raid" & 雪');
          // Submitting flushes debounce; no sleep or fabricated settled state.
          await page.locator('form[role="search"] button[type="submit"]').click();
          await readPath(page, 0);
          await clickView(page);
          expect(await copies(page)).toEqual([expectedView, expectedView]);
          await answer(page, target, 0, mode);
          await expect(page.locator("[data-cal-feedback]")).not.toBeEmpty();
          await clickView(page);
          expect(await copies(page)).toEqual([expectedView, expectedView, expectedView]);
          expect(page.url()).toBe(expectedView);
          await expect(view(page)).toHaveAttribute("data-copy-link", expectedView);
          await expect(feed(page)).toHaveAttribute("data-copy-link", expectedFeed);
        } finally {
          await context.close();
        }
      });
    }

    test("admitted swaps and Back/Forward update both controls; stale reads and detached promises cannot", async ({
      browser,
    }) => {
      const { context, page } = await fixturePage(browser, target);
      try {
        await requireView(page);
        await holdReads(page);
        await page.evaluate(() => {
          window.copyProbe.mode = "pending";
          window.retiredStatuses = Array.from(
            document.querySelectorAll<HTMLElement>("[data-copy-toast]"),
          );
        });
        await clickView(page);
        await changeGame(page, "Chess");
        await readPath(page, 0);
        await changeGame(page, "Catan & Co");
        const next = await readPath(page, 1);
        expect(next).toBe("/events?game=Catan+%26+Co&past=1");
        await answer(page, target, 1);
        await expect(view(page)).toHaveAttribute("data-copy-link", fixtureOrigin + next);
        await expect(feed(page)).toHaveAttribute(
          "data-copy-link",
          fixtureOrigin + "/events.ics?game=Catan+%26+Co",
        );
        const retiredBefore = await page.evaluate(() =>
          window.retiredStatuses.map((n) => ({ connected: n.isConnected, text: n.textContent })),
        );
        await answer(page, target, 0);
        await page.evaluate(() => window.copyProbe.pending[0]!.resolve());
        expect(
          await page.evaluate(() =>
            window.retiredStatuses.map((n) => ({ connected: n.isConnected, text: n.textContent })),
          ),
        ).toEqual(retiredBefore);
        await expect(view(page)).toHaveAttribute("data-copy-link", fixtureOrigin + next);
        await page.evaluate(() => {
          window.copyProbe.mode = "success";
          history.back();
        });
        await readPath(page, 2);
        // popstate moves location first, but only an admitted response changes sharing.
        await expect(view(page)).toHaveAttribute("data-copy-link", fixtureOrigin + next);
        await answer(page, target, 2);
        await expect(view(page)).toHaveAttribute("data-copy-link", expectedView);
        await reveal(page);
        await clickView(page);
        await feed(page).click();
        expect((await copies(page)).slice(-2)).toEqual([expectedView, expectedFeed]);
        await page.evaluate(() => history.forward());
        await readPath(page, 3);
        await answer(page, target, 3);
        await expect(view(page)).toHaveAttribute("data-copy-link", fixtureOrigin + next);
        await reveal(page);
        await clickView(page);
        await feed(page).click();
        expect((await copies(page)).slice(-2)).toEqual([
          fixtureOrigin + next,
          fixtureOrigin + "/events.ics?game=Catan+%26+Co",
        ]);
      } finally {
        await context.close();
      }
    });

    test("CONTROL: existing feed follows an admitted calendar snapshot without a schedule-copy oracle", async ({
      browser,
    }) => {
      const { context, page } = await fixturePage(browser, target);
      try {
        await reveal(page);
        await holdReads(page);
        await changeGame(page, "Chess");
        await readPath(page, 0);
        await expect(feed(page)).toHaveAttribute("data-copy-link", expectedFeed);
        await answer(page, target, 0);
        await expect(feed(page)).toHaveAttribute(
          "data-copy-link",
          fixtureOrigin + "/events.ics?game=Chess",
        );
        await reveal(page);
        await feed(page).focus();
        await page.keyboard.press("Enter");
        expect(await copies(page)).toEqual([fixtureOrigin + "/events.ics?game=Chess"]);
        await expect(feedStatus(page)).toHaveText("Calendar feed URL copied.");
      } finally {
        await context.close();
      }
    });
  });
}
