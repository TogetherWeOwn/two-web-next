// route-inventory: GET /events/past
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { listPast } from "../src/events/reads";
import {
  PAST_EVENTS_EMPTY_TESTID,
  PAST_EVENTS_OUT_OF_RANGE_TESTID,
  PAST_EVENTS_PAGE_SIZE,
  PAST_EVENTS_SEARCH_MISS_TESTID,
  PAST_EVENTS_UNREADABLE_TESTID,
  pastEventsUrl,
} from "../src/islands/contracts";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import {
  ARCHIVE_NOW,
  archiveEnv,
  archiveTwins,
  compileArchiveKit,
  eventKeys,
  linksIn,
  requestArchive,
  type ArchiveTwin,
} from "./helpers/past-archive-search-acceptance";

const unreadableEnd = "280000-06-01T20:00:00Z";
const q = "Raid night";
const stateIds = [
  PAST_EVENTS_EMPTY_TESTID,
  PAST_EVENTS_OUT_OF_RANGE_TESTID,
  PAST_EVENTS_SEARCH_MISS_TESTID,
  PAST_EVENTS_UNREADABLE_TESTID,
];

function expectState(html: string, state: string | null) {
  expect(stateIds.filter((id) => html.includes(`data-testid="${id}"`))).toEqual(
    state ? [state] : [],
  );
}

describe.skipIf(!process.env.DATABASE_URL)(
  "unreadable past archive pages (disposable PostgreSQL)",
  () => {
    let fixture: MemberDataFixture;
    let kit: Awaited<ReturnType<typeof compileArchiveKit>>;

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      kit = await compileArchiveKit();
    }, 60_000);
    afterAll(async () => {
      kit?.dispose();
      await fixture?.dispose();
    });
    beforeEach(async () => {
      await fixture.reset();
    });

    async function read(twin: ArchiveTwin, page: number, query = "") {
      // Force the twin's actual renderer rather than a shared warm response.
      __resetAnonEventCacheForTests();
      const response = await requestArchive(
        twin,
        pastEventsUrl(page, query),
        archiveEnv(fixture.db),
        kit,
      );
      expect(response.status).toBe(200);
      return response.text();
    }

    it("distinguishes one counted but unreadable event from empty, miss and out of range", async () => {
      for (const twin of archiveTwins) expectState(await read(twin, 1), PAST_EVENTS_EMPTY_TESTID);
      const [row] = await fixture.client<{ finite: boolean }[]>`
      insert into events (event_key, title, starts_at, ends_at, status)
      values ('unreadable-1', ${q}, '2020-06-01T18:00:00Z', ${unreadableEnd}, 'past')
      returning isfinite(ends_at) as finite
    `;
      expect(row?.finite).toBe(true);
      expect(await listPast(fixture.db, 1, ARCHIVE_NOW, q)).toEqual({
        rows: [],
        hasMore: false,
        totalPages: 1,
      });

      for (const twin of archiveTwins) {
        for (const query of ["", q]) {
          const html = await read(twin, 1, query);
          expectState(html, PAST_EVENTS_UNREADABLE_TESTID);
          expect(eventKeys(html)).toEqual([]);
          expect(html).toContain("We can’t show the events in this part of the archive right now.");
          expect(html).toContain("Page 1 of 1");
          expect(html).not.toContain("Back to page 1");
          expect(linksIn(html).filter((link) => link.pager)).toEqual([]);
        }
        expectState(await read(twin, 1, "No such meeting"), PAST_EVENTS_SEARCH_MISS_TESTID);
        expectState(await read(twin, 2, q), PAST_EVENTS_OUT_OF_RANGE_TESTID);
      }
    });

    it("keeps both search pager links usable when a whole middle page is unreadable", async () => {
      await fixture.client`
      insert into events (event_key, title, starts_at, ends_at, status)
      select 'newer-' || n, ${q}, '2021-06-01T18:00:00Z', '2021-06-01T20:00:00Z', 'past'
      from generate_series(1, ${PAST_EVENTS_PAGE_SIZE}::integer) as n
    `;
      await fixture.client`
      insert into events (event_key, title, starts_at, ends_at, status)
      select 'unreadable-' || n, ${q}, '2020-06-01T18:00:00Z', ${unreadableEnd}, 'past'
      from generate_series(1, ${PAST_EVENTS_PAGE_SIZE}::integer) as n
    `;
      await fixture.client`
      insert into events (event_key, title, starts_at, ends_at, status)
      values ('older', ${q}, '2019-06-01T18:00:00Z', '2019-06-01T20:00:00Z', 'past')
    `;

      for (const twin of archiveTwins) {
        const html = await read(twin, 2, q);
        expectState(html, PAST_EVENTS_UNREADABLE_TESTID);
        expect(eventKeys(html)).toEqual([]);
        expect(html).toContain(
          "We can’t show the events on page 2 of 3 right now. Try Newer or Older.",
        );
        expect(html).toContain("Page 2 of 3");
        expect(
          linksIn(html)
            .filter((link) => link.pager)
            .map(({ label, url }) => [label, url.pathname + url.search]),
        ).toEqual([
          ["Newer", pastEventsUrl(1, q)],
          ["Older", pastEventsUrl(3, q)],
        ]);
        const newer = await read(twin, 1, q);
        const older = await read(twin, 3, q);
        expectState(newer, null);
        expect(eventKeys(newer)).toHaveLength(PAST_EVENTS_PAGE_SIZE);
        expectState(older, null);
        expect(eventKeys(older)).toEqual(["older"]);
      }

      await fixture.client`update events set ends_at = ${unreadableEnd}`;
      for (const twin of archiveTwins) {
        const first = await read(twin, 1, q);
        const last = await read(twin, 3, q);
        expectState(first, PAST_EVENTS_UNREADABLE_TESTID);
        expectState(last, PAST_EVENTS_UNREADABLE_TESTID);
        expect(first).toContain("We can’t show the events on page 1 of 3 right now. Try Older.");
        expect(last).toContain("We can’t show the events on page 3 of 3 right now. Try Newer.");
      }
    });
  },
);
