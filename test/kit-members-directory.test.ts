import { describe, expect, it } from "vitest";
import {
  type DirectoryFixtureMember,
  MEMBER_SEARCH_LIMIT,
  projectMembersDirectory,
} from "../web/src/lib/members-directory";

const counts = { members: 814, attendedThisMonth: 212 };
const weekStartsAt = Date.parse("2030-04-08T00:00:00Z");
const day = 86_400_000;
const snapshotAt = weekStartsAt + 3 * day;

function fixture(
  name: string,
  overrides: Partial<DirectoryFixtureMember> = {},
): DirectoryFixtureMember {
  return {
    name,
    handle: name.toLowerCase(),
    profileHref: `/members/${name.toLowerCase()}`,
    rank: 2,
    games: ["Deep Rock", "Forza", "Valorant"],
    active: true,
    ...overrides,
  };
}

const roster = [
  fixture("SampleSpruce", { role: "Host", lastActivityAt: 1 }),
  fixture("SampleJuniper", { role: "Guide", lastActivityAt: 2, organizerRole: "Guide lead" }),
  fixture("SampleCafé", { handle: "fixture_cafe", active: false, lastActivityAt: 3 }),
  fixture("WithheldFixture", {
    optedOut: true,
    role: "Guide",
    organizerRole: "Moderator",
    lastActivityAt: 4,
  }),
];

function view(query = "", members: readonly DirectoryFixtureMember[] = roster) {
  const projection = projectMembersDirectory(
    { audience: "member", counts, members, weekStartsAt, snapshotAt },
    new URLSearchParams(query),
  );
  if (projection.audience !== "member") throw new Error("Expected member projection");
  return projection;
}

const names = (projection: ReturnType<typeof view>) => projection.rows.map((row) => row.name);

function newcomer(name: string, joinedAt: number, optedOut = false) {
  return fixture(name, {
    optedOut,
    welcome: { joinedAt, day: "Wed", sayHiHref: "https://example.invalid/welcome" },
    organizerRole: "Fixture organiser",
  });
}

describe("route-free Kit members directory projection", () => {
  it("projects only aggregate counts for a guest even with extra fixture values", () => {
    const input = {
      audience: "guest" as const,
      counts: { ...counts, organizer: roster[1] },
      members: roster,
    };
    expect(projectMembersDirectory(input, new URLSearchParams("q=sample&filter=guides"))).toEqual({
      audience: "guest",
      counts,
    });
  });

  it("defaults to active members sorted by recent activity; Everyone includes inactive members", () => {
    const active = view();
    expect(names(active)).toEqual(["SampleJuniper", "SampleSpruce"]);
    expect(active.filterCounts).toEqual({ active: 2, everyone: 3, guides: 1 });
    expect(names(view("filter=everyone"))).toEqual(["SampleCafé", "SampleJuniper", "SampleSpruce"]);
  });

  it("breaks activity ties by name and puts unrecorded activity last", () => {
    const members = [
      fixture("SampleFir", { lastActivityAt: 0 }),
      fixture("SampleAsh"),
      fixture("SampleElm", { lastActivityAt: 0 }),
    ];
    expect(names(view("", members))).toEqual(["SampleElm", "SampleFir", "SampleAsh"]);
  });

  it("finds active and inactive members by name or handle, including an @ prefix", () => {
    expect(names(view("q=sAmPlE"))).toEqual(["SampleCafé", "SampleJuniper", "SampleSpruce"]);
    expect(names(view(`q=${encodeURIComponent("  SAMPLECAFÉ  ")}`))).toEqual(["SampleCafé"]);
    expect(names(view("q=%40FIXTURE_CAFE"))).toEqual(["SampleCafé"]);
    expect(names(view("q=%40"))).toEqual([]);
  });

  it("keeps the Guides filter during search and distinguishes blank search from no matches", () => {
    expect(names(view("filter=guides&q=sample"))).toEqual(["SampleJuniper"]);
    expect(view("filter=guides&q=fixture_cafe")).toMatchObject({ rows: [], resultCount: 0 });
    expect(view("q=+").selection.query).toBe("");
    expect(view("q=missing")).toMatchObject({ selection: { query: "missing" }, rows: [] });
  });

  it("omits opted-out members from rows, search, welcomes and organisers", () => {
    const visible = newcomer("VisibleFixture", snapshotAt);
    const hidden = newcomer("OptedOutFixture", snapshotAt, true);
    const projection = view("filter=everyone", [visible, hidden]);
    expect(names(projection)).toEqual([visible.name]);
    expect(projection.newcomers.map(({ name }) => name)).toEqual([visible.name]);
    expect(projection.organizers.map(({ name }) => name)).toEqual([visible.name]);
    expect(view("q=optedout", [visible, hidden]).resultCount).toBe(0);
    expect(JSON.stringify(projection)).not.toContain(hidden.name);
    expect(projection.rows[0]).toEqual({
      name: visible.name,
      profileHref: visible.profileHref,
      rank: 2,
      games: ["Deep Rock", "Forza"],
    });
  });

  it("bounds the strip to the six latest joins in the fixture's week", () => {
    const members = Array.from({ length: 7 }, (_, i) =>
      newcomer(`NewFixture${i}`, weekStartsAt + i),
    );
    const projection = view("", [
      ...members,
      newcomer("FutureFixture", snapshotAt + 1),
      newcomer("PriorFixture", weekStartsAt - 1),
    ]);
    expect(projection.newcomers.map(({ name }) => name)).toEqual([
      "NewFixture6",
      "NewFixture5",
      "NewFixture4",
      "NewFixture3",
      "NewFixture2",
      "NewFixture1",
    ]);
    expect(view("", members.slice(0, 1)).newcomers).toHaveLength(1);
    expect(projection.organizers).toHaveLength(4);
  });

  it("projects only one page before transfer and normalizes out-of-range selections", () => {
    const members = Array.from({ length: 21 }, (_, i) =>
      fixture(`PagedFixture${i}`, { lastActivityAt: i }),
    );
    const first = view("page=-1&filter=unsupported", members);
    expect(first).toMatchObject({
      selection: { page: 1, filter: "active" },
      resultCount: 21,
      pageCount: 2,
    });
    expect(first.rows).toHaveLength(20);
    expect(first.rows[0]?.name).toBe("PagedFixture20");
    for (const page of ["1.5", "Infinity", "abc", "9007199254740992"]) {
      const invalid = view(`page=${page}`, members);
      expect(invalid.selection.page).toBe(1);
      expect(names(invalid)).toEqual(names(first));
    }
    expect(names(view("page=100000", members))).toEqual(["PagedFixture0"]);
    expect(view("page=2", members.slice(0, 20))).toMatchObject({
      selection: { page: 1 },
      resultCount: 20,
      pageCount: 1,
    });
    expect(view(`q=${"x".repeat(MEMBER_SEARCH_LIMIT + 1)}`).selection.query).toHaveLength(
      MEMBER_SEARCH_LIMIT,
    );
  });
});
