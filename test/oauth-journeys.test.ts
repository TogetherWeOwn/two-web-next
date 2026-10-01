import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  createMemoryOAuthJourneyStore,
  createPostgresOAuthJourneyStore,
  migrateOAuthJourneys,
  OAUTH_JOURNEY_TTL_SECONDS,
  type OAuthJourneyStore,
} from "../src/oauth-journeys";
import { createMemorySessionStore, createPostgresSessionStore, hashToken, migrate, type SessionStore, type Sql } from "../src/sessions";

import { authTestDatabaseUrl } from "./helpers/auth-test-db";

const url = authTestDatabaseUrl();

function journeyContract(name: string, make: () => OAuthJourneyStore) {
  describe(`${name} OAuth admission`, () => {
    it.each(["auth", "join"] as const)("admits %s once across concurrent consumers and retains the tombstone", async (flow) => {
      const store = make();
      const hash = await hashToken(crypto.randomUUID());
      expect(await store.issue(hash, flow)).toBe(true);
      const answers = await Promise.all(Array.from({ length: 24 }, () => store.consume(hash, flow)));
      expect(answers.filter(Boolean)).toHaveLength(1);
      expect(await store.consume(hash, flow)).toBe(false);
      expect(await store.issue(hash, flow)).toBe(false);
      expect(await store.consume(hash, flow)).toBe(false);
    });

    it("rejects unissued and cross-flow state without spending the valid journey", async () => {
      const store = make();
      const hash = await hashToken(crypto.randomUUID());
      expect(await store.consume(hash, "auth")).toBe(false);
      await store.issue(hash, "auth");
      expect(await store.consume(hash, "join")).toBe(false);
      expect(await store.consume(hash, "auth")).toBe(true);
    });
  });
}

function replacementContract(name: string, make: () => SessionStore) {
  describe(`${name} fresh-login replacement`, () => {
    const row = () => ({
      tokenHash: crypto.randomUUID(), userId: "42", username: "Fixture Member", avatar: null,
      member: true, moderator: false, expiresAt: new Date(Date.now() + 60_000),
    });

    it("revokes an active supplied token, not merely creates a different token", async () => {
      const store = make();
      const old = row();
      const replacement = { ...row(), userId: "43" };
      await store.create(old);
      await store.replace(old.tokenHash, replacement);
      expect(await store.get(old.tokenHash)).toBeNull();
      expect(await store.get(replacement.tokenHash)).toMatchObject({ userId: "43" });
    });

    it("can establish fresh authentication when the prior token is unknown", async () => {
      const store = make();
      const replacement = row();
      await store.replace(crypto.randomUUID(), replacement);
      expect(await store.get(replacement.tokenHash)).toMatchObject({ userId: "42" });
    });

    it("leaves the prior session live if the replacement insert fails", async () => {
      const store = make();
      const old = row();
      const collision = row();
      await store.create(old);
      await store.create(collision);
      await expect(store.replace(old.tokenHash, collision)).rejects.toThrow();
      expect(await store.get(old.tokenHash)).toMatchObject({ userId: "42" });
      expect(await store.get(collision.tokenHash)).toMatchObject({ userId: "42" });
    });

    it("refuses replacement with the same token without revoking it", async () => {
      const store = make();
      const old = row();
      await store.create(old);
      await expect(store.replace(old.tokenHash, old)).rejects.toThrow();
      expect(await store.get(old.tokenHash)).toMatchObject({ userId: "42" });
    });
  });
}

journeyContract("memory", () => createMemoryOAuthJourneyStore());
replacementContract("memory", () => createMemorySessionStore());

it("memory expiry rejects the exact ten-minute boundary even before cleanup", async () => {
  let now = 0;
  const store = createMemoryOAuthJourneyStore(() => now);
  await store.issue("expired", "auth");
  await store.issue("consumed", "join");
  expect(await store.consume("consumed", "join")).toBe(true);
  expect(await store.sweepExpired()).toBe(0);
  now = OAUTH_JOURNEY_TTL_SECONDS * 1000;
  expect(await store.consume("expired", "auth")).toBe(false);
  expect(await store.consume("consumed", "join")).toBe(false);
  expect(await store.sweepExpired()).toBe(2);
  expect(await store.sweepExpired()).toBe(0);
  expect(await store.consume("expired", "auth")).toBe(false);
});

describe.skipIf(!url)("isolated Postgres persistence", () => {
  const sql = postgres(url!, { max: 8 }) as unknown as Sql & { end: () => Promise<void> };
  const peer = postgres(url!, { max: 8 }) as unknown as Sql & { end: () => Promise<void> };
  beforeAll(async () => { await migrate(sql); await migrateOAuthJourneys(peer); });
  afterAll(async () => {
    await sql`delete from web_sessions`;
    await sql`delete from web_oauth_journeys`;
    await sql.end();
    await peer.end();
  });
  journeyContract("postgres", () => createPostgresOAuthJourneyStore(sql));
  replacementContract("postgres", () => createPostgresSessionStore(sql));

  it("independent clients contend on one durable record, which stores only the state hash", async () => {
    const state = crypto.randomUUID();
    const hash = await hashToken(state);
    const first = createPostgresOAuthJourneyStore(sql);
    const second = createPostgresOAuthJourneyStore(peer);
    await first.issue(hash, "join");
    const results = await Promise.all([first.consume(hash, "join"), second.consume(hash, "join")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await sql<{ state_hash: string; flow: string; lifetime: number; consumed_at: Date }[]>`
      select state_hash, flow, extract(epoch from (expires_at - consumed_at))::float8 as lifetime, consumed_at
      from web_oauth_journeys where state_hash = ${hash}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0]!.flow).toBe("join");
    expect(rows[0]!.consumed_at).toBeInstanceOf(Date);
    expect(rows[0]!.lifetime).toBeGreaterThan(590);
    expect(rows[0]!.lifetime).toBeLessThanOrEqual(600);
    expect(JSON.stringify(rows)).not.toContain(state);
  });

  it("expiry is checked after a contending row lock, not against the callback's stale statement clock", async () => {
    const name = `oauth_expiry_${crypto.randomUUID()}`;
    const locker = postgres(url!, { max: 1 });
    const consumer = postgres(url!, { max: 1, connection: { application_name: name } });
    const hash = await hashToken(crypto.randomUUID());
    const store = createPostgresOAuthJourneyStore(consumer as unknown as Sql);
    await store.issue(hash, "auth");
    let attempt!: Promise<boolean>;
    try {
      await locker.begin(async (tx) => {
        await tx`select state_hash from web_oauth_journeys where state_hash = ${hash} for update`;
        attempt = store.consume(hash, "auth");
        // Observe the actual database wait; do not assume a sleep made the
        // callback start. Then expire the record while it is waiting.
        const deadline = Date.now() + 3000;
        for (;;) {
          const rows = await sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity
            where application_name = ${name} and wait_event_type = 'Lock'`;
          if (rows[0]!.n === 1) break;
          if (Date.now() >= deadline) throw new Error("fixture consumer never reached the row lock");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await tx`update web_oauth_journeys set expires_at = clock_timestamp() where state_hash = ${hash}`;
      });
      expect(await attempt).toBe(false);
    } finally {
      await attempt?.catch(() => {});
      await locker.end();
      await consumer.end();
    }
  });

  it("server-side expiry rejects an original cookie's state before and after GC", async () => {
    const store = createPostgresOAuthJourneyStore(sql);
    const hash = await hashToken(crypto.randomUUID());
    await store.issue(hash, "auth");
    await sql`update web_oauth_journeys set expires_at = now() where state_hash = ${hash}`;
    expect(await store.consume(hash, "auth")).toBe(false);
    expect(await store.sweepExpired()).toBeGreaterThanOrEqual(1);
    expect(await store.consume(hash, "auth")).toBe(false);
  });
});
