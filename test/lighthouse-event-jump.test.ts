// Grid day-jump reads against the Lighthouse fixture database. Pins the rank
// statements the fixture's closed SQL list carries: an unhandled statement
// throws instead of answering. The worker fetch gate 404s every URL carrying
// a query string, so the jump itself is proven at the route level against
// real Postgres in test/calendar-upcoming-paging.test.ts; this file proves
// the fixture answers the same statements.
import { describe, expect, it } from "vitest";
import { fixtureEnvForRequest } from "../ci/lighthouse-worker";
import { fixtureKey } from "../ci/lighthouse-paths";
import type { Db } from "../src/db/index";
import { rankUpcoming } from "../src/events/reads";

describe("lighthouse event jump", () => {
  it("ranks the fixture card first with no predecessors", async () => {
    const env = fixtureEnvForRequest(Date.now());
    await expect(rankUpcoming(env.ADMIN_DB as Db, fixtureKey, new Date())).resolves.toBe(0);
  });
});
