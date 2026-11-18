import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { requireTestDatabase } from "../ci-only.mjs";
import { kitFixtureSessionSecret, parityTargets } from "../kit-parity";

test.describe.configure({ mode: "serial" });
const actor = "900000000000009101";
const list = "/admin/reconciliation";
const open = "e2e00000-0000-4000-8000-00000000a001";
const resolved = "e2e00000-0000-4000-8000-00000000b001";
const dir = process.env.RECONCILIATION_EVIDENCE_DIR ?? "reconciliation-evidence";

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`audited reconciliation at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    const bearer = `two_${randomBytes(32).toString("base64url")}`;
    const hash = createHash("sha256").update(bearer).digest("hex");
    const honoSecret = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(
      /^SESSION_SECRET=(.+)$/m,
    )?.[1];
    if (!honoSecret) throw new Error("Missing Hono fixture session secret");
    const sql = postgres(requireTestDatabase(process.env.DATABASE_URL) as string, { max: 1 });
    let seeded = false;
    try {
      expect(
        await sql`select idempotency_key from bot_reconciliation_intents limit 1`,
      ).toHaveLength(0);
      await sql`insert into web_sessions (token_hash, status_hash, user_id, username, member, moderator, expires_at)
        values (${hash}, ${hash}, ${actor}, 'Synthetic Moderator', true, true, now() + interval '2 hours')`;
      for (const target of parityTargets()) {
        const secret = target.name === "kit" ? kitFixtureSessionSecret() : honoSecret;
        const signature = createHmac("sha256", secret).update(bearer).digest("base64");
        await page.context().addCookies([
          {
            name: "__Host-two_session",
            value: `${bearer}.${signature}`,
            domain: new URL(target.origin).hostname,
            path: "/",
            secure: true,
            httpOnly: true,
          },
        ]);
        async function capture(name: string, path: string, status: number, heading: string) {
          const response = await page.goto(target.origin + path);
          expect(response?.status()).toBe(status);
          expect(response?.headers()["x-two-renderer"]).toBe(
            target.name === "kit" ? "kit" : undefined,
          );
          expect(response?.headers()["cache-control"]).toMatch(/no-store/);
          await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
          await expect(page.locator("main form, main a[href$='/resolve']")).toHaveCount(0);
          expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(
            true,
          );
          expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
          await page.screenshot({
            path: join(dir, `${name}-${target.name}-${viewport.width}.png`),
            scale: "css",
          });
        }

        await capture("dashboard", "/admin", 200, "Moderation");
        await expect(page.getByRole("link", { name: "Reconciliation" })).toHaveCount(
          target.name === "kit" ? 1 : 0,
        );
        if (target.name === "hono") continue;
        await capture("empty", list, 200, "Reconciliation");
        await expect(page.getByText("No open intents recorded.")).toBeVisible();
        await sql.file(fileURLToPath(new URL("../fixtures/reconciliation.sql", import.meta.url)));
        seeded = true;
        await capture("populated", list, 200, "Reconciliation");
        await expect(page.locator(`a[href='${list}/${resolved}']`)).toBeVisible();
        await capture("open", `${list}/${open}`, 200, "event.upsert");
        await expect(page.getByText("Delivery was not confirmed.")).toBeVisible();
        await capture("resolved", `${list}/${resolved}`, 200, "announcement.post");
        await expect(page.getByText("Superseded")).toBeVisible();
        await capture("missing", `${list}/not-a-key`, 404, "Reconciliation record not found");

        await sql`create trigger e2e_reconciliation_receipt_fail before insert on activity_log
            for each row execute function e2e_reconciliation_receipt_fail()`;
        for (const path of [list, `${list}/${open}`]) {
          await capture(
            path === list ? "list-unavailable" : "detail-unavailable",
            path,
            503,
            "Admin temporarily unavailable",
          );
          await expect(page.locator("body")).not.toContainText(
            /synthetic_open|synthetic_resolved|synthetic receipt failure/,
          );
        }
      }
    } finally {
      try {
        if (seeded) {
          await sql`drop trigger if exists e2e_reconciliation_receipt_fail on activity_log`;
          await sql`drop function e2e_reconciliation_receipt_fail()`;
          await sql`delete from bot_reconciliation_intents where idempotency_key in (${open}, ${resolved})`;
        }
        await sql`delete from web_sessions where token_hash = ${hash}`;
      } finally {
        await sql.end();
      }
    }
  });
}
