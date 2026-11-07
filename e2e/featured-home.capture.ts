import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { requireTestDatabase } from "./ci-only.mjs";
import { expect, test } from "./fixtures";

const state = process.env.FEATURED_CAPTURE_STATE;
const phase = process.env.FEATURED_CAPTURE_PHASE;
const output = process.env.FEATURED_CAPTURE_DIR;
if (
  !state ||
  !["populated", "empty", "oversized", "expired", "saturated", "read-failure"].includes(state) ||
  !["before", "after"].includes(phase ?? "") ||
  !output
) {
  throw new Error("Featured capture requires an explicit state, phase and output directory");
}
const directory = path.join(output, phase!);

test(`homepage featured evidence: ${state}`, async ({ page }) => {
  const sql = postgres(requireTestDatabase(process.env.DATABASE_URL), { max: 1 });
  const published = await sql`select id from featured_contents where is_published`;
  const inserted: number[] = [];
  try {
    await sql`update featured_contents set is_published = false where is_published`;
    async function insert(
      title: string,
      position: number,
      startsAt: string | null,
      endsAt: string | null,
    ) {
      const [row] = await sql`
        insert into featured_contents (title, body, url, position, is_published, starts_at, ends_at)
        values (${title}, 'Find your next community night. 一起玩 · 함께해요', '/events',
          ${position}, true, ${startsAt}, ${endsAt}) returning id
      `;
      inserted.push(row!.id);
    }
    if (state !== "empty") {
      await insert("Community games", 200, null, null);
    }
    if (state === "oversized") await insert("X".repeat(256), 0, null, null);
    if (state === "expired" || state === "saturated") {
      for (let index = 0; index < 101; index++) {
        await insert(
          `Window fixture ${index}`,
          index,
          state === "saturated" ? "2099-01-01T00:00:00Z" : null,
          state === "expired" ? "2000-01-01T00:00:00Z" : null,
        );
      }
    }
    await mkdir(directory, { recursive: true });
    async function capture() {
      for (const size of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(size);
        const response = await page.goto("/");
        expect(response?.status()).toBe(200);
        await page.waitForLoadState("networkidle");
        await expect(page.getByRole("heading", { name: "Community games", exact: true })).toHaveCount(
          state === "empty" || state === "read-failure" ? 0 : 1,
        );
        await expect(page.getByText("X".repeat(256), { exact: true })).toHaveCount(
          state === "oversized" && phase === "before" ? 1 : 0,
        );
        await expect(page.getByText(/^Window fixture /)).toHaveCount(0);
        await page.screenshot({
          path: path.join(directory, `${state}-${size.width}x${size.height}.png`),
          fullPage: true,
          mask: [page.locator("time")],
        });
      }
    }
    if (state === "read-failure") {
      // Only this job's disposable Postgres: force the real read's lock timeout.
      await sql.begin(async (tx) => {
        await tx`lock table featured_contents in access exclusive mode`;
        await capture();
      });
    } else {
      await capture();
    }
    await writeFile(
      path.join(directory, `${state}.json`),
      JSON.stringify(
        {
          state,
          phase,
          head: process.env.GITHUB_SHA,
          base: process.env.CAPTURE_BASE,
          viewports: ["1280x800", "390x844"],
          insertedRows: inserted.length,
          runtime: "local Wrangler Hono with disposable CI Postgres",
          masks: ["time"],
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      if (inserted.length) await sql`delete from featured_contents where id in ${sql(inserted)}`;
      if (published.length) {
        await sql`update featured_contents set is_published = true where id in ${sql(published.map((row) => row.id))}`;
      }
    } finally {
      await sql.end();
    }
  }
});
