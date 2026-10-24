// Review-hardening pins for the self-view attended history (U3 builder owned).
//
// The acceptance suite pins the happy path; these cases pin the three review
// findings on the same real wiring (never the owned files): each night's date
// renders in its event zone (UTC fallback when the stored zone is invalid),
// unrenderable infinity-window import rows stay out of the total and the
// window, and the truncation hint stays hidden whenever every night fits.
//
// Fixed 2026-07 instants keep the zone assertions deterministic: they only
// grow more past, so the ended predicate never flips.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ATTENDED_HISTORY_LIMIT,
  createAttendedHistoryHarness,
  OWNER,
  TITLES,
  type AttendedHistoryHarness,
  type Renderer,
} from "./helpers/profile-attended-history";

const INFINITY_TITLE = "Infinity Window Night";
// 2026-07-10T00:00Z is 9 Jul 20:00 in New York and 10 Jul 00:00 in UTC.
const ZONE_START = "2026-07-10T00:00:00Z";
const ZONE_END = "2026-07-10T02:00:00Z";

function historySection(html: string): string {
  const section = html.match(
    /<section\b[^>]*data-testid="profile-attended"[\s\S]*?<\/section>/,
  )?.[0];
  expect(section, "history section is one section element").toBeDefined();
  return section!;
}

function timeRows(section: string): number {
  return section.match(/<time\b[^>]*datetime="[^"]+"/g)?.length ?? 0;
}

describe.skipIf(!process.env.DATABASE_URL)("attended-history review pins (agent-testdb)", () => {
  let harness: AttendedHistoryHarness;
  beforeAll(async () => {
    harness = await createAttendedHistoryHarness();
  });
  afterAll(async () => {
    await harness?.dispose();
  });

  async function seedNight(seed: {
    key: string;
    title: string;
    startsAt: string;
    endsAt: string;
    timezone?: string;
  }): Promise<void> {
    const [row] = await harness.fixture.client<{ id: number }[]>`
      insert into events (event_key, title, starts_at, ends_at, status, timezone)
      values (${seed.key}, ${seed.title}, ${seed.startsAt}, ${seed.endsAt}, ${"published"}, ${
        seed.timezone ?? "UTC"
      })
      returning id`;
    await harness.fixture.client`
      insert into rsvps (event_id, user_id, status)
      values (${row!.id}, ${OWNER}, ${"going"})`;
  }

  for (const renderer of ["Hono", "Kit"] as const) {
    describe(`${renderer} review pins`, () => {
      it("renders the night date in the event timezone", async () => {
        await harness.reset();
        await seedNight({
          key: "review-zone-night",
          title: "Review Zone Night",
          startsAt: ZONE_START,
          endsAt: ZONE_END,
          timezone: "America/New_York",
        });
        const html = await (await harness.request(renderer, "owner")).text();
        expect(html).toContain("Attended 1 night");
        const section = historySection(html);
        expect(section).toContain('datetime="2026-07-10T00:00:00.000Z"');
        expect(section).toContain("9 Jul 2026");
        expect(section).not.toContain("10 Jul 2026");
        expect(section).not.toContain('data-testid="profile-attended-more"');
      });

      it("falls back to UTC on an invalid event timezone", async () => {
        await harness.reset();
        await seedNight({
          key: "review-bad-zone-night",
          title: "Review Bad-Zone Night",
          startsAt: ZONE_START,
          endsAt: ZONE_END,
          timezone: "Not/AZone",
        });
        const response = await harness.request(renderer, "owner");
        expect(response.status).toBe(200);
        const section = historySection(await response.text());
        expect(section).toContain("10 Jul 2026");
      });

      it("excludes infinity-window rows from the total and the window", async () => {
        await harness.reset();
        await harness.seedMatrix();
        await seedNight({
          key: "review-infinity-window",
          title: INFINITY_TITLE,
          startsAt: "infinity",
          endsAt: "2026-07-01T12:00:00Z",
        });
        const html = await (await harness.request(renderer, "owner")).text();
        // Without the finite guard this row sorts first, inflates the total
        // to 9, then drops post-slice and hides the valid fifth night.
        expect(html).toContain("Attended 8 nights");
        expect(html).toContain(TITLES.attendedFourth);
        expect(html).toMatch(/Showing the 5 most recent of 8/);
        expect(html).not.toContain(INFINITY_TITLE);
        expect(timeRows(historySection(html))).toBe(ATTENDED_HISTORY_LIMIT);
      });

      it("hides the truncation hint for a partial window", async () => {
        await harness.reset();
        await harness.seedMatrix();
        const html = await (await harness.request(renderer, "viewer")).text();
        expect(html).toContain("Attended 2 nights");
        expect(html).toContain(TITLES.viewerOwn);
        expect(html).not.toContain('data-testid="profile-attended-more"');
      });

      it("hides the truncation hint for a full window", async () => {
        await harness.reset();
        await harness.seedAttendedOnly(ATTENDED_HISTORY_LIMIT);
        const html = await (await harness.request(renderer, "owner")).text();
        expect(html).toContain(`Attended ${ATTENDED_HISTORY_LIMIT} nights`);
        expect(html).not.toContain('data-testid="profile-attended-more"');
        expect(timeRows(historySection(html))).toBe(ATTENDED_HISTORY_LIMIT);
      });
    });
  }
});
