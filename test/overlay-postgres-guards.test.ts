// Regression pins for the Postgres lifecycle and member-erasure boundary.
// The separate slice-1 acceptance suite remains unchanged.
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { countMemberRows, eraseMember, type ErasureSql } from "../src/member-erasure";
import {
  createPostgresOverlayTokenStore,
  hashOverlayToken,
  newOverlayToken,
  type OverlayTokenStore,
} from "../src/overlay-tokens";
import { migrate, type Sql } from "../src/sessions";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const member = "731000000000000001";
const other = "731000000000000002";
const freshHash = () => hashOverlayToken(newOverlayToken());

describe.skipIf(!process.env.DATABASE_URL)("overlay Postgres security guards", () => {
  let fixture: JobsFixture | undefined;
  let sql: postgres.Sql;
  let store: OverlayTokenStore;

  beforeAll(async () => {
    fixture = await createJobsFixture(process.env.DATABASE_URL!, { max: 4 });
    sql = fixture.client;
    await migrate(sql as unknown as Sql);
    store = createPostgresOverlayTokenStore(sql as unknown as Sql);
  });

  beforeEach(async () => {
    await sql`delete from overlay_tokens`;
    await sql`delete from overlay_configs`;
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  async function waitForBlocked(blocker: number) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const rows = await sql`select pid from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and ${blocker} = any(pg_blocking_pids(pid))`;
      if (rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("member operation did not reach the in-flight rotation lock");
  }

  it("revokes a successor committed after the revocation statement snapshot", async () => {
    const source = await freshHash();
    const successor = await freshHash();
    const bystander = await freshHash();
    await store.mint(member, source);
    await store.mint(other, bystander);
    let revocation: Promise<number> | undefined;
    try {
      await sql.begin(async (tx) => {
        const [holder] = await tx`select pg_backend_pid() as pid`;
        const rotating = createPostgresOverlayTokenStore(tx as unknown as Sql);
        expect(await rotating.rotate(member, source, successor)).toBe(true);
        // The successor exists only in this uncommitted transaction. The
        // revoker sees the old live predecessor, then waits on its row lock.
        revocation = store.revokeMemberTokens(member);
        await waitForBlocked(holder!.pid);
      });
      expect(await revocation).toBe(1);
      expect(await store.lookupByHash(source)).toBeNull();
      expect(await store.lookupByHash(successor)).toBeNull();
      expect(await store.lookupByHash(bystander)).toMatchObject({ memberId: other });
      expect((await store.listMemberTokens(member)).map((row) => row.status)).toEqual([
        "rotated",
        "revoked",
      ]);
    } finally {
      await revocation;
    }
  });

  it("enforces the partial unique index even for direct concurrent live inserts", async () => {
    const first = await freshHash();
    const second = await freshHash();
    const results = await Promise.allSettled([
      sql`insert into overlay_tokens (member_id, token_hash) values (${member}, ${first})`,
      sql`insert into overlay_tokens (member_id, token_hash) values (${member}, ${second})`,
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: { code: "23505", constraint_name: "overlay_tokens_member_live_unique" } },
    ]);
    // The predicate permits non-live history and a different member's live row.
    await sql`insert into overlay_tokens (member_id, token_hash, status)
      values (${member}, ${await freshHash()}, 'revoked'), (${other}, ${await freshHash()}, 'live')`;
    expect(await store.listMemberTokens(member)).toHaveLength(2);
  });

  it("allows exactly one concurrent store mint for a member", async () => {
    const hashes = [await freshHash(), await freshHash()];
    const results = await Promise.allSettled(hashes.map((hash) => store.mint(member, hash)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await store.listMemberTokens(member)).toHaveLength(1);
  });

  it("refuses another member's rotation without changing rows or creating a successor", async () => {
    const source = await freshHash();
    const successor = await freshHash();
    await store.mint(member, source);
    const before = await store.listMemberTokens(member);
    expect(await store.rotate(other, source, successor)).toBe(false);
    expect(await store.listMemberTokens(member)).toEqual(before);
    expect(await store.listMemberTokens(other)).toEqual([]);
    expect(await store.lookupByHash(successor)).toBeNull();
  });

  it("refuses predecessor replay after a successful rotation", async () => {
    const source = await freshHash();
    const successor = await freshHash();
    const replay = await freshHash();
    await store.mint(member, source);
    expect(await store.rotate(member, source, successor)).toBe(true);
    expect(await store.rotate(member, source, replay)).toBe(false);
    expect(await store.lookupByHash(replay)).toBeNull();
    expect(await store.listMemberTokens(member)).toHaveLength(2);
  });

  it("spares an aged token rotated inside grace, then prunes it at the exact deadline", async () => {
    const source = await freshHash();
    const successor = await freshHash();
    await store.mint(member, source);
    await sql`update overlay_tokens set created_at = clock_timestamp() - interval '91 days'
      where token_hash = ${source}`;
    expect(await store.rotate(member, source, successor)).toBe(true);
    const [row] = await sql`select rotated_at from overlay_tokens where token_hash = ${source}`;
    const rotatedAt = row!.rotated_at as Date;
    // Pin to JS millisecond precision; PG clock_timestamp() has microseconds.
    await sql`update overlay_tokens set rotated_at = ${rotatedAt} where token_hash = ${source}`;
    // Both assertions use the caller's supplied prune clock, not runner speed.
    expect(await store.pruneHistory(new Date(rotatedAt.getTime() + 9999))).toBe(0);
    expect(await store.listMemberTokens(member)).toHaveLength(2);
    expect(await store.pruneHistory(new Date(rotatedAt.getTime() + 10_000))).toBe(1);
    expect((await store.listMemberTokens(member)).map((token) => token.tokenHash)).toEqual([
      successor,
    ]);
  });

  it("counts and erases overlay configs and all token history, sparing another member", async () => {
    const source = await freshHash();
    const successor = await freshHash();
    const bystander = await freshHash();
    await store.mint(member, source);
    expect(await store.rotate(member, source, successor)).toBe(true);
    await store.mint(other, bystander);
    await sql`insert into overlay_configs (member_id, elements)
      values (${member}, '{"label":"fixture"}'::jsonb), (${other}, '{}'::jsonb)`;
    const erasureSql = sql as unknown as ErasureSql;
    expect(await countMemberRows(erasureSql, member)).toMatchObject({
      overlay_configs: 1,
      overlay_tokens: 2,
    });
    expect(await eraseMember(erasureSql, member, { dryRun: true })).toMatchObject({
      overlay_configs: 1,
      overlay_tokens: 2,
      passes: 0,
    });
    expect(await store.listMemberTokens(member)).toHaveLength(2);
    expect(await eraseMember(erasureSql, member, { dryRun: false })).toMatchObject({
      overlay_configs: 1,
      overlay_tokens: 2,
    });
    expect(await countMemberRows(erasureSql, member)).toMatchObject({
      overlay_configs: 0,
      overlay_tokens: 0,
    });
    expect(await store.lookupByHash(source)).toBeNull();
    expect(await store.lookupByHash(successor)).toBeNull();
    expect(await store.lookupByHash(bystander)).toMatchObject({ memberId: other });
    expect(await sql`select member_id from overlay_configs`).toEqual([{ member_id: other }]);
  });

  it("erases a successor committed after the erasure statement snapshot", async () => {
    const source = await freshHash();
    const successor = await freshHash();
    await store.mint(member, source);
    let erasure: ReturnType<typeof eraseMember> | undefined;
    try {
      await sql.begin(async (tx) => {
        const [holder] = await tx`select pg_backend_pid() as pid`;
        expect(
          await createPostgresOverlayTokenStore(tx as unknown as Sql).rotate(
            member,
            source,
            successor,
          ),
        ).toBe(true);
        erasure = eraseMember(sql as unknown as ErasureSql, member, { dryRun: false });
        await waitForBlocked(holder!.pid);
      });
      expect(await erasure).toMatchObject({ overlay_tokens: 2 });
      expect(await store.listMemberTokens(member)).toEqual([]);
      expect(await store.lookupByHash(source)).toBeNull();
      expect(await store.lookupByHash(successor)).toBeNull();
    } finally {
      await erasure;
    }
  });
});
