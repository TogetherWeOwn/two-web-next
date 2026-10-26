// route-inventory: GET /profile
// route-inventory: GET /members/:user
// Independent test-only handoff. No implementation-specific link prop is assumed.
// RED catches inert known games/missing public catalog admission. CONTROL cases
// preserve plain unknowns, Shared markers, private member reads and refusal gates.
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbFor } from "../src/admin/db";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { listPublishedGames } from "../src/events/reads";
import { declareMemberResult, memberReadResponse, nonSensitiveRead } from "../src/member-reads";
import {
  profileGameItems,
  profileScheduleFixture,
  SCHEDULE_PROFILE_OWNER,
} from "./helpers/profile-schedule-links";
import { scheduleGameCases } from "./helpers/profile-schedule-links-cases";

const outbound: unknown[] = [];
beforeEach(() => {
  outbound.length = 0;
  vi.stubGlobal("fetch", (input: unknown) => {
    outbound.push(input);
    return Promise.reject(new Error("External profile lookups are forbidden in this fixture"));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(outbound, "profile enhancement must not fetch Steam or another identity source").toEqual(
    [],
  );
});

describe("catalog admission at the real profile member-read boundary", () => {
  async function boundary(mode: "classified" | "naked" | "member projection") {
    const statements: string[] = [];
    const raw = drizzle(async (statement) => {
      statements.push(statement);
      return { rows: [["Deep Rock Galactic"]] };
    }) as unknown as Db;
    const response = await memberReadResponse(
      { method: "GET", route: "/profile" },
      {
        resource: "profile",
        action: "view",
        route: "profiles.show",
        viewer: SCHEDULE_PROFILE_OWNER,
      },
      async () => true,
      async () => {
        declareMemberResult([SCHEDULE_PROFILE_OWNER]);
        const db = (await dbFor({ env: { ADMIN_DB: raw } as unknown as Env }))!;
        const names =
          mode === "naked"
            ? await listPublishedGames(db)
            : await nonSensitiveRead<unknown>("events", () =>
                mode === "member projection"
                  ? db
                      .select({ game: sql<string>`(select bio from profiles limit 1)` })
                      .from(events)
                  : listPublishedGames(db),
              );
        return Response.json(names);
      },
    );
    return { response, statements };
  }

  it("RED: the existing bounded catalog is admitted as public without poisoning the profile capture", async () => {
    const { response, statements } = await boundary("classified");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(["Deep Rock Galactic"]);
    expect(statements).toHaveLength(1);
  });
  it.each(["naked", "member projection"] as const)(
    "CONTROL: %s never becomes an unkeyed identity-read exemption",
    async (mode) => {
      const { response, statements } = await boundary(mode);
      expect(response.status).toBe(503);
      expect(statements).toEqual([]);
      expect(await response.text()).not.toContain("Deep Rock Galactic");
    },
  );
});

for (const renderer of ["Hono", "Kit"] as const) {
  describe(`${renderer}: profile games open only admitted schedule facets`, () => {
    it.each(scheduleGameCases)(
      "native label $label has the independently derived destination",
      async ({ label, href }) => {
        const fixture = await profileScheduleFixture({ games: [label] });
        const response = await fixture.request(renderer);
        expect(response.status).toBe(200);
        const [item] = profileGameItems(await response.text());
        expect(item).toBeDefined();
        expect(item!.unsafeTags).toEqual([]);
        expect(item!.links).toEqual(href === null ? [] : [{ href, label }]);
        expect(item!.label.trim()).toBe(label.trim());
      },
    );

    it("RED: the render consumes exactly one events-classified, published-only, bounded catalog query", async () => {
      const fixture = await profileScheduleFixture();
      const response = await fixture.request(renderer);
      expect(response.status).toBe(200);
      await response.text();
      expect(fixture.queries).toHaveLength(1);
      const query = fixture.queries[0]!;
      expect(query.active, "query must be observed inside the real member-read boundary").toBe(
        true,
      );
      // A 200 with this observed query also proves the real memberReadDb
      // adapter admitted its public classification, not an unkeyed read.
      expect(query.sql).toMatch(/^select distinct trim\(/i);
      expect(query.sql).toMatch(/from "events" where /i);
      const status = /"status"\s*=\s*(\$(\d+)|'published')/i.exec(query.sql);
      expect(status, query.sql).not.toBeNull();
      expect(status![2] ? query.params[Number(status![2]) - 1] : status![1]).toBe(
        status![2] ? "published" : "'published'",
      );
      const limit = /\blimit (\$(\d+)|\d+)\s*$/i.exec(query.sql);
      expect(limit, query.sql).not.toBeNull();
      expect(Number(limit![2] ? query.params[Number(limit![2]) - 1] : limit![1])).toBe(100);
      expect(
        fixture.operations.filter(({ method }) => method === "find").map(({ args }) => args[0]),
      ).toEqual([SCHEDULE_PROFILE_OWNER, "100000000000000002"]);
      expect(fixture.audit).toHaveLength(1);
      expect(fixture.audit[0]!.subjectUserIds).toEqual([SCHEDULE_PROFILE_OWNER]);
    });

    it.each([false, true])(
      "RED: own profile (member alias=%s) adds no member-identity lookup",
      async (ownAlias) => {
        const fixture = await profileScheduleFixture({
          own: true,
          ownAlias,
          games: ["Deep Rock Galactic"],
        });
        const response = await fixture.request(renderer);
        expect(response.status).toBe(200);
        const [item] = profileGameItems(await response.text());
        expect(fixture.operations).toEqual([{ method: "find", args: [SCHEDULE_PROFILE_OWNER] }]);
        expect(item!.shared).toEqual([]);
        expect(item!.links).toEqual([
          { href: "/events?game=Deep+Rock+Galactic", label: "Deep Rock Galactic" },
        ]);
        expect(response.headers.get("cache-control")).toContain("private");
        expect(response.headers.get("cache-control")).toContain("no-store");
      },
    );

    it("RED: an admitted 100-game snapshot never invents a link for an omitted game", async () => {
      const catalog = Array.from(
        { length: 100 },
        (_, i) => `Published game ${String(i).padStart(3, "0")}`,
      );
      const fixture = await profileScheduleFixture({
        catalog,
        games: ["Published game 099", "Published game 100"],
      });
      const response = await fixture.request(renderer);
      expect(response.status).toBe(200);
      const items = profileGameItems(await response.text());
      expect(items.map(({ links }) => links)).toEqual([
        [{ href: "/events?game=Published+game+099", label: "Published game 099" }],
        [],
      ]);
      expect(fixture.queries).toHaveLength(1);
    });

    it("RED: a throwing catalog leaves a readable private profile and all labels plain", async () => {
      const fixture = await profileScheduleFixture({ catalogUnavailable: true });
      const response = await fixture.request(renderer);
      expect(response.status).toBe(200);
      const items = profileGameItems(await response.text());
      expect(items).toHaveLength(scheduleGameCases.length);
      expect(
        items.every(({ links, unsafeTags }) => links.length === 0 && unsafeTags.length === 0),
      ).toBe(true);
      expect(fixture.queries).toHaveLength(1);
      expect(response.headers.get("cache-control")).toContain("no-store");
    });

    it("CONTROL: an empty public catalog does not fall back to an unfiltered Events link", async () => {
      const fixture = await profileScheduleFixture({ catalog: [] });
      const response = await fixture.request(renderer);
      expect(response.status).toBe(200);
      expect(profileGameItems(await response.text()).every(({ links }) => links.length === 0)).toBe(
        true,
      );
      expect(fixture.queries.length).toBeLessThanOrEqual(1);
    });

    it("CONTROL: Shared markers survive on known and unknown interests without changing visible text", async () => {
      const fixture = await profileScheduleFixture();
      const response = await fixture.request(renderer);
      expect(response.status).toBe(200);
      const items = profileGameItems(await response.text());
      expect(items.map(({ label }) => label.trim())).toEqual(
        scheduleGameCases.map(({ label }) => label.trim()),
      );
      expect(items.map(({ shared }) => shared.map((s) => s.trim()))).toEqual([
        ["Shared"],
        ["Shared"],
        [],
        [],
        [],
        [],
        ["Shared"],
        [],
      ]);
      expect(items[6]!.links).toEqual([]);
    });

    it.each([
      { guest: true, status: 302 },
      { member: false, status: 403 },
    ])(
      "CONTROL: denied profile status $status performs no catalog/member read",
      async ({ status, ...options }) => {
        const fixture = await profileScheduleFixture(options);
        const response = await fixture.request(renderer);
        expect(response.status).toBe(status);
        expect(fixture.operations).toEqual([]);
        expect(fixture.queries).toEqual([]);
        expect(await response.text()).not.toContain("Deep Rock Galactic");
      },
    );

    it("CONTROL: audit refusal still withholds another member's games", async () => {
      const fixture = await profileScheduleFixture({ auditOk: false });
      const response = await fixture.request(renderer);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("Deep Rock Galactic");
    });

    it("RED: Games explains schedule navigation without promising a booking or available seat", async () => {
      const fixture = await profileScheduleFixture();
      const response = await fixture.request(renderer);
      expect(response.status).toBe(200);
      const html = await response.text();
      const section =
        /<section[^>]*aria-labelledby="profile-games-heading"[^>]*>([\s\S]*?)<\/section>/.exec(
          html,
        )?.[1];
      expect(section).toBeDefined();
      expect(section).toMatch(/schedule|game nights|events/i);
      expect(section).not.toMatch(
        /guaranteed|reserve (?:your|a) seat|book now|seats? (?:is |are )?available/i,
      );
    });
  });
}
