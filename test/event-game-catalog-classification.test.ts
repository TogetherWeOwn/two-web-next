// The detail page reads the distinct published-game catalog under the
// non-sensitive "events" classification. Only that complete statement may
// carry its computed trim projection; near misses must keep refusing.
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { events } from "../src/db/admin-schema";
import { validateNonSensitiveRead, type SelectedField } from "../src/db/read-classification";
import { MemberReadRefused } from "../src/member-reads";

// Independently specified admission shape; not derived from the classifier.
const CATALOG = `select distinct trim("game") from "events" where ("events"."status" = 'published' and "events"."game" is not null and trim("events"."game") <> '') order by trim("game") limit $1`;
const computed: SelectedField[] = [{ path: ["game"], field: sql`trim(${events.game})` }];

const nearMisses: Array<[string, string]> = [
  ["draft rows included", CATALOG.replace("= 'published'", "<> 'cancelled'")],
  [
    "different projection",
    CATALOG.replace('select distinct trim("game")', 'select distinct "title"'),
  ],
  ["extra projection", CATALOG.replace('trim("game") from', 'trim("game"), "description" from')],
  ["unbounded", CATALOG.replace(" limit $1", "")],
  ["literal limit", CATALOG.replace("limit $1", "limit 100")],
  [
    "member table subquery",
    CATALOG.replace(
      '"events"."game" is not null',
      '"events"."game" is not null and exists (select 1 from "rsvps")',
    ),
  ],
  ["stacked statement", `${CATALOG}; select 1`],
];

describe("published-game catalog read classification", () => {
  it("admits the exact catalog statement under the events classification", () => {
    expect(() => validateNonSensitiveRead("events", CATALOG, computed)).not.toThrow();
  });

  it("does not admit it under any other classification", () => {
    for (const classification of ["featured", "activity-log"] as const) {
      expect(() => validateNonSensitiveRead(classification, CATALOG, computed)).toThrow(
        MemberReadRefused,
      );
    }
  });

  it.each(nearMisses)("keeps refusing: %s", (_label, query) => {
    expect(() => validateNonSensitiveRead("events", query, computed)).toThrow(MemberReadRefused);
  });

  it("refuses the same statement without field metadata", () => {
    expect(() => validateNonSensitiveRead("events", CATALOG)).toThrow(MemberReadRefused);
  });
});
