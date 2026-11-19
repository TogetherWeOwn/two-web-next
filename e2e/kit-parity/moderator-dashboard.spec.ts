import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { PARITY_VIEWPORTS, parityTargets } from "../kit-parity";
import { moderatorTest as test, withModeratorFixture } from "./moderator-fixture";

const list = "/admin/reconciliation";
const openKey = "e2e00000-0000-4000-8000-00000000a001";
const resolvedKey = "e2e00000-0000-4000-8000-00000000b001";
const open = `${list}/${openKey}`;
const resolved = `${list}/${resolvedKey}`;

async function expectReadOnlyLayout(page: Page) {
  await expect(page.locator("main form, main a[href$='/resolve']")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

// Comparison captures, not visual baselines or replacements for existing axe gates.
for (const { name } of parityTargets()) {
  for (const viewport of PARITY_VIEWPORTS) {
    test(`${name} moderator dashboard at ${viewport.size.width}×${viewport.size.height}`, async ({
      browser,
    }) => {
      await withModeratorFixture(
        browser,
        name,
        viewport.size,
        async ({ page, navigate, capture }) => {
          await navigate("/admin", 200, "Moderation");
          await expectReadOnlyLayout(page);
          await expect(page.getByRole("link", { name: "Reconciliation" })).toHaveCount(
            name === "kit" ? 1 : 0,
          );
          // Check the changed card list, not unchanged dashboard widgets.
          if (name === "kit") {
            expect(
              (await new AxeBuilder({ page }).include("main .facts").analyze()).violations,
            ).toEqual([]);
          }
          await capture("dashboard");
        },
      );
    });
  }
}

for (const { size } of PARITY_VIEWPORTS) {
  test(`Kit audited reconciliation at ${size.width}×${size.height}`, async ({ browser }) => {
    test.setTimeout(120_000);
    await withModeratorFixture(browser, "kit", size, async ({ page, sql, navigate, capture }) => {
      async function check(name: string, path: string, status: number, heading: string) {
        await navigate(path, status, heading);
        await expectReadOnlyLayout(page);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        await capture(`reconciliation-${name}`);
      }

      expect(
        await sql`select idempotency_key from bot_reconciliation_intents limit 1`,
      ).toHaveLength(0);
      await check("empty", list, 200, "Reconciliation");
      await expect(page.getByText("No open intents recorded.")).toBeVisible();
      await sql`insert into bot_reconciliation_intents
        (idempotency_key, verb, subject, attempts, first_seen_at, last_attempt_at, resolved_at, resolution)
        values (${openKey}, 'event.upsert', 'synthetic_open', 2, '2030-01-01', '2030-01-02', null, null),
          (${resolvedKey}, 'announcement.post', 'synthetic_resolved', 1, '2030-01-01', '2030-01-02', '2030-01-03', 'superseded')`;
      try {
        await check("populated", list, 200, "Reconciliation");
        await expect(page.locator(`a[href='${resolved}']`)).toBeVisible();
        await page.getByRole("link", { name: "Back to the dashboard" }).focus();
        for (const name of ["Open intents", "Recently resolved"]) {
          await page.keyboard.press("Tab");
          const region = page.getByRole("region", { name });
          await expect(region.getByRole("link")).toBeFocused();
          if (size.width === 390) {
            const start = await region.evaluate((el) => el.scrollLeft);
            await page.keyboard.press("ArrowRight");
            await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(start);
          }
        }
        await check("open", open, 200, "event.upsert");
        await expect(page.getByText("Delivery was not confirmed.")).toBeVisible();
        await check("resolved", resolved, 200, "announcement.post");
        await expect(page.getByText("Superseded")).toBeVisible();
        await check("missing", `${list}/not-a-key`, 404, "Reconciliation record not found");

        // Fail the second list receipt and the detail receipt, not the open read.
        await sql.begin(async (tx) => {
          await tx`create function e2e_reconciliation_receipt_fail() returns trigger language plpgsql as $$
            begin
              if new.causer_id = '900000000000009101' and new.description = 'bot-reconciliation.read'
                  and new.event in ('list_resolved', 'view') then raise exception 'synthetic receipt failure'; end if;
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
