import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeSigned } from "hono/utils/cookie";
import { QA_IDENTITIES, STAGING_APP_URL } from "../src/qa";
import { eventKeyAllowed } from "../src/events/keys";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import type { Env } from "../src/env";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import app from "./app";
// @ts-expect-error Standalone Node CLI is intentionally JavaScript, like bin/import.
// biome-ignore format: single-line import keeps the @ts-expect-error above attached to TS7016 (wrapping detaches it)
import { applySeed, buildSeed, createSeedClient, main, parseMode, SEED_OWNER, SEED_USERS, summarize, validateEnvironment } from "../bin/seed-staging.mjs";

const script = fileURLToPath(new URL("../bin/seed-staging.mjs", import.meta.url).href);
const localEnv = {
  APP_URL: "http://localhost:8787",
  SEED_CONFIRM: "staging",
  DATABASE_URL: "postgres://agent_test@agent-testdb:5432/two_web_next",
};
const remoteEnv = {
  APP_URL: STAGING_APP_URL,
  SEED_CONFIRM: "staging",
  DATABASE_URL: "postgres://fixture:synthetic-password@ep-staging.example.neon.tech/neondb",
  SEED_STAGING_DB_HOST: "ep-staging.example.neon.tech",
  SEED_STAGING_DB_NAME: "neondb",
  SEED_PRODUCTION_DB_HOSTS: "ep-live.example.neon.tech,ep-live-pooler.example.neon.tech",
};
const run = (args: string[] = [], env: Record<string, string> = localEnv) =>
  spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8", timeout: 20_000 });
const day = new Date("2099-10-01T12:00:00Z");

const denied: [string, Record<string, string>, string][] = [
  ["missing confirmation", { SEED_CONFIRM: "" }, "SEED_CONFIRM"],
  ["wrong confirmation", { SEED_CONFIRM: "production" }, "SEED_CONFIRM"],
  ["production environment", { APP_ENV: "production" }, "APP_ENV"],
  ["uppercase production environment", { APP_ENV: "PRODUCTION" }, "APP_ENV"],
  ["production apex", { APP_URL: "https://togetherweown.com" }, "production APP_URL"],
  ["production www", { APP_URL: "https://www.togetherweown.com" }, "production APP_URL"],
  [
    "canonicalized production apex",
    { APP_URL: "https://TOGETHERWEOWN.COM.:443/" },
    "production APP_URL",
  ],
  ["apex over http", { APP_URL: "http://togetherweown.com" }, "production APP_URL"],
  ["unknown app", { APP_URL: "https://next.togetherweown.com.evil.test" }, "not the staging"],
  ["missing app", { APP_URL: "" }, "APP_URL"],
  ["missing database", { DATABASE_URL: "" }, "DATABASE_URL"],
  ["malformed database", { DATABASE_URL: "postgres://[synthetic-password" }, "DATABASE_URL"],
  [
    "non-Postgres protocol",
    { DATABASE_URL: "https://agent_test@agent-testdb/two_web_next" },
    "PostgreSQL",
  ],
  ["missing db name", { DATABASE_URL: "postgres://agent_test@agent-testdb" }, "database name"],
  ["missing db user", { DATABASE_URL: "postgres://agent-testdb/two_web_next" }, "PostgreSQL"],
  [
    "host query redirect",
    { DATABASE_URL: `${localEnv.DATABASE_URL}?host=production.test` },
    "query parameter",
  ],
  [
    "database query redirect",
    { DATABASE_URL: `${localEnv.DATABASE_URL}?dbname=production` },
    "query parameter",
  ],
  [
    "service query redirect",
    { DATABASE_URL: `${localEnv.DATABASE_URL}?service=live` },
    "query parameter",
  ],
  [
    "options redirect",
    { DATABASE_URL: `${localEnv.DATABASE_URL}?options=-csearch_path=live` },
    "query parameter",
  ],
  [
    "unsafe SSL mode",
    { DATABASE_URL: `${localEnv.DATABASE_URL}?sslmode=disable` },
    "query parameter",
  ],
  ["URL fragment", { DATABASE_URL: `${localEnv.DATABASE_URL}#secret` }, "PostgreSQL"],
  [
    "production host label",
    { DATABASE_URL: "postgres://fixture@db.production.test/two_web_next" },
    "production database host",
  ],
  [
    "production db name",
    { DATABASE_URL: "postgres://agent_test@agent-testdb/production" },
    "production database name",
  ],
  [
    "configured production host",
    { SEED_PRODUCTION_DB_HOSTS: "agent-testdb" },
    "production database host",
  ],
  [
    "configured production db name",
    { SEED_PRODUCTION_DB_NAMES: "two_web_next" },
    "production database name",
  ],
  [
    "unknown remote",
    { DATABASE_URL: "postgres://fixture@unknown.test/two_web_next" },
    "remote target",
  ],
  ["wrong local db", { DATABASE_URL: "postgres://agent_test@agent-testdb/wrong" }, "remote target"],
  [
    "wrong local user",
    { DATABASE_URL: "postgres://other@agent-testdb/two_web_next" },
    "remote target",
  ],
  [
    "nonempty local password",
    { DATABASE_URL: "postgres://agent_test:synthetic-password@agent-testdb/two_web_next" },
    "remote target",
  ],
  [
    "wrong local port",
    { DATABASE_URL: "postgres://agent_test@agent-testdb:5433/two_web_next" },
    "remote target",
  ],
  [
    "multihost URL",
    { DATABASE_URL: "postgres://agent_test@agent-testdb,production.test/two_web_next" },
    "PostgreSQL",
  ],
];

describe("staging seed: fail-closed offline CLI", () => {
  it.each(denied)(
    "refuses %s in both modes without disclosing URLs",
    (_label, override, message) => {
      for (const args of [[], ["--apply"]]) {
        const result = run(args, { ...localEnv, ...override });
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(message);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain("synthetic-password");
        expect(result.stderr).not.toContain("postgres://");
      }
    },
  );

  it("requires remote allowlist and production denylist; denylist wins even over the staging allowlist", () => {
    expect(validateEnvironment(remoteEnv)).toMatchObject({
      host: remoteEnv.SEED_STAGING_DB_HOST,
      name: "neondb",
    });
    for (const overrides of [
      { SEED_STAGING_DB_HOST: "" },
      { SEED_STAGING_DB_NAME: "" },
      { SEED_PRODUCTION_DB_HOSTS: "" },
      { SEED_STAGING_DB_HOST: "other.neon.tech" },
      { SEED_STAGING_DB_NAME: "other" },
      { APP_URL: "http://localhost:8787" },
      {
        DATABASE_URL: "postgres://fixture@ep-live.example.neon.tech/neondb",
        SEED_STAGING_DB_HOST: "ep-live.example.neon.tech",
      },
      {
        DATABASE_URL: "postgres://fixture@ep-live-pooler.example.neon.tech/neondb",
        SEED_STAGING_DB_HOST: "ep-live-pooler.example.neon.tech",
      },
    ])
      expect(() => validateEnvironment({ ...remoteEnv, ...overrides })).toThrow("Refusing seed:");
    expect(() =>
      validateEnvironment({
        ...remoteEnv,
        SEED_PRODUCTION_DB_HOSTS: " EP-STAGING.EXAMPLE.NEON.TECH. ",
      }),
    ).toThrow("production database host");
  });

  it("refuses production targets before any connection, so --apply writes nothing", () => {
    // Unroutable TEST-NET-1 host: any connection attempt would fail with a
    // driver/timeout error. A production refusal instead proves main()
    // validates the environment before importing postgres or connecting, which
    // is what makes zero writes possible. Covers both modes per target.
    const unreachableDb = "postgres://agent_test@192.0.2.1:5432/two_web_next";
    const prodTargets: [string, Record<string, string>, string][] = [
      ["production apex", { APP_URL: "https://togetherweown.com" }, "production APP_URL"],
      [
        "production host",
        { DATABASE_URL: "postgres://agent_test@db.production.test/two_web_next" },
        "production database host",
      ],
      [
        "production name",
        { DATABASE_URL: "postgres://agent_test@agent-testdb/production" },
        "production database name",
      ],
    ];
    for (const [_label, target, message] of prodTargets) {
      for (const args of [[], ["--apply"]]) {
        const result = run(args, { ...localEnv, DATABASE_URL: unreachableDb, ...target });
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(message);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain("192.0.2.1");
        expect(result.stderr).not.toMatch(/ECONN|ENOTFOUND|timed out/i);
      }
    }
  });

  it("defaults to a connection-free dry-run, accepts explicit preview, and rejects ambiguous/URL arguments", async () => {
    expect(parseMode([])).toBe("dry-run");
    expect(parseMode(["--dry-run"])).toBe("dry-run");
    expect(parseMode(["--apply"])).toBe("apply");
    for (const args of [
      ["--apply", "--dry-run"],
      ["--apply", "--apply"],
      ["--unknown"],
      ["postgres://secret@live/db"],
    ]) {
      expect(() => parseMode(args)).toThrow("Usage:");
      expect(run(args).status).toBe(1);
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // Unreachable synthetic host: preview succeeds because no driver is constructed.
      await main([], remoteEnv);
      expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
        mode: "dry-run",
        planned: { events: 50, users: 3, rsvps: 12, featured: 3 },
      });
      expect(log.mock.calls[0]![0]).not.toContain("synthetic-password");
    } finally {
      log.mockRestore();
    }
    expect(run().status).toBe(0);
    expect(run(["--dry-run"]).status).toBe(0);
  });

  it("pins driver target/port/password/debug instead of falling back to inherited PG credentials", () => {
    const factory = vi.fn((_url: string, options: { password: () => string }) => options);
    const options = createSeedClient(factory, localEnv.DATABASE_URL);
    expect(options).toMatchObject({
      host: "agent-testdb",
      database: "two_web_next",
      username: "agent_test",
      port: 5432,
      ssl: false,
      debug: false,
    });
    expect(options.password()).toBe("");
    expect(options.connection).toMatchObject({
      search_path: "public",
      application_name: SEED_OWNER,
    });
    expect(createSeedClient(factory, remoteEnv.DATABASE_URL).password()).toBe("synthetic-password");
  });
});

describe("staging seed fixture contract", () => {
  it("has the deterministic 50-event mix, QA users, a weekly series and full/waitlisted fixtures", () => {
    const seed = buildSeed(day);
    expect(summarize(seed)).toEqual({
      users: 3,
      events: 50,
      futurePublished: 30,
      drafts: 6,
      cancelled: 5,
      pastPublished: 9,
      timezones: 6,
      fullEvents: 4,
      rsvps: 12,
      waitlisted: 4,
      featured: 3,
      seriesOccurrences: 4,
    });
    expect(new Set(seed.events.map((e: { event_key: string }) => e.event_key)).size).toBe(50);
    expect(seed.events.every((e: { event_key: string }) => e.event_key.startsWith("seed-"))).toBe(
      true,
    );
    expect(SEED_USERS.slice(0, 2).map((u: { id: string }) => u.id)).toEqual([
      QA_IDENTITIES["qa-member"]!.discordId,
      QA_IDENTITIES["qa-moderator"]!.discordId,
    ]);
    expect(seed.users.every((u: { username: string }) => u.username.startsWith("seed-"))).toBe(
      true,
    );
    expect(seed.events[4]).toMatchObject({
      recurrence_frequency: "weekly",
      recurrence_count: 4,
      recurrence_index: 1,
      parent_key: null,
    });
    expect(seed.events.slice(5, 8).map((e: { parent_key: string }) => e.parent_key)).toEqual(
      Array(3).fill("seed-calendar-05"),
    );
    expect(
      seed.events.slice(4, 8).map((e: { timezone: string; game: string }) => [e.timezone, e.game]),
    ).toEqual(Array(4).fill(["Asia/Tokyo", "Tabletop"]));
    for (let i = 5; i < 8; i++)
      expect(seed.events[i].starts_at.getTime() - seed.events[i - 1].starts_at.getTime()).toBe(
        7 * 86_400_000,
      );
    for (const featured of seed.featured)
      expect(new URL(featured.url).pathname).toMatch(/^\/e\/seed-calendar-/);
    const tomorrow = buildSeed(new Date(day.getTime() + 86_400_000));
    seed.events.forEach((e: { starts_at: Date; event_key: string }, i: number) => {
      expect(tomorrow.events[i].event_key).toBe(e.event_key);
      expect(tomorrow.events[i].starts_at.getTime() - e.starts_at.getTime()).toBe(86_400_000);
    });
  });

  it("allows demo keys only on staging/local, never production or arbitrary remote URLs", () => {
    for (const url of [STAGING_APP_URL, "http://localhost:8787", "http://127.0.0.1:8787"])
      expect(eventKeyAllowed("seed-calendar-01", url)).toBe(true);
    for (const url of [
      "https://togetherweown.com",
      "https://www.togetherweown.com",
      "https://next.example.test",
      "https://next.togetherweown.com.evil.test",
    ])
      expect(eventKeyAllowed("seed-calendar-01", url)).toBe(false);
    for (const key of [
      "seed-calendar-00",
      "seed-calendar-51",
      "seed-anything",
      "seed-calendar-01/extra",
    ])
      expect(eventKeyAllowed(key, STAGING_APP_URL)).toBe(false);
    expect(eventKeyAllowed("01ARZ3NDEKTSV4RRFFQ69G5FAV", "https://togetherweown.com")).toBe(true);
  });
});

const url = process.env.DATABASE_URL;
describe.skipIf(!url)("staging seed against isolated test Postgres", () => {
  let fixture: MemberDataFixture;
  beforeAll(async () => {
    fixture = await createMemberDataFixture(url!, { max: 2 });
  });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.client`DELETE FROM featured_contents`;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });
  const counts = async () => {
    const [row] =
      await fixture.client`SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM events) AS events,
      (SELECT count(*)::int FROM rsvps) AS rsvps, (SELECT count(*)::int FROM featured_contents) AS featured`;
    return row;
  };

  it("upserts twice with stable counts/IDs/FIFO, rolls dates forward, preserves unrelated rows and bot-owned fields", async () => {
    await fixture.client`INSERT INTO users (id, username) VALUES ('unrelated', 'synthetic-unrelated')`;
    await fixture.client`INSERT INTO events (event_key, title, starts_at, ends_at, created_by) VALUES ('unrelated', 'Synthetic unrelated', ${day.toISOString()}, ${new Date(day.getTime() + 3_600_000).toISOString()}, 'unrelated')`;
    await fixture.client`INSERT INTO featured_contents (title, body, created_by) VALUES ('Unrelated fixture', 'Keep', 'unrelated')`;
    await applySeed(fixture.client, buildSeed(day));
    const before =
      await fixture.client`SELECT id, event_key, starts_at, parent_event_id FROM events ORDER BY id`;
    const beforeRsvps =
      await fixture.client`SELECT id, event_id, user_id, created_at FROM rsvps ORDER BY id`;
    await fixture.client`UPDATE events SET discord_event_id = 'synthetic-discord-event', discord_sync_failure_code = 'keep' WHERE event_key = 'seed-calendar-01'`;
    await applySeed(fixture.client, buildSeed(day));
    expect(await counts()).toEqual({ users: 4, events: 51, rsvps: 12, featured: 4 });
    expect(
      await fixture.client`SELECT id, event_key, starts_at, parent_event_id FROM events ORDER BY id`,
    ).toEqual(before);
    expect(
      await fixture.client`SELECT id, event_id, user_id, created_at FROM rsvps ORDER BY id`,
    ).toEqual(beforeRsvps);
    const tomorrow = new Date(day.getTime() + 86_400_000);
    await applySeed(fixture.client, buildSeed(tomorrow));
    const after =
      await fixture.client`SELECT id, event_key, starts_at, parent_event_id FROM events ORDER BY id`;
    for (let i = 0; i < before.length; i++) {
      expect(after[i]).toMatchObject({
        id: before[i]!.id,
        event_key: before[i]!.event_key,
        parent_event_id: before[i]!.parent_event_id,
      });
      expect(
        new Date(after[i]!.starts_at).getTime() - new Date(before[i]!.starts_at).getTime(),
      ).toBe(before[i]!.event_key === "unrelated" ? 0 : 86_400_000);
    }
    expect(
      (
        await fixture.client`SELECT discord_event_id, discord_sync_failure_code FROM events WHERE event_key = 'seed-calendar-01'`
      )[0],
    ).toEqual({ discord_event_id: "synthetic-discord-event", discord_sync_failure_code: "keep" });
    expect(
      (await fixture.client`SELECT username FROM users WHERE id = 'unrelated'`)[0]!.username,
    ).toBe("synthetic-unrelated");
    const full =
      await fixture.client`SELECT e.capacity, count(*)::int AS going FROM events e JOIN rsvps r ON r.event_id = e.id AND r.status = 'going' WHERE e.event_key IN ('seed-calendar-01', 'seed-calendar-02', 'seed-calendar-03', 'seed-calendar-04') GROUP BY e.id`;
    expect(full).toHaveLength(4);
    for (const row of full) expect(row.going).toBe(row.capacity);
    expect(
      (
        await fixture.client`SELECT count(*)::int AS count FROM users WHERE id != 'unrelated' AND (username NOT LIKE 'seed-%' OR avatar IS NOT NULL)`
      )[0]!.count,
    ).toBe(0);
  });

  it("serializes concurrent seed applies, including featured natural keys", async () => {
    await Promise.all([
      applySeed(fixture.client, buildSeed(day)),
      applySeed(fixture.client, buildSeed(day)),
    ]);
    expect(await counts()).toEqual({ users: 3, events: 50, rsvps: 12, featured: 3 });
  });

  it("reseeds idempotently: third run inserts nothing, all row IDs stay stable", async () => {
    await applySeed(fixture.client, buildSeed(day));
    await applySeed(fixture.client, buildSeed(day));
    const users = await fixture.client`SELECT id, username FROM users ORDER BY id`;
    const featured = await fixture.client`SELECT id, title FROM featured_contents ORDER BY id`;
    const maxIds =
      await fixture.client`SELECT (SELECT max(id) FROM users) AS users, (SELECT max(id) FROM events) AS events,
      (SELECT max(id) FROM rsvps) AS rsvps, (SELECT max(id) FROM featured_contents) AS featured`;
    await applySeed(fixture.client, buildSeed(day));
    expect(await counts()).toEqual({ users: 3, events: 50, rsvps: 12, featured: 3 });
    expect(await fixture.client`SELECT id, username FROM users ORDER BY id`).toEqual(users);
    expect(await fixture.client`SELECT id, title FROM featured_contents ORDER BY id`).toEqual(
      featured,
    );
    expect(
      await fixture.client`SELECT (SELECT max(id) FROM users) AS users, (SELECT max(id) FROM events) AS events,
      (SELECT max(id) FROM rsvps) AS rsvps, (SELECT max(id) FROM featured_contents) AS featured`,
    ).toEqual(maxIds);
  });

  it.each(["event", "user", "featured", "duplicate featured"])(
    "refuses %s ownership collisions without changing existing data",
    async (kind) => {
      if (kind === "event")
        await fixture.client`INSERT INTO events (event_key, title, starts_at, ends_at, created_by) VALUES ('seed-calendar-01', 'Existing', ${day.toISOString()}, ${day.toISOString()}, 'not-seed')`;
      if (kind === "user")
        await fixture.client`INSERT INTO users (id, username) VALUES (${SEED_USERS[0].id}, 'not-seed')`;
      if (kind === "featured")
        await fixture.client`INSERT INTO featured_contents (title, created_by) VALUES ('seed-featured-1', 'not-seed')`;
      if (kind === "duplicate featured")
        await fixture.client`INSERT INTO featured_contents (title, created_by) VALUES ('seed-featured-1', ${SEED_OWNER}), ('seed-featured-1', ${SEED_OWNER})`;
      const before = await counts();
      await expect(applySeed(fixture.client, buildSeed(day))).rejects.toThrow("Refusing seed:");
      expect(await counts()).toEqual(before);
    },
  );

  it("rolls back a mid-transaction failure and accepts only the two reserved QA display names", async () => {
    await fixture.client`INSERT INTO users (id, username) VALUES (${SEED_USERS[0].id}, 'QA Member'), (${SEED_USERS[1].id}, 'QA Moderator')`;
    const broken = buildSeed(day);
    broken.events[49].title = null; // A late NOT NULL failure proves earlier writes are rolled back.
    await expect(applySeed(fixture.client, broken)).rejects.toThrow();
    expect(await counts()).toEqual({ users: 2, events: 0, rsvps: 0, featured: 0 });
    await applySeed(fixture.client, buildSeed(day));
    expect(await counts()).toEqual({ users: 3, events: 50, rsvps: 12, featured: 3 });
  });

  it("renders seed pages/ICS and preserves guest, draft and production route gates", async () => {
    await applySeed(fixture.client, buildSeed(day));
    const store = createMemorySessionStore();
    const secret = "seed-test-session-secret-at-least-32-bytes";
    const env = {
      APP_URL: STAGING_APP_URL,
      ADMIN_DB: fixture.db,
      SESSION_STORE: store,
      SESSION_SECRET: secret,
      DISCORD_CLIENT_ID: "fixture-client",
      DISCORD_GUILD_ID: "fixture-guild",
      DISCORD_CLIENT_SECRET: "fixture-secret",
      DISCORD_INVITE_URL: "https://discord.gg/fixture",
      DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
    } as unknown as Env;
    const request = (path: string, init: RequestInit = {}, bindings: Env = env) =>
      app.request(path, init, bindings);
    const cookie = async (moderator: boolean) => {
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: SEED_USERS[0].id,
        username: "seed-qa-member",
        avatar: null,
        member: true,
        moderator,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      return (
        await serializeSigned("__Host-two_session", token, secret, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
    };
    const published = await request("/e/seed-calendar-01");
    expect(published.status).toBe(200);
    expect(await published.text()).toContain("Seed 01:");
    expect((await request("/events/seed-calendar-01.ics")).status).toBe(200);
    expect((await request("/e/seed-calendar-31")).status).toBe(403);
    expect(
      (await request("/e/seed-calendar-31", { headers: { cookie: await cookie(true) } })).status,
    ).toBe(200);
    expect((await request("/e/seed-calendar-37")).status).toBe(410);
    expect(
      (
        await request("/events/seed-calendar-01/rsvp", {
          method: "PUT",
          headers: { origin: STAGING_APP_URL, "content-type": "application/json" },
          body: '{"status":"going"}',
        })
      ).status,
    ).toBe(401);
    const answer = await request("/events/seed-calendar-01/rsvp", {
      method: "PUT",
      headers: {
        cookie: await cookie(false),
        origin: STAGING_APP_URL,
        "content-type": "application/json",
      },
      body: '{"status":"going"}',
    });
    expect(answer.status).toBe(200);
    const withdraw = await request("/events/seed-calendar-01/rsvp", {
      method: "DELETE",
      headers: { cookie: await cookie(false), origin: STAGING_APP_URL },
    });
    expect(withdraw.status).toBe(204);
    const production = { ...env, APP_URL: "https://togetherweown.com" };
    for (const path of ["/e/seed-calendar-01", "/events/seed-calendar-01.ics"])
      expect((await request(path, {}, production)).status).toBe(404);
    expect(
      (
        await request(
          "/events/seed-calendar-01/rsvp",
          {
            method: "PUT",
            headers: {
              cookie: await cookie(false),
              origin: production.APP_URL,
              "content-type": "application/json",
            },
            body: '{"status":"going"}',
          },
          production,
        )
      ).status,
    ).toBe(404);
  });
});
