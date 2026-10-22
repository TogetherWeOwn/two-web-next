import { createHash, randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import postgres from "postgres";
import { requireTestDatabase } from "./ci-only.mjs";
import { test, expect } from "./fixtures";

// Browser pin for the overlay live-data slice: a config change and an event
// change each reach the rendered overlay within 30s through the 20s poll.
// Text-only assertions (no testids: the overlay page is slice 2's surface).
// No QA login: the overlay URL is a capability URL, unauthenticated. The
// seeded member has no avatar hash, so the page loads no third-party bytes
// and the network-isolation fixture stays quiet. Disposable CI Postgres only.
function watchConsole(page: Page) {
  const consoleNoise: string[] = [];
  page.on("console", (message) => {
    if (message.text().startsWith("Failed to load resource")) return;
    if (message.type() === "error" || message.type() === "warning") {
      consoleNoise.push(`${message.type()}: ${message.text()}`);
    }
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(String(error));
  });
  return {
    async expectQuiet() {
      expect(consoleNoise, "no console errors or warnings").toEqual([]);
      expect(pageErrors, "no uncaught page errors").toEqual([]);
    },
  };
}

const VISIBILITY_BUDGET_MS = 30_000;

test.describe("overlay live polling", () => {
  test.setTimeout(90_000);

  test("a config change reaches the overlay within 30s", async ({ page }) => {
    const sql = postgres(requireTestDatabase(process.env.DATABASE_URL), { max: 1 });
    try {
      const tables =
        await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('overlay_tokens','overlay_configs')`;
      const names = tables.map((row) => (row as { table_name: string }).table_name);
      expect(
        names,
        "overlay schema (slices 1-2) must be migrated before this spec can run",
      ).toContain("overlay_tokens");
      expect(
        names,
        "overlay schema (slices 1-2) must be migrated before this spec can run",
      ).toContain("overlay_configs");

      const memberId = `9200000000000000${randomBytes(2).toString("hex")}`;
      const displayName = `E2E Overlay ${randomBytes(4).toString("hex")}`;
      const customBefore = `custom before ${randomBytes(4).toString("hex")}`;
      const customAfter = `custom after ${randomBytes(4).toString("hex")}`;
      const elements = {
        show_identity: true,
        show_avatar: false,
        show_live_line: true,
        live_line_mode: "custom",
        custom_text: customBefore,
        layout: "compact",
      };
      const theme = { preset: "dark-translucent", accent: "gold" };
      const token = `two_ov_${randomBytes(32).toString("base64url")}`;
      const tokenHash = createHash("sha256").update(token).digest("hex");
      await sql`INSERT INTO users (id, username, avatar, member) VALUES (${memberId}, ${displayName}, NULL, TRUE)`;
      await sql`INSERT INTO overlay_configs (member_id, elements, theme) VALUES (${memberId}, ${JSON.stringify(elements)}::text::jsonb, ${JSON.stringify(theme)}::text::jsonb)`;
      await sql`INSERT INTO overlay_tokens (member_id, token_hash, status) VALUES (${memberId}, ${tokenHash}, 'live')`;

      const console = watchConsole(page);
      await page.goto(`/o/${token}`);
      await expect(page.getByText(displayName)).toBeVisible();
      await expect(page.getByText(customBefore)).toBeVisible();

      const startedAt = Date.now();
      const next = { ...elements, custom_text: customAfter };
      await sql`UPDATE overlay_configs SET elements = ${JSON.stringify(next)}::text::jsonb, updated_at = now() WHERE member_id = ${memberId}`;
      await expect
        .poll(async () => page.getByText(customAfter).count(), {
          timeout: VISIBILITY_BUDGET_MS,
          intervals: [1_000, 2_000, 3_000],
        })
        .toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(VISIBILITY_BUDGET_MS);
      await console.expectQuiet();
    } finally {
      await sql.end();
    }
  });

  test("an event retitle reaches the overlay within 30s", async ({ page }) => {
    const sql = postgres(requireTestDatabase(process.env.DATABASE_URL), { max: 1 });
    try {
      const tables =
        await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('overlay_tokens','overlay_configs')`;
      const names = tables.map((row) => (row as { table_name: string }).table_name);
      expect(
        names,
        "overlay schema (slices 1-2) must be migrated before this spec can run",
      ).toContain("overlay_tokens");
      expect(
        names,
        "overlay schema (slices 1-2) must be migrated before this spec can run",
      ).toContain("overlay_configs");

      const memberId = `9200000000000010${randomBytes(2).toString("hex")}`;
      const displayName = `E2E Ov Event ${randomBytes(4).toString("hex")}`;
      const titleBefore = `E2E Ov Title Before ${randomBytes(4).toString("hex")}`;
      const titleAfter = `E2E Ov Title After ${randomBytes(4).toString("hex")}`;
      const eventKey = `overlay-live-e2e-${randomBytes(8).toString("hex")}`;
      const elements = {
        show_identity: true,
        show_avatar: false,
        show_live_line: true,
        live_line_mode: "event",
        custom_text: null,
        layout: "compact",
      };
      const theme = { preset: "dark-translucent", accent: "gold" };
      const token = `two_ov_${randomBytes(32).toString("base64url")}`;
      const tokenHash = createHash("sha256").update(token).digest("hex");
      await sql`INSERT INTO users (id, username, avatar, member) VALUES (${memberId}, ${displayName}, NULL, TRUE)`;
      await sql`INSERT INTO overlay_configs (member_id, elements, theme) VALUES (${memberId}, ${JSON.stringify(elements)}::text::jsonb, ${JSON.stringify(theme)}::text::jsonb)`;
      await sql`INSERT INTO overlay_tokens (member_id, token_hash, status) VALUES (${memberId}, ${tokenHash}, 'live')`;
      await sql`
        INSERT INTO events (event_key, title, description, starts_at, ends_at, timezone, status, capacity, rsvp_open)
        VALUES (${eventKey}, ${titleBefore}, 'overlay live-data e2e fixture', '2099-01-01T18:00:00Z', '2099-01-01T20:00:00Z', 'UTC', 'published', 10, true)
      `;

      const console = watchConsole(page);
      await page.goto(`/o/${token}`);
      await expect(page.getByText(displayName)).toBeVisible();
      await expect(page.getByText(titleBefore)).toBeVisible();

      const startedAt = Date.now();
      await sql`UPDATE events SET title = ${titleAfter} WHERE event_key = ${eventKey}`;
      await expect
        .poll(async () => page.getByText(titleAfter).count(), {
          timeout: VISIBILITY_BUDGET_MS,
          intervals: [1_000, 2_000, 3_000],
        })
        .toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(VISIBILITY_BUDGET_MS);
      await console.expectQuiet();
    } finally {
      await sql.end();
    }
  });
});
