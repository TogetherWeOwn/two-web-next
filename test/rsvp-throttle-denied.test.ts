// route-inventory: PUT /events/:key/rsvp
// TOG-20410 R2: pin the per-member RSVP write budget (12/min, shared by PUT
// and DELETE) with a hermetic kill.
//
// `chargeThrottle` in src/events/rsvp.ts refuses the 13th write in the window
// with `limited`. A mutant that weakens that check (e.g. `&& false`) lets the
// over-budget write through, so this test — count already at the budget —
// fails against the mutant and kills it.
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

describe("RSVP throttle budget (TOG-20410 R2)", () => {
  it("a member at the 12/min budget is refused with limited", async () => {
    const { db, inserted } = fakeRsvpDb({
      event: EVENT,
      existing: null,
      throttleCount: { n: 12, wait: 30 },
      finalRow: () => ({}),
    });

    const r = await writeRsvp(db, "some-key", "member-1", "going");

    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "limited") {
      expect(r.retryAfter).toBeGreaterThan(0);
    } else {
      throw new Error(`expected a limited refusal, got ${JSON.stringify(r)}`);
    }
    expect(inserted).toHaveLength(0);
  });
});
