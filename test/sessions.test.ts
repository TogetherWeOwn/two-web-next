import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";
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

    it("exposes a non-authenticating status key only for a live session", async () => {
      const s = row();
      expect(await store.statusHash(s.tokenHash)).toBeNull();
      expect(await store.isActive(s.tokenHash)).toBe(false);
      await store.create(s);
      expect(await store.statusHash(s.tokenHash)).toBe(s.tokenHash);
      expect(await store.isActive(s.tokenHash)).toBe(true);
    });

    it("preserves the status key across repeated and no-op rotation without reviving old login tokens", async () => {
      const original = row();
      await store.create(original);
      const statusHash = (await store.statusHash(original.tokenHash))!;
      const first = row();
      const second = { ...row(), moderator: true };
      for (const [source, replacement] of [[original, first], [first, second], [second, second]] as const) {
        expect(await store.rotate(source.tokenHash, replacement)).toBe(true);
        expect(await store.statusHash(replacement.tokenHash)).toBe(statusHash);
        expect(await store.isActive(statusHash)).toBe(true);
        expect(await store.get(replacement.tokenHash)).toMatchObject({ userId: "42", moderator: replacement.moderator });
        if (source.tokenHash !== replacement.tokenHash) {
          expect(await store.get(source.tokenHash)).toBeNull();
          expect(await store.statusHash(source.tokenHash)).toBeNull();
        }
      }
      expect(await store.get(original.tokenHash)).toBeNull();
      expect(await store.get(first.tokenHash)).toBeNull();
      const replay = row();
      expect(await store.rotate(original.tokenHash, replay)).toBe(false);
      expect(await store.get(replay.tokenHash)).toBeNull();
      expect(await store.statusHash(replay.tokenHash)).toBeNull();
      expect(await store.isActive(statusHash)).toBe(true);
      // A replacement's login hash does not become a second probe key.
      expect(await store.isActive(second.tokenHash)).toBe(false);
    });

    it("revoking the current login token deactivates the status key retained through rotation", async () => {
      const original = row();
      const replacement = row();
      await store.create(original);
      expect(await store.rotate(original.tokenHash, replacement)).toBe(true);
      expect(await store.isActive(original.tokenHash)).toBe(true);
      await store.revoke(replacement.tokenHash);
      expect(await store.isActive(original.tokenHash)).toBe(false);
      expect(await store.statusHash(replacement.tokenHash)).toBeNull();
      expect(await store.get(original.tokenHash)).toBeNull();
      expect(await store.get(replacement.tokenHash)).toBeNull();
    });

    it("expiry of the rotated row deactivates the original status key", async () => {
      const original = row();
      const replacement = { ...row(), expiresAt: new Date(Date.now() - 1000) };
      await store.create(original);
      expect(await store.rotate(original.tokenHash, replacement)).toBe(true);
      expect(await store.isActive(original.tokenHash)).toBe(false);
      expect(await store.statusHash(replacement.tokenHash)).toBeNull();
      expect(await store.get(original.tokenHash)).toBeNull();
      expect(await store.get(replacement.tokenHash)).toBeNull();
    });

    it.each(["expired", "revoked"] as const)("a session marked %s cannot expose a status key or regain one through rotation", async (state) => {
      const s = { ...row(), expiresAt: new Date(Date.now() + (state === "expired" ? -1000 : 3600_000)) };
      await store.create(s);
      if (state === "revoked") await store.revoke(s.tokenHash);
      expect(await store.isActive(s.tokenHash)).toBe(false);
      expect(await store.statusHash(s.tokenHash)).toBeNull();
      expect(await store.get(s.tokenHash)).toBeNull();
      expect(await store.rotate(s.tokenHash, s)).toBe(false);
      const replacement = row();
      expect(await store.rotate(s.tokenHash, replacement)).toBe(false);
      expect(await store.get(replacement.tokenHash)).toBeNull();
      expect(await store.statusHash(replacement.tokenHash)).toBeNull();
      expect(await store.isActive(replacement.tokenHash)).toBe(false);
      expect(await store.isActive(s.tokenHash)).toBe(false);
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

it("memory status follows the replacement's expiry boundary, never the retired login token", async () => {
  let now = 10_000;
  const store = createMemorySessionStore(() => now);
  const original = { ...row(), expiresAt: new Date(now + 1000) };
  const replacement = { ...row(), expiresAt: new Date(now + 2000) };
  await store.create(original);
  expect(await store.rotate(original.tokenHash, replacement)).toBe(true);
  now = replacement.expiresAt.getTime() - 1;
  expect(await store.isActive(original.tokenHash)).toBe(true);
  expect(await store.statusHash(replacement.tokenHash)).toBe(original.tokenHash);
  expect(await store.get(original.tokenHash)).toBeNull();
  expect(await store.get(replacement.tokenHash)).not.toBeNull();
  now++;
  expect(await store.isActive(original.tokenHash)).toBe(false);
  expect(await store.statusHash(replacement.tokenHash)).toBeNull();
  expect(await store.get(replacement.tokenHash)).toBeNull();
  expect(await store.rotate(replacement.tokenHash, row())).toBe(false);
});

// Isolated schema on agent-testdb or CI service containers only, never public.
describe.skipIf(!url)("postgres", () => {
  let fixture: JobsFixture | undefined;
  let sql: Sql;
  beforeAll(async () => {
    fixture = await createJobsFixture(url!);
    sql = fixture.client as unknown as Sql;
    await migrate(sql);
  });
  afterAll(async () => fixture?.dispose());
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
