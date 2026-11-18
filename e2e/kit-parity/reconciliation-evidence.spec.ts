import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { requireTestDatabase } from "../ci-only.mjs";
import { kitFixtureSessionSecret, parityTargets } from "../kit-parity";

test.describe.configure({ mode: "serial" });
const actor = "900000000000009101";
const list = "/admin/reconciliation";
const openKey = "e2e00000-0000-4000-8000-00000000a001";
const resolvedKey = "e2e00000-0000-4000-8000-00000000b001";
const open = `${list}/${openKey}`;
const resolved = `${list}/${resolvedKey}`;
const dir = process.env.RECONCILIATION_EVIDENCE_DIR ?? "reconciliation-evidence";

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`audited reconciliation at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    const honoSecret = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(
      /^SESSION_SECRET=(.+)$/m,
    )?.[1];
    if (!honoSecret) throw new Error("Missing Hono fixture session secret");
    const sql = postgres(requireTestDatabase(process.env.DATABASE_URL) as string, { max: 1 });
    const hashes: string[] = [];
    let seeded = false;
    try {
      expect(
        await sql`select idempotency_key from bot_reconciliation_intents limit 1`,
      ).toHaveLength(0);
      for (const { name: renderer, origin } of parityTargets()) {
        const kit = renderer === "kit";
        const bearer = `two_${randomBytes(32).toString("base64url")}`;
        const hash = createHash("sha256").update(bearer).digest("hex");
        await sql`insert into web_sessions (token_hash, status_hash, user_id, username, member, moderator, expires_at)
          values (${hash}, ${hash}, ${actor}, 'Synthetic Moderator', true, true, now() + interval '2 hours')`;
        hashes.push(hash);
        const signature = createHmac("sha256", kit ? kitFixtureSessionSecret() : honoSecret)
          .update(bearer)
          .digest("base64");
        await page.context().clearCookies();
        await page.context().addCookies([
          {
            name: "__Host-two_session",
            value: `${bearer}.${signature}`,
            domain: new URL(origin).hostname,
            path: "/",
            secure: true,
            httpOnly: true,
          },
        ]);
        async function capture(name: string, path: string, status: number, heading: string) {
          const response = await page.goto(origin + path);
          expect(response?.status()).toBe(status);
          expect(response?.headers()["x-two-renderer"]).toBe(kit ? "kit" : undefined);
          expect(response?.headers()["cache-control"]).toMatch(/no-store/);
          await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
          await expect(page.locator("main form, main a[href$='/resolve']")).toHaveCount(0);
          expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(
            true,
          );
          // Keep the unchanged dashboard widgets out of the new-surface axe check.
          if (kit) {
            const axe = new AxeBuilder({ page });
            if (path === "/admin") axe.include("main .facts");
            expect((await axe.analyze()).violations).toEqual([]);
          }
          await page.screenshot({
            path: join(dir, `${name}-${renderer}-${viewport.width}.png`),
            scale: "css",
          });
        }

        await capture("dashboard", "/admin", 200, "Moderation");
        await expect(page.getByRole("link", { name: "Reconciliation" })).toHaveCount(kit ? 1 : 0);
        if (!kit) continue;
        await capture("empty", list, 200, "Reconciliation");
        await expect(page.getByText("No open intents recorded.")).toBeVisible();
        await sql`insert into bot_reconciliation_intents
          (idempotency_key, verb, subject, attempts, first_seen_at, last_attempt_at, resolved_at, resolution)
          values (${openKey}, 'event.upsert', 'synthetic_open', 2, '2030-01-01', '2030-01-02', null, null),
            (${resolvedKey}, 'announcement.post', 'synthetic_resolved', 1, '2030-01-01', '2030-01-02', '2030-01-03', 'superseded')`;
        seeded = true;
        await capture("populated", list, 200, "Reconciliation");
        await expect(page.locator(`a[href='${resolved}']`)).toBeVisible();
        await capture("open", open, 200, "event.upsert");
        await expect(page.getByText("Delivery was not confirmed.")).toBeVisible();
        await capture("resolved", resolved, 200, "announcement.post");
        await expect(page.getByText("Superseded")).toBeVisible();
        await capture("missing", `${list}/not-a-key`, 404, "Reconciliation record not found");

        // Fail the second list receipt and the detail receipt, not the open read.
        await sql`create function e2e_reconciliation_receipt_fail() returns trigger language plpgsql as $$
          begin
            if new.causer_id = '900000000000009101' and new.description = 'bot-reconciliation.read'
                and new.event in ('list_resolved', 'view') then raise exception 'synthetic receipt failure'; end if;
            return new;
          end $$`;
        await sql`create trigger e2e_reconciliation_receipt_fail before insert on activity_log
          for each row execute function e2e_reconciliation_receipt_fail()`;
        for (const [name, path] of [
          ["list-unavailable", list],
          ["detail-unavailable", open],
        ] as const) {
          await capture(name, path, 503, "Admin temporarily unavailable");
          await expect(page.locator("body")).not.toContainText(
            /synthetic_open|synthetic_resolved|synthetic receipt failure/,
          );
        }
      }
    } finally {
      try {
        if (seeded) {
          await sql`drop function if exists e2e_reconciliation_receipt_fail() cascade`;
          await sql`delete from bot_reconciliation_intents where idempotency_key in (${openKey}, ${resolvedKey})`;
        }
        for (const hash of hashes) {
          await sql`delete from web_session_grace where status_hash = ${hash}`;
          await sql`delete from web_sessions where status_hash = ${hash}`;
        }
      } finally {
        await sql.end();
      }
    }
  });
}
