import postgres from "postgres";
import { requireTestDatabase } from "../ci-only.mjs";
import { expect, qaLogin, test } from "../fixtures";

// Public pages only: no session, no writes. Server-rendered times depend on the
// wall clock, so every <time> element is masked; everything else must match the
// committed baseline within maxDiffPixels (playwright.visual.config.ts).
// Changing a baseline is a deliberate act: see docs/visual-regression.md.
const ROUTES: Array<[name: string, path: string]> = [
  ["home", "/"],
  ["events", "/events"],
  ["event", "/e/01J00000000000000000000001"],
  ["past", "/events/past"],
  ["rules", "/rules"],
  ["privacy", "/privacy"],
];

const VIEWPORTS: Array<[name: string, size: { width: number; height: number }]> = [
  ["desktop", { width: 1280, height: 800 }],
  ["mobile", { width: 390, height: 844 }],
];

for (const [viewport, size] of VIEWPORTS) {
  for (const [name, path] of ROUTES) {
    test(`${name} @ ${viewport}`, async ({ page }) => {
      await page.setViewportSize(size);
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveScreenshot(`${name}-${viewport}.png`, {
        fullPage: true,
        mask: [page.locator("time")],
      });
    });
  }
}

// Event member states. Both fixtures are inserted AFTER the public routes
// above have been compared and deleted before the journeys start: a future
// paused or cancelled row would otherwise join /events, the seeded event's
// "more events" cards and the journeys' lists, and re-baseline pages this
// block does not own. The seed (e2e/seed.mjs) stays untouched for the same
// reason. Tests in one file run in declaration order (workers: 1, not fully
// parallel), so this block always runs last.
const STATE_FIXTURES = {
  // Published with RSVPs paused: only a signed-in member sees the paused notice
  // (a guest gets the sign-in link whatever the flag says).
  paused: {
    key: "01J00000000000000000000005",
    title: "E2E Visual Paused Night",
    status: "published",
    rsvpOpen: false,
  },
  // The cancelled page renders before any session read, so it is the same 410
  // for a guest and a member: no login needed.
  cancelled: {
    key: "01J00000000000000000000006",
    title: "E2E Visual Cancelled Night",
    status: "cancelled",
    rsvpOpen: true,
  },
} as const;

test.describe("event member states", () => {
  test.beforeAll(async () => {
    const sql = postgres(requireTestDatabase(process.env.DATABASE_URL), { max: 1 });
    try {
      for (const [index, fixture] of Object.values(STATE_FIXTURES).entries()) {
        // Delete first: a worker restart after a failed test re-runs this hook.
        await sql`delete from events where event_key = ${fixture.key}`;
        await sql`
          insert into events (event_key, title, description, starts_at, ends_at, timezone, status, capacity, rsvp_open)
          values (${fixture.key}, ${fixture.title}, 'Disposable visual-state fixture',
            ${`2099-09-${15 + index}T18:00:00Z`}, ${`2099-09-${15 + index}T20:00:00Z`}, 'UTC',
            ${fixture.status}, 10, ${fixture.rsvpOpen})
        `;
      }
    } finally {
      await sql.end();
    }
  });

  test.afterAll(async () => {
    const sql = postgres(requireTestDatabase(process.env.DATABASE_URL), { max: 1 });
    try {
      for (const fixture of Object.values(STATE_FIXTURES)) {
        await sql`delete from events where event_key = ${fixture.key}`;
      }
    } finally {
      await sql.end();
    }
  });

  for (const [viewport, size] of VIEWPORTS) {
    test(`cancelled @ ${viewport}`, async ({ page }) => {
      await page.setViewportSize(size);
      const response = await page.goto(`/e/${STATE_FIXTURES.cancelled.key}`);
      expect(response?.status()).toBe(410);
      await expect(page.getByTestId("event-cancelled")).toHaveText("Cancelled");
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveScreenshot(`event-cancelled-${viewport}.png`, {
        fullPage: true,
        mask: [page.locator("time")],
      });
    });
  }

  // One login for both widths: POST /auth/qa/:identity shares the 10/min
  // qa-login throttle with the journeys that run next (e2e/fixtures.ts).
  test("paused as a signed-in member @ desktop and mobile", async ({ page, context }) => {
    await qaLogin(context, "qa-member");
    for (const [viewport, size] of VIEWPORTS) {
      await page.setViewportSize(size);
      const response = await page.goto(`/e/${STATE_FIXTURES.paused.key}`);
      expect(response?.status()).toBe(200);
      // The member view, not the guest one: paused notice, no join control.
      await expect(page.getByTestId("rsvp-paused")).toBeVisible();
      await expect(page.getByTestId("rsvp-going")).toHaveCount(0);
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveScreenshot(`event-paused-${viewport}.png`, {
        fullPage: true,
        mask: [page.locator("time")],
      });
    }
  });
});
