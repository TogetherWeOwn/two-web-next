// route-inventory: PUT /events/:key/rsvp
// TOG-20410 R3: pin waitlist-first admission for new going answers with a
// hermetic kill.
//
// Every new seat request joins the waitlist line before allocation
// (`settledStatus` in src/events/rsvp.ts); `promoteWaitlist` settles heads
// only when a seat is free. A mutant that skips the line (new going answers
// written as going directly) bypasses FIFO, so this test — asserting the
// inserted row is waitlisted — fails against the mutant and kills it.
//
// Hermetic and DB-free: drives `writeRsvp` directly with the ordered-script
// fake Db in test/helpers/fake-rsvp-db.ts. No DATABASE_URL, no Discord, no
// secrets. Matches the sessions-join nightly contract exactly.

import { describe, expect, it } from "vitest";
import { writeRsvp } from "../src/events/rsvp";
import { fakeRsvpDb } from "./helpers/fake-rsvp-db";

const EVENT = {
  id: 7,
  eventKey: "some-key",
  status: "published",
  rsvpOpen: true,
  endsAt: new Date(Date.now() + 3_600_000),
  capacity: null,
};

describe("RSVP waitlist admission (TOG-20410 R3)", () => {
  it("a new going answer is written to the waitlist line first", async () => {
    const handle = fakeRsvpDb({
      event: EVENT,
      existing: null,
      throttleCount: { n: 0, wait: 1 },
      finalRow: () => ({
        status: handle.inserted[0]?.status ?? "MISSING",
        syncedToDiscordAt: null,
      }),
    });

    const r = await writeRsvp(handle.db, "some-key", "member-1", "going");

    expect(r.ok).toBe(true);
    expect(handle.inserted).toHaveLength(1);
    expect(handle.inserted[0]?.status).toBe("waitlisted");
    if (r.ok) {
      expect(r.answer.status).toBe("waitlisted");
    }
  });
});
