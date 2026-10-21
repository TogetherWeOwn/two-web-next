// Regression (Builder-owned): staggered neighbor subqueries must not 503 the page.
//
// getEventNeighbors fans out to two permitted reads. Promise.all rejects on the
// first failure without awaiting the sibling, so a fast previous-rejection with
// a still-running next query resolved the route-level settle early while the
// orphaned subquery still counted as pending — and the member-read boundary
// refuses while pending !== 0 (src/member-reads.ts). The fix settles both
// sub-reads inside getEventNeighbors before it settles, so the route-level
// belt (src/events/routes-detail.tsx, src/events/kit-detail.ts) degrades to
// empty neighbors only after the capture drains. Hermetic: a fake Db with
// staggered limit() timing plus the real memberReadResponse boundary.
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/index";
import { memberQueryPermit, memberReadResponse } from "../src/member-reads";
import { getEventNeighbors } from "../src/events/reads";

// Fake Db: chainable builders; limit() consumes the read permit exactly like
// the observed adapter (one statement per permitted read), then settles with
// staggered timing: previous rejects immediately, next resolves after a delay
// while still holding the capture pending.
function staggeredDb(delayMs = 50): Db {
  let limits = 0;
  const chainable = {
    from() {
      return chainable;
    },
    where() {
      return chainable;
    },
    orderBy() {
      return chainable;
    },
    limit() {
      limits += 1;
      // Consume the permit inside the read, as PgSession.execute does; the
      // anchor select never reaches limit(), so the two neighbor reads are
      // calls one and two in Promise order (previous, then next).
      memberQueryPermit();
      if (limits === 1) return Promise.reject(new Error("previous down"));
      return new Promise<never[]>((resolve) => setTimeout(() => resolve([]), delayMs));
    },
  };
  return {
    select() {
      return chainable;
    },
  } as unknown as Db;
}

describe("event neighbors staggered settle", () => {
  it("fast previous-rejection plus delayed next still releases 200 with empty neighbors", async () => {
    const db = staggeredDb();
    const response = await memberReadResponse(
      { method: "GET", route: "/e/key" },
      { viewer: null, resource: "events", action: "view", route: "/e/key" },
      async () => true,
      async () => {
        // Exact settle shape both twins use at their call sites: a throwing
        // neighbors read degrades to the lone-event shape instead of refusing.
        const neighbors = await getEventNeighbors(db, { id: 7 }).then(
          (settled) => settled,
          () => ({ previous: null, next: null }),
        );
        const degraded = neighbors.previous === null && neighbors.next === null;
        return new Response(degraded ? "degraded" : "full", { status: 200 });
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("degraded");
  });
});
