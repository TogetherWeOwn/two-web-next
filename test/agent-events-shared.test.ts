import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { clearAuditRows } from "./helpers/audit-rows";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { DEFAULT_CONFIG, handleAgentEvent, type IngressEffects } from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";
import { signedEventReader } from "../src/bot/event-read";
import { dispatchWriteBack } from "../src/admin/writeback";
import { transitionEvent, updateEvent } from "../src/admin/store";
import { parseEventForm, ValidationError } from "../src/admin/validation";
import type { QueueMessage } from "../src/jobs/types";
import { createMemorySessionStore } from "../src/sessions";
import type { Env } from "../src/env";

type TrackedSync = Extract<QueueMessage, { kind: "sync-event" }>;

// The tracked W13 producer (SYNC_EVENT_QUEUE) supersedes main #124's stub
// EVENT_SYNC_QUEUE carrier: the message holds identity only and the consumer
// reads the current row, so assertions derive the action from the committed
// row status at send time. Mirrors the real narrow signature (events.test.ts).
vi.mock("../src/jobs/worker", () => ({
  enqueueSyncEvent: async (env: Env, message: TrackedSync) => {
    await env.SYNC_EVENT_QUEUE!.send(
      { ...message, jobId: crypto.randomUUID() },
      { delaySeconds: 10 },
    );
    return true;
  },
}));

const CALLER = "shared-ingress-fixture";
const cfg = { ...DEFAULT_CONFIG, enabled: true, callerAgentId: CALLER, lockWaitMs: 1500 };
const fields = {
  title: "Agent shared proof",
  game: "Chess",
  description: "Shared public event",
  starts_at: "2099-07-01 20:00",
  ends_at: "2099-07-01 22:00",
  timezone: "Europe/London",
  location: "Voice",
  capacity: 2,
};
const unavailable = (reason: string) => ({ unavailable: "verification_unavailable", reason });

// Real web SQL, an isolated test schema, an in-memory queue and stubbed bot only.
describe.skipIf(!process.env.DATABASE_URL)("shared agent event acceptance (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let credential: string;
  let env: Env;
  let effects: IngressEffects;
  const sent: TrackedSync[] = [];
  // Committed row status observed at each send; the tracked carrier has no
  // action field, so this is what assertions derive the action from.
  const sentStatuses: string[] = [];
  const call = (op: string, rest: Record<string, unknown> = {}, deps = effects) =>
    handleAgentEvent(
      fixture.client,
      cfg,
      { op, idempotency_key: randomUUID(), ...rest },
      credential,
      null,
      deps,
    );
  const create = async () => {
    const result = await call("create", { fields });
    expect(result.status).toBe(201);
    return result.body.event_key as string;
  };

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
    sentStatuses.length = 0;
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
          // A second pool query must already see the committed state and replay receipt.
          const [row] =
            await fixture.client`SELECT status FROM events WHERE event_key = ${message.eventKey}`;
          expect(["published", "cancelled"]).toContain(row!.status);
          sentStatuses.push(row!.status as string);
          const [saved] =
            await fixture.client`SELECT count(*)::int AS n FROM agent_event_idempotency_keys WHERE event_key = ${message.eventKey}`;
          expect(saved!.n).toBeGreaterThanOrEqual(2);
          sent.push(message);
        },
      },
    } as unknown as Env;
    effects = { writeBack: (wb) => dispatchWriteBack(env, wb) };
  });

  it("route create/publish uses the same row as the public list, detail and sitemap", async () => {
    const write = (body: unknown) =>
      app.request(
        "/api/agent-events",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
        env,
      );
    const created = await write({ op: "create", idempotency_key: randomUUID(), fields });
    expect(created.status).toBe(201);
    const { event_key, proof_marker } = (await created.json()) as {
      event_key: string;
      proof_marker: string;
    };
    expect(sent).toHaveLength(0);
    expect((await app.request(`/e/${event_key}`, {}, env)).status).toBe(403);
    const draftList = await app.request("/events", {}, env);
    expect(await draftList.text()).not.toContain(fields.title);
    const published = await write({ op: "publish", event_key, idempotency_key: randomUUID() });
    expect(published.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: "sync-event",
      eventKey: event_key,
    });
    // The tracked carrier holds identity only; the upsert action is what the
    // consumer derives from the published row.
    expect(sentStatuses).toEqual(["published"]);
    for (const path of ["/events", `/e/${event_key}`]) {
      const page = await app.request(path, {}, env);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain(fields.title);
    }
    const sitemap = await app.request("/sitemap_index.xml", {}, env);
    expect(sitemap.status).toBe(200);
    expect(await sitemap.text()).toContain(`/e/${event_key}`);
    const [row] = await fixture.client`SELECT * FROM events WHERE event_key = ${event_key}`;
    expect(row).toMatchObject({ proof_marker, agent_version: 1, status: "published" });
    expect(new Date(row!.starts_at).toISOString()).toBe("2099-07-01T19:00:00.000Z");
    const read = await call("read", { event_key });
    expect(read.body.event).toMatchObject({
      starts_at: fields.starts_at,
      ends_at: fields.ends_at,
      proof_marker,
    });
    expect(read.body).toMatchObject({
      local: { synced_to_discord: false },
      discord: unavailable("never_mirrored"),
    });
  });

  it("dispatches once per accepted lifecycle move/published edit, never for drafts, replays or denials", async () => {
    const event_key = await create();
    expect((await call("update", { event_key, version: 1, fields })).status).toBe(200);
    expect(sent).toHaveLength(0);
    const publishKey = randomUUID();
    expect((await call("publish", { event_key, idempotency_key: publishKey })).status).toBe(200);
    expect((await call("publish", { event_key, idempotency_key: publishKey })).body.replayed).toBe(
      true,
    );
    expect(sent).toHaveLength(1);
    const update = {
      event_key,
      version: 2,
      fields: { ...fields, title: "Updated" },
      idempotency_key: randomUUID(),
    };
    expect((await call("update", update)).body.agent_version).toBe(3);
    expect((await call("update", update)).body.replayed).toBe(true);
    expect((await call("update", { ...update, idempotency_key: randomUUID() })).body.reason).toBe(
      "stale_version",
    );
    expect(sent).toHaveLength(2);
    const cancel = { event_key, idempotency_key: randomUUID() };
    expect((await call("cancel", cancel)).status).toBe(200);
    expect((await call("cancel", cancel)).body.replayed).toBe(true);
    expect((await call("update", { event_key, version: 3, fields })).body.reason).toBe(
      "event_not_open",
    );
    expect(sentStatuses).toEqual(["published", "published", "cancelled"]);
    expect(new Set(sent.map((m) => m.idempotencyKey)).size).toBe(3);
    expect((await app.request(`/e/${event_key}`, {}, env)).status).toBe(410);
  });

  it("advances calendar revisions for agent writes, not reads, replays or denials", async () => {
    const event_key = await create();
    const revision = async () => {
      const [row] =
        await fixture.client`SELECT ics_sequence::text AS revision FROM events WHERE event_key = ${event_key}`;
      return BigInt(row!.revision);
    };
    const created = await revision();
    expect(created).toBeGreaterThan(0n);
    const publish = { event_key, idempotency_key: randomUUID() };
    expect((await call("publish", publish)).status).toBe(200);
    const published = await revision();
    expect(published).toBeGreaterThan(created);
    const feed = await app.request("/events.ics", {}, env);
    expect(feed.status).toBe(200);
    expect(await feed.text()).toContain(`SEQUENCE:${published}\r\n`);
    expect((await call("publish", publish)).body.replayed).toBe(true);
    expect((await call("read", { event_key })).status).toBe(200);
    expect(await revision()).toBe(published);
    const update = {
      event_key,
      version: 1,
      fields: { ...fields, title: "Calendar correction" },
      idempotency_key: randomUUID(),
    };
    expect((await call("update", update)).status).toBe(200);
    const edited = await revision();
    expect(edited).toBeGreaterThan(published);
    expect((await call("update", update)).body.replayed).toBe(true);
    expect((await call("update", { ...update, idempotency_key: randomUUID() })).body.reason).toBe(
      "stale_version",
    );
    expect(await revision()).toBe(edited);
    const cancel = { event_key, idempotency_key: randomUUID() };
    expect((await call("cancel", cancel)).status).toBe(200);
    const cancelled = await revision();
    expect(cancelled).toBeGreaterThan(edited);
    expect((await call("cancel", cancel)).body.replayed).toBe(true);
    expect(await revision()).toBe(cancelled);
  });

  it("racing duplicate publish requests commit one result and enqueue once", async () => {
    const event_key = await create();
    const idempotency_key = randomUUID();
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => call("publish", { event_key, idempotency_key })),
    );
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200, 200]);
    expect(answers.filter((answer) => answer.body.replayed)).toHaveLength(4);
    expect(sent).toHaveLength(1);
  });

  it("observes only the owned mapped event, returns each reason and replays observations without refetching", async () => {
    const event_key = await create();
    const fetcher = vi.fn<typeof fetch>();
    const readEvent = signedEventReader(
      { baseUrl: "https://bot.fixture.test", keyId: "fixture", secret: "fixture-only-secret" },
      fetcher,
    );
    const deps = { ...effects, readEvent };
    expect((await call("read", { event_key }, deps)).body.discord).toEqual(
      unavailable("never_mirrored"),
    );
    expect(fetcher).not.toHaveBeenCalled();
    await fixture.client`UPDATE events SET discord_event_id = 'mapped-id' WHERE event_key = ${event_key}`;
    fetcher.mockRejectedValueOnce(new Error("fixture unavailable"));
    expect((await call("read", { event_key }, deps)).body).toMatchObject({
      local: { synced_to_discord: true },
      discord: unavailable("bot_unreachable"),
    });
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: { code: "event_not_found" } }), {
        status: 404,
      }),
    );
    expect((await call("read", { event_key }, deps)).body.discord).toEqual(
      unavailable("event_not_found"),
    );
    const observed = {
      event_id: "different-id",
      name: "Name from bot, not SQL",
      starts_at: "2030-01-01T01:00:00Z",
      location: "Bot location",
      status: "active",
      observed_at: "2030-01-01T02:00:00Z",
    };
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: observed })));
    expect((await call("read", { event_key }, deps)).body.discord).toEqual(
      unavailable("mirror_mismatch"),
    );
    const matched = { ...observed, event_id: "mapped-id" };
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: matched })));
    const savedRead = { event_key, idempotency_key: randomUUID() };
    expect((await call("read", savedRead, deps)).body.discord).toEqual(matched);
    expect((await call("read", savedRead, deps)).body).toMatchObject({
      replayed: true,
      discord: matched,
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    for (const [, request] of fetcher.mock.calls) {
      expect(JSON.parse(request!.body as string)).toEqual({ action: "event.read", event_key });
    }
    await fixture.client`INSERT INTO events (event_key, title, starts_at, ends_at) VALUES ('human-event', 'Human', now(), now())`;
    expect((await call("read", { event_key: "human-event" }, deps)).body.reason).toBe(
      "foreign_event",
    );
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("keeps the shared Going capacity floor and promotes available FIFO seats on published edits", async () => {
    const event_key = await create();
    await call("publish", { event_key });
    const [event] = await fixture.client`SELECT id FROM events WHERE event_key = ${event_key}`;
    await fixture.client`INSERT INTO rsvps (event_id, user_id, status, created_at) VALUES
      (${event!.id}, 'going-1', 'going', now()), (${event!.id}, 'going-2', 'going', now()),
      (${event!.id}, 'first-waiter', 'waitlisted', now() - interval '2 seconds'),
      (${event!.id}, 'second-waiter', 'waitlisted', now() - interval '1 second')`;
    expect(
      (await call("update", { event_key, version: 1, fields: { ...fields, capacity: 1 } })).status,
    ).toBe(422);
    expect(sent).toHaveLength(1);
    expect(
      (await call("update", { event_key, version: 1, fields: { ...fields, capacity: 3 } })).status,
    ).toBe(200);
    expect(sent).toHaveLength(2);
    const answers =
      await fixture.client`SELECT user_id, status FROM rsvps WHERE event_id = ${event!.id} ORDER BY user_id`;
    expect(answers).toContainEqual({ user_id: "first-waiter", status: "going" });
    expect(answers).toContainEqual({ user_id: "second-waiter", status: "waitlisted" });
  });

  it("invalidates stale agent versions after moderator edits and transitions", async () => {
    const event_key = await create();
    const actor = { id: "fixture-moderator", username: "Moderator" };
    const edited = await updateEvent(
      fixture.db,
      actor,
      event_key,
      parseEventForm({ ...fields, title: "Moderator correction" }),
    );
    expect(edited.row.agentVersion).toBe(2);
    const stale = await call("update", { event_key, version: 1, fields });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ reason: "stale_version", agent_version: 2 });
    expect((await call("read", { event_key })).body.event).toMatchObject({
      title: "Moderator correction",
      agent_version: 2,
    });
    const fresh = await call("update", {
      event_key,
      version: 2,
      fields: { ...fields, title: "Agent fresh edit" },
    });
    expect(fresh.body.agent_version).toBe(3);
    const published = await transitionEvent(fixture.db, actor, event_key, "published");
    expect(published.row.agentVersion).toBe(4);
    expect((await call("update", { event_key, version: 3, fields })).body.reason).toBe(
      "stale_version",
    );
    expect(
      (
        await fixture.client`SELECT title, status, agent_version FROM events WHERE event_key = ${event_key}`
      )[0],
    ).toEqual({ title: "Agent fresh edit", status: "published", agent_version: 4 });
    expect(sent).toHaveLength(0);
  });

  it("serializes a queued human publish behind an actual agent cancellation without resurrection", async () => {
    const event_key = await create();
    let release!: () => void;
    let ready!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const holder = fixture.client.begin(async (tx) => {
      await tx`SELECT id FROM events WHERE event_key = ${event_key} FOR UPDATE`;
      const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
      ready(Number(backend!.pid));
      await gate;
    });
    const waitForBlock = async (holderPid: number, cancelPid = -1): Promise<number> => {
      const deadline = Date.now() + 3000;
      do {
        const waiting =
          await fixture.client`SELECT pid FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND pid <> ${cancelPid}
          AND (${holderPid} = ANY(pg_blocking_pids(pid)) OR ${cancelPid} = ANY(pg_blocking_pids(pid)))`;
        if (waiting.length) return Number(waiting[0]!.pid);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } while (Date.now() < deadline);
      throw new Error("Contender never reached the event row lock");
    };
    let cancel: ReturnType<typeof call> | undefined;
    let publish: Promise<unknown> | undefined;
    try {
      const holderPid = await acquired;
      cancel = handleAgentEvent(
        fixture.client,
        { ...cfg, lockWaitMs: 5000 },
        { op: "cancel", event_key, idempotency_key: randomUUID() },
        credential,
        null,
        effects,
      );
      const cancelPid = await waitForBlock(holderPid);
      // The agent already owns the first row-lock wait; human publication must
      // observe its committed cancellation rather than the old draft snapshot.
      publish = transitionEvent(
        fixture.db,
        { id: "fixture-moderator", username: "Moderator" },
        event_key,
        "published",
      ).catch((error: unknown) => error);
      expect(await waitForBlock(holderPid, cancelPid)).not.toBe(cancelPid);
    } finally {
      release();
      await holder;
      await cancel;
      await publish;
    }
    expect((await cancel)!.status).toBe(200);
    expect(await publish).toBeInstanceOf(ValidationError);
    expect(
      (await fixture.client`SELECT status FROM events WHERE event_key = ${event_key}`)[0]!.status,
    ).toBe("cancelled");
    expect(
      (
        await fixture.client`SELECT count(*)::int AS n FROM activity_log WHERE subject_id = ${event_key}`
      )[0]!.n,
    ).toBe(0);
    expect(sentStatuses).toEqual(["cancelled"]);
  }, 15_000);

  it("refuses DST gaps without a shared event write or queue message", async () => {
    const result = await call("create", {
      fields: { ...fields, starts_at: "2030-03-31 01:30", ends_at: "2030-03-31 03:30" },
    });
    expect(result.status).toBe(422);
    expect(result.body.errors).toHaveProperty("starts_at");
    expect((await fixture.client`SELECT count(*)::int AS n FROM events`)[0]!.n).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
