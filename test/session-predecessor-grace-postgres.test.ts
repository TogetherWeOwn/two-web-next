import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresSessionStore,
  migrate,
  SESSION_PREDECESSOR_GRACE_SECONDS,
  type Sql,
} from "../src/sessions";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const url = process.env.DATABASE_URL;
const USER = "100000000000000401";

const session = (tokenHash: string, userId = USER, expiresAt?: Date) => ({
  tokenHash,
  userId,
  username: "grace-fixture",
  avatar: null,
  member: true,
  moderator: false,
  expiresAt: expiresAt ?? new Date(Date.now() + 3600_000),
});

describe.skipIf(!url)("postgres predecessor grace", () => {
  let fixture: JobsFixture;
  let store: ReturnType<typeof createPostgresSessionStore>;

  beforeAll(async () => {
    fixture = await createJobsFixture(url!, { max: 4 });
    await migrate(fixture.client as unknown as Sql);
    store = createPostgresSessionStore(fixture.client as unknown as Sql);
  });

  beforeEach(async () => {
    await fixture.client`delete from web_session_grace`;
    await fixture.client`delete from web_sessions`;
  });

  afterAll(async () => fixture?.dispose());

  it("keeps the immediate predecessor for 10s with a fixed deadline from winning rotation", async () => {
    expect(SESSION_PREDECESSOR_GRACE_SECONDS).toBe(10);
    await store.create(session("grace-source"));
    expect(await store.rotate("grace-source", session("grace-successor"))).toBe(true);
    expect(await store.get("grace-source")).toMatchObject({ userId: USER });
    expect(await store.get("grace-successor")).toMatchObject({ userId: USER });
    expect(await store.statusHash("grace-source")).toBeNull();
    const [g] = await fixture.client<{ grace_expires_at: Date; created_at: Date }[]>`
      select grace_expires_at, created_at from web_session_grace where predecessor_hash = 'grace-source'`;
    expect(g).toBeDefined();
    const skewMs = g!.grace_expires_at.getTime() - g!.created_at.getTime();
    expect(skewMs).toBeGreaterThanOrEqual(9_900);
    expect(skewMs).toBeLessThanOrEqual(10_500);
  });

  it("refuses at the exact deadline and after, without touching the live successor", async () => {
    await store.create(session("deadline-source"));
    expect(await store.rotate("deadline-source", session("deadline-successor"))).toBe(true);
    expect(await store.get("deadline-source")).not.toBeNull();
    await fixture.client`update web_session_grace set grace_expires_at = clock_timestamp()
      where predecessor_hash = 'deadline-source'`;
    expect(await store.get("deadline-source")).toBeNull();
    expect(await store.get("deadline-successor")).toMatchObject({ userId: USER });
    await fixture.client`update web_session_grace set grace_expires_at = clock_timestamp() - interval '1 second'
      where predecessor_hash = 'deadline-source'`;
    expect(await store.get("deadline-source")).toBeNull();
    expect(await store.get("deadline-successor")).toMatchObject({ userId: USER });
  });

  it("bounds grace by the predecessor original expiry even inside the 10s window", async () => {
    await store.create(session("expiry-source"));
    expect(await store.rotate("expiry-source", session("expiry-successor"))).toBe(true);
    expect(await store.get("expiry-source")).not.toBeNull();
    await fixture.client`update web_session_grace set expires_at = clock_timestamp() - interval '1 second'
      where predecessor_hash = 'expiry-source'`;
    expect(await store.get("expiry-source")).toBeNull();
    expect(await store.get("expiry-successor")).toMatchObject({ userId: USER });
  });

  it("keeps only the immediate predecessor: a grandparent is pruned on the next win", async () => {
    await store.create(session("chain-a"));
    expect(await store.rotate("chain-a", session("chain-b"))).toBe(true);
    expect(await store.get("chain-a")).not.toBeNull();
    expect(await store.rotate("chain-b", session("chain-c"))).toBe(true);
    expect(await store.get("chain-a")).toBeNull();
    expect(await store.get("chain-b")).toMatchObject({ userId: USER });
    expect(await store.get("chain-c")).toMatchObject({ userId: USER });
    const rows = await fixture.client<
      { predecessor_hash: string }[]
    >`select predecessor_hash from web_session_grace order by predecessor_hash`;
    expect(rows.map((r) => r.predecessor_hash)).toEqual(["chain-b"]);
  });

  it("never mints siblings or restarts grace on predecessor reads", async () => {
    await store.create(session("norestart-source"));
    expect(await store.rotate("norestart-source", session("norestart-successor"))).toBe(true);
    const [before] = await fixture.client<{ grace_expires_at: Date }[]>`
      select grace_expires_at from web_session_grace where predecessor_hash = 'norestart-source'`;
    for (let i = 0; i < 3; i++) {
      expect(await store.get("norestart-source")).not.toBeNull();
    }
    const [after] = await fixture.client<{ grace_expires_at: Date }[]>`
      select grace_expires_at from web_session_grace where predecessor_hash = 'norestart-source'`;
    expect(after!.grace_expires_at.getTime()).toBe(before!.grace_expires_at.getTime());
    const live = await fixture.client<{ n: number }[]>`select count(*)::int as n from web_sessions
      where revoked_at is null and expires_at > clock_timestamp()`;
    expect(live[0]!.n).toBe(1);
    const grace = await fixture.client<
      { n: number }[]
    >`select count(*)::int as n from web_session_grace`;
    expect(grace[0]!.n).toBe(1);
  });

  it("revoking the successor, predecessor, lineage or user kills predecessor grace", async () => {
    await store.create(session("kill-source"));
    await store.create(session("kill-independent"));
    const lineage = await store.statusHash("kill-source");
    expect(await store.rotate("kill-source", session("kill-successor"))).toBe(true);
    expect(await store.get("kill-source")).not.toBeNull();

    await store.revoke("kill-successor");
    expect(await store.get("kill-source")).toBeNull();
    expect(await store.get("kill-successor")).toBeNull();
    expect(await store.get("kill-independent")).not.toBeNull();

    await store.create(session("kill-source2"));
    expect(await store.rotate("kill-source2", session("kill-successor2"))).toBe(true);
    await store.revoke("kill-source2");
    expect(await store.get("kill-source2")).toBeNull();
    expect(await store.get("kill-successor2")).not.toBeNull();

    await store.revokeLineage(lineage!);
    expect(await store.get("kill-successor2")).not.toBeNull();
    const lineage2 = await store.statusHash("kill-successor2");
    await store.revokeLineage(lineage2!);
    expect(await store.get("kill-source2")).toBeNull();
    expect(await store.get("kill-successor2")).toBeNull();
    expect(await store.get("kill-independent")).not.toBeNull();

    await store.create(session("kill-source3"));
    expect(await store.rotate("kill-source3", session("kill-successor3"))).toBe(true);
    await store.create(session("kill-fresh"));
    await store.revokeUserSessions(USER, "kill-fresh");
    expect(await store.get("kill-source3")).toBeNull();
    expect(await store.get("kill-successor3")).toBeNull();
    expect(await store.get("kill-independent")).toBeNull();
    expect(await store.get("kill-fresh")).not.toBeNull();
  });

  it("a predecessor cannot rotate, revive or become a second lineage", async () => {
    await store.create(session("norevive-source"));
    expect(await store.rotate("norevive-source", session("norevive-successor"))).toBe(true);
    expect(await store.rotate("norevive-source", session("norevive-fork"))).toBe(false);
    expect(await store.get("norevive-fork")).toBeNull();
    expect(await store.get("norevive-source")).not.toBeNull();
    await store.revoke("norevive-successor");
    expect(await store.rotate("norevive-source", session("norevive-revival"))).toBe(false);
    expect(await store.get("norevive-revival")).toBeNull();
    expect(await store.get("norevive-source")).toBeNull();
  });

  it("sweeps grace when either deadline passes and reports both drains", async () => {
    await store.create(session("sweep-source"));
    expect(await store.rotate("sweep-source", session("sweep-successor"))).toBe(true);
    await fixture.client`update web_session_grace set grace_expires_at = now() - interval '1 second'
      where predecessor_hash = 'sweep-source'`;
    expect(await store.sweepExpired(new Date())).toBe(1);
    expect(await store.get("sweep-source")).toBeNull();
    expect(await store.get("sweep-successor")).not.toBeNull();
    const grace = await fixture.client<
      { n: number }[]
    >`select count(*)::int as n from web_session_grace`;
    expect(grace[0]!.n).toBe(0);
  });

  it("fixes the grace deadline at the winning rotation after a row-lock wait", async () => {
    await store.create(session("lock-source"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = (async () => {
      await fixture.client.begin(async (tx) => {
        await tx`select token_hash from web_sessions where token_hash = 'lock-source' for update`;
        await gate;
      });
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rotation = store.rotate("lock-source", session("lock-successor"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    expect(await rotation).toBe(true);
    await holder;
    expect(await store.get("lock-source")).not.toBeNull();
    const [g] = await fixture.client<{ skew_ms: string }[]>`
      select extract(epoch from (grace_expires_at - clock_timestamp())) * 1000 as skew_ms
      from web_session_grace where predecessor_hash = 'lock-source'`;
    const skewMs = Number(g!.skew_ms);
    expect(skewMs).toBeGreaterThan(9_000);
    expect(skewMs).toBeLessThanOrEqual(10_500);
  });
});
