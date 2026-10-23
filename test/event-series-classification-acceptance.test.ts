// The public-series exception must admit the bounded reader, not computed event
// projections in general. All SQL construction, classification and Hono response
// observation are real; only the final database transport returns local rows.
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AccessEntry } from "../src/access-log";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { memberReadDb } from "../src/db/member-reads";
import { validateNonSensitiveRead, type SelectedField } from "../src/db/read-classification";
import { getEventSeriesContext, type SeriesEventRef } from "../src/events/reads";
import {
  bufferedMemberJson,
  MemberReadRefused,
  memberReadBoundary,
  nonSensitiveRead,
  type NonSensitiveRead,
} from "../src/member-reads";

// Independently specified admission shape. Do not import the classifier's
// allowlist or derive this expectation from the reader's generated statement.
const SERIES_SELECT = `select "id", case when ( octet_length("events"."event_key") + octet_length("events"."title") + octet_length("events"."timezone") + coalesce(octet_length("events"."location"), 0) + coalesce(octet_length("events"."organizer_name"), 0) ) <= $1 then "event_key" end, case when ( octet_length("events"."event_key") + octet_length("events"."title") + octet_length("events"."timezone") + coalesce(octet_length("events"."location"), 0) + coalesce(octet_length("events"."organizer_name"), 0) ) <= $2 then "title" end, "starts_at", case when ( octet_length("events"."event_key") + octet_length("events"."title") + octet_length("events"."timezone") + coalesce(octet_length("events"."location"), 0) + coalesce(octet_length("events"."organizer_name"), 0) ) <= $3 then "timezone" end, case when ( octet_length("events"."event_key") + octet_length("events"."title") + octet_length("events"."timezone") + coalesce(octet_length("events"."location"), 0) + coalesce(octet_length("events"."organizer_name"), 0) ) <= $4 then "location" end, case when ( octet_length("events"."event_key") + octet_length("events"."title") + octet_length("events"."timezone") + coalesce(octet_length("events"."location"), 0) + coalesce(octet_length("events"."organizer_name"), 0) ) <= $5 then "organizer_name" end, "recurrence_index", ( octet_length("event_key") + octet_length("title") + octet_length("timezone") + coalesce(octet_length("location"), 0) + coalesce(octet_length("organizer_name"), 0) ) <= $6 from "events" where ("events"."status" in ($7, $8) and isfinite("events"."starts_at") and ("events"."id" = $9 or "events"."parent_event_id" = $10)) order by "events"."recurrence_index" asc, "events"."id" asc limit $11`;
const WHERE =
  ' where ("events"."status" in ($7, $8) and isfinite("events"."starts_at") and ("events"."id" = $9 or "events"."parent_event_id" = $10))';
const ORDER = ' order by "events"."recurrence_index" asc, "events"."id" asc';
const computedFields: SelectedField[] = [
  { path: ["id"], field: events.id },
  { path: ["title"], field: sql`case when true then ${events.title} end` },
];

// Each variant keeps computed-field metadata, so it cannot pass through the
// normal event-column path. A broad computed-events allowance must fail here.
const nearMisses: Array<[string, string]> = [
  [
    "different public projection",
    SERIES_SELECT.replace('then "title" end', 'then "description" end'),
  ],
  [
    "unbounded title projection",
    SERIES_SELECT.replace(/case when (?:(?! end).)*then "title" end/, '"title"'),
  ],
  ["character count instead of byte count", SERIES_SELECT.replaceAll("octet_length", "length")],
  [
    "different text operation",
    SERIES_SELECT.replace(
      'octet_length("events"."title")',
      'octet_length(lower("events"."title"))',
    ),
  ],
  [
    "missing organizer byte term",
    SERIES_SELECT.replace(' + coalesce(octet_length("events"."organizer_name"), 0)', ""),
  ],
  [
    "different null arithmetic",
    SERIES_SELECT.replace(
      'coalesce(octet_length("events"."location"), 0)',
      'coalesce(octet_length("events"."location"), 1)',
    ),
  ],
  ["different byte comparison", SERIES_SELECT.replace("<= $1", "< $1")],
  ["literal byte bound", SERIES_SELECT.replace("<= $1 ", "<= 4096 ")],
  ["different byte-bound parameter", SERIES_SELECT.replace("<= $1 ", "<= $12 ")],
  [
    "changed overflow marker",
    SERIES_SELECT.replace(') <= $6 from "events"', ') > $6 from "events"'),
  ],
  ...["event_key", "title", "timezone", "location", "organizer_name"].map(
    (column): [string, string] => [
      `ELSE expression for ${column}`,
      SERIES_SELECT.replace(`then "${column}" end`, `then "${column}" else "${column}" end`),
    ],
  ),
  ["extra event field", SERIES_SELECT.replace(' from "events"', ', "description" from "events"')],
  ["extra computed field", SERIES_SELECT.replace(' from "events"', ', current_user from "events"')],
  [
    "member identity subquery",
    SERIES_SELECT.replace(
      ' from "events"',
      ', (select "username" from "users" limit 1) from "events"',
    ),
  ],
  ["users join", SERIES_SELECT.replace(WHERE, ' inner join "users" on true' + WHERE)],
  ["profiles join", SERIES_SELECT.replace(WHERE, ' inner join "profiles" on true' + WHERE)],
  [
    "new public relation",
    SERIES_SELECT.replace(WHERE, ' inner join "featured_contents" on true' + WHERE),
  ],
  [
    "new event alias relation",
    SERIES_SELECT.replace(WHERE, ' inner join "events" as "other" on true' + WHERE),
  ],
  [
    "new public subquery",
    SERIES_SELECT.replace(WHERE, WHERE + ' and exists (select 1 from "events")'),
  ],
  [
    "new member subquery",
    SERIES_SELECT.replace(WHERE, WHERE + ' and exists (select 1 from "rsvps")'),
  ],
  [
    "different source relation",
    SERIES_SELECT.replace(' from "events"', ' from "featured_contents"'),
  ],
  ["trailing statement", SERIES_SELECT + '; select "username" from "users"'],
  ["trailing delimiter", SERIES_SELECT + ";"],
  ["missing where clause", SERIES_SELECT.replace(WHERE, "")],
  ["missing status gate", SERIES_SELECT.replace('"events"."status" in ($7, $8) and ', "")],
  ["changed status parameter", SERIES_SELECT.replace("in ($7, $8)", "in ($7, $12)")],
  ["missing finite predicate", SERIES_SELECT.replace('isfinite("events"."starts_at") and ', "")],
  [
    "changed finite predicate",
    SERIES_SELECT.replace('isfinite("events"."starts_at")', 'isfinite("events"."ends_at")'),
  ],
  [
    "missing root scope",
    SERIES_SELECT.replace(' and ("events"."id" = $9 or "events"."parent_event_id" = $10)', ""),
  ],
  ["missing root arm", SERIES_SELECT.replace('"events"."id" = $9 or ', "")],
  ["missing child arm", SERIES_SELECT.replace(' or "events"."parent_event_id" = $10', "")],
  [
    "changed root parameter",
    SERIES_SELECT.replace('"events"."parent_event_id" = $10', '"events"."parent_event_id" = $12'),
  ],
  ["unrestricted scope", SERIES_SELECT.replace(WHERE, WHERE + " or true")],
  ["missing order", SERIES_SELECT.replace(ORDER, "")],
  ["missing tie breaker", SERIES_SELECT.replace(', "events"."id" asc limit', " limit")],
  [
    "changed order direction",
    SERIES_SELECT.replace('"events"."recurrence_index" asc', '"events"."recurrence_index" desc'),
  ],
  ["missing limit", SERIES_SELECT.replace(" limit $11", "")],
  ["literal limit", SERIES_SELECT.replace("limit $11", "limit 53")],
  ["different limit parameter", SERIES_SELECT.replace("limit $11", "limit $12")],
  ["computed limit", SERIES_SELECT.replace("limit $11", "limit ($11 + 1)")],
  ["new offset", SERIES_SELECT + " offset 0"],
  ["arbitrary event expression", 'select "id", lower("title") from "events" limit $1'],
];

const previous = {
  id: 71,
  eventKey: "01J00000000000000000000071",
  title: "Earlier night",
  startsAt: new Date("2099-11-01T20:00:00Z"),
  timezone: "UTC",
  location: null,
};
const current = {
  id: 72,
  eventKey: "01J00000000000000000000072",
  title: "Current night",
  startsAt: new Date("2099-11-08T20:00:00Z"),
  timezone: "UTC",
  location: "Voice lounge",
};
const following = {
  id: 73,
  eventKey: "01J00000000000000000000073",
  title: "Following night",
  startsAt: new Date("2099-11-15T20:00:00Z"),
  timezone: "UTC",
  location: null,
};
const seriesRows = [
  { ...previous, recurrenceIndex: 0, organizer_name: "First host", textFits: true },
  { ...current, recurrenceIndex: 1, organizer_name: "Current host", textFits: true },
  { ...following, recurrenceIndex: 2, organizer_name: "Next host", textFits: true },
];

function observedFixture() {
  const raw = drizzle.mock();
  const prepared: Array<{ sql: string; params: unknown[]; fields?: SelectedField[] }> = [];
  let executions = 0;
  const internals = raw as unknown as {
    session: {
      prepareQuery: (
        query: { sql: string; params: unknown[] },
        fields?: SelectedField[],
      ) => unknown;
    };
  };
  internals.session.prepareQuery = (query, fields) => {
    prepared.push({ ...query, fields });
    return {
      setToken() {
        return this;
      },
      execute: async () => {
        executions++;
        return seriesRows;
      },
    };
  };
  return { db: memberReadDb(raw as unknown as Db), prepared, executions: () => executions };
}

function boundary(viewer: string | null) {
  const app = new Hono();
  const audit: AccessEntry[] = [];
  app.use("*", (c, next) =>
    memberReadBoundary(
      c,
      { viewer, resource: "event", action: "view", route: "events.show" },
      async (entry) => {
        audit.push(entry);
        return true;
      },
      next,
    ),
  );
  return { app, audit };
}

describe("exact public series SELECT classification", () => {
  it("admits the complete bound statement with computed fields", () => {
    expect(() => validateNonSensitiveRead("events", SERIES_SELECT, computedFields)).not.toThrow();
  });

  it("normalizes whitespace without widening the statement", () => {
    const spaced = ` \n${SERIES_SELECT.replaceAll(" ", " \n\t ")}\n `;
    expect(() => validateNonSensitiveRead("events", spaced, computedFields)).not.toThrow();
  });

  it.each([
    "featured",
    "activity-log",
    "join-funnel",
    "going-counts",
    "roster-count",
    "search-widget",
    "timeouts",
    "members",
    "Events",
    "",
  ])("does not lend the exception to classification %j", (classification) => {
    expect(() =>
      validateNonSensitiveRead(classification as NonSensitiveRead, SERIES_SELECT, computedFields),
    ).toThrow(MemberReadRefused);
  });

  it.each<{ label: string; fields: SelectedField[] | undefined }>([
    { label: "missing", fields: undefined },
    { label: "empty", fields: [] },
  ])("refuses the exact statement with $label field metadata", ({ fields }) => {
    expect(() => validateNonSensitiveRead("events", SERIES_SELECT, fields)).toThrow(
      MemberReadRefused,
    );
  });

  it.each(nearMisses)("refuses %s", (_name, statement) => {
    // A stale replacement must not silently test the allowed statement.
    expect(statement).not.toBe(SERIES_SELECT);
    expect(() => validateNonSensitiveRead("events", statement, computedFields)).toThrow(
      MemberReadRefused,
    );
  });

  it("preserves normal event column-only reads", () => {
    expect(() =>
      validateNonSensitiveRead(
        "events",
        'select "id", "title" from "events" where "events"."status" = $1',
        [
          { path: ["id"], field: events.id },
          { path: ["title"], field: events.title },
        ],
      ),
    ).not.toThrow();
  });
});

describe("generated series read inside the Hono member boundary", () => {
  it.each([null, "100000000000000102"])(
    "releases the actual bounded series context audit-silently for viewer %j",
    async (viewer) => {
      const fixture = observedFixture();
      const { app, audit } = boundary(viewer);
      const event: SeriesEventRef = {
        id: 72,
        parentEventId: 71,
        recurrenceIndex: 1,
        recurrenceFrequency: null,
        organizer_name: "Current host",
      };
      app.get("/events/series", async (c) =>
        bufferedMemberJson(c, await getEventSeriesContext(fixture.db, event)),
      );
      const response = await app.request("/events/series");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({
        hosts: ["Current host", "First host", "Next host"],
        previous: { ...previous, startsAt: "2099-11-01T20:00:00.000Z" },
        next: { ...following, startsAt: "2099-11-15T20:00:00.000Z" },
      });
      expect(fixture.executions()).toBe(1);
      expect(fixture.prepared).toHaveLength(1);
      expect(fixture.prepared[0]!.sql.trim().replace(/\s+/g, " ")).toBe(SERIES_SELECT);
      expect(fixture.prepared[0]!.params).toEqual([
        4096,
        4096,
        4096,
        4096,
        4096,
        4096,
        "published",
        "past",
        71,
        71,
        53,
      ]);
      expect(fixture.prepared[0]!.fields).toHaveLength(9);
      expect(audit).toEqual([]);
    },
  );

  it("keeps ordinary column-only event queries working under observation", async () => {
    const fixture = observedFixture();
    const { app, audit } = boundary(null);
    app.get("/events/columns", async (c) => {
      const rows = await nonSensitiveRead("events", () =>
        fixture.db
          .select({ id: events.id, title: events.title })
          .from(events)
          .where(eq(events.id, 72)),
      );
      return bufferedMemberJson(
        c,
        rows.map(({ id, title }) => ({ id, title })),
      );
    });
    const response = await app.request("/events/columns");
    expect(response.status).toBe(200);
    expect(await response.json()).toContainEqual({ id: 72, title: "Current night" });
    expect(fixture.executions()).toBe(1);
    expect(audit).toEqual([]);
  });

  it.each(["computed", "foreign-subquery"])(
    "refuses a generated %s projection before transport even when caught",
    async (variant) => {
      const fixture = observedFixture();
      const { app, audit } = boundary(null);
      let refusal: unknown;
      app.get("/events/unreviewed", async (c) => {
        try {
          await nonSensitiveRead("events", () =>
            fixture.db
              .select({
                id: events.id,
                extra:
                  variant === "computed"
                    ? sql`lower(${events.title})`
                    : sql`(select "username" from "users" limit 1)`,
              })
              .from(events),
          );
        } catch (error) {
          refusal = error;
        }
        return bufferedMemberJson(c, { marker: "must-not-release" });
      });
      const response = await app.request("/events/unreviewed");
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).not.toContain("must-not-release");
      expect(refusal).toBeInstanceOf(MemberReadRefused);
      expect(fixture.executions()).toBe(0);
      expect(audit).toEqual([]);
    },
  );
});
