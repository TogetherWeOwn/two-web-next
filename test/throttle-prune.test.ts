// TOG-19533: prove the 5-minute throttle-hit prune deletes expired rows while
// a fresh row survives, on both prune paths (the join allow-path DELETE and
// the RSVP pre-charge pruneThrottle). Every older throttle double stubbed the
// DELETE away, so nothing proved an expired row is actually removed.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newEventKey } from "../src/admin/validation";
import { events } from "../src/db/admin-schema";
import { writeRsvp } from "../src/events/rsvp";
import { checkJoinThrottle } from "../src/join/service";
import type { Sql } from "../src/sessions";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

describe("throttle-prune test containment", () => {
  it("refuses staging/production URLs before a driver can connect", () => {
    for (const host of ["production.example.test", "staging.example.test"]) {
      expect(() => testDatabaseUrl(`postgres://agent_test@${host}/two_web_next`, {})).toThrow(
        "refusing before connecting",
      );
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("throttle-hit prune (agent-testdb)", () => {
  let fixture: MemberDataFixture;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 4 });
  });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.client`delete from web_throttle_hits`;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  const buckets = async () =>
    (await fixture.client<{ bucket: string }[]>`select bucket from web_throttle_hits`).map(
      (r) => r.bucket,
    );

  const seedPair = async (expiredBucket: string, freshBucket: string) => {
    await fixture.client`insert into web_throttle_hits (bucket, at)
      values (${expiredBucket}, now() - interval '10 minutes')`;
    await fixture.client`insert into web_throttle_hits (bucket, at)
      values (${freshBucket}, now())`;
  };

  it("join checkJoinThrottle deletes the expired row and keeps the fresh row", async () => {
    await seedPair("throttle-prune-expired-join", "throttle-prune-fresh-join");
    const verdict = await checkJoinThrottle(
      fixture.client as unknown as Sql,
      "throttle-prune-probe-join",
      10,
    );
    expect(verdict).toEqual({ limited: false });
    const seen = await buckets();
    expect(seen).not.toContain("throttle-prune-expired-join");
    expect(seen).toContain("throttle-prune-fresh-join");
    expect(seen).toContain("throttle-prune-probe-join");
  });

  it("RSVP charge deletes the expired row and keeps the fresh row", async () => {
    const [row] = await fixture.db
      .insert(events)
      .values({
        eventKey: newEventKey(),
        title: "Prune night",
        startsAt: new Date("2099-01-01T20:00:00Z"),
        endsAt: new Date("2099-01-01T22:00:00Z"),
        status: "published",
      })
      .returning();
    await seedPair("throttle-prune-expired-rsvp", "throttle-prune-fresh-rsvp");
    const written = await writeRsvp(fixture.db, row!.eventKey, "prune-member", "maybe");
    expect(written.ok).toBe(true);
    const seen = await buckets();
    expect(seen).not.toContain("throttle-prune-expired-rsvp");
    expect(seen).toContain("throttle-prune-fresh-rsvp");
    expect(seen).toContain("rsvp-write:prune-member");
  });
});
