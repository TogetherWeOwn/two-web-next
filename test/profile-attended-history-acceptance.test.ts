// Acceptance: your own attended nights on the profile self-view (U3).
//
// The owner's own `/profile` self-view, on both twins, shows an
// attended-history section: total count plus the most recent
// ATTENDED_HISTORY_LIMIT past nights (title/when/link each). Strictly
// self-only: other-member and anonymous renders stay byte-identical to today.
//
// Protected acceptance file (U3 Test Author owned): the paired builder
// starts from this branch/SHA, never edits this file, and returns test
// corrections to the Test Author.
//
// RED expectations on unmodified source: every test marked RED below fails
// because no history section exists on either twin. Tests marked GREEN are
// controls that pass before and after the fix; the builder must keep them
// green (byte-parity, no-store, unaudited own reads, no-leak guards).
//
// Render contract the builder implements (both twins, same testids):
// - section[data-testid="profile-attended"][aria-labelledby="attended-heading"]
// - h2#attended-heading "Nights you attended"
// - p[data-testid="profile-attended-count"] "Attended N night(s)" (total)
// - ul > li > a[href="/e/<eventKey>"]<title> + <time datetime="<ISO>">
// - p[data-testid="profile-attended-more"] "Showing the 5 most recent of N …"
//   only when the total exceeds the limit
// - empty history: p[data-testid="profile-attended-empty"] with an <a
//   href="/events"> schedule link, and no count element
// Attended = a `going` answer on an ended event with status `published` or
// `past`. Cancelled/draft events, maybe/not_going/waitlisted answers,
// withdrawn answers (no row) and upcoming answers are excluded. Order is
// startsAt desc, id desc (the past-archive tiebreak).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ATTENDED_HISTORY_LIMIT,
  createAttendedHistoryHarness,
  normalizeProfileHtml,
  TITLES,
  type Actor,
  type AttendedHistoryHarness,
  type Renderer,
} from "./helpers/profile-attended-history";
import { testDatabaseUrl } from "./helpers/member-data-db";

const BASELINES = join(
  dirname(fileURLToPath(import.meta.url)),
  "baselines",
  "profile-attended-history",
);
const EXCLUDED_TITLES = [
  TITLES.cancelled,
  TITLES.draft,
  TITLES.maybe,
  TITLES.declined,
  TITLES.waitlisted,
  TITLES.withdrawn,
  TITLES.upcomingOne,
  TITLES.upcomingTwo,
] as const;
const HISTORY_MARKERS = [
  'data-testid="profile-attended"',
  'data-testid="profile-attended-count"',
  'data-testid="profile-attended-more"',
  'data-testid="profile-attended-empty"',
  'id="attended-heading"',
] as const;

// Static containment pin: the guard refuses non-test URLs before any driver
// exists. Always runs, needs no database.
describe("attended-history test containment", () => {
  it("refuses a non-test DATABASE_URL before driver construction", () => {
    expect(() => testDatabaseUrl("postgres://agent_test@staging.example.test/some_db", {})).toThrow(
      "refusing before connecting",
    );
  });

  it("pins the history window the builder implements", () => {
    expect(ATTENDED_HISTORY_LIMIT).toBe(5);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("own attended nights (agent-testdb)", () => {
  let harness: AttendedHistoryHarness;
  beforeAll(async () => {
    harness = await createAttendedHistoryHarness();
  });
  afterAll(async () => {
    await harness?.dispose();
  });

  async function selfView(renderer: Renderer, actor: Actor = "owner"): Promise<Response> {
    await harness.reset();
    await harness.seedMatrix();
    harness.resetStatements();
    harness.audit.length = 0;
    return harness.request(renderer, actor);
  }

  function baselinePath(renderer: Renderer): string {
    return join(BASELINES, `other-member-${renderer.toLowerCase()}.html`);
  }

  function expectByteParity(renderer: Renderer, html: string): void {
    const normalized = normalizeProfileHtml(html, renderer);
    const path = baselinePath(renderer);
    if (process.env.RECORD_ATTENDED_BASELINES === "1") {
      mkdirSync(BASELINES, { recursive: true });
      writeFileSync(path, normalized);
      return;
    }
    expect(existsSync(path), `byte-parity baseline committed at ${path}`).toBe(true);
    expect(normalized).toBe(readFileSync(path, "utf8"));
  }

  for (const renderer of ["Hono", "Kit"] as const) {
    describe(`${renderer} self-view history`, () => {
      it("RED: shows the attended count and the five most recent nights, newest first", async () => {
        const html = await (await selfView(renderer)).text();
        expect(html).toContain('data-testid="profile-attended"');
        expect(html).toContain('id="attended-heading"');
        expect(html).toContain("Nights you attended");
        expect(html).toContain('data-testid="profile-attended-count"');
        expect(html).toContain("Attended 8 nights");
        for (const [title, key] of [
          [TITLES.attendedNewest, "attended-alpha"],
          [TITLES.attendedSecond, "attended-beta"],
          [TITLES.attendedThird, "attended-gamma"],
          [TITLES.attendedFourth, "attended-delta"],
        ] as const) {
          expect(html).toContain(`href="/e/${key}"`);
          expect(html).toContain(title);
        }
        // Newest first, in document order.
        const positions = [
          TITLES.attendedNewest,
          TITLES.attendedSecond,
          TITLES.attendedThird,
          TITLES.attendedFourth,
        ].map((title) => html.indexOf(title));
        expect(positions.every((position) => position >= 0)).toBe(true);
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
        // Each night carries a machine-readable instant.
        const section = html.match(
          /<section\b[^>]*data-testid="profile-attended"[\s\S]*?<\/section>/,
        )?.[0];
        expect(section, "history section is one section element").toBeDefined();
        expect(section!.match(/<time\b[^>]*datetime="[^"]+"/g)?.length).toBe(5);
      });

      it("RED: counts a past-status row and truncates past the limit", async () => {
        const html = await (await selfView(renderer)).text();
        // Eight attended, five shown: the past-status row counts toward the
        // total from below the window, like the past archive counts it.
        expect(html).toContain("Attended 8 nights");
        expect(html).toContain('data-testid="profile-attended-more"');
        expect(html).toMatch(/Showing the 5 most recent of 8/);
        expect(html).not.toContain(TITLES.attendedTruncated);
        expect(html).not.toContain(TITLES.attendedPastStatus);
        expect(html).not.toContain(TITLES.attendedFifthShown);
      });

      it("RED: keeps the id-desc tiebreak inside the window", async () => {
        const html = await (await selfView(renderer)).text();
        // Delta and epsilon share a start; the later insert (higher id)
        // renders fifth while epsilon is the first truncated row.
        expect(html).toContain(TITLES.attendedFourth);
        expect(html).not.toContain(TITLES.attendedFifthShown);
      });

      it("RED: excludes cancelled, draft, no-show, withdrawn and upcoming answers", async () => {
        const html = await (await selfView(renderer)).text();
        // The section must exist for the exclusions below to mean anything.
        expect(html).toContain('data-testid="profile-attended"');
        for (const title of EXCLUDED_TITLES) {
          expect(html, `excluded answer must not render: ${title}`).not.toContain(title);
        }
        expect(html).not.toContain("excluded-cancelled");
        expect(html).not.toContain("excluded-upcoming-one");
      });

      it("RED: escapes a hostile night title like any other member text", async () => {
        const html = await (await selfView(renderer)).text();
        // Both twins escape `<`; only Hono also escapes `>`, so the shared
        // pin is the `&lt;` opening both renderers emit, plus raw absence.
        expect(html).toContain("&lt;script");
        expect(html).not.toContain("<script>alert(1)</script>");
      });

      it("RED: scopes the list to the actor, not the event", async () => {
        const html = await (await selfView(renderer)).text();
        // The viewer also answered Alpha, but only the viewer's own night is
        // theirs: it must not appear in the owner's history.
        expect(html).toContain(TITLES.attendedNewest);
        expect(html).not.toContain(TITLES.viewerOwn);
      });

      it("RED: another member's self-view shows only their own history", async () => {
        const html = await (await selfView(renderer, "viewer")).text();
        expect(html).toContain("Attended 2 nights");
        expect(html).toContain(TITLES.viewerOwn);
        expect(html).toContain(TITLES.attendedNewest);
        expect(html).not.toContain(TITLES.attendedSecond);
        expect(html).not.toContain(TITLES.attendedThird);
      });

      it("RED: empty history keeps an explicit state with a schedule link", async () => {
        const html = await (await selfView(renderer, "empty")).text();
        expect(html).toContain('data-testid="profile-attended"');
        expect(html).toContain('data-testid="profile-attended-empty"');
        expect(html).toContain('href="/events"');
        expect(html).not.toContain('data-testid="profile-attended-count"');
        expect(html).not.toContain('data-testid="profile-attended-more"');
      });

      it("RED: adds exactly one bounded read to the self-view", async () => {
        await harness.reset();
        await harness.seedMatrix();
        harness.resetStatements();
        const other = await harness.request(renderer, "viewer", `/members/100000000000000001`);
        expect(other.status).toBe(200);
        await other.text();
        const otherStatements = harness.statements();
        harness.resetStatements();
        const self = await harness.request(renderer, "owner");
        expect(self.status).toBe(200);
        await self.text();
        // One new bounded keyed read on the actor's own answers — no more.
        expect(harness.statements() - otherStatements).toBe(1);
      });

      it("GREEN: the history read stays flat past the limit (no N+1)", async () => {
        const counts: number[] = [];
        for (const n of [3, 8]) {
          await harness.reset();
          await harness.seedAttendedOnly(n);
          harness.resetStatements();
          const response = await harness.request(renderer, "owner");
          expect(response.status).toBe(200);
          await response.text();
          counts.push(harness.statements());
        }
        expect(counts[1]).toBe(counts[0]);
      });

      it("GREEN: self-view stays private no-store without shared-cache validators", async () => {
        const response = await selfView(renderer);
        expect(response.status).toBe(200);
        const cache = response.headers.get("cache-control") ?? "";
        expect(cache).toContain("private");
        expect(cache).toContain("no-store");
        expect(response.headers.get("etag")).toBeNull();
        await response.text();
      });

      it("GREEN: own reads stay unaudited, including the new history read", async () => {
        for (const actor of ["owner", "viewer", "empty"] as const) {
          await harness.reset();
          await harness.seedMatrix();
          harness.audit.length = 0;
          const response = await harness.request(renderer, actor);
          expect(response.status).toBe(200);
          await response.text();
          expect(harness.audit, `${actor} self-view writes no audit row`).toEqual([]);
        }
      });

      it("GREEN: no night or count leaks into logs, audit rows or the stats fallback", async () => {
        const warnings: unknown[][] = [];
        const errors: unknown[][] = [];
        const warn = vi.spyOn(console, "warn").mockImplementation((...args) => {
          warnings.push(args);
        });
        const error = vi.spyOn(console, "error").mockImplementation((...args) => {
          errors.push(args);
        });
        try {
          const response = await selfView(renderer);
          expect(response.status).toBe(200);
          await response.text();
        } finally {
          warn.mockRestore();
          error.mockRestore();
        }
        const leaked = [...warnings, ...errors].map((args) => JSON.stringify(args)).join("\n");
        for (const title of Object.values(TITLES)) {
          expect(leaked, `log output must not carry: ${title}`).not.toContain(title);
        }
        expect(leaked).not.toContain("Attended 8 nights");
        expect(JSON.stringify(harness.audit)).not.toContain("Attended");
      });

      it("GREEN: an other-member view carries no history and stays byte-identical", async () => {
        await harness.reset();
        await harness.seedMatrix();
        const response = await harness.request(renderer, "viewer", "/members/100000000000000001");
        expect(response.status).toBe(200);
        const html = await response.text();
        for (const marker of HISTORY_MARKERS) {
          expect(html, `other-member view must not carry ${marker}`).not.toContain(marker);
        }
        for (const title of Object.values(TITLES)) {
          expect(html, `other-member view must not carry ${title}`).not.toContain(title);
        }
        expectByteParity(renderer, html);
      });

      it("GREEN: viewing someone else still audits exactly the profile read", async () => {
        await harness.reset();
        await harness.seedMatrix();
        harness.audit.length = 0;
        const response = await harness.request(renderer, "viewer", "/members/100000000000000001");
        expect(response.status).toBe(200);
        await response.text();
        expect(harness.audit).toHaveLength(1);
        expect(harness.audit[0]).toMatchObject({
          viewerUserId: "100000000000000002",
          subjectUserIds: ["100000000000000001"],
        });
      });

      it("GREEN: a self-view never bleeds into a later other-member render", async () => {
        await harness.reset();
        await harness.seedMatrix();
        const self = await harness.request(renderer, "owner");
        expect(self.status).toBe(200);
        await self.text();
        const other = await harness.request(renderer, "viewer", "/members/100000000000000001");
        expect(other.status).toBe(200);
        expectByteParity(renderer, await other.text());
      });

      it("GREEN: guests bounce to login with no history, no audit and no reads", async () => {
        await harness.reset();
        await harness.seedMatrix();
        harness.resetStatements();
        harness.audit.length = 0;
        const response = await harness.request(renderer, "guest");
        expect(response.status).toBe(302);
        expect(response.headers.get("location") ?? "").toMatch(/^\/auth\/discord/);
        const body = await response.text();
        for (const marker of HISTORY_MARKERS) {
          expect(body).not.toContain(marker);
        }
        expect(harness.audit).toEqual([]);
        expect(harness.statements()).toBe(0);
      });

      it("GREEN: signed-in non-members are refused before any history", async () => {
        await harness.reset();
        await harness.seedMatrix();
        harness.audit.length = 0;
        const response = await harness.request(renderer, "outsider");
        expect(response.status).toBe(403);
        const body = await response.text();
        for (const marker of HISTORY_MARKERS) {
          expect(body).not.toContain(marker);
        }
        expect(harness.audit).toEqual([]);
      });
    });
  }
});
