import { expect, test } from "@playwright/test";
import {
  createAdminTableRenderers,
  type Panel,
  type Renderer,
  type RenderPanel,
} from "../test/helpers/admin-table-clarity-render";

// Local SSR fixtures only. This spec also runs without the worker/DB E2E setup:
// playwright test --config test/helpers/admin-table-clarity.config.ts
// Missing contextual names, silently dropped filters and ambiguous UTC headers
// must fail against the real renderers, not a hand-written HTML substitute.
const notice = "Search terms are limited to 128 characters. Showing all rows.";
const title = 'Friday & friends "Chess"';
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let renderPanel: RenderPanel;

test.use({ javaScriptEnabled: false });
test.beforeAll(async () => {
  renderPanel = await createAdminTableRenderers();
});
test.beforeEach(async ({ page }) => {
  // Shell assets and any future accidental fetch cannot escape to the network.
  await page.route("**/*", (route) => route.abort());
});

const fields: Array<{ panel: Panel; input: string; parsed: string }> = [
  { panel: "roster", input: "roster_q", parsed: "q" },
  { panel: "join-attempts", input: "q", parsed: "q" },
  { panel: "activity-log", input: "subject", parsed: "subject" },
  { panel: "activity-log", input: "causer", parsed: "causer" },
  { panel: "events", input: "q", parsed: "q" },
  { panel: "featured", input: "q", parsed: "q" },
];

for (const renderer of ["Hono", "Kit"] satisfies Renderer[]) {
  test.describe(renderer, () => {
    for (const [eventTitle, actions] of [
      [title, ["Publish", "Cancel"]],
      ["Sunday strategy", ["Publish", "Cancel"]],
      ["Open games", ["Cancel", "Pause RSVPs"]],
      ["Paused games", ["Cancel", "Reopen RSVPs"]],
    ] as const) {
      for (const action of actions) {
        test(`events row: ${action} names ${eventTitle}`, async ({ page }) => {
          const { html } = await renderPanel(renderer, "events");
          await page.setContent(html);
          const row = page.getByRole("row").filter({ hasText: eventTitle });
          const button = row.getByRole("button", { name: new RegExp(escape(action)) });
          await expect(button).toHaveCount(1);
          await expect(button).toContainText(action);
          await expect(button).toHaveAccessibleName(new RegExp(escape(eventTitle)));
        });
      }
    }

    for (const [status, rsvpOpen, actions] of [
      ["draft", true, ["Publish", "Cancel"]],
      ["published", true, ["Cancel", "Pause RSVPs"]],
      ["published", false, ["Cancel", "Reopen RSVPs"]],
    ] as const) {
      for (const action of actions) {
        test(`edit ${status}/${rsvpOpen}: ${action} names the event`, async ({ page }) => {
          const { html } = await renderPanel(renderer, "roster", {}, { status, rsvpOpen });
          await page.setContent(html);
          const button = page.getByRole("button", { name: new RegExp(escape(action)) });
          await expect(button).toHaveCount(1);
          await expect(button).toContainText(action);
          await expect(button).toHaveAccessibleName(new RegExp(escape(title)));
        });
      }
    }

    for (const { panel, input, parsed } of fields) {
      for (const [label, value, normalized] of [
        ["absent", "", ""],
        ["ordinary", "  Friday games  ", "Friday games"],
        ["128 characters", "x".repeat(128), "x".repeat(128)],
        ["trimmed 128 characters", `  ${"x".repeat(128)}  `, "x".repeat(128)],
        ["NUL-stripped 128 characters", "x".repeat(128) + "\0".repeat(16), "x".repeat(128)],
      ] as const) {
        test(`${panel}/${input}: ${label} has no rejection notice`, async ({ page }) => {
          const { html, query } = await renderPanel(renderer, panel, { [input]: value });
          expect(query[parsed]).toBe(normalized);
          await page.setContent(html);
          await expect(page.locator(`input[name="${input}"]`)).toHaveValue(normalized);
          await expect(page.getByRole("status").filter({ hasText: notice })).toHaveCount(0);
        });
      }

      for (const [label, value] of [
        ["129 characters", "x".repeat(129)],
        ["trimmed 129 characters", `  ${"x".repeat(129)}  `],
        ["multi-KB", "x".repeat(8192)],
      ] as const) {
        test(`${panel}/${input}: ${label} announces dropped, never truncated search`, async ({
          page,
        }) => {
          const { html, query } = await renderPanel(renderer, panel, { [input]: value });
          expect(query[parsed]).toBe("");
          await page.setContent(html);
          await expect(page.locator(`input[name="${input}"]`)).toHaveValue("");
          const links = await page
            .locator("a[href]")
            .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href") ?? ""));
          expect(links.some((href) => href.includes("x".repeat(128)))).toBe(false);
          const status = page.getByRole("status").filter({ hasText: notice });
          await expect(status).toHaveCount(1);
          await expect(status).toHaveText(notice);
          await expect(status).toBeVisible();
        });
      }

      test(`${panel}/${input}: an empty result still announces the dropped filter`, async ({
        page,
      }) => {
        const { html } = await renderPanel(
          renderer,
          panel,
          { [input]: "x".repeat(129) },
          { empty: true },
        );
        await page.setContent(html);
        await expect(page.getByRole("status").filter({ hasText: notice })).toHaveText(notice);
      });
    }

    test("activity log announces two dropped fields only once", async ({ page }) => {
      const { html, query } = await renderPanel(renderer, "activity-log", {
        subject: "x".repeat(129),
        causer: "y".repeat(129),
        page: "2",
      });
      expect(query).toMatchObject({ subject: "", causer: "", page: 2 });
      await page.setContent(html);
      await expect(page.getByRole("status").filter({ hasText: notice })).toHaveCount(1);
    });

    test("activity log labels its UTC timestamp column", async ({ page }) => {
      const { html } = await renderPanel(renderer, "activity-log");
      await page.setContent(html);
      await expect(page.getByRole("columnheader", { name: "When (UTC)", exact: true })).toHaveCount(
        1,
      );
    });

    test("join attempts labels its UTC timestamp column", async ({ page }) => {
      const { html } = await renderPanel(renderer, "join-attempts");
      await page.setContent(html);
      await expect(
        page.getByRole("columnheader", { name: "Attempted (UTC)", exact: true }),
      ).toHaveCount(1);
    });
  });
}
