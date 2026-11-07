import { expect, it } from "vitest";
import { rawMemberOwner, validateNonSensitiveRead } from "../src/db/read-classification";
import { MemberReadRefused } from "../src/member-reads";

// Offline refusal pins remain runnable without DATABASE_URL. PostgreSQL proofs
// are registered by admin.test.ts under its pre-existing integration gate.
it("WQ-P03 new ranking cannot turn arbitrary roster SQL/member projections into exempt reads", async () => {
  const hostile = [
    'select "user_id", count(*) from "rsvps" group by "user_id"',
    'select count(*) from "rsvps"',
    'select count(*) from "rsvps" inner join "events" on "events"."id" = "rsvps"."event_id" where "events"."event_key" = $1 or true',
    'select "id", "username" from "users"',
    "select user_id, position from (select user_id, row_number() over (order by updated_at) as position from rsvps) line",
  ];
  for (const query of hostile) {
    expect(() => validateNonSensitiveRead("roster-count", query)).toThrow(MemberReadRefused);
    expect(rawMemberOwner(query)).toBeUndefined();
  }
});
