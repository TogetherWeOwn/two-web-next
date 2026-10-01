// Drill probes as Vitest tests (TOG-11732).
//
// Ports the two dropped legacy artisan drills from docs/parity.md §7 as hermetic
// Vitest proofs — no commands, no staging/prod, no network, no DATABASE_URL:
//   - `error-alert:probe` → `error.alert` emits one critical line per
//     `class@route` fingerprint per 5 minutes against a fixture logger.
//   - `queue:poison-probe` → a poison-queue fixture is isolated from ordinary
//     queued work (malformed carrier + terminal poison in the same batch).
//
// Fixture-only: in-memory sink/ledger/lock/bot. The console spies prove no
// payload leaks through the warn/error paths.

import { afterEach, describe, expect, it, vi } from "vitest";
import { HTTPException } from "hono/http-exception";
import {
  ALERT_WINDOW_MS,
  AlertRateLimit,
  alertRequestError,
} from "../src/alerts";
import { consume } from "../src/jobs/consumer";
import { CALL_INTERNAL_ACTION, SYNC_EVENT } from "../src/jobs/constants";
import { BotTerminalError } from "../src/jobs/types";
import type {
  BotClient,
  EventStore,
  SyncAttempt,
  QueueLedger,
  UniqueLock,
} from "../src/jobs/types";

class DrillBoomError extends Error {}

function errorProbeFixture() {
  let t = 1_000;
  const limiter = new AlertRateLimit(ALERT_WINDOW_MS, () => t);
  const lines: string[] = [];
  const sink = (line: string) => void lines.push(line);
  const emit = (route: string, err: unknown) =>
    alertRequestError(err, { method: "POST", route }, { limiter, sink });
  return { emit, lines, advance: (ms: number) => { t += ms; } };
}

describe("error-alert:probe drill", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits one critical line per fingerprint per 5 minutes against a fixture logger", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = errorProbeFixture();

    // First sighting alerts.
    expect(f.emit("/drill-probe", new DrillBoomError("private SQL values"))).toBe(true);
    expect(f.lines).toHaveLength(1);

    // Same fingerprint inside the window stays silent.
    expect(f.emit("/drill-probe", new DrillBoomError("private SQL values"))).toBe(false);
    expect(f.lines).toHaveLength(1);

    // A different fingerprint is independent.
    expect(f.emit("/drill-probe-other", new DrillBoomError("private SQL values"))).toBe(true);
    expect(f.lines).toHaveLength(2);

    // Still muted just before the window closes.
    f.advance(ALERT_WINDOW_MS - 1);
    expect(f.emit("/drill-probe", new DrillBoomError("again"))).toBe(false);
    expect(f.lines).toHaveLength(2);

    // Re-alerts at the exact window boundary.
    f.advance(1);
    expect(f.emit("/drill-probe", new DrillBoomError("again"))).toBe(true);
    expect(f.lines).toHaveLength(3);

    // The drill writes to the fixture sink, never to the real console.
    expect(err).not.toHaveBeenCalled();
  });

  it("the critical line is single-line JSON with class@route and no message", () => {
    const f = errorProbeFixture();
    expect(f.emit("/drill-probe", new DrillBoomError("secret INSERT values\nsecond line"))).toBe(true);
    expect(f.lines).toHaveLength(1);
    const line = f.lines[0]!;
    expect(line).not.toContain("\n");
    expect(line).not.toContain("secret");
    expect(JSON.parse(line)).toEqual({
      level: "critical",
      event: "error.alert",
      fingerprint: "DrillBoomError@/drill-probe",
      exception: "DrillBoomError",
      method: "POST",
      route: "/drill-probe",
    });
  });

  it("dont-report errors stay silent and consume no mute", () => {
    const f = errorProbeFixture();
    expect(f.emit("/drill-probe", new HTTPException(404))).toBe(false);
    expect(f.emit("/drill-probe", new HTTPException(403))).toBe(false);
    expect(f.emit("/drill-probe", Object.assign(new Error("invalid"), { name: "ZodError" }))).toBe(false);
    expect(f.lines).toHaveLength(0);
    // A reportable error on the same route still alerts: silenced probes never
    // occupied the fingerprint.
    expect(f.emit("/drill-probe", new DrillBoomError("x"))).toBe(true);
    expect(f.lines).toHaveLength(1);
  });
});

// --- queue:poison-probe drill fixtures (in-memory only) ---------------------

const LEASE = "11111111-1111-4111-8111-111111111111";

function memLedger() {
  const rows = new Map<string, { state: string; reason?: string }>();
  const ledger: QueueLedger = {
    enqueued: async (j) => void rows.set(j.jobId, { state: "pending" }),
    reserved: async (id) => void rows.set(id, { state: "reserved" }),
    released: async (id) => void rows.set(id, { state: "released" }),
    dequeued: async (id) => void rows.delete(id),
    failed: async (id, _kind, _key, reason) => void rows.set(id, { state: "failed", reason }),
  };
  return { ledger, rows };
}

function memLock() {
  const held = new Set<string>();
  const lock: UniqueLock = {
    acquire: async (k) => (held.has(k) ? null : (held.add(k), LEASE)),
    release: async (k, token) => { if (token === LEASE) held.delete(k); },
  };
  return { lock, held };
}

function memStore(): EventStore {
  const attempt = (eventKey: string, idempotencyKey: string): SyncAttempt => ({
    idempotencyKey, eventKey, revision: 1, action: "event.upsert",
    payload: { eventKey, name: "n", startsAt: "s", endsAt: null, location: "l", description: null },
    mirroredAt: new Date(0), state: "pending", requestAttempts: 0, nextAttemptAt: new Date(0),
  });
  return {
    prepareSync: async (eventKey, key) => attempt(eventKey, key),
    claimSync: async (a) => a,
    completeSync: async () => {},
    deferSync: async () => {},
    failSync: async () => {},
    needsSync: async () => false,
    pendingSync: async () => null,
    closeFinished: async () => 0,
    materializeSeries: async () => 0,
    staleEventKeys: async () => [],
  };
}

function track(body: unknown, attempts = 1) {
  const r = { body, attempts, acked: false, retried: undefined as number | undefined | "now" };
  return Object.assign(r, {
    ack() { r.acked = true; },
    retry(o?: { delaySeconds?: number }) { r.retried = o?.delaySeconds ?? "now"; },
  });
}

describe("queue:poison-probe drill", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a malformed poison carrier is discarded while the ordinary sibling completes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ledger, rows } = memLedger();
    const { lock } = memLock();
    const bot = {
      upsertEvent: async () => ({ ok: true as const, requestId: null, discordEventId: "d1" }),
    } as unknown as BotClient;

    const poison = track({ kind: "poison", payload: "private-poison-body", jobId: "poison-job" });
    const ordinary = track(
      { kind: "sync-event", eventKey: "e-ordinary", idempotencyKey: "k-ordinary", jobId: "ordinary-job" },
    );

    await consume({ messages: [poison, ordinary] }, { bot, events: memStore(), lock, ledger });

    // Poison discarded alone: acked, never retried, no ledger row, no lock, no
    // handler error. The fixed warning carries no attacker-controlled payload.
    expect(poison.acked).toBe(true);
    expect(poison.retried).toBeUndefined();
    expect(rows.has("poison-job")).toBe(false);
    expect(warn).toHaveBeenCalledExactlyOnceWith("queue malformed message discarded");
    expect(warn.mock.calls[0]![0]).not.toContain("private-poison");
    expect(err).not.toHaveBeenCalled();

    // Ordinary sibling completes in the same batch: acked, ledger dequeued.
    expect(ordinary.acked).toBe(true);
    expect(ordinary.retried).toBeUndefined();
    expect(rows.has("ordinary-job")).toBe(false);
  });

  it("a terminal poison fails alone while the ordinary sibling succeeds", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ledger, rows } = memLedger();
    const { lock } = memLock();
    const poisonAnn = {
      kind: "announcement",
      idempotencyKey: "poison-key",
      action: { channelKey: "c", body: "poison-body" },
      jobId: "poison-job",
    };
    const ordinaryAnn = {
      kind: "announcement",
      idempotencyKey: "ordinary-key",
      action: { channelKey: "c", body: "ordinary-body" },
      jobId: "ordinary-job",
    };
    const bot = {
      postAnnouncement: async (a: { body: string }) => {
        if (a.body === "poison-body") throw new BotTerminalError("poison terminal");
        return { ok: true as const, requestId: null, messageId: "m1", replayed: false };
      },
    } as unknown as BotClient;

    const poison = track(poisonAnn, CALL_INTERNAL_ACTION.tries);
    const ordinary = track(ordinaryAnn);

    await consume({ messages: [poison, ordinary] }, { bot, events: memStore(), lock, ledger });

    // Both reach a terminal ack; only the poison lands in the failed ledger.
    expect(poison.acked).toBe(true);
    expect(ordinary.acked).toBe(true);
    expect(rows.get("poison-job")?.state).toBe("failed");
    expect(rows.has("ordinary-job")).toBe(false);

    // One queue.failing line for the poison, none for the ordinary sibling.
    const failing = err.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('"queue.failing"'))
      .map((l) => JSON.parse(l));
    expect(failing).toHaveLength(1);
    expect(failing[0]).toMatchObject({
      level: "critical",
      event: "queue.failing",
      queue: "two-internal-action",
      job: "CallInternalAction",
      attempts: CALL_INTERNAL_ACTION.tries,
    });
    expect(String(failing[0].exception)).not.toContain("poison-body");
  });

  it("an exhausted poison throw frees its lock while the ordinary sync-event still mirrors", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ledger, rows } = memLedger();
    const { lock, held } = memLock();
    const mirrored: string[] = [];
    const events: EventStore = {
      ...memStore(),
      completeSync: async (_a, id) => void mirrored.push(id),
    };
    let calls = 0;
    const bot = {
      upsertEvent: async (_p: unknown, _key: string) => {
        if (++calls === 1) throw new TypeError("poison-boom");
        return { ok: true as const, requestId: null, discordEventId: "d-ordinary" };
      },
    } as unknown as BotClient;

    const poisonKey = "sync-event:e-poison";
    held.add(poisonKey);
    const poison = track(
      { kind: "sync-event", eventKey: "e-poison", idempotencyKey: "k-poison", leaseToken: LEASE, jobId: "poison-job" },
      SYNC_EVENT.tries,
    );
    const ordinary = track(
      { kind: "sync-event", eventKey: "e-ordinary", idempotencyKey: "k-ordinary", jobId: "ordinary-job" },
    );

    await consume({ messages: [poison, ordinary] }, { bot, events, lock, ledger });

    // Poison at the tries cap acks terminally, lands failed, and frees its lock;
    // the ordinary sibling still mirrors and dequeues in the same batch.
    expect(poison.acked).toBe(true);
    expect(poison.retried).toBeUndefined();
    expect(rows.get("poison-job")?.state).toBe("failed");
    expect(held.has(poisonKey)).toBe(false);
    expect(ordinary.acked).toBe(true);
    expect(rows.has("ordinary-job")).toBe(false);
    expect(mirrored).toEqual(["d-ordinary"]);
  });
});
