import { afterEach, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  createMemorySessionStore,
  createPostgresSessionStore,
  hashToken,
  migrate,
  newSessionToken,
  type SessionStore,
  type Sql,
} from "../src/sessions";

const url = process.env.DATABASE_URL;

const row = () => ({
  tokenHash: `hash-${Math.random().toString(36).slice(2)}`,
  userId: "42",
  username: "Rick",
  avatar: null as string | null,
  member: true,
  moderator: false,
  expiresAt: new Date(Date.now() + 3600_000),
});

/** Every store implementation must honor the same contract. */
function contract(name: string, make: () => SessionStore | Promise<SessionStore>) {
  describe(`${name} session store`, () => {
    let store: SessionStore;
    beforeAll(async () => {
      store = await make();
    });

    it("creates and reads a row", async () => {
      const s = row();
      await store.create(s);
      expect(await store.get(s.tokenHash)).toEqual({
        userId: "42",
        username: "Rick",
        avatar: null,
        member: true,
        moderator: false,
      });
    });

    it("rotation deletes the old row and inserts the replacement; replay misses", async () => {
      const s = row();
      await store.create(s);
      const replacement = { ...row(), moderator: true };
      expect(await store.rotate(s.tokenHash, replacement)).toBe(true);
      expect(await store.get(s.tokenHash)).toBeNull();
      expect(await store.get(replacement.tokenHash)).toMatchObject({ moderator: true });
      // Second rotation of the same old token fails: no double-spend.
      expect(await store.rotate(s.tokenHash, row())).toBe(false);
    });

    it("returns false when rotating a token that was never issued, and mints no orphan row", async () => {
      const replacement = row();
      expect(await store.rotate("no-such-token", replacement)).toBe(false);
      expect(await store.get(replacement.tokenHash)).toBeNull();
    });

    it("revoke kills the row; the token cannot replay", async () => {
      const s = row();
      await store.create(s);
      await store.revoke(s.tokenHash);
      expect(await store.get(s.tokenHash)).toBeNull();
    });

    it("expired rows read as missing", async () => {
      const s = { ...row(), expiresAt: new Date(Date.now() - 1000) };
      await store.create(s);
      expect(await store.get(s.tokenHash)).toBeNull();
    });
  });
}

contract("memory", () => createMemorySessionStore());

// Live round-trip against agent-testdb. Skipped when DATABASE_URL is unset
// (CI has no test-DB access), so the cold CI run stays green. Run locally with
// DATABASE_URL=postgres://agent_test@agent-testdb:5432/two_web_next.
describe.skipIf(!url)("postgres", () => {
  const sql = postgres(url!, { max: 1 }) as unknown as Sql & { end: () => Promise<void> };
  beforeAll(async () => migrate(sql));
  afterEach(async () => {
    await sql`delete from web_sessions`;
  });
  contract("postgres", () => createPostgresSessionStore(sql));

  it("stores only hashes: the bearer token never appears in the table", async () => {
    const store = createPostgresSessionStore(sql);
    const token = newSessionToken();
    const hash = await hashToken(token);
    await store.create({
      tokenHash: hash,
      userId: "42",
      username: "Rick",
      avatar: null,
      member: true,
      moderator: false,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const found = await sql<{ token_hash: string }[]>`select token_hash from web_sessions`;
    expect(found.map((r) => r.token_hash)).toContain(hash);
    expect(found.map((r) => r.token_hash).join(" ")).not.toContain(token.slice(4, 12));
  });
});
