import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { createPostgresSessionStore, type Sql } from "../src/sessions";
import { countActiveMemberSessions, revokeMemberSessions } from "../src/session-revocation";
// @ts-expect-error Standalone Node CLI is intentionally JavaScript, like bin/import.
// biome-ignore format: keep the directive adjacent to TS7016 (wrapping detaches it)
import { createRevokeClient, isProductionDatabaseUrl, parseRevokeArgs, validateRevokeEnvironment } from "../bin/revoke-sessions.mjs";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const script = fileURLToPath(new URL("../bin/revoke-sessions.mjs", import.meta.url).href);
const run = (args: string[] = [], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["--import", "./bin/ts-hook.mjs", script, ...args], {
    env,
    cwd: fileURLToPath(new URL("..", import.meta.url).href),
    encoding: "utf8",
    timeout: 20_000,
  });
const MEMBER_A = "100000000000000201";
const MEMBER_B = "100000000000000202";
const url = process.env.DATABASE_URL;

describe("revoke-sessions CLI safety", () => {
  it("defaults to dry-run, accepts apply, and rejects invalid arguments", () => {
    expect(parseRevokeArgs([`--discord-id=${MEMBER_A}`])).toEqual({
      discordId: MEMBER_A,
      mode: "dry-run",
      target: undefined,
    });
    expect(parseRevokeArgs([`--discord-id=${MEMBER_A}`, "--apply"]).mode).toBe("apply");
    for (const args of [
      [],
      ["--discord-id=bad"],
      [`--discord-id=${MEMBER_A}`, "--apply", "--dry-run"],
      ["--discord-id=", `--discord-id=${MEMBER_A}`],
      [`--discord-id=${MEMBER_A}`, "--target=staging"],
      [`--discord-id=${MEMBER_A}`, "--target", "production", "--target=production"],
    ])
      expect(() => parseRevokeArgs(args)).toThrow();
    const malformed = run(["--discord-id=bad"], {
      DATABASE_URL: "postgres://agent_test@127.0.0.1:1/test",
    });
    expect(malformed.status).toBe(2);
    expect(malformed.stderr).toContain("malformed Discord id");
    const unavailable = run([`--discord-id=${MEMBER_A}`], {
      DATABASE_URL: "postgres://agent_test@127.0.0.1:1/test",
    });
    expect(unavailable.status).toBe(1);
    expect(unavailable.stdout + unavailable.stderr).not.toContain("postgres://");
  });

  it("runs when invoked through a symlink", async () => {
    const { mkdtempSync, symlinkSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = mkdtempSync(join(tmpdir(), "revoke-sessions-link-"));
    const link = join(directory, "revoke.mjs");
    try {
      symlinkSync(script, link);
      const result = spawnSync(
        process.execPath,
        ["--import", "./bin/ts-hook.mjs", link, `--discord-id=${MEMBER_A}`],
        {
          env: { DATABASE_URL: "postgres://agent_test@127.0.0.1:1/test" },
          cwd: fileURLToPath(new URL("..", import.meta.url).href),
          encoding: "utf8",
          timeout: 20_000,
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("operation failed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves validated TLS and IPv6 connection settings", () => {
    let first: unknown;
    let options: any;
    const capture = (firstArg: unknown, secondArg?: unknown) => {
      first = firstArg;
      options = secondArg ?? firstArg;
      return {};
    };
    createRevokeClient(capture, "postgres://fixture@[::1]:5432/test?sslmode=disable");
    expect(options).toMatchObject({ host: ["::1"], port: [5432], ssl: false });
    createRevokeClient(capture, "postgres://fixture@localhost/test?sslrootcert=system");
    expect(options).toMatchObject({ host: ["localhost"], port: [5432], ssl: "verify-full" });
    createRevokeClient(capture, "postgres://fixture@db.example.test/neondb");
    expect(options).toMatchObject({ host: ["db.example.test"], port: [5432], ssl: "verify-full" });
    // The raw URL must never reach postgres.js: its query string would be
    // forwarded as server startup parameters (sslrootcert -> Postgres 42704).
    for (const raw of [
      "postgres://fixture@localhost/test?sslrootcert=system",
      "postgres://fixture@db.example.test/neondb?sslmode=verify-full",
    ]) {
      createRevokeClient(capture, raw);
      expect(typeof first).not.toBe("string");
      expect(JSON.stringify(options)).not.toContain("sslrootcert");
      expect(options).not.toHaveProperty("sslrootcert");
      expect(options.connection).not.toHaveProperty("sslrootcert");
      expect(options.ssl).toBe("verify-full");
    }
    expect(() =>
      validateRevokeEnvironment(
        { DATABASE_URL: "postgres://fixture@db.example.test/neondb?sslmode=require" },
        "production",
      ),
    ).toThrow("sslmode=verify-full");
    expect(() =>
      validateRevokeEnvironment(
        { DATABASE_URL: "postgres://fixture@db.example.test/neondb?sslmode=disable" },
        "production",
      ),
    ).toThrow("sslmode=verify-full");
    expect(() =>
      validateRevokeEnvironment(
        { DATABASE_URL: "postgres://fixture@db.example.test/neondb?sslmode=verify-ca" },
        "production",
      ),
    ).toThrow("sslmode=verify-full");
    expect(
      validateRevokeEnvironment(
        { DATABASE_URL: "postgres://fixture@db.example.test/neondb?sslmode=verify-full" },
        "production",
      ).databaseUrl,
    ).toContain("sslmode=verify-full");
    expect(
      validateRevokeEnvironment(
        { DATABASE_URL: "postgres://fixture@db.example.test/neondb?sslrootcert=system" },
        "production",
      ).databaseUrl,
    ).toContain("sslrootcert=system");
    expect(() =>
      validateRevokeEnvironment(
        {
          DATABASE_URL: "postgres://fixture@db.example.test/neondb?sslmode=verify-full",
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
        },
        "production",
      ),
    ).toThrow("disables TLS verification");
  });

  it("refuses production-looking URLs unless explicitly targeted and never prints URLs", () => {
    const production = "postgres://fixture:synthetic-password@db.production.test/neondb";
    expect(isProductionDatabaseUrl(production)).toBe(true);
    expect(() => validateRevokeEnvironment({ DATABASE_URL: production }, undefined)).toThrow(
      "--target production",
    );
    expect(validateRevokeEnvironment({ DATABASE_URL: production }, "production").databaseUrl).toBe(
      production,
    );
    expect(() =>
      validateRevokeEnvironment(
        { DATABASE_URL: "postgres://fixture@ep-staging.example.neon.tech/neondb" },
        undefined,
      ),
    ).toThrow("--target production");
    const result = run([`--discord-id=${MEMBER_A}`], { DATABASE_URL: production });
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).not.toContain("synthetic-password");
    expect(result.stdout + result.stderr).not.toContain("postgres://");
  });
});

describe.skipIf(!url)("session revocation against isolated test Postgres", () => {
  let fixture: MemberDataFixture;
  const expiresLater = new Date(Date.now() + 3_600_000).toISOString();
  const expiresEarlier = new Date(Date.now() - 3_600_000).toISOString();

  beforeAll(async () => {
    fixture = await createMemberDataFixture(url!, { max: 4 });
    const { migrate } = await import("../src/sessions");
    await migrate(fixture.client as unknown as Parameters<typeof migrate>[0]);
  });

  beforeEach(async () => {
    await fixture.client`delete from web_sessions`;
    await fixture.client`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at, revoked_at)
      values ('active-a', ${MEMBER_A}, 'synthetic-a', true, true, ${expiresLater}, null),
             ('revoked-a', ${MEMBER_A}, 'synthetic-a', true, true, ${expiresLater}, clock_timestamp()),
             ('expired-a', ${MEMBER_A}, 'synthetic-a', true, true, ${expiresEarlier}, null),
             ('active-b', ${MEMBER_B}, 'synthetic-b', true, false, ${expiresLater}, null)`;
  });

  afterAll(async () => fixture?.dispose());

  const counts = async (id: string) => {
    const [row] = await fixture.client<{ n: number }[]>`select count(*)::int as n from web_sessions
      where user_id = ${id} and revoked_at is null and expires_at > clock_timestamp()`;
    return row?.n ?? 0;
  };

  it("dry-run reports only active sessions and changes nothing", async () => {
    const sql = fixture.client as unknown as Parameters<typeof revokeMemberSessions>[0];
    expect(await countActiveMemberSessions(sql, MEMBER_A)).toEqual({ web_sessions: 1 });
    expect(await revokeMemberSessions(sql, MEMBER_A, { dryRun: true })).toEqual({
      web_sessions: 1,
    });
    expect(await counts(MEMBER_A)).toBe(1);
    expect(await counts(MEMBER_B)).toBe(1);
  });

  it("apply revokes only active target sessions, preserves expired/revoked and other members", async () => {
    const sql = fixture.client as unknown as Parameters<typeof revokeMemberSessions>[0];
    expect(await revokeMemberSessions(sql, MEMBER_A, { dryRun: false })).toEqual({
      web_sessions: 1,
    });
    const [rows] = await fixture.client<{ n: number }[]>`select count(*)::int as n from web_sessions
      where user_id = ${MEMBER_A} and revoked_at is not null`;
    expect(rows?.n).toBe(2);
    expect(await counts(MEMBER_A)).toBe(0);
    expect(await counts(MEMBER_B)).toBe(1);
    expect(await revokeMemberSessions(sql, MEMBER_A, { dryRun: false })).toEqual({
      web_sessions: 0,
    });
  });

  it("rolls back the revocation when the database rejects an update", async () => {
    await fixture.client`alter table web_sessions add constraint revoke_sessions_fixture_check
      check (token_hash <> 'active-a' or revoked_at is null)`;
    try {
      const sql = fixture.client as unknown as Parameters<typeof revokeMemberSessions>[0];
      await expect(revokeMemberSessions(sql, MEMBER_A, { dryRun: false })).rejects.toMatchObject({
        code: "23514",
      });
      expect(await counts(MEMBER_A)).toBe(1);
      expect(await counts(MEMBER_B)).toBe(1);
    } finally {
      await fixture.client`alter table web_sessions drop constraint revoke_sessions_fixture_check`;
    }
  });

  it("catches a session inserted by a rotation queued ahead of revocation", async () => {
    await fixture.client`delete from web_sessions`;
    await fixture.client`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
      values ('race-other-user', ${MEMBER_B}, 'synthetic-b', true, false, ${expiresLater})`;
    const store = createPostgresSessionStore(fixture.client as unknown as Sql);
    const source = {
      tokenHash: "race-source",
      userId: MEMBER_A,
      username: "synthetic-a",
      avatar: null,
      member: true,
      moderator: true,
      // Fixture binds expiry as ISO text because postgres.js date serialization varies by version.
      expiresAt: expiresLater as unknown as Date,
    };
    await store.create(source);
    let rotation: Promise<boolean> | undefined;
    let revocation: ReturnType<typeof revokeMemberSessions> | undefined;
    const waitForBlocked = async (query: string) => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const blocked = await fixture.client`select pid from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and query ilike ${`%${query}%`}`;
        if (blocked.length) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`expected ${query} to reach the held row lock`);
    };
    try {
      await fixture.client.begin(async (tx) => {
        await tx`select pg_backend_pid()`;
        await tx`select token_hash from web_sessions where token_hash = ${source.tokenHash} for update`;
        rotation = store.rotate(source.tokenHash, { ...source, tokenHash: "race-replacement" });
        await waitForBlocked("with locked as materialized");
        revocation = revokeMemberSessions(
          fixture.client as unknown as Parameters<typeof revokeMemberSessions>[0],
          MEMBER_A,
          { dryRun: false },
        );
        await waitForBlocked("update web_sessions");
      });
      expect(await rotation).toBe(true);
      expect(await revocation).toEqual({ web_sessions: 1 });
      expect(await counts(MEMBER_A)).toBe(0);
      expect(await counts(MEMBER_B)).toBe(1);
    } finally {
      await Promise.all([rotation, revocation].filter(Boolean));
    }
  });
});
