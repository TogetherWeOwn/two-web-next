// route-inventory: (none; service-level)
// Acceptance: a pre-found fast replay revalidates grant liveness after the
// idempotency wait (agent ingress, source pin c84bbef9).
//
// Contract under test (each RED test names the production change that flips it):
// - A pre-found replay blocked on idempotency acquisition revalidates grant
//   liveness AFTER the wait and holds the grant lock through receipt/commit.
//   Today `src/agent-events/ingress.ts` returns the pre-found replay directly
//   after the idempotency lock, while execution and raced replays revalidate
//   (`checkGrant`); a grant disabled, removed or expired during the wait is
//   answered as a replayed success. The fix routes the fast path through the
//   same final liveness check: disabled or removed grants answer
//   403 `grant_disabled`, expiry crossing the wait answers 403 `grant_expired`.
//   A removed grant audits with a null grant (no row to attribute), like the
//   execution path; disabled/expired audits attribute the grant.
// - The refusal stores no success body (the seeded evidence row is untouched:
//   a later live retry still replays the original bytes) and writes exactly
//   one denied audit — never a replay-success (`replayed`) audit.
// - Final grant-lock contention stays bounded: a held grant lock settles as
//   the existing retryable 503 `operation_busy` with the existing audited
//   error refusal, never a hung connection or an unaudited answer. The fast
//   path takes no operation lock: revalidation rides the grant lock only.
// - Valid same-key replays are unchanged: no inner-budget spend, no event
//   mutation, no bot observation, no queue work. Digest-conflict and
//   corrupt-receipt answers keep their exact 409 `idempotency_conflict`
//   contract (this file pins one representative of each; the full corrupt
//   matrix lives in `test/agent-replay-corrupt.test.ts`).
//
// Caller's next action per outcome (stable reason codes + request_id; the
// answers below carry no credential material — asserted secret-free):
// - 403 grant_disabled / grant_expired: final for this grant. Do NOT retry
//   with the same credential; have the provisioning owner issue a live grant
//   and resubmit under a fresh idempotency key (keys are namespaced per
//   grant, so the old key is not reusable elsewhere).
// - 503 operation_busy: retryable load refusal. Retry with the SAME
//   idempotency key after a short backoff; the key was not consumed.
// - 409 idempotency_conflict: the key is spent on a different payload (or an
//   undecodable receipt). Resubmit the corrected operation under a NEW key.
//
// Driven hermetically through `handleAgentEvent` against the in-memory fake
// store: no DATABASE_URL, no Discord, no network. The idempotency wait is an
// explicit gate, not a wall-clock race: a tagged-SQL wrapper records the
// semantic query order and flips the post-wait grant state (disabled /
// removed / clock-crossed expiry / held grant lock) exactly when the
// idempotency advisory lock is acquired. Initial admission always sees a live
// grant; only the post-wait revalidation observes the flip. Expiry crosses
// the wait on a fake clock pinned to the exact boundary millisecond.
// Combined precedence (e.g. disabled grant AND mismatched payload) is
// deliberately unpinned here: CISO owns that ordering on the build.
//
// Scope guard (same as the sibling replay suites): drive only the public
// `handleAgentEvent`; never import the ingress internals
// (`src/agent-events/grants.ts`, `shield.ts`, `rate-limit.ts`,
// `idempotency.ts`) directly. The wrapper observes SQL text through the fake
// `Sql` double only, like the lookup counters in the pre-auth suite.
import { afterEach, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import {
  DEFAULT_CONFIG,
  digest,
  handleAgentEvent,
  type Answer,
  type IngressConfig,
} from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";
import { makeFakeAgentDb, type FakeGrant } from "./helpers/fake-agent-ingress-db";

const CALLER = "fast-replay-revalidate-fixture";
const STAGING = DEFAULT_CONFIG.stagingGuildId;
const CRED = "cred-fast-replay-revalidate-001";
const GRANT_ID = "grant-fast-replay-revalidate-1";
const EVENT_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAA";

const cfg: IngressConfig = {
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: CALLER,
  lockWaitMs: 50,
};

const FIELDS = {
  title: "Fast-replay revalidation proof event",
  game: "Helldivers 2",
  description: "One uniquely labelled fast-replay proof.",
  starts_at: "2026-10-01 20:00",
  ends_at: "2026-10-01 22:00",
  timezone: "Europe/London",
  location: "Voice: General",
  capacity: 4,
};

const liveGrant = (overrides: Partial<FakeGrant> = {}): FakeGrant => ({
  id: GRANT_ID,
  agent_id: CALLER,
  guild_id: STAGING,
  expires_at: null,
  disabled_at: null,
  ...overrides,
});

let seq = 0;
const key = () => `fast-replay-revalidate-${++seq}`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function noFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("fetch must not be called on the fast-replay paths");
    }),
  );
}

type TagFn = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

/** Post-wait grant state observed only after the idempotency gate fires. */
type AfterWait = { mode: "live" } | { mode: "disabled" } | { mode: "removed" } | { mode: "clock" }; // Expiry is driven purely by the fake clock; pass the re-read through.

/**
 * Wrap the fake sql tag with an explicit idempotency-wait gate and a semantic
 * query-order recorder. Initial admission (grant lookup, replay lookup) always
 * passes through to the live grant; once the idempotency advisory lock is
 * acquired, `afterWait` governs the final grant re-read, and an armed
 * `busyGrantLock` makes the final grant acquisition throw 55P03. Every
 * statement the ingress issues is classified into `order`.
 */
function gatedSql(
  fake: ReturnType<typeof makeFakeAgentDb>,
  hooks: {
    afterWait?: AfterWait;
    busyGrantLock?: boolean;
    onWait?: () => void;
  } = {},
) {
  const order: string[] = [];
  let waited = false;
  const state = {
    afterWait: hooks.afterWait ?? { mode: "live" as const },
    busyGrantLock: hooks.busyGrantLock ?? false,
  };
  const setAfterWait = (next: AfterWait) => {
    state.afterWait = next;
  };

  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    const text = strings.join(" ");
    const through = () => (fake.sql as unknown as TagFn)(strings, ...values);

    if (head.includes("pg_advisory_xact_lock")) {
      const name = String(values[0] ?? "");
      if (name.startsWith("agent-event-idempotency:")) {
        order.push("idempotency-lock");
        if (!waited) {
          waited = true;
          hooks.onWait?.();
        }
        return through();
      }
      order.push(name.startsWith("agent-event-hits:") ? "hits-lock" : "operation-lock");
      return through();
    }
    if (text.includes("FOR SHARE")) {
      order.push("grant-lock");
      if (state.busyGrantLock) throw { code: "55P03" };
      if (waited && state.afterWait.mode === "removed") return [];
      return through();
    }
    if (head.includes("expires_at_ms")) {
      order.push("grant-reread");
      if (!waited || state.afterWait.mode === "live" || state.afterWait.mode === "clock")
        return through();
      if (state.afterWait.mode === "removed") return [];
      // Disabled: keep the stored expiry sample, flip only the flag.
      const rows = (await through()) as { expires_at_ms: number | null; disabled: boolean }[];
      return rows.map((r) => ({ ...r, disabled: true }));
    }
    if (head.includes("FROM agent_event_grants WHERE verifier_hash")) {
      order.push("grant-lookup");
      return through();
    }
    if (head.includes("FROM agent_event_idempotency_keys WHERE grant_id")) {
      order.push("replay-lookup");
      return through();
    }
    if (head.includes("INSERT INTO agent_event_idempotency_keys")) {
      order.push("store");
      return through();
    }
    if (head.includes("INSERT INTO agent_event_audits")) {
      order.push("audit");
      return through();
    }
    if (head.includes("INSERT INTO events")) {
      order.push("event-insert");
      return through();
    }
    if (head.includes("INSERT INTO agent_event_hits")) {
      order.push("hit");
      return through();
    }
    return through();
  }) as unknown as postgres.Sql;

  const seams = tag as unknown as Record<string, unknown>;
  const fakeSeams = fake.sql as unknown as Record<string, unknown>;
  seams.unsafe = async (...args: unknown[]) => {
    order.push("lock-timeout");
    return (fakeSeams.unsafe as (...a: unknown[]) => Promise<unknown[]>)(...args);
  };
  seams.end = fakeSeams.end;
  seams.begin = async (fn: (tx: unknown) => Promise<unknown>) => fn(tag);
  return { sql: tag, order, setAfterWait };
}

function expectOrdered(order: string[], first: string, second: string, label: string) {
  const rendered = `[${order.join(",")}]`;
  const i = order.indexOf(first);
  const j = order.indexOf(second);
  expect(i, `${label}: expected ${first} in ${rendered}`).toBeGreaterThanOrEqual(0);
  expect(j, `${label}: expected ${second} in ${rendered}`).toBeGreaterThanOrEqual(0);
  expect(j, `${label}: expected ${second} after ${first} in ${rendered}`).toBeGreaterThan(i);
}

function expectCorrelated(answer: Answer) {
  expect(typeof answer.body.request_id).toBe("string");
  expect(String(answer.body.request_id).length).toBeGreaterThan(0);
}

async function expectSecretFree(
  answer: Answer,
  fake: ReturnType<typeof makeFakeAgentDb>,
  credential: string,
) {
  const evidence = JSON.stringify({ answer, audits: fake.audits });
  expect(evidence).not.toContain(credential);
  expect(evidence).not.toContain(await sha256Hex(credential));
}

const INNER_BUCKETS = [`mutating:${GRANT_ID}`, "service-mutating"];
const innerHitCount = (fake: ReturnType<typeof makeFakeAgentDb>) =>
  fake.hits.filter((h) => INNER_BUCKETS.includes(h.bucket)).length;

function effects() {
  const writeBack = vi.fn(async () => {});
  const readEvent = vi.fn(async () => ({ ok: false as const, code: "fixture" }));
  return { writeBack, readEvent };
}

async function seedLiveReplay(
  fake: ReturnType<typeof makeFakeAgentDb>,
  body: Record<string, unknown>,
  stored: Record<string, unknown> = { event_key: EVENT_KEY, status: "draft" },
) {
  fake.seedReplay(GRANT_ID, body.idempotency_key as string, {
    payload_digest: await digest(body),
    status: 201,
    body: JSON.stringify(stored),
    event_key: EVENT_KEY,
  });
  return stored;
}

describe("fast replays revalidate grant liveness after the idempotency wait", () => {
  it("a grant disabled during the wait answers 403 grant_disabled, stores nothing and audits once", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, liveGrant());
    fake.prespend(`mutating:${GRANT_ID}`);
    fake.prespend("service-mutating");
    const body = { op: "create", idempotency_key: key(), fields: FIELDS };
    const stored = await seedLiveReplay(fake, body);
    const eff = effects();

    const gate = gatedSql(fake, { afterWait: { mode: "disabled" } });
    const innerBefore = innerHitCount(fake);
    const answer = await handleAgentEvent(gate.sql, cfg, body, CRED, null, eff);

    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ reason: "grant_disabled" });
    expect(answer.body).not.toHaveProperty("replayed");
    expectCorrelated(answer);
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({
      grantId: GRANT_ID,
      operation: "create",
      result: "denied",
      reason: "grant_disabled",
      requestId: answer.body.request_id,
    });
    // The revalidation happens after the wait, on the grant lock, before the
    // receipt — and the fast path takes no operation lock.
    expectOrdered(gate.order, "idempotency-lock", "grant-reread", "disable");
    expectOrdered(gate.order, "idempotency-lock", "grant-lock", "disable");
    expectOrdered(gate.order, "grant-lock", "audit", "disable");
    expect(gate.order).not.toContain("operation-lock");
    // No stored success body: nothing is written to the idempotency store, and
    // the seeded evidence survives byte-identically for a later live retry.
    expect(gate.order).not.toContain("store");
    expect(innerHitCount(fake)).toBe(innerBefore);
    expect(eff.writeBack).not.toHaveBeenCalled();
    expect(eff.readEvent).not.toHaveBeenCalled();
    await expectSecretFree(answer, fake, CRED);

    gate.setAfterWait({ mode: "live" });
    const retry = await handleAgentEvent(gate.sql, cfg, body, CRED, null, eff);
    expect(retry.status).toBe(201);
    const { request_id: _ignored, ...rest } = retry.body as Record<string, unknown>;
    expect(rest).toEqual({ ...stored, replayed: true });
  });

  it("a grant removed during the wait answers 403 grant_disabled with a null-grant audit", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, liveGrant());
    const body = { op: "create", idempotency_key: key(), fields: FIELDS };
    await seedLiveReplay(fake, body);
    const eff = effects();

    const gate = gatedSql(fake, { afterWait: { mode: "removed" } });
    const innerBefore = innerHitCount(fake);
    const answer = await handleAgentEvent(gate.sql, cfg, body, CRED, null, eff);

    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ reason: "grant_disabled" });
    expect(answer.body).not.toHaveProperty("replayed");
    expectCorrelated(answer);
    // No grant row survives to attribute: the denial audits with a null grant,
    // exactly like the execution path for a removed grant.
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({
      grantId: null,
      operation: "create",
      result: "denied",
      reason: "grant_disabled",
      requestId: answer.body.request_id,
    });
    expectOrdered(gate.order, "idempotency-lock", "grant-reread", "removal");
    expectOrdered(gate.order, "idempotency-lock", "grant-lock", "removal");
    expect(gate.order).not.toContain("operation-lock");
    expect(gate.order).not.toContain("store");
    expect(innerHitCount(fake)).toBe(innerBefore);
    expect(eff.writeBack).not.toHaveBeenCalled();
    expect(eff.readEvent).not.toHaveBeenCalled();
    await expectSecretFree(answer, fake, CRED);
  });

  it("expiry crossing the wait on the fake clock answers 403 grant_expired", async () => {
    noFetch();
    const EXPIRY = Date.parse("2030-01-01T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(EXPIRY - 1);
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, liveGrant({ expires_at: new Date(EXPIRY) }));
    const body = { op: "create", idempotency_key: key(), fields: FIELDS };
    await seedLiveReplay(fake, body);
    const eff = effects();

    // Initial admission runs live at EXPIRY - 1; the wait carries the clock
    // onto the exact expiry boundary, which the post-wait sample must refuse.
    const gate = gatedSql(fake, {
      afterWait: { mode: "clock" },
      onWait: () => clock.mockReturnValue(EXPIRY),
    });
    const innerBefore = innerHitCount(fake);
    const answer = await handleAgentEvent(gate.sql, cfg, body, CRED, null, eff);

    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ reason: "grant_expired" });
    expect(answer.body).not.toHaveProperty("replayed");
    expectCorrelated(answer);
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({
      grantId: GRANT_ID,
      operation: "create",
      result: "denied",
      reason: "grant_expired",
      requestId: answer.body.request_id,
    });
    expectOrdered(gate.order, "idempotency-lock", "grant-reread", "expiry");
    expect(gate.order).not.toContain("operation-lock");
    expect(gate.order).not.toContain("store");
    expect(innerHitCount(fake)).toBe(innerBefore);
    expect(eff.writeBack).not.toHaveBeenCalled();
    expect(eff.readEvent).not.toHaveBeenCalled();
    await expectSecretFree(answer, fake, CRED);
  });

  it("final grant-lock contention settles as the audited 503 operation_busy refusal", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, liveGrant());
    const body = { op: "create", idempotency_key: key(), fields: FIELDS };
    await seedLiveReplay(fake, body);
    const eff = effects();

    const gate = gatedSql(fake, { busyGrantLock: true });
    const innerBefore = innerHitCount(fake);
    const answer = await handleAgentEvent(gate.sql, cfg, body, CRED, null, eff);

    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ reason: "operation_busy" });
    expect(answer.body).not.toHaveProperty("replayed");
    expectCorrelated(answer);
    // The existing load-error disposition: one audited error refusal, never a
    // replay-success audit and never a rate denial.
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({
      operation: "create",
      result: "error",
      reason: "operation_busy",
      requestId: answer.body.request_id,
    });
    expect(gate.order).toContain("grant-lock");
    expect(gate.order).not.toContain("store");
    expect(innerHitCount(fake)).toBe(innerBefore);
    expect(eff.writeBack).not.toHaveBeenCalled();
    expect(eff.readEvent).not.toHaveBeenCalled();
    await expectSecretFree(answer, fake, CRED);
  });
});

describe("fast-replay controls: valid, boundary-live, conflict and corrupt (pass before and after)", () => {
  it("a valid same-key replay spends no inner budget, mutates nothing and triggers no effects", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, liveGrant());
    fake.prespend(`mutating:${GRANT_ID}`);
    fake.prespend("service-mutating");
    const body = { op: "create", idempotency_key: key(), fields: FIELDS };
    const stored = await seedLiveReplay(fake, body);
    const eff = effects();

    const gate = gatedSql(fake);
    const innerBefore = innerHitCount(fake);
    const answer = await handleAgentEvent(gate.sql, cfg, body, CRED, null, eff);

    expect(answer.status).toBe(201);
    const { request_id: _ignored, ...rest } = answer.body as Record<string, unknown>;
    expect(rest).toEqual({ ...stored, replayed: true });
    expectCorrelated(answer);
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({
      grantId: GRANT_ID,
      result: "replayed",
      reason: null,
      requestId: answer.body.request_id,
    });
    expect(innerHitCount(fake)).toBe(innerBefore);
    expect(gate.order).not.toContain("event-insert");
    expect(gate.order).not.toContain("store");
    expect(eff.writeBack).not.toHaveBeenCalled();
    expect(eff.readEvent).not.toHaveBeenCalled();

    // Stable: a second identical delivery replays the same bytes again.
    const again = await handleAgentEvent(gate.sql, cfg, body, CRED, null, eff);
    expect(again.status).toBe(201);
    const { request_id: _againId, ...againRest } = again.body as Record<string, unknown>;
    expect(againRest).toEqual({ ...stored, replayed: true });
    expect(again.body.request_id).not.toBe(answer.body.request_id);
  });

  it("a grant still live at the boundary millisecond replays (fake-clock control)", async () => {
    noFetch();
    const EXPIRY = Date.parse("2030-01-01T00:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(EXPIRY - 1);
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, liveGrant({ expires_at: new Date(EXPIRY) }));
    const body = { op: "create", idempotency_key: key(), fields: FIELDS };
    const stored = await seedLiveReplay(fake, body);

    // The clock never crosses: admission and the post-wait sample both see a
    // live grant, so the replay is answered.
    const gate = gatedSql(fake, { afterWait: { mode: "clock" } });
    const answer = await handleAgentEvent(gate.sql, cfg, body, CRED);

    expect(answer.status).toBe(201);
    const { request_id: _ignored, ...rest } = answer.body as Record<string, unknown>;
    expect(rest).toEqual({ ...stored, replayed: true });
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({ result: "replayed", reason: null });
  });

  it("a digest-conflicting fast replay keeps the exact 409 contract and preserves the row", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, liveGrant());
    const original = { op: "create", idempotency_key: key(), fields: FIELDS };
    const stored = await seedLiveReplay(fake, original);
    const gate = gatedSql(fake);

    const changed = { ...original, fields: { ...FIELDS, title: "A different payload entirely" } };
    const conflict = await handleAgentEvent(gate.sql, cfg, changed, CRED);
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ reason: "idempotency_conflict" });
    expect(conflict.body).not.toHaveProperty("replayed");
    expectCorrelated(conflict);
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({ result: "conflict", reason: "idempotency_conflict" });
    expect(gate.order).not.toContain("store");

    // The stored evidence is untouched: the original payload still replays.
    const replay = await handleAgentEvent(gate.sql, cfg, original, CRED);
    expect(replay.status).toBe(201);
    const { request_id: _ignored, ...rest } = replay.body as Record<string, unknown>;
    expect(rest).toEqual({ ...stored, replayed: true });
  });

  it("a corrupt fast-replay receipt keeps the stable audited 409 without re-executing", async () => {
    noFetch();
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, liveGrant());
    const body = { op: "create", idempotency_key: key(), fields: FIELDS };
    fake.seedReplay(GRANT_ID, body.idempotency_key, {
      payload_digest: await digest(body),
      status: 201,
      body: "definitely not json {{{",
      event_key: EVENT_KEY,
    });
    const gate = gatedSql(fake);

    const first = await handleAgentEvent(gate.sql, cfg, body, CRED);
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({ reason: "idempotency_conflict" });
    expect(first.body).not.toHaveProperty("replayed");
    // The wedge is gone: the retry answers the same way instead of throwing.
    const second = await handleAgentEvent(gate.sql, cfg, body, CRED);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ reason: "idempotency_conflict" });
    expect(second.body.request_id).not.toBe(first.body.request_id);
    expect(fake.audits.map((a) => [a.result, a.reason])).toEqual([
      ["conflict", "idempotency_conflict"],
      ["conflict", "idempotency_conflict"],
    ]);
    expect(gate.order).not.toContain("store");
    expect(gate.order).not.toContain("event-insert");
  });
});
