import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type postgres from "postgres";
import {
  createMemorySessionStore,
  createPostgresSessionStore,
  migrate,
  type SessionStore,
  type Sql,
} from "../src/sessions";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const url = process.env.DATABASE_URL;
const session = (tokenHash: string) => ({
  tokenHash,
  userId: "rotation-test-user",
  username: "Rotation fixture",
  avatar: null,
  member: true,
  moderator: false,
  expiresAt: new Date(Date.now() + 3600_000),
});

type Harness = { store: SessionStore; expire: (hash: string) => Promise<void> };

function eligibilityContract(make: () => Harness) {
  it("refuses get -> committed revoke -> rotate without minting a replacement", async () => {
    const { store } = make();
    const source = session("revoke-source");
    await store.create(source);
    expect(await store.get(source.tokenHash)).not.toBeNull();
    await store.revoke(source.tokenHash);
    expect(await store.rotate(source.tokenHash, session("revoke-replacement"))).toBe(false);
    expect(await store.get(source.tokenHash)).toBeNull();
    expect(await store.get("revoke-replacement")).toBeNull();
  });

  it("refuses a session that expires between get and rotate", async () => {
    const { store, expire } = make();
    const source = session("expiry-source");
    await store.create(source);
    expect(await store.get(source.tokenHash)).not.toBeNull();
    await expire(source.tokenHash);
    expect(await store.rotate(source.tokenHash, session("expiry-replacement"))).toBe(false);
    expect(await store.get(source.tokenHash)).toBeNull();
    expect(await store.get("expiry-replacement")).toBeNull();
  });

  it.each(["revoked", "expired"])("refuses a %s same-hash rotation", async (state) => {
    const { store, expire } = make();
    const source = session("same-hash-source");
    await store.create(source);
    if (state === "revoked") await store.revoke(source.tokenHash);
    else await expire(source.tokenHash);
    expect(await store.rotate(source.tokenHash, { ...source, moderator: true })).toBe(false);
    expect(await store.get(source.tokenHash)).toBeNull();
  });

  it("accepts active rotation and rejects old-token replay and unknown sources", async () => {
    const { store } = make();
    const source = session("active-source");
    await store.create(source);
    expect(await store.rotate(source.tokenHash, source)).toBe(true);
    expect(await store.rotate(source.tokenHash, session("active-replacement"))).toBe(true);
    expect(await store.get(source.tokenHash)).toBeNull();
    expect(await store.get("active-replacement")).toMatchObject({ userId: source.userId });
    expect(await store.rotate(source.tokenHash, session("replay-replacement"))).toBe(false);
    expect(await store.get("replay-replacement")).toBeNull();
    expect(await store.rotate("missing", session("missing"))).toBe(false);
  });

  it("allows only one concurrent rotation to mint a replacement", async () => {
    const { store } = make();
    const source = session("concurrent-source");
    await store.create(source);
    const replacements = [session("winner-a"), session("winner-b")];
    const results = await Promise.all(replacements.map((r) => store.rotate(source.tokenHash, r)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.get(source.tokenHash)).toBeNull();
    for (const [i, replacement] of replacements.entries()) {
      expect(Boolean(await store.get(replacement.tokenHash))).toBe(results[i]);
    }
  });
}

describe("memory rotation eligibility", () => {
  let now: number;
  let store: SessionStore;
  beforeEach(() => {
    now = Date.now();
    store = createMemorySessionStore(() => now);
  });
  eligibilityContract(() => ({ store, expire: async () => { now = Date.now() + 3600_000; } }));
});

// Safe target validation precedes driver construction. Every write, constraint
// and cleanup is confined to the fixture's disposable schema, not public.
describe.skipIf(!url)("postgres rotation eligibility", () => {
  let fixture: JobsFixture | undefined;
  let sql: postgres.Sql;
  let store: SessionStore;
  beforeAll(async () => {
    fixture = await createJobsFixture(url!, { max: 4 });
    sql = fixture.client;
    await migrate(sql as unknown as Sql);
    store = createPostgresSessionStore(sql as unknown as Sql);
  });
  beforeEach(async () => { await sql`delete from web_sessions`; });
  afterAll(async () => { await fixture?.dispose(); });
  eligibilityContract(() => ({
    store,
    expire: async (hash) => {
      await sql`update web_sessions set expires_at = clock_timestamp() - interval '1 second'
        where token_hash = ${hash}`;
    },
  }));

  it("keeps an active same-hash rotation a no-op", async () => {
    const source = session("no-op-source");
    await store.create(source);
    const before = await sql`select * from web_sessions where token_hash = ${source.tokenHash}`;
    expect(await store.rotate(source.tokenHash, {
      ...source, moderator: true, expiresAt: new Date(source.expiresAt.getTime() + 3600_000),
    })).toBe(true);
    expect(await sql`select * from web_sessions where token_hash = ${source.tokenHash}`).toEqual(before);
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
    throw new Error("rotation did not reach the held row lock");
  }

  it.each([false, true])("refuses committed revocation after a row-lock wait (same hash: %s)", async (sameHash) => {
    const source = session("locked-revoke-source");
    const replacement = session(sameHash ? source.tokenHash : "locked-revoke-replacement");
    await store.create(source);
    expect(await store.get(source.tokenHash)).not.toBeNull();
    let rotation: Promise<boolean> | undefined;
    try {
      await sql.begin(async (tx) => {
        const [holder] = await tx`select pg_backend_pid() as pid`;
        await tx`select token_hash from web_sessions where token_hash = ${source.tokenHash} for update`;
        rotation = store.rotate(source.tokenHash, replacement);
        await waitForBlocked(holder!.pid);
        await createPostgresSessionStore(tx as unknown as Sql).revoke(source.tokenHash);
      }); // Revocation commits before the waiting rotation can acquire the lock.
      expect(await rotation).toBe(false);
      expect(await store.get(replacement.tokenHash)).toBeNull();
      const rows = await sql`select token_hash, revoked_at from web_sessions`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ token_hash: source.tokenHash, revoked_at: expect.any(Date) });
    } finally { await rotation; }
  });

  it.each([false, true])("rechecks wall clock after an unchanged row-lock wait (same hash: %s)", async (sameHash) => {
    const source = session("locked-expiry-source");
    const replacement = session(sameHash ? source.tokenHash : "locked-expiry-replacement");
    await store.create(source);
    expect(await store.get(source.tokenHash)).not.toBeNull();
    // Set expiry before taking the lock: the holder must not update the tuple.
    // Otherwise Postgres may re-evaluate a pre-lock WHERE clause after an update,
    // hiding the bug in a plain DELETE ... expires_at > clock_timestamp().
    await sql`update web_sessions set expires_at = clock_timestamp() + interval '3 seconds'
      where token_hash = ${source.tokenHash}`;
    let rotation: Promise<boolean> | undefined;
    try {
      await sql.begin(async (tx) => {
        const [holder] = await tx`select pg_backend_pid() as pid`;
        await tx`select token_hash from web_sessions where token_hash = ${source.tokenHash} for update`;
        rotation = store.rotate(source.tokenHash, replacement);
        await waitForBlocked(holder!.pid);
        const [before] = await tx`select expires_at > clock_timestamp() as live from web_sessions
          where token_hash = ${source.tokenHash}`;
        expect(before!.live).toBe(true);
        await tx`select pg_sleep(greatest(0, extract(epoch from expires_at - clock_timestamp()))::float8 + 0.01)
          from web_sessions where token_hash = ${source.tokenHash}`;
        const [after] = await tx`select expires_at > now() as transaction_live,
          expires_at <= clock_timestamp() as expired from web_sessions where token_hash = ${source.tokenHash}`;
        expect(after).toMatchObject({ transaction_live: true, expired: true });
      });
      expect(await rotation).toBe(false);
      expect(await store.get(replacement.tokenHash)).toBeNull();
      const rows = await sql`select token_hash from web_sessions`;
      expect(rows).toEqual([{ token_hash: source.tokenHash }]);
    } finally { await rotation; }
  }, 10_000);

  it("does not renew an expired session using an older transaction's now()", async () => {
    const source = session("old-transaction-source");
    await store.create(source);
    await sql.begin(async (tx) => {
      await tx`update web_sessions set expires_at = now() + interval '0.2 seconds'
        where token_hash = ${source.tokenHash}`;
      await tx`select pg_sleep(0.3)`;
      const [row] = await tx`select expires_at > now() as transaction_live,
        expires_at <= clock_timestamp() as expired from web_sessions where token_hash = ${source.tokenHash}`;
      expect(row).toMatchObject({ transaction_live: true, expired: true });
      const txStore = createPostgresSessionStore(tx as unknown as Sql);
      expect(await txStore.rotate(source.tokenHash, session("old-transaction-replacement"))).toBe(false);
      expect(await txStore.rotate(source.tokenHash, source)).toBe(false);
    });
    expect(await store.get("old-transaction-replacement")).toBeNull();
  });

  it("rolls back deletion when replacement insertion fails", async () => {
    const source = session("rollback-source");
    await store.create(source);
    await sql`alter table web_sessions add constraint rotation_fixture_username
      check (username <> 'invalid-replacement')`;
    try {
      await expect(store.rotate(source.tokenHash, {
        ...session("rollback-replacement"), username: "invalid-replacement",
      })).rejects.toMatchObject({ code: "23514" });
      expect(await store.get(source.tokenHash)).toMatchObject({ username: source.username });
      expect(await store.get("rollback-replacement")).toBeNull();
      expect(await sql`select token_hash from web_sessions`).toEqual([{ token_hash: source.tokenHash }]);
    } finally {
      await sql`alter table web_sessions drop constraint rotation_fixture_username`;
    }
  });
});
