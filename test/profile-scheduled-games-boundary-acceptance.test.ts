// route-inventory: GET /profile
// route-inventory: GET /members/:user
// Follow-up to the immutable scheduled-game link acceptance suite. An injected
// publishedGames function cannot expose a refused computed SQL projection.
// These tests keep Drizzle, dbFor, the production reader/defaults and both
// member-read boundaries real; only the final transport supplies local rows.
//
// Breaks caught: rejecting the reviewed distinct-game query; broadening its
// exception to arbitrary computed reads; omitting production default wiring;
// treating public game labels as audited member subjects. No DB or network.
import { and, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessEntry } from "../src/access-log";
import type { EnvWithAdminDb } from "../src/admin/db";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { memberReadDb } from "../src/db/member-reads";
import { validateNonSensitiveRead, type SelectedField } from "../src/db/read-classification";
import { users } from "../src/db/schema";
import { listPublishedGames } from "../src/events/reads";
import {
  bufferedMemberJson,
  MemberReadRefused,
  memberReadBoundary,
  memberReadResponse,
  nonSensitiveRead,
} from "../src/member-reads";
import { kitProfileDeps, resolveKitProfile } from "../src/profiles/kit";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const VIEWER = "100000000000000021";
const MEMBER = "100000000000000022";
const SECRET = "test-session-secret-at-least-32-bytes-long";
const env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_BOT_TOKEN: "fixture",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  SESSION_SECRET: SECRET,
};

// Independently specified complete statement, not the classifier's allowlist.
// The classifier API does not receive params: the real-reader checks below also
// pin the bound limit value (100), rather than claiming SQL shape proves it.
const GAME_SELECT = `select distinct trim("game") from "events" where ("events"."status" = 'published' and "events"."game" is not null and trim("events"."game") <> '') order by trim("game") limit $1`;
const computedFields: SelectedField[] = [{ path: ["game"], field: sql`trim(${events.game})` }];
const nearMisses: Array<[string, string]> = [
  ["extra event projection", GAME_SELECT.replace(' from "events"', ', "title" from "events"')],
  [
    "extra computed projection",
    GAME_SELECT.replace(' from "events"', ', current_user from "events"'),
  ],
  ["missing distinct", GAME_SELECT.replace("select distinct ", "select ")],
  ["missing published filter", GAME_SELECT.replace('"events"."status" = \'published\' and ', "")],
  ["draft filter", GAME_SELECT.replace("'published'", "'draft'")],
  ["missing nonnull filter", GAME_SELECT.replace('"events"."game" is not null and ', "")],
  ["missing blank filter", GAME_SELECT.replace(' and trim("events"."game") <> \'\'', "")],
  ["missing order", GAME_SELECT.replace(' order by trim("game")', "")],
  ["missing limit", GAME_SELECT.replace(" limit $1", "")],
  ["literal oversized limit", GAME_SELECT.replace("limit $1", "limit 101")],
  ["computed oversized limit", GAME_SELECT.replace("limit $1", "limit ($1 + 1)")],
  ["member join", GAME_SELECT.replace(" where ", ' inner join "users" on true where ')],
  [
    "member subquery",
    GAME_SELECT.replace(
      ' from "events"',
      ', (select "username" from "users" limit 1) from "events"',
    ),
  ],
  ["trailing statement", GAME_SELECT + '; select "username" from "users"'],
  ["unrelated computed event read", 'select lower("title") from "events" limit $1'],
];

function transportFixture() {
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
        return [{ game: "Go" }, { game: "Chess" }];
      },
    };
  };
  return { raw: raw as unknown as Db, prepared, executions: () => executions };
}

function expectPublishedRead(fixture: ReturnType<typeof transportFixture>) {
  expect(fixture.prepared).toHaveLength(1);
  expect(fixture.prepared[0]!.sql.trim().replace(/\s+/g, " ")).toBe(GAME_SELECT);
  expect(fixture.prepared[0]!.params).toEqual([100]);
  expect(fixture.prepared[0]!.fields?.map(({ path }) => path)).toEqual([["game"]]);
  expect(fixture.executions()).toBe(1);
}

function store() {
  return createMemoryProfileStore([
    { id: VIEWER, username: "viewer", avatar: null, bio: null, games: ["Chess"], timezone: null },
    {
      id: MEMBER,
      username: "member",
      avatar: null,
      bio: null,
      games: ["chess", "Doom"],
      timezone: null,
    },
  ]);
}

const expectedAudit: AccessEntry[] = [
  {
    viewerDiscordId: VIEWER,
    viewerUserId: VIEWER,
    resource: "profile",
    action: "view",
    route: "profiles.show",
    subjectUserIds: [MEMBER],
  },
];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("published distinct-game classification is a narrow exception", () => {
  it("RED: admits the complete statement with a computed game field", () => {
    expect(() => validateNonSensitiveRead("events", GAME_SELECT, computedFields)).not.toThrow();
  });

  it("RED: whitespace normalization does not prevent exact admission", () => {
    const spaced = ` \n${GAME_SELECT.replaceAll(" ", " \n\t ")}\n `;
    expect(() => validateNonSensitiveRead("events", spaced, computedFields)).not.toThrow();
  });

  it.each<{ label: string; fields: SelectedField[] | undefined }>([
    { label: "absent", fields: undefined },
    { label: "empty", fields: [] },
  ])("GUARD: refuses $label selected-field metadata", ({ fields }) => {
    expect(() => validateNonSensitiveRead("events", GAME_SELECT, fields)).toThrow(
      MemberReadRefused,
    );
  });

  it("GUARD: does not lend the exception to another classification", () => {
    expect(() => validateNonSensitiveRead("featured", GAME_SELECT, computedFields)).toThrow(
      MemberReadRefused,
    );
  });

  it.each(nearMisses)("GUARD: refuses %s", (_label, statement) => {
    expect(statement).not.toBe(GAME_SELECT);
    expect(() => validateNonSensitiveRead("events", statement, computedFields)).toThrow(
      MemberReadRefused,
    );
  });
});

describe("the production game reader inside actual member-read boundaries", () => {
  it("GUARD: the same real reader succeeds outside capture with the exact bounded statement", async () => {
    const fixture = transportFixture();
    expect(await listPublishedGames(memberReadDb(fixture.raw))).toEqual(["Chess", "Go"]);
    expectPublishedRead(fixture);
  });

  it.each(["hono", "kit"])("RED: %s releases game results without audit subjects", async (kind) => {
    const fixture = transportFixture();
    const db = memberReadDb(fixture.raw);
    const audit: AccessEntry[] = [];
    const sink = async (entry: AccessEntry) => {
      audit.push(entry);
      return true;
    };
    let response: Response;
    if (kind === "hono") {
      const app = new Hono();
      app.use("*", (c, next) =>
        memberReadBoundary(
          c,
          {
            viewer: VIEWER,
            resource: "profile",
            action: "view",
            route: "profiles.show",
          },
          sink,
          next,
        ),
      );
      app.get("/profile", async (c) =>
        bufferedMemberJson(c, await nonSensitiveRead("events", () => listPublishedGames(db))),
      );
      response = await app.request("/profile");
    } else {
      response = await memberReadResponse(
        { method: "GET", route: "/profile" },
        {
          viewer: VIEWER,
          resource: "profile",
          action: "view",
          route: "profile",
        },
        sink,
        async () => Response.json(await nonSensitiveRead("events", () => listPublishedGames(db))),
      );
    }
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(["Chess", "Go"]);
    expectPublishedRead(fixture);
    expect(audit).toEqual([]);
  });

  it.each(["extra projection", "dropped published filter", "missing limit", "member join"])(
    "GUARD: generated %s refuses before transport even when the caller catches it",
    async (variant) => {
      const fixture = transportFixture();
      const db = memberReadDb(fixture.raw);
      const app = new Hono();
      const audit: AccessEntry[] = [];
      let refusal: unknown;
      app.use("*", (c, next) =>
        memberReadBoundary(
          c,
          {
            viewer: VIEWER,
            resource: "profile",
            action: "view",
            route: "profiles.show",
          },
          async (entry) => {
            audit.push(entry);
            return true;
          },
          next,
        ),
      );
      app.get("/profile", async (c) => {
        try {
          await nonSensitiveRead("events", async () => {
            const selected = { game: sql<string>`trim(${events.game})` };
            const from = db
              .selectDistinct(
                variant === "extra projection" ? { ...selected, extra: events.title } : selected,
              )
              .from(events);
            const joined = variant === "member join" ? from.innerJoin(users, sql`true`) : from;
            const filtered = joined
              .where(
                and(
                  variant === "dropped published filter"
                    ? undefined
                    : sql`${events.status} = 'published'`,
                  sql`${events.game} is not null`,
                  sql`trim(${events.game}) <> ''`,
                ),
              )
              .orderBy(sql`trim(${sql.identifier(events.game.name)})`);
            return variant === "missing limit" ? await filtered : await filtered.limit(100);
          });
        } catch (error) {
          refusal = error;
        }
        return bufferedMemberJson(c, { marker: "must-not-release" });
      });
      const response = await app.request("/profile");
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).not.toContain("must-not-release");
      expect(refusal).toBeInstanceOf(MemberReadRefused);
      expect(fixture.prepared).toHaveLength(1);
      expect(fixture.executions()).toBe(0);
      expect(audit).toEqual([]);
    },
  );
});

describe("profile production published-games defaults (no publishedGames double)", () => {
  it.each(["/profile", `/members/${MEMBER}`])(
    "RED: Hono %s links through the real reader and retains audit subjects",
    async (path) => {
      const fixture = transportFixture();
      const bindings: EnvWithAdminDb = { ...env, ADMIN_DB: fixture.raw };
      const sessions = createMemorySessionStore();
      const token = newSessionToken();
      await sessions.create({
        tokenHash: await hashToken(token),
        userId: VIEWER,
        username: "viewer",
        avatar: null,
        member: true,
        moderator: false,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      const cookie = await serializeSigned("__Host-two_session", token, SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      });
      const audit: AccessEntry[] = [];
      const app = profilesApp({
        sessionStore: sessions,
        store: store(),
        stats: async () => null,
        accessLog: async (entry) => {
          audit.push(entry);
          return true;
        },
      });
      const response = await app.request(
        env.APP_URL + path,
        { headers: { cookie: cookie.split(";")[0]! } },
        bindings,
      );
      expect(response.status).toBe(200);
      expectPublishedRead(fixture);
      const html = await response.text();
      expect(html).toContain('href="/events?game=Chess"');
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(audit).toEqual(path === "/profile" ? [] : expectedAudit);
    },
  );

  it.each([VIEWER, MEMBER])(
    "RED: Kit default links member %s without broadening audit subjects",
    async (requestedId) => {
      const fixture = transportFixture();
      const bindings: EnvWithAdminDb = { ...env, ADMIN_DB: fixture.raw };
      const defaults = kitProfileDeps(bindings) as ReturnType<typeof kitProfileDeps> & {
        publishedGamesFor?: () => Promise<string[]>;
      };
      // Assert the missing contract explicitly on baseline, rather than a TypeError.
      expect(typeof defaults.publishedGamesFor).toBe("function");
      const audit: AccessEntry[] = [];
      const response = await memberReadResponse(
        { method: "GET", route: requestedId === VIEWER ? "/profile" : "/members/:user" },
        {
          viewer: VIEWER,
          resource: "profile",
          action: "view",
          route: "profiles.show",
        },
        async (entry) => {
          audit.push(entry);
          return true;
        },
        async () => {
          const outcome = await resolveKitProfile(
            {
              session: {
                status: "authenticated",
                session: {
                  userId: VIEWER,
                  username: "viewer",
                  avatar: null,
                  member: true,
                  moderator: false,
                },
              },
              requestedId,
              joinResult: null,
            },
            { store: store(), publishedGames: () => defaults.publishedGamesFor!() } as Parameters<
              typeof resolveKitProfile
            >[1],
          );
          return Response.json(outcome);
        },
      );
      expect(response.status).toBe(200);
      expectPublishedRead(fixture);
      expect(await response.json()).toMatchObject({
        kind: "ok",
        member: { id: requestedId },
        scheduledGames: requestedId === VIEWER ? { Chess: "Chess" } : { chess: "Chess" },
        sharedGames: requestedId === VIEWER ? [] : ["chess"],
      });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(audit).toEqual(requestedId === VIEWER ? [] : expectedAudit);
    },
  );
});
