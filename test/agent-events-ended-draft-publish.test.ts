import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAuditRows } from "./helpers/audit-rows";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { DEFAULT_CONFIG, handleAgentEvent, type IngressEffects } from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";
import { dispatchWriteBack } from "../src/admin/writeback";
import type { QueueMessage } from "../src/jobs/types";
import { createMemorySessionStore } from "../src/sessions";
import type { Env } from "../src/env";

type TrackedSync = Extract<QueueMessage, { kind: "sync-event" }>;

// Mirror the shared agent-events harness: the tracked queue carrier holds
// identity only, so a send proves a Discord write-back was dispatched.
vi.mock("../src/jobs/worker", () => ({
  enqueueSyncEvent: async (env: Env, message: TrackedSync) => {
    await env.SYNC_EVENT_QUEUE!.send(
      { ...message, jobId: crypto.randomUUID() },
      { delaySeconds: 10 },
    );
    return true;
  },
}));

const CALLER = "ended-draft-publish-fixture";
const cfg = { ...DEFAULT_CONFIG, enabled: true, callerAgentId: CALLER, lockWaitMs: 1500 };
// The stored draft ends at this exact instant (UTC wall fields below).
const ENDS = Date.UTC(2099, 6, 1, 22, 0, 0);
const ENDED = "An event that has already ended cannot be published. Update its dates first.";
const fields = {
  title: "Agent ended draft proof",
  game: "Chess",
  description: "Ended draft publication proof",
  starts_at: "2099-07-01 20:00",
  ends_at: "2099-07-01 22:00",
  timezone: "UTC",
  location: "Voice",
  capacity: 2,
};

// Acceptance: the machine publish path must refuse an already-ended owned
// draft exactly like the moderator transition does (strict end-before-now),
// judged on the locked row at publication time. Real web SQL against an
// isolated test schema, an in-memory queue and no bot contact; only the
// decision clock (Date) is faked, timers stay real for lock waits.
describe.skipIf(!process.env.DATABASE_URL)("agent publish of ended drafts (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let credential: string;
  let env: Env;
  let effects: IngressEffects;
  const sent: TrackedSync[] = [];
  const call = (op: string, rest: Record<string, unknown> = {}, config = cfg) =>
    handleAgentEvent(
      fixture.client,
      config,
      { op, idempotency_key: randomUUID(), ...rest },
      credential,
      null,
      effects,
    );
  const create = async () => {
    const result = await call("create", { fields });
    expect(result.status).toBe(201);
    return result.body.event_key as string;
  };
  const rowOf = async (event_key: string) =>
    (
      await fixture.client`SELECT status, location, agent_version, ends_at, updated_at
        FROM events WHERE event_key = ${event_key}`
    )[0]!;
  const publishAudits = async (event_key: string) =>
    fixture.client`SELECT result, reason_code FROM agent_event_audits
      WHERE operation = 'publish' AND event_key = ${event_key} ORDER BY id`;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 8 });
  });
  afterAll(async () => {
    await fixture?.dispose();
  });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.client`DELETE FROM agent_event_idempotency_keys`;
    await clearAuditRows(fixture.client, ["agent_event_audits"]);
    await fixture.client`DELETE FROM agent_event_hits`;
    await fixture.client`DELETE FROM agent_event_grants`;
    sent.length = 0;
    credential = `fixture-${randomUUID()}`;
    await fixture.client`INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
      VALUES (${CALLER}, 'fixture-company', ${cfg.stagingGuildId}, ${await sha256Hex(credential)})`;
    env = {
      APP_URL: "https://next.example.test",
      SESSION_SECRET: "fixture-session-secret-long-enough-for-tests",
      DISCORD_CLIENT_ID: "fixture",
      DISCORD_GUILD_ID: cfg.stagingGuildId,
      DISCORD_INVITE_URL: "https://discord.gg/fixture",
      DISCORD_CLIENT_SECRET: "fixture",
      DISCORD_BOT_TOKEN: "fixture",
      AGENT_EVENTS_ENABLED: "true",
      AGENT_EVENTS_CALLER_AGENT_ID: CALLER,
      AGENT_EVENT_SQL: fixture.client,
      ADMIN_DB: fixture.db,
      SESSION_STORE: createMemorySessionStore(),
      DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
      SYNC_EVENT_QUEUE: {
        send: async (message: TrackedSync) => {
          sent.push(message);
        },
      },
    } as unknown as Env;
    effects = { writeBack: (wb) => dispatchWriteBack(env, wb) };
    // Create and act while the draft is still in the future; each test then
    // moves only the decision clock.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(ENDS - 3600_000));
  });
  afterEach(() => vi.useRealTimers());

  it.each([1, 3600_000])(
    "refuses publish %i ms after the draft ended, with no mutation, write-back or stored receipt",
    async (pastEnd) => {
      const event_key = await create();
      const before = await rowOf(event_key);
      expect(before.status).toBe("draft");
      vi.setSystemTime(new Date(ENDS + pastEnd));
      const publishKey = randomUUID();
      const publish = await call("publish", { event_key, idempotency_key: publishKey });
      expect(publish.status).toBe(422);
      expect(publish.body).toMatchObject({
        reason: "validation_failed",
        errors: { ends_at: [ENDED] },
      });
      expect(await rowOf(event_key)).toEqual(before);
      expect(sent).toHaveLength(0);
      // Existing refusal handling: a denied audit row, and nothing stored
      // under the idempotency key, so the same key re-executes the refusal
      // instead of replaying a success.
      expect(await publishAudits(event_key)).toEqual([
        { result: "denied", reason_code: "validation_failed" },
      ]);
      expect(
        (
          await fixture.client`SELECT count(*)::int AS n FROM agent_event_idempotency_keys WHERE key = ${publishKey}`
        )[0]!.n,
      ).toBe(0);
      const retry = await call("publish", { event_key, idempotency_key: publishKey });
      expect(retry.status).toBe(422);
      expect(retry.body.replayed).toBeUndefined();
      expect(await publishAudits(event_key)).toHaveLength(2);
      expect(await rowOf(event_key)).toEqual(before);
      expect(sent).toHaveLength(0);
    },
  );

  it.each([0, 1])(
    "still publishes when the end is %i ms away or exactly now (strict boundary)",
    async (untilEnd) => {
      const event_key = await create();
      vi.setSystemTime(new Date(ENDS - untilEnd));
      const publish = await call("publish", { event_key });
      expect(publish.status).toBe(200);
      expect(publish.body).toMatchObject({ event_key, status: "published" });
      expect((await rowOf(event_key)).status).toBe("published");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ kind: "sync-event", eventKey: event_key });
      expect(await publishAudits(event_key)).toEqual([{ result: "ok", reason_code: null }]);
    },
  );

  it("judges the clock after waiting for the owned-row lock, not at request entry", async () => {
    const event_key = await create();
    const before = await rowOf(event_key);
    const [event] = await fixture.client`SELECT id FROM events WHERE event_key = ${event_key}`;
    let release!: () => void;
    let ready!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const holder = fixture.client.begin(async (tx) => {
      await tx`SELECT id FROM events WHERE id = ${event!.id} FOR UPDATE`;
      const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
      ready(Number(backend!.pid));
      await gate;
    });
    // performance.now stays real while Date is faked.
    const waitForBlock = async (holderPid: number): Promise<void> => {
      const deadline = performance.now() + 3000;
      do {
        const waiting =
          await fixture.client`SELECT pid FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND ${holderPid} = ANY(pg_blocking_pids(pid))`;
        if (waiting.length) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      } while (performance.now() < deadline);
      throw new Error("Publish never reached the owned-row lock");
    };
    let publish: ReturnType<typeof call> | undefined;
    try {
      const holderPid = await acquired;
      // One millisecond before the end at entry: publishable if judged now.
      vi.setSystemTime(new Date(ENDS - 1));
      publish = call("publish", { event_key }, { ...cfg, lockWaitMs: 5000 });
      await waitForBlock(holderPid);
      // The window elapses while the publish waits for the lock.
      vi.setSystemTime(new Date(ENDS + 1));
    } finally {
      release();
      await holder;
    }
    const result = await publish!;
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      reason: "validation_failed",
      errors: { ends_at: [ENDED] },
    });
    expect(await rowOf(event_key)).toEqual(before);
    expect(sent).toHaveLength(0);
    expect(await publishAudits(event_key)).toEqual([
      { result: "denied", reason_code: "validation_failed" },
    ]);
  }, 15_000);

  it("still cancels an already-ended draft, and already-cancelled stays event_not_open", async () => {
    const event_key = await create();
    vi.setSystemTime(new Date(ENDS + 3600_000));
    const cancel = await call("cancel", { event_key });
    expect(cancel.status).toBe(200);
    expect(cancel.body).toMatchObject({ event_key, status: "cancelled" });
    expect((await rowOf(event_key)).status).toBe("cancelled");
    expect(sent).toHaveLength(1);
    // Terminal-state semantics are unchanged: neither move reopens, and the
    // ended-draft refusal does not shadow the existing 409.
    for (const op of ["publish", "cancel"]) {
      const again = await call(op, { event_key });
      expect(again.status).toBe(409);
      expect(again.body.reason).toBe("event_not_open");
    }
    expect(sent).toHaveLength(1);
  });

  it("keeps the blank-location refusal for a draft that has not ended", async () => {
    const event_key = await create();
    await fixture.client`UPDATE events SET location = '   ' WHERE event_key = ${event_key}`;
    const publish = await call("publish", { event_key });
    expect(publish.status).toBe(422);
    expect(publish.body).toMatchObject({
      reason: "validation_failed",
      errors: { location: ["Add a location before publishing."] },
    });
    expect((await rowOf(event_key)).status).toBe("draft");
    expect(sent).toHaveLength(0);
  });

  it("keeps ownership refusal ahead of the ended check for a foreign ended draft", async () => {
    await create();
    await fixture.client`INSERT INTO events (event_key, title, starts_at, ends_at, location)
      VALUES ('foreign-ended', 'Foreign', '2099-07-01T20:00:00Z', '2099-07-01T22:00:00Z', 'Voice')`;
    vi.setSystemTime(new Date(ENDS + 3600_000));
    const publish = await call("publish", { event_key: "foreign-ended" });
    expect(publish.status).toBe(403);
    expect(publish.body.reason).toBe("foreign_event");
    expect(
      (await fixture.client`SELECT status FROM events WHERE event_key = 'foreign-ended'`)[0]!
        .status,
    ).toBe("draft");
    expect(sent).toHaveLength(0);
  });
});
