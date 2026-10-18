import { describe, expect, it } from "vitest";
import {
  botRefusalReason,
  botRetryExhaustedReason,
  queueExceptionClass,
  sanitizeQueueCode,
  sanitizeQueueScope,
  terminalFailureReason,
} from "../src/jobs/queue-error";

describe("sanitizeQueueCode", () => {
  it.each([null, undefined, 0, 123, {}, [], true])("maps non-string %p to unknown", (code) => {
    expect(sanitizeQueueCode(code)).toBe("unknown");
  });

  it("maps empty code to unknown", () => {
    expect(sanitizeQueueCode("")).toBe("unknown");
  });

  it.each([
    "malformed",
    "unauthorized",
    "stale_request",
    "action_not_allowed",
    "replayed",
    "in_progress",
    "discord_rejected",
    "rate_limited",
    "internal",
    "discord_unavailable",
    "upstream_timeout",
  ])("preserves the known diagnostic code %s", (code) => {
    expect(sanitizeQueueCode(code)).toBe(code);
    expect(botRefusalReason("announcement.post", code)).toBe(
      `The bot refused announcement.post with \`${code}\``,
    );
    expect(botRetryExhaustedReason("role.assign", code, 5)).toBe(
      `The bot refused role.assign with a retryable \`${code}\` on all 5 attempts.`,
    );
  });

  it("rejects unknown codes even when they use a safe alphabet", () => {
    expect(sanitizeQueueCode("foo.bar-baz_1")).toBe("unknown");
  });

  it("drops unsafe codes rather than preserving cleaned substrings", () => {
    expect(sanitizeQueueCode("bad code!\nDROP")).toBe("unknown");
    expect(sanitizeQueueCode("a b/c:d")).toBe("unknown");
  });

  it("drops overlong codes rather than preserving truncated substrings", () => {
    expect(sanitizeQueueCode("x".repeat(100))).toBe("unknown");
    expect(sanitizeQueueCode("x".repeat(64))).toBe("unknown");
  });
});

describe("sanitizeQueueScope", () => {
  it("flattens CR/LF runs to a single underscore", () => {
    expect(sanitizeQueueScope("a\rb\nc")).toBe("a_b_c");
    expect(sanitizeQueueScope("a\r\n\r\nb")).toBe("a_b");
  });

  it("bounds scopes at 200 characters", () => {
    expect(sanitizeQueueScope("x".repeat(300))).toBe("x".repeat(200));
  });
});

describe("queueExceptionClass", () => {
  it("reports the error class, never its message", () => {
    const err = new TypeError("secret token abc123 with SQL values");
    expect(queueExceptionClass(err)).toBe("TypeError");
    expect(queueExceptionClass(err)).not.toContain("secret");
  });

  it("classifies non-error thrown values by type", () => {
    expect(queueExceptionClass("boom")).toBe("string");
    expect(queueExceptionClass(null)).toBe("object");
    expect(queueExceptionClass(undefined)).toBe("undefined");
    expect(queueExceptionClass(42)).toBe("number");
  });

  it("bounds the classification at 100 characters", () => {
    const err = new Error("hidden");
    Object.defineProperty(err, "constructor", { value: { name: "A".repeat(150) } });
    expect(queueExceptionClass(err)).toBe("A".repeat(100));
  });
});

describe("class-only refusal reasons", () => {
  it("botRefusalReason carries job and classified code only", () => {
    const providerMessage = "token=abc123 leaked\nsecond line";
    const reason = botRefusalReason("sync-event", providerMessage);
    expect(reason).toBe("The bot refused sync-event with `unknown`");
    expect(reason).not.toContain(providerMessage);
  });

  it("botRetryExhaustedReason carries job, classified code and attempt count", () => {
    const reason = botRetryExhaustedReason("call-internal-action", "boom!", 5);
    expect(reason).toBe(
      "The bot refused call-internal-action with a retryable `unknown` on all 5 attempts.",
    );
  });

  it("sanitizes non-string codes in refusal reasons", () => {
    expect(botRefusalReason("sync-event", null)).toBe("The bot refused sync-event with `unknown`");
  });

  it("terminalFailureReason is a fixed class with no message", () => {
    expect(terminalFailureReason()).toBe("BotTerminalError");
  });
});
