import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EVENT_PAGE_SIZE, eventListUrl, parseEventListQuery } from "../src/admin/event-list";
import { listEvents } from "../src/admin/store";
import { events } from "../src/db/admin-schema";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const startsAt = new Date("2026-11-01T20:00:00Z");
const endsAt = new Date("2026-11-01T22:00:00Z");
const event = (eventKey: string, title: string) => ({ eventKey, title, startsAt, endsAt });

const titles = [
  "Raid 100%",
  "Raid 100X",
  "Raid_A",
  "RaidXA",
  "Raid\\path",
  "Raidpath",
  "Raid\\%_",
  "Raid%X",
  "Ordinary games night",
  "Games  night",
  "Raid's night",
];

describe("admin event search normalization", () => {
  it.each([
    [undefined, ""],
    ["", ""],
    [" \t\n ", ""],
    ["\u0000 \u0000", ""],
    [" \u0000Raid\u0000 100%\u0000 ", "Raid 100%"],
    ["  Games  night  ", "Games  night"],
    [" \\%_ ", "\\%_"],
  ])("normalizes %j without changing literal text", (q, expected) => {
    expect(parseEventListQuery({ q }).q).toBe(expected);
  });

  it("keeps literal query text (not SQL escaping) in navigation URLs", () => {
    const query = parseEventListQuery({ q: " \u0000Raid\\%_ ", page: "2" });
    const url = new URL(eventListUrl(query, { page: 3 }), "https://next.example.test");
    expect(url.searchParams.get("q")).toBe("Raid\\%_");
    expect(url.searchParams.get("page")).toBe("3");
    expect(parseEventListQuery(Object.fromEntries(url.searchParams)).q).toBe(query.q);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("admin literal search (owned PostgreSQL schema)", () => {
  let fixture: MemberDataFixture;
  const list = async (params: Parameters<typeof listEvents>[1]) =>
    (await listEvents(fixture.db, params)).map((row) => row.eventKey);

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });
  afterAll(() => fixture?.dispose());
  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.insert(events).values(titles.map((title, i) => event(`literal-${i}`, title)));
  });

  it.each([
    ["%", [0, 6, 7]],
    ["_", [2, 6]],
    ["\\", [4, 6]],
    ["100%", [0]],
    ["Raid_A", [2]],
    ["Raid\\path", [4]],
    ["\\%_", [6]],
    ["  gAmEs NiGhT  ", [8]],
    ["Games  night", [9]],
    ["Raid's", [10]],
    [" \u0000Raid\u0000 100%\u0000 ", [0]],
    ["missing", []],
  ])("matches %j as a case-insensitive literal substring", async (q, indices) => {
    expect(await list({ q, sort: "starts_at", order: "asc" })).toEqual(
      indices.map((i) => `literal-${i}`),
    );
  });

  it.each([undefined, "", " \t\n ", "\u0000 \u0000"])("treats %j as no search", async (q) => {
    expect(await list({ q, sort: "starts_at", order: "asc" })).toEqual(
      titles.map((_, i) => `literal-${i}`),
    );
  });

  it.each(["title", "starts_at", "status"])(
    "preserves totals, lookahead and id ties across %s pages",
    async (sort) => {
      const inserted = await fixture.db
        .insert(events)
        .values(
          Array.from({ length: EVENT_PAGE_SIZE + 2 }, (_, i) =>
            event(`literal-page-${i}`, "Page%_\\ fixture"),
          ),
        )
        .returning();
      await fixture.db
        .insert(events)
        .values([
          event("page-wildcard-decoy", "PageXX fixture"),
          event("page-escape-decoy", "Page%_ fixture"),
        ]);
      const expected = inserted.map((row) => row.eventKey);
      for (const order of ["asc", "desc"] as const) {
        const query = { q: "Page%_\\", sort, order };
        const first = await list(query);
        const second = await list({ ...query, page: "2" });
        expect(first).toEqual(expected.slice(0, EVENT_PAGE_SIZE + 1));
        expect(second).toEqual(expected.slice(EVENT_PAGE_SIZE));
        const visible = [...first.slice(0, EVENT_PAGE_SIZE), ...second];
        expect(visible).toEqual(expected);
        expect(new Set(visible).size).toBe(EVENT_PAGE_SIZE + 2);
        expect(await list({ ...query, page: "3" })).toEqual([]);
      }
    },
  );

  it("combines literal search with the existing filters", async () => {
    await fixture.db.insert(events).values([
      {
        ...event("filtered-match", "Filtered%_\\ fixture"),
        status: "published",
        capacity: 2,
        rsvpOpen: false,
      },
      {
        ...event("filtered-draft", "Filtered%_\\ fixture"),
        status: "draft",
        capacity: 2,
        rsvpOpen: false,
      },
      {
        ...event("filtered-wildcard", "FilteredXY fixture"),
        status: "published",
        capacity: 2,
        rsvpOpen: false,
      },
      {
        ...event("filtered-open", "Filtered%_\\ fixture"),
        status: "published",
        capacity: 2,
        rsvpOpen: true,
      },
    ]);
    expect(
      await list({
        q: "Filtered%_\\",
        status: "published",
        series: "standalone",
        fill: "has_seats",
        rsvp_open: "0",
      }),
    ).toEqual(["filtered-match"]);
  });
});
