// Audit-fallback sanitiser pins for the agent-ingress control-byte guard.
//
// Companion to test/agent-events-ingress-control-bytes.test.ts (acceptance
// owned — do not duplicate its cases here): the two denials that run before
// the admission guard (ingress-disabled 404 and shape-invalid 422) audit
// sanitised `auditOp`/`auditKey` fallbacks, so a hostile value on the other
// half of an invalid envelope must never reach the audit INSERT raw, where
// PostgreSQL `text` would reject NUL (22021) and turn the denial into a 500.
//
// Scope guard: drive only through the public `handleAgentEvent` seam, like
// the sibling ingress suites; do not import ingress/grants/shield/rate-limit/
// idempotency internals.
//
// NOTE: this file must contain no raw control bytes itself. The hostile byte
// is built with String.fromCharCode so the source stays plain ASCII.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONFIG,
  handleAgentEvent,
  type Answer,
  type IngressConfig,
} from "../src/agent-events/service";
import { makeFakeAgentDb, type FakeAgentDb, type FakeGrant } from "./helpers/fake-agent-ingress-db";

const CALLER = "agent-under-test";
const STAGING = DEFAULT_CONFIG.stagingGuildId;
const CRED = "cred-audit-fallback-001";
const GRANT_ID = "grant-audit-fallback-1";

// Built without escapes so this source file carries no raw control bytes.
const NUL = String.fromCharCode(0);
const HOSTILE_KEY = `x${NUL}y`;
const HOSTILE_OP = `cre${NUL}ate`;

const cfg: IngressConfig = {
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: CALLER,
  lockWaitMs: 50,
};

const FIELDS = {
  title: "Agent proof event",
  game: "Helldivers 2",
  description: "One uniquely labelled audit-fallback proof.",
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

function hasControlByte(value: string): boolean {
  for (const ch of value) {
    const c = ch.charCodeAt(0);
    if (c <= 31 || c === 127) return true;
  }
  return false;
}

afterEach(() => vi.unstubAllGlobals());

function noFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("fetch must not be called on the ingress admission paths");
    }),
  );
}

// PostgreSQL `text` cannot carry NUL: a real bind raises 22021. The plain
// fake accepts any string, so wrap it to reproduce that one driver behaviour
// and to record the values offered to the audit INSERT.
function pgTextDouble(fake: FakeAgentDb) {
  const auditValues: unknown[][] = [];
  const guard = (args: unknown[]) => {
    const strings = args[0];
    const head = Array.isArray(strings) ? ((strings[0] as string) ?? "") : "";
    if (head.includes("INSERT INTO agent_event_audits")) auditValues.push([...args.slice(1)]);
    for (const value of args.slice(1)) {
      if (typeof value === "string" && value.includes(NUL)) {
        throw Object.assign(
          new Error(
            'invalid byte sequence for encoding "UTF8": 0x00 (simulated PostgreSQL text bind)',
          ),
          { code: "22021" },
        );
      }
    }
  };
  const wrap = (target: unknown): unknown =>
    new Proxy(target as object, {
      apply: async (t, thisArg, args: unknown[]) => {
        guard(args);
        return Reflect.apply(t as (...a: unknown[]) => unknown, thisArg, args);
      },
      get: (t, prop) =>
        prop === "begin"
          ? (fn: (tx: unknown) => Promise<unknown>) =>
              (t as { begin: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).begin(
                (tx) => fn(wrap(tx)),
              )
          : Reflect.get(t, prop),
    });
  return { sql: wrap(fake.sql) as FakeAgentDb["sql"], auditValues };
}

async function setup(grant: FakeGrant | null = liveGrant(), config: IngressConfig = cfg) {
  noFetch();
  const fake = makeFakeAgentDb();
  if (grant) await fake.addGrant(CRED, grant);
  const { sql, auditValues } = pgTextDouble(fake);
  const call = (body: unknown, credential: string | null = CRED): Promise<Answer> =>
    handleAgentEvent(sql, config, body, credential);
  return { fake, sql, auditValues, call };
}

// No value offered to (or recorded by) the audit INSERT may carry the
// hostile bytes raw: the denial is audited sanitised, never by persisting
// the attacker's control character.
function expectNoControlInAudit(fake: FakeAgentDb, auditValues: unknown[][]) {
  for (const row of auditValues) {
    for (const value of row) {
      if (typeof value === "string") expect(hasControlByte(value)).toBe(false);
    }
  }
  for (const audit of fake.audits) {
    expect(hasControlByte(audit.operation)).toBe(false);
  }
}

describe("audit-fallback sanitiser (denials before the control guard)", () => {
  it("non-string op with a NUL key answers 422, never 500, auditing a sanitised fallback", async () => {
    const { fake, auditValues, call } = await setup();
    const a = await call({ op: 5, idempotency_key: HOSTILE_KEY, fields: FIELDS });
    expect(a.status).not.toBeGreaterThanOrEqual(500);
    expect(a.status).toBe(422);
    expect(a.body).toMatchObject({ reason: "validation_failed" });
    expectNoControlInAudit(fake, auditValues);
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({ operation: "unknown", reason: "validation_failed" });
  });

  it("NUL op with an over-length key answers 422, never 500, auditing a sanitised fallback", async () => {
    const { fake, auditValues, call } = await setup();
    const a = await call({ op: HOSTILE_OP, idempotency_key: "a".repeat(256), fields: FIELDS });
    expect(a.status).not.toBeGreaterThanOrEqual(500);
    expect(a.status).toBe(422);
    expect(a.body).toMatchObject({ reason: "validation_failed" });
    expectNoControlInAudit(fake, auditValues);
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({ operation: "unknown", reason: "validation_failed" });
  });

  it("disabled ingress with NUL op and key answers 404, never 500, auditing a sanitised fallback", async () => {
    const disabled: IngressConfig = { ...cfg, enabled: false };
    const { fake, auditValues, call } = await setup(liveGrant(), disabled);
    const a = await call({ op: HOSTILE_OP, idempotency_key: HOSTILE_KEY, fields: FIELDS });
    expect(a.status).not.toBeGreaterThanOrEqual(500);
    expect(a.status).toBe(404);
    expect(a.body).toMatchObject({ reason: "ingress_disabled" });
    expectNoControlInAudit(fake, auditValues);
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({ operation: "unknown", reason: "ingress_disabled" });
  });
});
