// TOG-12440: `listUpcoming` ordered by `startsAt` only, so tied events fell
// back to physical row order. It now orders by `(startsAt, id)` like
// `listHomeUpcoming` already does. Equal-start seed asserts stable id order
// with projection, visibility and (uncapped) shape unchanged.
// Isolated test DB only.
import { describe, expect, it } from "vitest";
import { listUpcoming } from "../src/events/reads";
import { createMemberDataFixture, testDatabaseUrl } from "./helpers/member-data-db";

const raw = process.env.DATABASE_URL;
const url = raw ? testDatabaseUrl(raw).href : undefined;

const TIED_STARTS = "2070-01-01T18:00:00Z";
const TIED_ENDS = "2070-01-01T20:00:00Z";
const NOW = new Date("2060-06-01T00:00:00Z");

describe.skipIf(!url)("listUpcoming orders equal starts by id (isolated test DB)", () => {
  it("returns tied events in ascending id order, projection/visibility/cap unchanged", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      // Tied rows carry explicit ids inserted in DESCENDING physical order, so
      // neither heap order nor any single-column (starts_at) index can fake the
      // (startsAt, id) tiebreak: ascending id means A before B before C.
      await client`insert into events (id, event_key, title, starts_at, ends_at, status)
        values
          (9003, '01J0000000000000000000T0C', 'Tied C', ${TIED_STARTS}, ${TIED_ENDS}, 'published'),
          (9002, '01J0000000000000000000T0B', 'Tied B', ${TIED_STARTS}, ${TIED_ENDS}, 'published'),
          (9001, '01J0000000000000000000T0A', 'Tied A', ${TIED_STARTS}, ${TIED_ENDS}, 'published'),
          (9100, '01J0000000000000000000T0E', 'Earlier', '2069-01-01T18:00:00Z', '2069-01-01T20:00:00Z', 'published'),
          (9101, '01J0000000000000000000T0L', 'Later', '2071-01-01T18:00:00Z', '2071-01-01T20:00:00Z', 'published'),
          (9102, '01J0000000000000000000T0D', 'Draft tied', ${TIED_STARTS}, ${TIED_ENDS}, 'draft'),
          (9103, '01J0000000000000000000T0X', 'Cancelled tied', ${TIED_STARTS}, ${TIED_ENDS}, 'cancelled')`;
      await client`insert into rsvps (event_id, user_id, status)
        values (9002, '424242424242424242', 'going')`;

      const rows = await listUpcoming(db, NOW);
      // Primary order by startsAt, ties by ascending id; drafts stay
      // invisible while cancelled rows stay listed; no cap is applied.
      expect(rows.map((row) => row.eventKey)).toEqual([
        "01J0000000000000000000T0E",
        "01J0000000000000000000T0A",
        "01J0000000000000000000T0B",
        "01J0000000000000000000T0C",
        "01J0000000000000000000T0X",
        "01J0000000000000000000T0L",
      ]);
      const tiedStarts = new Date(TIED_STARTS).getTime();
      const tied = rows.filter((row) => row.startsAt.getTime() === tiedStarts);
      expect(tied.map((row) => row.id)).toEqual([9001, 9002, 9003, 9103]);
      // goingCount projection still rides along on the tied rows.
      expect(rows.find((row) => row.eventKey === "01J0000000000000000000T0B")?.goingCount).toBe(1);
      expect(rows.find((row) => row.eventKey === "01J0000000000000000000T0A")?.goingCount).toBe(0);

      const withDrafts = await listUpcoming(db, NOW, { includeDrafts: true });
      expect(withDrafts.map((row) => row.eventKey)).toContain("01J0000000000000000000T0D");
    } finally {
      await fixture.dispose();
    }
  });
});
