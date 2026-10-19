// Session grace duplicates member identity outside web_sessions. Erasure must
// delete those rows, not merely make their bearer unusable via successor revoke.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eraseMember } from "../src/member-erasure";
import {
  createPostgresSessionStore,
  hashToken,
  type SessionStore,
  type Sql,
} from "../src/sessions";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const MEMBER_A = "100000000000000201";
const MEMBER_B = "100000000000000202";
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("member erasure includes session predecessor grace", () => {
  let fixture: JobsFixture;
  let store: SessionStore;
  let chains: Map<string, { predecessor: string; successor: string }>;

  beforeEach(async () => {
    fixture = await createJobsFixture(url!);
    store = createPostgresSessionStore(fixture.client as unknown as Sql);
    chains = new Map();
    for (const userId of [MEMBER_A, MEMBER_B]) {
      const predecessor = await hashToken(`two_erasure_predecessor_${userId}`);
      const successor = await hashToken(`two_erasure_successor_${userId}`);
      await fixture.client`INSERT INTO users (id, username, member) VALUES (${userId}, 'fixture', true)`;
      const row = {
        userId,
        username: "fixture",
        avatar: null,
        member: true,
        moderator: false,
        expiresAt: new Date(Date.now() + 3_600_000),
      };
      await store.create({ ...row, tokenHash: predecessor });
      expect(await store.rotate(predecessor, { ...row, tokenHash: successor })).toBe(true);
      expect(await store.get(predecessor)).toMatchObject({ userId });
      expect(await store.get(successor)).toMatchObject({ userId });
      chains.set(userId, { predecessor, successor });
    }
  });

  afterEach(async () => fixture?.dispose());

  const rowsFor = async (userId: string) => {
    const [grace] = await fixture.client`
      SELECT count(*)::int AS n FROM web_session_grace WHERE user_id = ${userId}`;
    const [sessions] = await fixture.client`
      SELECT count(*)::int AS n FROM web_sessions WHERE user_id = ${userId}`;
    return { grace: grace!.n, sessions: sessions!.n };
  };

  it("dry-run counts grace rows without modifying either member's chain", async () => {
    const before = await fixture.client`SELECT * FROM web_session_grace ORDER BY user_id`;
    expect(before).toHaveLength(2);
    const preview = await eraseMember(
      fixture.client as unknown as Parameters<typeof eraseMember>[0],
      MEMBER_A,
      { dryRun: true },
    );
    expect(await fixture.client`SELECT * FROM web_session_grace ORDER BY user_id`).toEqual(before);
    for (const userId of [MEMBER_A, MEMBER_B]) {
      expect(await rowsFor(userId)).toEqual({ grace: 1, sessions: 1 });
      const chain = chains.get(userId)!;
      expect(await store.get(chain.predecessor)).toMatchObject({ userId });
      expect(await store.get(chain.successor)).toMatchObject({ userId });
    }
    expect(preview).toMatchObject({ web_session_grace: 1, web_sessions: 1, users: 1 });
  });

  it("apply deletes the target's grace identity, preserves the other chain and is idempotent", async () => {
    expect(await rowsFor(MEMBER_A)).toEqual({ grace: 1, sessions: 1 });
    const otherBefore =
      await fixture.client`SELECT * FROM web_session_grace WHERE user_id = ${MEMBER_B}`;
    const removed = await eraseMember(
      fixture.client as unknown as Parameters<typeof eraseMember>[0],
      MEMBER_A,
      {
        dryRun: false,
      },
    );
    // Physical deletion is required even when a dangling predecessor would
    // already be refused because its successor no longer exists.
    expect(await rowsFor(MEMBER_A)).toEqual({ grace: 0, sessions: 0 });
    const erased = chains.get(MEMBER_A)!;
    expect(await store.get(erased.predecessor)).toBeNull();
    expect(await store.get(erased.successor)).toBeNull();
    expect(removed).toMatchObject({ web_session_grace: 1, web_sessions: 1, users: 1 });
    expect(await rowsFor(MEMBER_B)).toEqual({ grace: 1, sessions: 1 });
    expect(
      await fixture.client`SELECT * FROM web_session_grace WHERE user_id = ${MEMBER_B}`,
    ).toEqual(otherBefore);
    const other = chains.get(MEMBER_B)!;
    expect(await store.get(other.predecessor)).toMatchObject({ userId: MEMBER_B });
    expect(await store.get(other.successor)).toMatchObject({ userId: MEMBER_B });
    const repeat = await eraseMember(
      fixture.client as unknown as Parameters<typeof eraseMember>[0],
      MEMBER_A,
      { dryRun: false },
    );
    expect(repeat).toMatchObject({ web_session_grace: 0, web_sessions: 0, users: 0 });
    expect(await rowsFor(MEMBER_B)).toEqual({ grace: 1, sessions: 1 });
  });
});
