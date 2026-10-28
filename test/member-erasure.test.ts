// Member erasure (TOG-12548). Proves the operator command backs the
// published deletion promise: dry-run writes nothing, apply removes exactly
// one member's rows across all six tables, re-apply is a no-op, and a
// malformed id is refused before any connection is opened.
//
// Live round-trips use a guarded disposable schema on agent-testdb or the
// explicitly allowed GitHub CI Postgres service; CLI safety tests run
// without a database.
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertDiscordId,
  countMemberRows,
  eraseMember,
  InvalidMemberIdError,
  isValidDiscordId,
} from "../src/member-erasure";
// @ts-expect-error Standalone Node CLI is intentionally JavaScript, like bin/import.
// biome-ignore format: single-line import keeps the @ts-expect-error above attached to TS7016 (wrapping detaches it)
import { createEraseClient, isProductionDatabaseUrl, parseEraseArgs, validateEraseEnvironment } from "../bin/erase-member.mjs";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const script = fileURLToPath(new URL("../bin/erase-member.mjs", import.meta.url).href);
const run = (args: string[] = [], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["--import", "./bin/ts-hook.mjs", script, ...args], {
    env,
    cwd: fileURLToPath(new URL("..", import.meta.url).href),
    encoding: "utf8",
    timeout: 20_000,
  });

const MEMBER_A = "100000000000000201";
const MEMBER_B = "100000000000000202";
const EVENT_KEY = "01J000000000000000000000E1";

describe("member-erasure id validation (no database)", () => {
  it("accepts Discord snowflakes and refuses everything else before connecting", () => {
    expect(isValidDiscordId(MEMBER_A)).toBe(true);
    expect(isValidDiscordId("1")).toBe(true);
    expect(isValidDiscordId("900000000000001396")).toBe(true);
    // Non-canonical forms are refused too: "007" would otherwise cast to
    // bigint 7 in Postgres and erase a different member; "0"/"00" name nobody.
    for (const bad of [
      "",
      "  ",
      "abc",
      "12a34",
      "-1",
      "+1",
      "1.5",
      "1_2",
      " ".repeat(3),
      "0",
      "00",
      "007",
    ]) {
      expect(isValidDiscordId(bad), JSON.stringify(bad)).toBe(false);
      expect(() => assertDiscordId(bad)).toThrow(InvalidMemberIdError);
    }
    // 20 digits is the 64-bit width; 21 is truncated or fabricated.
    expect(isValidDiscordId("9".repeat(20))).toBe(true);
    expect(isValidDiscordId("9".repeat(21))).toBe(false);
    expect(isValidDiscordId(undefined)).toBe(false);
    expect(isValidDiscordId(null)).toBe(false);
    expect(isValidDiscordId(42)).toBe(false);
    expect(() => assertDiscordId("not-an-id")).toThrow("malformed Discord id");
    expect(() => assertDiscordId("")).toThrow("required");
  });

  it("refuses a malformed id before any query runs", async () => {
    let calls = 0;
    const neverQuery = (async () => {
      calls++;
      throw new Error("must not connect");
    }) as unknown as Parameters<typeof eraseMember>[0];
    (neverQuery as unknown as Record<string, unknown>).begin = async () => {
      calls++;
      throw new Error("must not connect");
    };
    await expect(eraseMember(neverQuery, "not-an-id", { dryRun: true })).rejects.toThrow(
      InvalidMemberIdError,
    );
    await expect(eraseMember(neverQuery, "not-an-id", { dryRun: false })).rejects.toThrow(
      InvalidMemberIdError,
    );
    await expect(countMemberRows(neverQuery, "")).rejects.toThrow(InvalidMemberIdError);
    expect(calls).toBe(0);
  });
});

describe("erase-member CLI safety (no database)", () => {
  it("defaults to dry-run, accepts explicit preview/apply, and refuses ambiguous or URL arguments", () => {
    expect(parseEraseArgs([`--discord-id=${MEMBER_A}`])).toEqual({
      discordId: MEMBER_A,
      mode: "dry-run",
      target: undefined,
    });
    expect(parseEraseArgs([`--discord-id=${MEMBER_A}`, "--dry-run"])).toMatchObject({
      mode: "dry-run",
    });
    expect(parseEraseArgs([`--discord-id=${MEMBER_A}`, "--apply"])).toMatchObject({
      mode: "apply",
    });
    expect(parseEraseArgs([MEMBER_A, "--apply", "--target", "production"])).toEqual({
      discordId: MEMBER_A,
      mode: "apply",
      target: "production",
    });
    expect(parseEraseArgs([`--discord-id=${MEMBER_A}`, "--target=production"])).toMatchObject({
      target: "production",
    });
    for (const args of [
      [],
      ["--discord-id="],
      ["--discord-id=not-an-id"],
      ["--discord-id=007"],
      ["007"],
      [`--discord-id=${MEMBER_A}`, "--apply", "--dry-run"],
      [`--discord-id=${MEMBER_A}`, "--unknown"],
      [`--discord-id=${MEMBER_A}`, "--target"],
      [`--discord-id=${MEMBER_A}`, "--target", "sideways"],
      ["postgres://agent_test@agent-testdb/two_web_next"],
      [`--discord-id=${MEMBER_A}`, "postgres://agent_test@agent-testdb/two_web_next"],
    ]) {
      expect(() => parseEraseArgs(args), JSON.stringify(args)).toThrow();
    }
    expect(run([]).status).toBe(2);
    expect(run([`--discord-id=${MEMBER_A}`, "--apply", "--dry-run"]).status).toBe(2);
  });

  it("refuses a malformed id with exit 2 before opening any connection", () => {
    // No DATABASE_URL at all: a refusal here proves no connection was opened.
    const refused = run(["--discord-id=not-an-id"], {});
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("malformed Discord id");
    expect(refused.stdout).toBe("");
  });

  it("detects production-looking connection strings without printing them", () => {
    for (const prod of [
      "postgres://fixture@db.production.test/two_web_next",
      "postgres://fixture@prod.example.test/neondb",
      "postgres://fixture@ep-live-pooler.example.neon.tech.invalid/prod",
      "postgres://fixture@ep-live.example.neon.tech.invalid/production",
      "postgres://agent_test@agent-testdb/production",
    ])
      expect(isProductionDatabaseUrl(prod), prod).toBe(true);
    for (const safe of [
      "postgres://agent_test@agent-testdb:5432/two_web_next",
      "postgres://fixture@ep-staging.example.neon.tech.invalid/neondb",
      "postgres://postgres:ci@localhost:5432/postgres",
      "not a url",
      "",
    ])
      expect(isProductionDatabaseUrl(safe), safe).toBe(false);
  });

  it("refuses production without --target production and never echoes the URL", () => {
    const prod =
      "postgres://fixture:synthetic-password@db.production.test/neondb?sslmode=verify-full";
    expect(() => validateEraseEnvironment({ DATABASE_URL: prod }, undefined)).toThrow(
      "--target production",
    );
    expect(validateEraseEnvironment({ DATABASE_URL: prod }, "production")).toMatchObject({
      databaseUrl: prod,
    });
    const local = "postgres://agent_test@agent-testdb:5432/two_web_next";
    expect(validateEraseEnvironment({ DATABASE_URL: local }, undefined)).toMatchObject({
      databaseUrl: local,
    });
    for (const env of [{}, { DATABASE_URL: "" }, { DATABASE_URL: "https://example.test/db" }]) {
      expect(() => validateEraseEnvironment(env, undefined)).toThrow("DATABASE_URL");
    }
    const refused = run([`--discord-id=${MEMBER_A}`], { DATABASE_URL: prod });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("--target production");
    expect(refused.stdout + refused.stderr).not.toContain("synthetic-password");
    expect(refused.stdout + refused.stderr).not.toContain("postgres://");
    const missing = run([`--discord-id=${MEMBER_A}`], {});
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("DATABASE_URL");
  });
});

const NO_TARGET = "--target staging or --target production";
const TLS_REQUIRED = "sslmode=verify-full or sslrootcert=system";
const LOCAL_URL = "postgres://agent_test@agent-testdb:5432/two_web_next";
const STAGING_URL =
  "postgres://fixture:synthetic-password@ep-staging.example.neon.tech.invalid/neondb?sslmode=verify-full";
const STAGING_REQUIRE_URL =
  "postgres://fixture:synthetic-password@ep-staging.example.neon.tech.invalid/neondb?sslmode=require";
const POOLER_URL =
  "postgres://fixture:synthetic-password@ep-cool-frost-12345-pooler.us-east-2.aws.neon.tech.invalid/neondb?sslmode=verify-full";
const PSDB_URL =
  "postgres://fixture:synthetic-password@aws-us-east-1.pg.psdb.cloud.invalid/two_web_next?sslmode=verify-full";
const OPAQUE_URL =
  "postgres://fixture:synthetic-password@db-7f3a9c.internal.example/postgres?sslmode=verify-full";
const PROD_URL =
  "postgres://fixture:synthetic-password@db.production.test/neondb?sslmode=verify-full";
const STAGING_UPPER_URL =
  "postgres://fixture:synthetic-password@EP-Staging.Example.Invalid./neondb?sslmode=verify-full";
const recordingPostgres =
  (calls: Record<string, unknown>[]) =>
  (options: Record<string, unknown>): object => {
    calls.push(options);
    return {};
  };

describe("erase target and TLS policy (no connection)", () => {
  it("refuses a staging-looking remote URL without a target", () => {
    expect(() => validateEraseEnvironment({ DATABASE_URL: STAGING_URL }, undefined)).toThrow(
      NO_TARGET,
    );
    expect(validateEraseEnvironment({ DATABASE_URL: STAGING_URL }, "staging")).toMatchObject({
      databaseUrl: STAGING_URL,
    });
  });

  it("accepts only staging or production as a remote target, even when called directly", () => {
    for (const bad of ["dev", "STAGING", "", null, 0, false])
      expect(
        () => validateEraseEnvironment({ DATABASE_URL: STAGING_URL }, bad),
        String(bad),
      ).toThrow(NO_TARGET);
  });

  it("refuses pooler, *.pg.psdb.cloud.invalid, and opaque-host URLs without a target", () => {
    for (const remote of [POOLER_URL, PSDB_URL, OPAQUE_URL])
      expect(() => validateEraseEnvironment({ DATABASE_URL: remote }, undefined), remote).toThrow(
        NO_TARGET,
      );
  });

  it("requires sslmode=verify-full or sslrootcert for a remote target", () => {
    const base =
      "postgres://fixture:synthetic-password@ep-staging.example.neon.tech.invalid/neondb";
    for (const query of [
      "",
      "?sslmode=require",
      "?sslmode=verify-ca",
      "?sslmode=disable",
      "?sslmode=require&sslrootcert=system",
    ])
      expect(
        () => validateEraseEnvironment({ DATABASE_URL: `${base}${query}` }, "staging"),
        query,
      ).toThrow(TLS_REQUIRED);
    for (const query of ["?sslmode=verify-full", "?sslrootcert=system"])
      expect(
        validateEraseEnvironment({ DATABASE_URL: `${base}${query}` }, "staging"),
      ).toMatchObject({ databaseUrl: `${base}${query}` });
  });

  it("applies the TLS rule to production targets and keeps production-looking URLs on production", () => {
    expect(() =>
      validateEraseEnvironment(
        {
          DATABASE_URL:
            "postgres://fixture:synthetic-password@db.production.test/neondb?sslmode=require",
        },
        "production",
      ),
    ).toThrow(TLS_REQUIRED);
    expect(() => validateEraseEnvironment({ DATABASE_URL: PROD_URL }, "staging")).toThrow(
      "--target production",
    );
  });

  it("refuses NODE_TLS_REJECT_UNAUTHORIZED=0 for remote and local targets", () => {
    expect(() =>
      validateEraseEnvironment(
        { DATABASE_URL: STAGING_URL, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
        "staging",
      ),
    ).toThrow("NODE_TLS_REJECT_UNAUTHORIZED=0");
    expect(() =>
      validateEraseEnvironment(
        { DATABASE_URL: LOCAL_URL, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
        undefined,
      ),
    ).toThrow("NODE_TLS_REJECT_UNAUTHORIZED=0");
  });

  it("keeps the local allowlist free of target and TLS requirements", () => {
    for (const local of [
      LOCAL_URL,
      "postgres://fixture@localhost:5432/postgres",
      "postgres://fixture@127.0.0.1:5432/postgres",
      "postgres://fixture@[::1]:5432/postgres",
    ])
      expect(validateEraseEnvironment({ DATABASE_URL: local }, undefined), local).toMatchObject({
        databaseUrl: local,
      });
  });

  it("builds the client from parsed endpoint fields, never the raw URL", () => {
    const calls: unknown[][] = [];
    const fakePostgres = (...args: unknown[]) => {
      calls.push(args);
      return {};
    };
    createEraseClient(fakePostgres, STAGING_URL);
    expect(calls).toHaveLength(1);
    const [[options, ...extra]] = calls as [[Record<string, unknown>, ...unknown[]]];
    expect(extra).toEqual([]);
    expect(options).toMatchObject({
      host: ["ep-staging.example.neon.tech.invalid"],
      port: [5432],
      database: "neondb",
      username: "fixture",
      ssl: "verify-full",
      max: 1,
    });
    // Bounded operator waits, like revoke-sessions: finite server-enforced
    // statement and lock budgets on this CLI's own single connection.
    expect(options.connection).toMatchObject({ statement_timeout: 10_000, lock_timeout: 5_000 });
    expect((options!.password as () => string)()).toBe("synthetic-password");
    expect(options).not.toHaveProperty("sslmode");
  });

  it("refuses to build a remote client unless its effective TLS is verify-full", () => {
    const calls: Record<string, unknown>[] = [];
    const fakePostgres = (options: Record<string, unknown>) => {
      calls.push(options);
      return {};
    };
    const base =
      "postgres://fixture:synthetic-password@ep-staging.example.neon.tech.invalid/neondb";
    for (const query of ["", "?sslmode=require", "?sslmode=disable"])
      expect(() => createEraseClient(fakePostgres, `${base}${query}`), query).toThrow(
        "requires verify-full TLS",
      );
    expect(calls).toHaveLength(0);
    createEraseClient(fakePostgres, `${base}?sslrootcert=system`);
    expect(calls[0]).toMatchObject({ ssl: "verify-full" });
  });

  it("gives the driver the same normalized host the TLS classifier checks", () => {
    const calls: Record<string, unknown>[] = [];
    createEraseClient(recordingPostgres(calls), STAGING_UPPER_URL);
    expect(calls[0]).toMatchObject({ host: ["ep-staging.example.invalid"], ssl: "verify-full" });
  });

  it("keeps the agent-testdb client plaintext by default", () => {
    const calls: Record<string, unknown>[] = [];
    createEraseClient(recordingPostgres(calls), LOCAL_URL);
    expect(calls[0]).toMatchObject({ ssl: false });
  });

  it("refuses unauthorized remote URLs before connecting and never echoes them", () => {
    const cases: [string[], Record<string, string>, string][] = [
      [[`--discord-id=${MEMBER_A}`], { DATABASE_URL: POOLER_URL }, NO_TARGET],
      [[`--discord-id=${MEMBER_A}`], { DATABASE_URL: PSDB_URL }, NO_TARGET],
      [[`--discord-id=${MEMBER_A}`], { DATABASE_URL: OPAQUE_URL }, NO_TARGET],
      [
        [`--discord-id=${MEMBER_A}`, "--target", "staging"],
        { DATABASE_URL: STAGING_REQUIRE_URL },
        TLS_REQUIRED,
      ],
      [
        [`--discord-id=${MEMBER_A}`, "--target", "staging"],
        { DATABASE_URL: STAGING_URL, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
        "NODE_TLS_REJECT_UNAUTHORIZED=0",
      ],
    ];
    for (const [args, env, reason] of cases) {
      const result = run(args, env);
      expect(result.status, reason).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(reason);
      const output = result.stdout + result.stderr;
      for (const secret of [env.DATABASE_URL!, "synthetic-password", MEMBER_A, "postgres://"])
        expect(output).not.toContain(secret);
    }
  });

  it("checks the live process environment for the TLS override, not only the env argument", () => {
    // The port is closed: if the gate is missing, the run fails with exit 1, never a live connection.
    const code = `import(${JSON.stringify(pathToFileURL(script).href)}).then((m) => m.main(["--discord-id=${MEMBER_A}"], { DATABASE_URL: "postgres://fixture@127.0.0.1:1/neondb" })).then((code) => { process.exitCode = code; });`;
    const result = spawnSync(
      process.execPath,
      ["--import", "./bin/ts-hook.mjs", "--input-type=module", "-e", code],
      {
        env: { PATH: process.env.PATH ?? "", NODE_TLS_REJECT_UNAUTHORIZED: "0" },
        cwd: fileURLToPath(new URL("..", import.meta.url).href),
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("NODE_TLS_REJECT_UNAUTHORIZED=0");
    expect(result.stdout + result.stderr).not.toContain("127.0.0.1:1");
  });
});

const url = process.env.DATABASE_URL;
describe.skipIf(!url)("member erasure against isolated test Postgres", () => {
  let fixture: MemberDataFixture;
  let eventId: number;

  const seedMember = async (id: string, username: string) => {
    // Bind expiry as ISO text: the driver's Date serializer is version-sensitive,
    // and text casts to timestamptz without touching it.
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await fixture.client`insert into users (id, username, member) values (${id}, ${username}, true)`;
    await fixture.client`insert into profiles (user_id, bio, games, timezone)
      values (${id}, ${`bio for ${id}`}, '["Synthetic Game"]', 'Europe/London')`;
    await fixture.client`insert into rsvps (event_id, user_id, status)
      values (${eventId}, ${id}, 'going')`;
    await fixture.client`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
      values (${`hash-${id}-1`}, ${id}, ${username}, true, false, ${expiresAt}),
             (${`hash-${id}-2`}, ${id}, ${username}, true, false, ${expiresAt})`;
    await fixture.client`insert into join_attempts (outcome, source, request_id, discord_id)
      values ('added', 'site', ${`request-${id}`}, ${id})`;
  };

  const countsFor = async (id: string) => {
    const [[u], [p], [r], [s], [g], [j]] = await Promise.all([
      fixture.client`select count(*)::int as n from users where id = ${id}`,
      fixture.client`select count(*)::int as n from profiles where user_id = ${id}`,
      fixture.client`select count(*)::int as n from rsvps where user_id = ${id}`,
      fixture.client`select count(*)::int as n from web_sessions where user_id = ${id}`,
      fixture.client`select count(*)::int as n from web_session_grace where user_id = ${id}`,
      fixture.client`select count(*)::int as n from join_attempts where discord_id = ${id}`,
    ]);
    return {
      users: (u as { n: number }).n,
      profiles: (p as { n: number }).n,
      rsvps: (r as { n: number }).n,
      web_sessions: (s as { n: number }).n,
      web_session_grace: (g as { n: number }).n,
      join_attempts: (j as { n: number }).n,
      overlay_configs: 0,
      overlay_tokens: 0,
    };
  };

  beforeAll(async () => {
    fixture = await createMemberDataFixture(url!);
    const { migrate } = await import("../src/sessions");
    await migrate(fixture.client as unknown as Parameters<typeof migrate>[0]);
  });

  beforeEach(async () => {
    await fixture.client`delete from web_session_grace`;
    await fixture.client`delete from web_sessions`;
    await fixture.client`delete from rsvps`;
    await fixture.client`delete from profiles`;
    await fixture.client`delete from join_attempts`;
    await fixture.client`delete from events`;
    await fixture.client`delete from users`;
    const [event] = (await fixture.client`insert into events
      (event_key, title, starts_at, ends_at) values
      (${EVENT_KEY}, 'Synthetic erasure event', '2099-11-04T20:00:00Z', '2099-11-04T22:00:00Z')
      returning id`) as { id: number }[];
    eventId = event!.id;
    await seedMember(MEMBER_A, "synthetic-erase-a");
    await seedMember(MEMBER_B, "synthetic-erase-b");
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  it("dry-run counts member A without changing anything", async () => {
    const before = await countsFor(MEMBER_A);
    expect(before).toEqual({
      users: 1,
      profiles: 1,
      rsvps: 1,
      web_sessions: 2,
      web_session_grace: 0,
      join_attempts: 1,
      overlay_configs: 0,
      overlay_tokens: 0,
    });
    const preview = await eraseMember(
      fixture.client as unknown as Parameters<typeof eraseMember>[0],
      MEMBER_A,
      { dryRun: true },
    );
    expect(preview).toEqual({ ...before, passes: 0, deletesPerPass: [] });
    expect(await countsFor(MEMBER_A)).toEqual(before);
    expect(await countsFor(MEMBER_B)).toEqual(before);
  });

  it("apply removes exactly member A across all six tables and leaves member B intact", async () => {
    const removed = await eraseMember(
      fixture.client as unknown as Parameters<typeof eraseMember>[0],
      MEMBER_A,
      { dryRun: false },
    );
    expect(removed).toEqual({
      users: 1,
      profiles: 1,
      rsvps: 1,
      web_sessions: 2,
      web_session_grace: 0,
      join_attempts: 1,
      overlay_configs: 0,
      overlay_tokens: 0,
      passes: 1,
      deletesPerPass: [2],
    });
    expect(await countsFor(MEMBER_A)).toEqual({
      users: 0,
      profiles: 0,
      rsvps: 0,
      web_sessions: 0,
      web_session_grace: 0,
      join_attempts: 0,
      overlay_configs: 0,
      overlay_tokens: 0,
    });
    expect(await countsFor(MEMBER_B)).toEqual({
      users: 1,
      profiles: 1,
      rsvps: 1,
      web_sessions: 2,
      web_session_grace: 0,
      join_attempts: 1,
      overlay_configs: 0,
      overlay_tokens: 0,
    });
    // The event itself survives: erasure removes answers, never content.
    expect(
      ((await fixture.client`select count(*)::int as n from events`) as { n: number }[])[0]!.n,
    ).toBe(1);
  });

  it("a second apply is a no-op", async () => {
    await eraseMember(fixture.client as unknown as Parameters<typeof eraseMember>[0], MEMBER_A, {
      dryRun: false,
    });
    const repeat = await eraseMember(
      fixture.client as unknown as Parameters<typeof eraseMember>[0],
      MEMBER_A,
      { dryRun: false },
    );
    expect(repeat).toEqual({
      users: 0,
      profiles: 0,
      rsvps: 0,
      web_sessions: 0,
      web_session_grace: 0,
      join_attempts: 0,
      overlay_configs: 0,
      overlay_tokens: 0,
      passes: 1,
      deletesPerPass: [0],
    });
    expect(await countsFor(MEMBER_B)).toEqual({
      users: 1,
      profiles: 1,
      rsvps: 1,
      web_sessions: 2,
      web_session_grace: 0,
      join_attempts: 1,
      overlay_configs: 0,
      overlay_tokens: 0,
    });
  });
});
