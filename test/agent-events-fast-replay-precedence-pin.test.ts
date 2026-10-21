// route-inventory: (none; service-level)
// Pin: on the fast-replay path, post-wait admission wins over replay
// semantics. A grant that dies during the idempotency wait is refused 403
// even when the stored receipt would otherwise answer 409 (digest conflict
// or corrupt body) — the same admission-wins ordering the raced path
// already pins. The acceptance suite deliberately leaves this corner
// unpinned; this file owns the CISO decision so a future reorder of the
// revalidation and the receipt cannot flip it silently.
//
// Scope guard (same as the sibling replay suites): drive only the public
// `handleAgentEvent`; never import the ingress internals directly.
import { afterEach, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import {
  DEFAULT_CONFIG,
  digest,
  handleAgentEvent,
  type IngressConfig,
} from "../src/agent-events/service";
import { makeFakeAgentDb, type FakeGrant } from "./helpers/fake-agent-ingress-db";

const CALLER = "fast-replay-precedence-fixture";
const STAGING = DEFAULT_CONFIG.stagingGuildId;
const CRED = "cred-fast-replay-precedence-001";
const GRANT_ID = "grant-fast-replay-precedence-1";
const EVENT_KEY = "BBBBBBBBBBBBBBBBBBBBBBBBBB";

const cfg: IngressConfig = {
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: CALLER,
  lockWaitMs: 50,
};

const FIELDS = {
  title: "Fast-replay precedence proof event",
  game: "Helldivers 2",
  description: "One uniquely labelled precedence proof.",
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
const key = () => `fast-replay-precedence-${++seq}`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type TagFn = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

/**
 * Minimal idempotency-wait gate: initial admission always sees the live
 * grant; once the idempotency advisory lock is acquired, the final grant
 * re-read observes the flipped state. No order recorder — this file pins
 * verdicts only; the acceptance suite pins the query order.
 */
function gatedSql(
  fake: ReturnType<typeof makeFakeAgentDb>,
  hooks: { disableAfterWait?: boolean; onWait?: () => void } = {},
) {
  let waited = false;
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    const text = strings.join(" ");
    const through = () => (fake.sql as unknown as TagFn)(strings, ...values);

    if (head.includes("pg_advisory_xact_lock")) {
      const name = String(values[0] ?? "");
      if (name.startsWith("agent-event-idempotency:") && !waited) {
        waited = true;
        hooks.onWait?.();
      }
      return through();
    }
    if (text.includes("FOR SHARE")) return through();
    if (head.includes("expires_at_ms")) {
      if (!waited || !hooks.disableAfterWait) return through();
      const rows = (await through()) as { expires_at_ms: number | null; disabled: boolean }[];
      return rows.map((r) => ({ ...r, disabled: true }));
    }
    return through();
  }) as unknown as postgres.Sql;

  const seams = tag as unknown as Record<string, unknown>;
  const fakeSeams = fake.sql as unknown as Record<string, unknown>;
  seams.unsafe = fakeSeams.unsafe;
  seams.end = fakeSeams.end;
  seams.begin = async (fn: (tx: unknown) => Promise<unknown>) => fn(tag);
  return tag;
}

describe("fast-replay combined precedence: admission wins over the receipt", () => {
  it("disabled during the wait plus a conflicting digest answers 403 grant_disabled, not 409", async () => {
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, liveGrant());
    const original = { op: "create", idempotency_key: key(), fields: FIELDS };
    fake.seedReplay(GRANT_ID, original.idempotency_key, {
      payload_digest: await digest(original),
      status: 201,
      body: JSON.stringify({ event_key: EVENT_KEY, status: "draft" }),
      event_key: EVENT_KEY,
    });

    const sql = gatedSql(fake, { disableAfterWait: true });
    const changed = { ...original, fields: { ...FIELDS, title: "A different payload entirely" } };
    const answer = await handleAgentEvent(sql, cfg, changed, CRED);

    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ reason: "grant_disabled" });
    expect(answer.body).not.toHaveProperty("replayed");
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({
      grantId: GRANT_ID,
      operation: "create",
      result: "denied",
      reason: "grant_disabled",
      requestId: answer.body.request_id,
    });
  });

  it("expiry crossing the wait plus a conflicting digest answers 403 grant_expired, not 409", async () => {
    const EXPIRY = Date.parse("2030-01-01T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(EXPIRY - 1);
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, liveGrant({ expires_at: new Date(EXPIRY) }));
    const original = { op: "create", idempotency_key: key(), fields: FIELDS };
    fake.seedReplay(GRANT_ID, original.idempotency_key, {
      payload_digest: await digest(original),
      status: 201,
      body: JSON.stringify({ event_key: EVENT_KEY, status: "draft" }),
      event_key: EVENT_KEY,
    });

    const sql = gatedSql(fake, { onWait: () => clock.mockReturnValue(EXPIRY) });
    const changed = { ...original, fields: { ...FIELDS, title: "A different payload entirely" } };
    const answer = await handleAgentEvent(sql, cfg, changed, CRED);

    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ reason: "grant_expired" });
    expect(answer.body).not.toHaveProperty("replayed");
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({
      grantId: GRANT_ID,
      operation: "create",
      result: "denied",
      reason: "grant_expired",
      requestId: answer.body.request_id,
    });
  });

  it("disabled during the wait plus a corrupt receipt answers 403 grant_disabled, not 409", async () => {
    const fake = makeFakeAgentDb();
    await fake.addGrant(CRED, liveGrant());
    const body = { op: "create", idempotency_key: key(), fields: FIELDS };
    fake.seedReplay(GRANT_ID, body.idempotency_key, {
      payload_digest: await digest(body),
      status: 201,
      body: "definitely not json {{{",
      event_key: EVENT_KEY,
    });

    const sql = gatedSql(fake, { disableAfterWait: true });
    const answer = await handleAgentEvent(sql, cfg, body, CRED);

    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ reason: "grant_disabled" });
    expect(answer.body).not.toHaveProperty("replayed");
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({
      grantId: GRANT_ID,
      operation: "create",
      result: "denied",
      reason: "grant_disabled",
      requestId: answer.body.request_id,
    });
  });
});
