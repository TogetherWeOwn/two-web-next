import { expect, type Page } from "@playwright/test";
import { KIT_ORIGIN, PARITY_VIEWPORTS } from "../kit-parity";
import { moderatorTest as test, withModeratorFixture } from "./moderator-fixture";

const values = {
  title: "Community night\nBring a friend",
  game: "Co-op\nValheim",
  location: "Community hall\nRoom two",
  organizer_name: "Jordan\nSmith",
  description: "Bring a friend.\nAll experience levels welcome.",
  accessibility_notes: `${"Step-free entrance. ".repeat(48)}\nHearing loop 🎧.`,
  join_instructions: "Meet at the entrance.\nAsk for the community table.",
  join_url: "https://example.com/lobby",
};
const conditionalFields = ["title", "game", "location", "organizer_name"] as const;
const limit = [...values.accessibility_notes].length;
const atLimit = `${values.accessibility_notes}${".".repeat(1000 - limit)}`;
const saved = { ...values, accessibility_notes: atLimit };
const historical = process.env.KIT_EVENT_NEWLINE_PHASE === "before";
const form = (page: Page) => page.locator("form[data-event-editor]");
const control = (page: Page, name: string) => form(page).locator(`[name="${name}"]`);
const baseline = (page: Page) => control(page, "saved_baseline");
const asWire = (value: string) => value.replace(/\n/g, "\r\n");

async function clickSave(page: Page, path: string, status: number, token: string) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url() === KIT_ORIGIN + path && r.request().method() === "POST"),
    page.getByTestId("save-event").click(),
  ]);
  const request = response.request();
  expect(request.isNavigationRequest()).toBe(true);
  expect(request.headers()["content-type"]).toBe("application/x-www-form-urlencoded");
  expect(request.headers().origin).toBe(KIT_ORIGIN);
  expect(response.headers()["x-two-renderer"]).toBeUndefined();
  expect(response.status()).toBe(status);
  const wire = new URLSearchParams(request.postData() ?? "");
  expect(wire.get("saved_baseline") === token, "native POST carries the rendered baseline").toBe(
    true,
  );
  return { wire, response };
}

for (const [index, { size }] of PARITY_VIEWPORTS.entries()) {
  // Separate rows for each viewport and JS mode; the service itself is disposable.
  for (const js of [true, false]) {
    const key = `01J${String(8700 + index * 2 + (js ? 0 : 1)).padStart(23, "0")}`;
    const path = `/admin/events/${key}`;
    test(`Kit native event newlines at ${size.width}×${size.height}, JS ${js ? "on" : "off"}`, async ({
      browser,
    }) => {
      await withModeratorFixture(
        browser,
        "kit",
        size,
        async ({ page, sql, navigate, capture }) => {
          const shot = (name: string) => capture(`event-newlines-${js ? "js" : "no-js"}-${name}`);
          await sql`insert into events
          (event_key, title, game, location, organizer_name, description, accessibility_notes,
           join_instructions, join_url, starts_at, ends_at, timezone, status)
          values (${key}, ${saved.title}, ${saved.game}, ${saved.location}, ${saved.organizer_name},
            ${saved.description}, ${saved.accessibility_notes}, ${saved.join_instructions},
            ${saved.join_url}, '2099-01-02T18:00:00Z', '2099-01-02T20:00:00Z', 'UTC', 'draft')`;
          try {
            const read = async () => {
              const [row] = await sql`select title, game, location, organizer_name, description,
              accessibility_notes, join_instructions, join_url, updated_at
              from events where event_key = ${key}`;
              expect(row).toBeDefined();
              return row!;
            };
            await navigate(path, 200, "Edit Community night Bring a friend");
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true);
            for (const field of conditionalFields) {
              const input = control(page, field);
              await expect(
                form(page).locator(`${historical ? "input" : "textarea"}[name="${field}"]`),
              ).toHaveCount(1);
              await expect(input).toHaveValue(
                historical ? saved[field].replace(/\n/g, "") : saved[field],
              );
              if (!historical) await expect(input).toHaveAttribute("rows", "2");
            }
            await shot(historical ? "before-renderer" : "multiline-before-save");
            expect([...atLimit]).toHaveLength(1000);
            const originalToken = await baseline(page).inputValue();
            expect(/^[0-9a-f]{64}$/.test(originalToken)).toBe(true);
            const original = await read();
            const first = await clickSave(page, path, 303, originalToken);
            expect(first.response.headers().location).toBe(`${path}?saved=1`);
            if (historical) {
              const committed = await read();
              for (const field of conditionalFields) {
                const collapsed = saved[field].replace(/\n/g, "");
                expect(first.wire.getAll(field)).toEqual([collapsed]);
                expect(committed[field]).toBe(collapsed);
              }
              return;
            }
            for (const [field, value] of Object.entries(saved)) {
              expect(first.wire.getAll(field)).toEqual([asWire(value)]);
            }
            expect([...(first.wire.get("accessibility_notes") ?? "")]).toHaveLength(1001);
            await expect(page).toHaveURL(`${KIT_ORIGIN}${path}?saved=1`);
            await navigate(path, 200, "Edit Community night Bring a friend");
            const committed = await read();
            expect(committed).toMatchObject(saved);
            expect(committed.updated_at).not.toEqual(original.updated_at);
            for (const [field, value] of Object.entries(saved)) {
              await expect(control(page, field)).toHaveValue(value);
            }
            const freshToken = await baseline(page).inputValue();
            expect(/^[0-9a-f]{64}$/.test(freshToken) && freshToken !== originalToken).toBe(true);
            await shot("untouched-reloaded");

            if (js) {
              await control(page, "game").fill("");
              await shot("optional-game-cleared");
              const clear = await clickSave(page, path, 303, freshToken);
              expect(clear.wire.getAll("game")).toEqual([""]);
              await expect(page).toHaveURL(`${KIT_ORIGIN}${path}?saved=1`);
              await navigate(path, 200, "Edit Community night Bring a friend");
              const cleared = await read();
              expect(cleared).toMatchObject({ ...saved, game: null });
              await expect(form(page).locator('input[name="game"]')).toHaveValue("");
              await control(page, "title").fill("");
              await page.getByTestId("save-event").click();
              await expect(control(page, "title")).toBeFocused();
              expect(
                await control(page, "title").evaluate(
                  (el) => (el as HTMLTextAreaElement).validity.valueMissing,
                ),
              ).toBe(true);
              expect(await read()).toEqual(cleared);
              await shot("required-title-cleared");
            } else {
              const draftOrganizer = "\nJordan\nSmith";
              await control(page, "organizer_name").fill(draftOrganizer);
              await control(page, "accessibility_notes").fill(`${atLimit}.`);
              const rejected = await clickSave(page, path, 422, freshToken);
              expect(rejected.wire.getAll("accessibility_notes")).toEqual([asWire(`${atLimit}.`)]);
              expect(rejected.wire.getAll("organizer_name")).toEqual([asWire(draftOrganizer)]);
              expect(await read()).toEqual(committed);
              const summary = page.getByTestId("form-errors");
              await expect(summary).toBeVisible();
              await expect(control(page, "organizer_name")).toHaveValue(draftOrganizer);
              expect((await baseline(page).inputValue()) === freshToken).toBe(true);
              const notes = control(page, "accessibility_notes");
              await expect(notes).toHaveValue(`${atLimit}.`);
              await expect(notes).toHaveAttribute("aria-invalid", "true");
              await expect(notes).toHaveAttribute(
                "aria-describedby",
                /\bf-accessibility-notes-error\b/,
              );
              await expect(page.getByTestId("error-accessibility_notes")).toHaveText(
                "Keep accessibility notes to 1000 characters.",
              );
              await shot("server-refused-draft");
              const link = summary.locator('a[href="#f-accessibility-notes"]');
              await link.focus();
              await page.keyboard.press("Enter");
              await expect(notes).toBeFocused();
              await shot("server-error-focused");
            }
          } finally {
            await sql`delete from events where event_key = ${key}`;
          }
        },
        { javaScriptEnabled: js, fullPage: true },
      );
    });
  }
}
