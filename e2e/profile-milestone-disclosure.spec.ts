// Protected RED acceptance contract. Execute both actual renderers, never source
// regexes. The builder owns production styling, screenshots and visual gates.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  milestoneFixture,
  MILESTONE_ORIGIN,
  MILESTONE_OWNER,
  type MilestoneRenderer,
} from "../test/helpers/profile-milestone-disclosure";

test.use({ javaScriptEnabled: false, locale: "en-GB", timezoneId: "UTC" });

async function open(
  page: Page,
  renderer: MilestoneRenderer,
  options: Parameters<typeof milestoneFixture>[0],
) {
  const fixture = await milestoneFixture(options);
  const response = await fixture.request(renderer);
  expect(response.status).toBe(200);
  let html = await response.text();
  // Same shipped typography/tokens as the profile shells, plus any component CSS
  // returned by the actual Svelte compiler. No acceptance-only layout repair.
  const css =
    renderer === "Kit"
      ? readFileSync("web/src/app.css", "utf8")
      : ["public/styles.css", "public/theme.css", "public/profile-theme.css"]
          .map((path) => readFileSync(path, "utf8"))
          .join("\n");
  html = html.replace("</head>", `<style>${css}</style></head>`);
  const unexpected: string[] = [];
  const documents: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.resourceType() === "document") documents.push(request.url());
    if (["fetch", "xhr"].includes(request.resourceType()) || request.method() !== "GET") {
      unexpected.push(request.url());
      await route.abort();
    } else if (request.url() === MILESTONE_ORIGIN + fixture.path) {
      await route.fulfill({ contentType: "text/html", body: html });
    } else {
      // Styles/fonts/images may be referenced by the real shell; no external
      // network is admitted. The shipped styles are already inlined above.
      await route.abort();
    }
  });
  await page.goto(MILESTONE_ORIGIN + fixture.path);
  return { ...fixture, unexpected, documents };
}

const panel = (page: Page) => page.getByTestId("profile-stats");
const rows = (page: Page) => panel(page).locator("li");
const olderDisclosure = (page: Page) => panel(page).locator("details");

async function disclosureContract(page: Page, count: number) {
  const details = olderDisclosure(page);
  if (count <= 5) {
    expect(await details.count(), "zero through five loaded rows need no disclosure").toBe(0);
  } else {
    expect(await details.count(), "older rows need one native details").toBe(1);
    expect(await details.getAttribute("open"), "older loaded rows start collapsed").toBeNull();
    const summary = details.locator(":scope > summary");
    expect(await summary.count()).toBe(1);
    const label = (await summary.innerText()).trim();
    expect(label).toMatch(/older/i);
    expect(label).toMatch(new RegExp(`(?:^|\\D)${count - 5}(?:\\D|$)`));
    expect(
      label,
      "disclosure must not present the loaded remainder as lifetime history",
    ).not.toMatch(/lifetime|all.time|total.history/i);
    expect(await details.locator("li").count()).toBe(count - 5);
  }
  expect(
    await panel(page).locator("li:visible").count(),
    "only the newest five loaded rows are initially visible",
  ).toBe(Math.min(count, 5));
  expect(await rows(page).count(), "all already-loaded rows remain in the server HTML").toBe(count);
  expect(await panel(page).locator("li:visible strong").allTextContents()).toEqual(
    Array.from(
      { length: Math.min(count, 5) },
      (_, i) => `Achievement ${String(i + 1).padStart(3, "0")}`,
    ),
  );
}

async function keyboardToSummary(page: Page) {
  const summary = olderDisclosure(page).locator(":scope > summary");
  expect(await summary.count(), "a native summary must be keyboard reachable").toBe(1);
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    if (await summary.evaluate((element) => element === element.ownerDocument.activeElement))
      return;
  }
  throw new Error("Milestone summary is absent from the native tab order");
}

for (const renderer of ["Hono", "Kit"] as const) {
  test.describe(`${renderer} real SSR milestone disclosure`, () => {
    for (const count of [0, 1, 5, 6, 100]) {
      for (const owner of [true, false]) {
        test(`${count} loaded rows, ${owner ? "owner" : "other"}: bounded initial history`, async ({
          page,
        }) => {
          await open(page, renderer, { count, owner });
          await disclosureContract(page, count);
          const form = page.getByTestId("profile-form");
          expect(await form.count()).toBe(owner ? 1 : 0);
          if (owner) {
            await expect(form).toBeVisible();
            expect(await form.locator("xpath=ancestor::details").count()).toBe(0);
            await expect(form.locator('[name="bio"]')).toBeEditable();
            await expect(form.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
            expect(await page.locator("#edit-heading").count()).toBe(1);
          }
        });
      }
    }

    test("CONTROL: all rows, equal-date boundary, escaped detail and dates survive SSR", async ({
      page,
    }) => {
      await open(page, renderer, { count: 100 });
      expect(await rows(page).count()).toBe(100);
      // Literal independent endpoints plus a boundary tie: neither splitting nor
      // expanding may reverse, drop or duplicate rows with equal timestamps.
      const labels = await rows(page).locator("strong").allTextContents();
      expect(labels.slice(0, 7)).toEqual([
        "Achievement 001",
        "Achievement 002",
        "Achievement 003",
        "Achievement 004",
        "Achievement 005",
        "Achievement 006",
        "Achievement 007",
      ]);
      expect(labels.at(-1)).toBe("Achievement 100");
      expect(new Set(labels).size).toBe(100);
      expect(labels).toEqual(
        Array.from({ length: 100 }, (_, i) => `Achievement ${String(i + 1).padStart(3, "0")}`),
      );
      const editor = page.getByTestId("profile-form");
      await expect(editor).toBeVisible();
      expect(await editor.locator("xpath=ancestor::details").count()).toBe(0);
      await expect(editor.locator('[name="bio"]')).toBeEditable();
      await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
      expect(
        await rows(page)
          .locator("time")
          .evaluateAll((elements) =>
            elements
              .slice(0, 6)
              .map((element) => [element.getAttribute("datetime"), element.textContent]),
          ),
      ).toEqual([
        ["2026-09-30T12:00:00.000Z", "30 Sept 2026"],
        ["2026-09-29T12:00:00.000Z", "29 Sept 2026"],
        ["2026-09-28T12:00:00.000Z", "28 Sept 2026"],
        ["2026-09-27T12:00:00.000Z", "27 Sept 2026"],
        ["2026-09-26T12:00:00.000Z", "26 Sept 2026"],
        ["2026-09-26T12:00:00.000Z", "26 Sept 2026"],
      ]);
      expect(await rows(page).first().textContent()).toContain(
        "Chess <script>not executable</script> & friends",
      );
      expect(await panel(page).locator("script").count()).toBe(0);
      // Keep native numbering across either one list or split lists with start/value.
      const numbers = await rows(page).evaluateAll((elements) =>
        elements.map((element) => {
          const list = element.parentElement;
          if (list?.tagName !== "OL" || list.hasAttribute("reversed")) return null;
          let number = Number(list.getAttribute("start") ?? 1);
          for (const sibling of Array.from(list.children)) {
            if (sibling.tagName !== "LI") continue;
            if (sibling.hasAttribute("value")) number = Number(sibling.getAttribute("value"));
            if (sibling === element) return number;
            number++;
          }
          return null;
        }),
      );
      expect(numbers).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    });

    for (const state of [
      "complete",
      "truncated",
      "milestones unavailable",
      "membership unavailable",
      "partial",
    ] as const) {
      test(`CONTROL: preserves ${state} meaning and owner editor`, async ({ page }) => {
        const count = state === "truncated" ? 100 : state === "partial" ? 6 : 0;
        await open(page, renderer, { count, state });
        const stats = panel(page);
        const text = await stats.innerText();
        const loadedCount = (
          await stats
            .locator("dt")
            .filter({ hasText: /^Milestones$/ })
            .locator("xpath=following-sibling::dd")
            .allTextContents()
        ).join("");
        if (state === "complete") {
          expect(text).toContain("No milestones yet");
          expect(loadedCount?.trim()).toBe("0");
          expect(await olderDisclosure(page).count()).toBe(0);
        }
        if (state === "milestones unavailable") {
          expect(text).toMatch(/unavailable/i);
          expect(text).not.toContain("No milestones yet");
          expect(loadedCount?.trim()).not.toBe("0");
          expect(await olderDisclosure(page).count()).toBe(0);
          expect(text).toContain("Community Regular");
          expect(text).toContain("637 days");
        }
        if (state === "membership unavailable") {
          expect(text).toMatch(/unavailable/i);
          expect(text).not.toContain("Community Regular");
          expect(text).not.toContain("637 days");
        }
        if (state === "partial") {
          expect(text).not.toContain("Community Regular");
          expect(text).toContain("637 days");
          expect(await rows(page).count()).toBe(6);
        }
        if (state === "truncated") {
          expect(text).toMatch(/100\+/);
          expect(text).toMatch(/newest/i);
          expect(text).not.toMatch(/lifetime|all.time/i);
          // Collapsed rows must not swallow the truthful newest-window notice.
          const visible = await stats.locator("p:visible").allTextContents();
          expect(visible.join(" ")).toMatch(/newest/i);
        }
        await expect(page.getByTestId("profile-form")).toBeVisible();
      });
    }

    for (const width of [1280, 390]) {
      test(`${width}px no-JS: Tab/Enter/Space opens and collapses without reads or hiding editing`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
        const fixture = await open(page, renderer, { count: 100, state: "truncated" });
        await disclosureContract(page, 100);
        await keyboardToSummary(page);
        await page.keyboard.press("Enter");
        await expect(rows(page).nth(5)).toBeVisible();
        await expect(rows(page).last()).toBeVisible();
        expect(await panel(page).locator("li:visible").count()).toBe(100);
        expect(
          await rows(page)
            .nth(5)
            .locator("p")
            .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          "long details must wrap",
        ).toBe(true);
        expect(
          await page
            .locator("html")
            .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          "mobile/desktop must not overflow horizontally",
        ).toBe(true);
        await page.keyboard.press("Space");
        await expect(rows(page).nth(5)).toBeHidden();
        await expect(rows(page).first()).toBeVisible();
        await expect(page.getByTestId("profile-form")).toBeVisible();
        await page
          .getByTestId("profile-form")
          .locator('[name="bio"]')
          .fill("Still editing after collapse");
        await expect(page.getByTestId("profile-form").locator('[name="bio"]')).toHaveValue(
          "Still editing after collapse",
        );
        expect(fixture.operations).toEqual([`find:${MILESTONE_OWNER}`]);
        expect(fixture.statsReads).toEqual([MILESTONE_OWNER]);
        expect(fixture.unexpected).toEqual([]);
        expect(fixture.documents).toEqual([MILESTONE_ORIGIN + fixture.path]);
      });
    }
  });
}

test("CONTROL: native keyboard oracle runs without JavaScript", async ({ page }) => {
  const newest = Array.from(
    { length: 5 },
    (_, i) => `<li><strong>Achievement 00${i + 1}</strong></li>`,
  ).join("");
  await page.setContent(
    `<section data-testid="profile-stats"><ol>${newest}</ol><details><summary>1 older loaded milestone</summary><ol start="6"><li><strong>Achievement 006</strong></li></ol></details></section>`,
  );
  await disclosureContract(page, 6);
  await keyboardToSummary(page);
  await page.keyboard.press("Enter");
  await expect(rows(page).last()).toBeVisible();
  await page.keyboard.press("Space");
  await expect(rows(page).last()).toBeHidden();
});

test("NEGATIVE CONTROL: an ordinary expanded six-row list fails the disclosure oracle", async ({
  page,
}) => {
  await page.setContent(
    '<section data-testid="profile-stats"><ol><li>1</li><li>2</li><li>3</li><li>4</li><li>5</li><li>6</li></ol></section>',
  );
  await expect(disclosureContract(page, 6)).rejects.toThrow(/older rows need one native details/);
});
