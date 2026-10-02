import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env, Session } from "../src/env";
import { requestLog } from "../src/request-log";
import { registerEventRoutes } from "../src/events/routes";
import { enqueueEventSync, type SyncMessage } from "../src/events/sync";
import { dispatchWriteBack } from "../src/admin/writeback";
import { dispatchRsvpSync } from "../src/events/rsvp";
import { dispatchSyncEvent } from "../src/jobs/sync-event";
import { dispatchAnnouncement, dispatchRoleAssign } from "../src/jobs/call-internal-action";
import { trackingQueue } from "../src/jobs/ledger";
import { consume } from "../src/jobs/consumer";
import { BotTerminalError } from "../src/jobs/types";
import type { BotClient, EventStore, QueueLedger, QueueMessage, UniqueLock } from "../src/jobs/types";

// Stub only persistence, not dispatch: route -> seam -> carrier remains real.
vi.mock("../src/admin/db", () => ({ dbFor: async () => ({}) }));
vi.mock("../src/admin/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/admin/store")>(),
  transitionEvent: async (_db: unknown, _actor: unknown, eventKey: string, status: string) => ({
    row: { eventKey, status, startsAt: new Date(0), endsAt: new Date(1) },
    writeBack: { eventKey, status },
  }),
}));
vi.mock("../src/events/reads", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/events/reads")>(),
  withGoingCount: async (_db: unknown, row: object) => ({ ...row, goingCount: 0 }),
}));
vi.mock("../src/events/rsvp", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/events/rsvp")>(),
  writeRsvp: async (_db: unknown, eventKey: string) => ({
    ok: true, eventKey, mirrored: "published", created: true, answer: { status: "going", syncedToDiscordAt: null },
  }),
  withdrawRsvp: async () => ({ limited: false, status: "published" }),
}));

const ID = "0123456789abcdef-LHR";
const OTHER_ID = "fedcba9876543210-LHR";
const KEY = "01ARYZ6S41TSV4RRFFQ69G5FAV";
const env = { APP_URL: "https://example.test" } as Env;
const LEASE = "00000000-0000-4000-8000-000000000000";
const lock: UniqueLock = { acquire: async () => LEASE, release: async () => {} };
const ledger: QueueLedger = {
  enqueued: async () => {}, reserved: async () => {}, released: async () => {}, dequeued: async () => {}, failed: async () => {},
};
afterEach(() => vi.restoreAllMocks());

/** One real event route with requestLog, capturing what it sends to EVENT_SYNC_QUEUE. */
async function routeSync(method: string, path: string) {
  const sent: SyncMessage[] = [];
  const bindings = { ...env, EVENT_SYNC_QUEUE: { send: async (message: SyncMessage) => void sent.push(message) } };
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", requestLog);
  const session = { id: "fixture-member", username: "fixture", member: true, moderator: true, avatar: null } as Session;
  registerEventRoutes(app, async () => session, async () => session);
  const response = await app.request(path, {
    method, headers: { "cf-ray": ID, "content-type": "application/json" },
    body: method === "PUT" ? JSON.stringify({ status: "going" }) : undefined,
  }, bindings);
  return { response, sent };
}

describe("request correlation through queue envelopes (local fixtures)", () => {
  it.each([
    ["POST", `/events/${KEY}/publish`, 200], ["POST", `/events/${KEY}/cancel`, 200],
    ["PUT", `/events/${KEY}/rsvp`, 201], ["DELETE", `/events/${KEY}/rsvp`, 204],
  ])("propagates the HTTP ID from %s %s to the actual event-sync envelope", async (method, path, status) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { response, sent } = await routeSync(method, path);
    expect(response.status).toBe(status);
    expect(response.headers.get("x-request-id")).toBe(ID);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ requestId: ID, eventKey: KEY, dedupeKey: KEY });
    expect(sent[0]!.idempotencyKey).not.toBe(ID);
  });

  // The W8 producer binding (EVENT_SYNC_QUEUE) and the consumer's queue
  // (SYNC_EVENT_QUEUE) are still split in wrangler; that wiring is TOG-10815.
  // This proves the carrier itself: a route-produced message reaches the
  // terminal queue.failing alert with the originating request ID.
  it.each([["POST", `/events/${KEY}/publish`], ["PUT", `/events/${KEY}/rsvp`]])(
    "carries the ID from %s %s through consume to a terminal queue.failing alert", async (method, path) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { sent } = await routeSync(method, path);
      expect(sent).toHaveLength(1);
      const events = { find: async (eventKey: string) => ({ eventKey, payload: {}, mirrored: true }) } as unknown as EventStore;
      const bot = { upsertEvent: async () => { throw new BotTerminalError("fixture-failure"); } } as unknown as BotClient;
      const ack = vi.fn(), retry = vi.fn();
      await consume({ messages: [{ body: sent[0], attempts: 1, ack, retry }] }, { bot, lock, ledger, events });
      const alerts = error.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('"queue.failing"'));
      expect(alerts.map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ event: "queue.failing", job: "SyncEventToDiscord", request_id: ID }),
      ]);
      expect(ack).toHaveBeenCalledTimes(1);
      expect(retry).not.toHaveBeenCalled();
    });

  it("preserves IDs through admin/RSVP seams, rejects invalid metadata, and accepts legacy calls", async () => {
    const sent: SyncMessage[] = [];
    const bindings = { ...env, EVENT_SYNC_QUEUE: { send: async (message: SyncMessage) => void sent.push(message) } };
    await dispatchWriteBack(bindings, { eventKey: KEY, status: "published" }, ID);
    await dispatchRsvpSync(bindings, KEY, "published", OTHER_ID);
    await enqueueEventSync(bindings, KEY, "published", "bearer-secret");
    await enqueueEventSync(bindings, KEY, "cancelled");
    expect(sent.map((m) => m.requestId)).toEqual([ID, OTHER_ID, undefined, undefined]);
    expect(JSON.stringify(sent)).not.toContain("bearer-secret");
    expect(new Set(sent.map((m) => m.idempotencyKey)).size).toBe(4);
  });

  it("all job producers and the ledger wrapper preserve correlation independent of job/idempotency keys", async () => {
    const sent: QueueMessage[] = [];
    const queue = trackingQueue({ send: async (body: unknown) => void sent.push(body as QueueMessage) }, ledger);
    await dispatchSyncEvent(queue, lock, KEY, ID);
    await dispatchAnnouncement(queue, { channelKey: "fixture", body: "fixture" }, ID);
    await dispatchRoleAssign(queue, { userId: "fixture-member", roleKey: "fixture" }, ID);
    expect(sent).toHaveLength(3);
    for (const message of sent) {
      expect(message.requestId).toBe(ID);
      expect(message.jobId).toMatch(/^[0-9a-f-]{36}$/);
      expect("idempotencyKey" in message && message.idempotencyKey).not.toBe(ID);
    }
    await dispatchAnnouncement(queue, { channelKey: "fixture", body: "fixture" }, "cookie-secret");
    expect(sent[3]!.requestId).toBeUndefined();
  });

  it.each(["terminal", "exhausted throw"])("correlates %s alerts per message without overwriting IDs on retries", async (failure) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const bot = { postAnnouncement: async () => {
      if (failure === "terminal") throw new BotTerminalError("fixture-failure");
      throw new TypeError("fixture-failure");
    } } as unknown as BotClient;
    const body = { kind: "announcement", action: { channelKey: "fixture", body: "fixture" }, idempotencyKey: "fixed", requestId: ID };
    const ack = vi.fn(), retry = vi.fn();
    if (failure === "exhausted throw") {
      await consume({ messages: [{ body, attempts: 1, ack, retry }] }, { bot, lock, ledger, events: {} as EventStore });
      expect(retry).toHaveBeenCalledTimes(1);
      expect(ack).not.toHaveBeenCalled();
      expect(body.requestId).toBe(ID);
      expect(body.idempotencyKey).toBe("fixed");
      expect(error.mock.calls.some(([line]) => String(line).includes('"queue.failing"'))).toBe(false);
    }
    const messages = [ID, OTHER_ID, "cookie-secret", undefined].map((requestId) => ({
      body: { ...body, requestId }, attempts: 5, ack, retry,
    }));
    await consume({ messages }, { bot, lock, ledger, events: {} as EventStore });
    const alerts = error.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('"queue.failing"')).map((line) => JSON.parse(line));
    expect(alerts.map((line) => line.request_id)).toEqual([ID, OTHER_ID, undefined, undefined]);
    expect(JSON.stringify(alerts)).not.toContain("cookie-secret");
    expect(ack).toHaveBeenCalledTimes(4);
  });
});
