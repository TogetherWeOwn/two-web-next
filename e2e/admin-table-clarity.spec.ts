import { expect, test, type Locator } from "@playwright/test";
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
//
// Canonical accessible names for the destructive and RSVP row actions. The
// occurrence discriminator is the event start instant in ISO UTC, so two
// same-title recurring occurrences never share a name:
//   list row: `Publish <title> (<startsAt ISO>)`, `Cancel <title> (<startsAt ISO>)`,
//     `Pause RSVPs for <title> (<startsAt ISO>)`, `Reopen RSVPs for <title> (<startsAt ISO>)`
//   edit screen: the same forms, except the visible label there is
//     `Cancel event`, so its name is `Cancel event <title> (<startsAt ISO>)`.
// Every name still begins with the exact visible label (label-in-name).
const notice =
  "Search terms are limited to 128 characters. Overlong search terms were not applied. Other filters and pagination still apply.";
const title = 'Friday & friends "Chess"';
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const endpointFor: Record<string, string> = {
  Publish: "publish",
  Cancel: "cancel",
  "Cancel event": "cancel",
  "Pause RSVPs": "rsvp-pause",
  "Reopen RSVPs": "rsvp-reopen",
};
const exactNameFor = (visible: string, eventTitle: string, startsAtIso: string) =>
  visible === "Pause RSVPs" || visible === "Reopen RSVPs"
    ? `${visible} for ${eventTitle} (${startsAtIso})`
    : `${visible} ${eventTitle} (${startsAtIso})`;

// Exact oracle for one action control: the full accessible name (anchored, so
// a name such as `Do not Publish ...` cannot pass), the exact visible label,
// and the effective POST target from the control's own form association
// (a per-button formaction/formmethod override counts as the target). The
// form is only inspected, never submitted.
async function expectActionControl(
  button: Locator,
  expected: { visible: string; name: string; path: string },
) {
  await expect(button).toHaveCount(1);
  await expect(button).toHaveAccessibleName(new RegExp(`^${escape(expected.name)}$`));
  const actual = await button.evaluate((el) => {
    const control = el as HTMLButtonElement;
    const form = control.form;
    return {
      visible: (control.textContent ?? "").replace(/\s+/g, " ").trim(),
      method: (control.getAttribute("formmethod") ?? form?.method ?? "").toLowerCase(),
      action: control.getAttribute("formaction") ?? form?.getAttribute("action") ?? "",
    };
  });
  expect(actual).toEqual({ visible: expected.visible, method: "post", action: expected.path });
}
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
    // Same-title recurring occurrences share a title; only the ISO start in
    // the name (and the event key in the form path) tells them apart.
    for (const { eventKey, eventTitle, startsAt, actions } of [
      {
        eventKey: "01K00000000000000000000001",
        eventTitle: title,
        startsAt: "2099-11-01T18:00:00.000Z",
        actions: ["Publish", "Cancel"],
      },
      {
        eventKey: "01K00000000000000000000005",
        eventTitle: title,
        startsAt: "2099-11-08T18:00:00.000Z",
        actions: ["Publish", "Cancel"],
      },
      {
        eventKey: "01K00000000000000000000002",
        eventTitle: "Sunday strategy",
        startsAt: "2099-11-03T18:00:00.000Z",
        actions: ["Publish", "Cancel"],
      },
      {
        eventKey: "01K00000000000000000000003",
        eventTitle: "Open games",
        startsAt: "2099-11-02T18:00:00.000Z",
        actions: ["Cancel", "Pause RSVPs"],
      },
      {
        eventKey: "01K00000000000000000000006",
        eventTitle: "Open games",
        startsAt: "2099-11-09T18:00:00.000Z",
        actions: ["Cancel", "Pause RSVPs"],
      },
      {
        eventKey: "01K00000000000000000000004",
        eventTitle: "Paused games",
        startsAt: "2099-11-04T18:00:00.000Z",
        actions: ["Cancel", "Reopen RSVPs"],
      },
      {
        eventKey: "01K00000000000000000000007",
        eventTitle: "Paused games",
        startsAt: "2099-11-11T18:00:00.000Z",
        actions: ["Cancel", "Reopen RSVPs"],
      },
    ] as const) {
      for (const action of actions) {
        test(`events row ${eventKey.slice(-2)}: ${action} names ${eventTitle} (${startsAt})`, async ({
          page,
        }) => {
          const { html } = await renderPanel(renderer, "events");
          await page.setContent(html);
          const row = page
            .getByRole("row")
            .filter({ hasText: eventTitle })
            .filter({ hasText: startsAt });
          await expect(row).toHaveCount(1);
          if (action === "Pause RSVPs") {
            const review = row.getByTestId("rsvp-pause-review");
            await expect(review).toHaveJSProperty("open", false);
            await review.locator("summary").click();
            await expect(review).toHaveJSProperty("open", true);
          }
          const name = exactNameFor(action, eventTitle, startsAt);
          // The dated name identifies exactly one control on the whole page.
          await expect(page.getByRole("button", { name, exact: true })).toHaveCount(1);
          await expectActionControl(row.getByRole("button", { name, exact: true }), {
            visible: action,
            name,
            path: `/admin/events/${eventKey}/${endpointFor[action]}`,
          });
        });
      }
    }

    // The edit screen renders one occurrence at a time; render two same-title
    // occurrences per lifecycle state so its names are occurrence-exact too.
    for (const [status, rsvpOpen, actions] of [
      ["draft", true, ["Publish", "Cancel event"]],
      ["published", true, ["Cancel event", "Pause RSVPs"]],
      ["published", false, ["Cancel event", "Reopen RSVPs"]],
    ] as const) {
      for (const { eventKey, startsAt } of [
        { eventKey: "01K00000000000000000000001", startsAt: "2099-11-01T18:00:00.000Z" },
        { eventKey: "01K00000000000000000000005", startsAt: "2099-11-08T18:00:00.000Z" },
      ] as const) {
        for (const action of actions) {
          test(`edit ${status}/${rsvpOpen} ${eventKey.slice(-2)}: ${action} names the event (${startsAt})`, async ({
            page,
          }) => {
            const { html } = await renderPanel(
              renderer,
              "roster",
              {},
              { status, rsvpOpen, eventKey, startsAt },
            );
            await page.setContent(html);
            if (action === "Pause RSVPs") {
              const review = page.getByTestId("rsvp-pause-review");
              await expect(review).toHaveJSProperty("open", false);
              await review.locator("summary").click();
              await expect(review).toHaveJSProperty("open", true);
            }
            const name = exactNameFor(action, title, startsAt);
            await expectActionControl(page.getByRole("button", { name, exact: true }), {
              visible: action,
              name,
              path: `/admin/events/${eventKey}/${endpointFor[action]}`,
            });
          });
        }
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

    // Only the overlong field drops: a valid sibling filter and the page
    // number stay in force, so the notice must not claim all rows are shown.
    test("activity log drops only the overlong field and keeps the valid causer and page", async ({
      page,
    }) => {
      const { html, query } = await renderPanel(renderer, "activity-log", {
        subject: "x".repeat(129),
        causer: "valid-causer",
        page: "2",
      });
      expect(query).toMatchObject({ subject: "", causer: "valid-causer", page: 2 });
      await page.setContent(html);
      await expect(page.locator(`input[name="subject"]`)).toHaveValue("");
      await expect(page.locator(`input[name="causer"]`)).toHaveValue("valid-causer");
      const links = await page
        .locator("a[href]")
        .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href") ?? ""));
      expect(links.some((href) => href.includes("causer=valid-causer"))).toBe(true);
      expect(links.some((href) => href.includes("page=1&causer=valid-causer"))).toBe(true);
      expect(links.some((href) => href.includes("subject="))).toBe(false);
      expect(links.some((href) => href.includes("x".repeat(128)))).toBe(false);
      const status = page.getByRole("status").filter({ hasText: notice });
      await expect(status).toHaveCount(1);
      await expect(status).toHaveText(notice);
      await expect(status).toBeVisible();
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
