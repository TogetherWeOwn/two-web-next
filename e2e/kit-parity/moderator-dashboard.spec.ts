import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { PARITY_VIEWPORTS, parityTargets } from "../kit-parity";
import { moderatorTest as test, withModeratorFixture } from "./moderator-fixture";

const list = "/admin/reconciliation";
const openKey = "e2e00000-0000-4000-8000-00000000a001";
const resolvedKey = "e2e00000-0000-4000-8000-00000000b001";
const open = `${list}/${openKey}`;
const resolved = `${list}/${resolvedKey}`;
const focusOutline = "rgb(255, 156, 54) solid 3px";

async function expectReadOnlyLayout(page: Page) {
  await expect(page.locator("main form, main a[href$='/resolve']")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

// Comparison captures, not visual baselines or replacements for existing axe gates.
for (const { name } of parityTargets()) {
  for (const { size } of PARITY_VIEWPORTS) {
    test(`${name} moderator dashboard at ${size.width}×${size.height}`, async ({ browser }) => {
      await withModeratorFixture(browser, name, size, async ({ page, navigate, capture }) => {
        await navigate("/admin", 200, "Moderation");
        await expectReadOnlyLayout(page);
        const reconciliation = page.getByRole("link", { name: "Reconciliation" });
        await expect(reconciliation).toHaveCount(name === "kit" ? 1 : 0);
        if (name === "kit") {
          const audit = await new AxeBuilder({ page }).include("main .facts").analyze();
          expect(audit.violations).toEqual([]);
        }
        await capture("dashboard");
      });
    });
  }
}

for (const { size } of PARITY_VIEWPORTS) {
  test(`Kit audited reconciliation at ${size.width}×${size.height}`, async ({ browser }) => {
    test.setTimeout(120_000);
    await withModeratorFixture(browser, "kit", size, async ({ page, sql, navigate, capture }) => {
      async function check(name: string, path: string, status: number, heading: string) {
        await navigate(path, status, heading);
        if (name === "open") {
          await expect(page.getByRole("combobox", { name: "Resolution" })).toBeVisible();
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
        } else {
          await expectReadOnlyLayout(page);
        }
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        const back = path === list ? "Back to the dashboard" : "Back to reconciliation";
        await expect(page.getByRole("link", { name: back, exact: true })).toBeVisible();
        await capture(`reconciliation-${name}`);
        await page.keyboard.press("Tab");
        for (const link of await page.getByRole("link", { name: /^(Back to|Retry)/ }).all()) {
          await link.focus();
          await expect(link).toHaveCSS("outline", focusOutline);
        }
      }

      // Use a native form navigation so the built Worker sees a browser Origin.
      async function submitFixture(
        value: string,
        status: number,
        heading: string,
        captureName: string,
      ) {
        const [response] = await Promise.all([
          page.waitForNavigation(),
          page.evaluate(
            ({ action, value }) => {
              const form = document.createElement("form");
              form.method = "post";
              form.action = action;
              const field = document.createElement("input");
              field.name = "resolution";
              field.value = value;
              form.appendChild(field);
              document.body.appendChild(form);
              form.submit();
            },
            { action: open, value },
          ),
        ]);
        expect(response?.status()).toBe(status);
        await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
        await expectReadOnlyLayout(page);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        await capture(`reconciliation-${captureName}`);
      }

      expect(await sql`select 1 from bot_reconciliation_intents limit 1`).toHaveLength(0);
      const receipts = () => sql`
        select causer_id, properties from activity_log
        where description = 'bot-reconciliation.resolve' and subject_id = ${openKey}
        order by id`;
      const priorReceipts = (await receipts()).length;
      await check("empty", list, 200, "Reconciliation");
      await expect(page.getByText("No open intents recorded.")).toBeVisible();
      await sql`insert into bot_reconciliation_intents
        (idempotency_key, verb, subject, attempts, first_seen_at, last_attempt_at, resolved_at, resolution)
        values (${openKey}, 'event.upsert', 'synthetic_open', 2, '2030-01-01', '2030-01-02', null, null),
          (${resolvedKey}, 'announcement.post', 'synthetic_resolved', 1, '2030-01-01', '2030-01-02', '2030-01-03', 'superseded')`;
      try {
        await check("populated", list, 200, "Reconciliation");
        await expect(page.locator(`a[href='${resolved}']`)).toBeVisible();
        for (const name of ["Open intents", "Recently resolved"]) {
          await page.keyboard.press("Tab");
          const region = page.getByRole("region", { name });
          await expect(region.getByRole("link")).toBeFocused();
          await expect(region.getByRole("link")).toHaveCSS("outline", focusOutline);
          await capture(`reconciliation-focus-${name === "Open intents" ? "open" : "resolved"}`);
          if (size.width === 390) {
            const start = await region.evaluate((el) => el.scrollLeft);
            await page.keyboard.press("ArrowRight");
            await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(start);
          }
        }
        await check("open", open, 200, "event.upsert");
        await expect(page.getByText("Delivery was not confirmed.")).toBeVisible();
        await page.getByRole("button", { name: "Stamp resolved" }).scrollIntoViewIfNeeded();
        await capture("reconciliation-open-form");
        await check("resolved", resolved, 200, "announcement.post");
        await expect(page.getByText("Superseded")).toBeVisible();
        await check("missing", `${list}/not-a-key`, 404, "Reconciliation record not found");
        await submitFixture("unknown", 400, "Resolution not recorded", "invalid-resolution");
        await expect(page.getByRole("link", { name: "Review the record" })).toHaveAttribute(
          "href",
          open,
        );
        // Fail the second list, detail and resolution receipts, not the open list read.
        await sql.begin(async (tx) => {
          await tx`create function e2e_reconciliation_receipt_fail() returns trigger language plpgsql as $$
            begin
              if new.causer_id = '900000000000009101' and (
                (new.description = 'bot-reconciliation.read' and new.event in ('list_resolved', 'view'))
                or new.description = 'bot-reconciliation.resolve'
              ) then raise exception 'synthetic receipt failure'; end if;
              return new;
            end $$`;
          await tx`create trigger e2e_reconciliation_receipt_fail before insert on activity_log
            for each row execute function e2e_reconciliation_receipt_fail()`;
        });
        for (const [name, path] of [
          ["list-unavailable", list],
          ["detail-unavailable", open],
        ] as const) {
          await check(name, path, 503, "Admin temporarily unavailable");
          await expect(page.getByText("Retry loading")).toHaveAttribute("href", path);
          await expect(page.locator("body")).not.toContainText(
            /synthetic_open|synthetic_resolved|synthetic receipt failure/,
          );
        }
        await submitFixture("confirmed", 503, "Admin temporarily unavailable", "write-unavailable");
        await expect(page.locator("body")).not.toContainText(
          /synthetic_open|synthetic receipt failure/,
        );
        expect(
          await sql`select resolution from bot_reconciliation_intents where idempotency_key = ${openKey}`,
        ).toEqual([{ resolution: null }]);
        expect(await receipts()).toHaveLength(priorReceipts);
        await sql`drop trigger e2e_reconciliation_receipt_fail on activity_log`;

        await navigate(open, 200, "event.upsert");
        await page.getByRole("combobox", { name: "Resolution" }).selectOption("confirmed");
        const saved = page.waitForResponse((response) => response.request().method() === "POST");
        await page.getByRole("button", { name: "Stamp resolved" }).click();
        const response = await saved;
        expect(response.status()).toBe(303);
        expect(response.headers().location).toBe(open);
        const conclusion = page.getByText("Confirmed", { exact: true });
        await expect(conclusion).toBeVisible();
        await expectReadOnlyLayout(page);
        await conclusion.scrollIntoViewIfNeeded();
        await capture("reconciliation-recorded-resolution");

        await submitFixture("not_applied", 409, "Resolution not recorded", "stale-resolution");
        await expect(page.getByRole("link", { name: "Review the record" })).toHaveAttribute(
          "href",
          open,
        );
        expect((await receipts()).slice(priorReceipts)).toEqual([
          {
            causer_id: "900000000000009101",
            properties: { resolution: { before: null, after: "confirmed" } },
          },
        ]);
      } finally {
        // Keep append-only receipts until the disposable CI database is destroyed.
        await sql.begin(async (tx) => {
          await tx`drop trigger if exists e2e_reconciliation_receipt_fail on activity_log`;
          await tx`drop function if exists e2e_reconciliation_receipt_fail()`;
          await tx`delete from bot_reconciliation_intents where idempotency_key in (${openKey}, ${resolvedKey})`;
        });
      }
    });
  });
}
