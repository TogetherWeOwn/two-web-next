// Needs-reconciliation kernel pins (contract v2 §7.4/§11).
//
// The hard stop keys on the wire code alone — never the HTTP status, never
// the retryable flag — and the stuck intent carries scalars only, never DM
// bodies. Hermetic: pure functions, synthetic keys, no bot, no database.
import { describe, expect, it, vi } from "vitest";
import {
  InvalidStuckIntentError,
  isNeedsReconciliation,
  lastWireOutcome,
  NEEDS_RECONCILIATION_CODE,
  parseStuckKey,
  stuckIntent,
} from "../src/jobs/reconciliation";

const KEY = "11111111-1111-4111-8111-111111111111";
const OTHER_KEY = "22222222-2222-4222-8222-222222222222";

const base = () => ({
  idempotencyKey: KEY,
  verb: "announcement.post",
  subject: "events-final",
  lastCode: "needs_reconciliation" as string | null,
  lastStatus: 409 as number | null,
  lastRequestId: "req-1" as string | null,
  attempts: 3,
});

describe("needs_reconciliation gate", () => {
  it("pins the wire code literal", () => {
    expect(NEEDS_RECONCILIATION_CODE).toBe("needs_reconciliation");
  });

  it("hard-stops on the code alone", () => {
    expect(isNeedsReconciliation("needs_reconciliation")).toBe(true);
  });

  it.each([
    "NEEDS_RECONCILIATION",
    "needs-reconciliation",
    "needs_reconciliation ",
    " needs_reconciliation",
    "in_progress",
    "upstream_timeout",
    "",
    null,
    undefined,
    409,
    true,
    { code: "needs_reconciliation" },
    ["needs_reconciliation"],
  ])("never fires on %p: status, flag and lookalikes do not stop", (code) => {
    expect(isNeedsReconciliation(code)).toBe(false);
  });
});

describe("stuckIntent factory", () => {
  it("accepts every keyed verb with scalar facts", () => {
    for (const verb of [
      "announcement.post",
      "event.upsert",
      "event.cancel",
      "reminder.send",
      "place_offer.send",
    ]) {
      const intent = stuckIntent({ ...base(), verb });
      expect(intent.idempotencyKey).toBe(KEY);
      expect(intent.verb).toBe(verb);
    }
  });

  it("accepts transport-loss nulls and floors attempts at one", () => {
    const intent = stuckIntent({
      ...base(),
      lastCode: null,
      lastStatus: null,
      lastRequestId: null,
      attempts: 1,
    });
    expect(intent.lastCode).toBeNull();
    expect(intent.lastStatus).toBeNull();
    expect(intent.lastRequestId).toBeNull();
  });

  it.each([
    { ...base(), idempotencyKey: "not-a-uuid" },
    { ...base(), idempotencyKey: "" },
    { ...base(), idempotencyKey: KEY.slice(0, 35) },
    { ...base(), verb: "role.assign" },
    { ...base(), verb: "voice.move_member" },
    { ...base(), verb: "" },
    { ...base(), subject: "" },
    { ...base(), subject: "x".repeat(201) },
    { ...base(), subject: "line one\nline two" },
    { ...base(), subject: "announcement body with\rcarriage" },
    { ...base(), lastCode: "x".repeat(101) },
    { ...base(), lastCode: "code\nsplit" },
    { ...base(), lastStatus: -1 },
    { ...base(), lastStatus: 1.5 },
    { ...base(), attempts: 0 },
    { ...base(), attempts: -2 },
    { ...base(), attempts: Number.MAX_SAFE_INTEGER + 1 },
  ])("refuses non-scalar or out-of-bound intent %#", (intent) => {
    expect(() => stuckIntent(intent)).toThrow(InvalidStuckIntentError);
  });

  it("keeps intent identity on the carrier key, never a re-key", () => {
    const first = stuckIntent(base());
    const again = stuckIntent({ ...base(), attempts: 5 });
    expect(first.idempotencyKey).toBe(again.idempotencyKey);
    expect(first.idempotencyKey).not.toBe(OTHER_KEY);
  });
});

describe("lastWireOutcome safe capture", () => {
  it("round-trips a well-formed answer with the same key the bot saw", () => {
    expect(
      lastWireOutcome({ ok: false, code: "needs_reconciliation", status: 409, requestId: "req-1" }),
    ).toEqual({ code: "needs_reconciliation", status: 409, requestId: "req-1" });
  });

  it("classifies a garbage wire code as unknown instead of retaining provider text", () => {
    const garbage = "Bearer CANARY-1\nSELECT * FROM sessions;--";
    const last = lastWireOutcome({ ok: false, code: garbage, status: 504, requestId: "r" });
    expect(last.code).toBe("unknown");
    expect(JSON.stringify(last)).not.toContain("CANARY-1");
  });

  it("never executes input accessors and never throws", () => {
    const read = vi.fn(() => {
      throw new Error("must not run");
    });
    const hostile = {};
    Object.defineProperty(hostile, "code", { get: read });
    Object.defineProperty(hostile, "status", { get: read });
    Object.defineProperty(hostile, "requestId", { get: read });
    expect(lastWireOutcome(hostile)).toEqual({ code: "unknown", status: null, requestId: null });
    expect(read).not.toHaveBeenCalled();
    for (const bad of [undefined, null, 42, "code", [], "x".repeat(1000)]) {
      expect(() => lastWireOutcome(bad)).not.toThrow();
    }
    expect(lastWireOutcome(undefined)).toEqual({ code: "unknown", status: null, requestId: null });
  });

  it("bounds status and requestId to scalars the intent accepts", () => {
    expect(lastWireOutcome({ code: "internal", status: -1, requestId: "r" }).status).toBeNull();
    expect(lastWireOutcome({ code: "internal", status: 1.5, requestId: "r" }).status).toBeNull();
    expect(
      lastWireOutcome({ code: "internal", status: 429, requestId: "x".repeat(101) }).requestId,
    ).toBeNull();
    expect(
      lastWireOutcome({ code: "internal", status: 429, requestId: "a\nb" }).requestId,
    ).toBeNull();
  });
});

describe("parseStuckKey route gate", () => {
  it("passes a UUID through, case-insensitively", () => {
    expect(parseStuckKey(KEY)).toBe(KEY);
    expect(parseStuckKey(KEY.toUpperCase())).toBe(KEY.toUpperCase());
  });

  it.each(["", "not-a-uuid", KEY.slice(0, 35), `${KEY}x`, 42, null, undefined, {}, [KEY]])(
    "refuses %p without throwing",
    (raw) => {
      expect(parseStuckKey(raw)).toBeNull();
    },
  );
});
