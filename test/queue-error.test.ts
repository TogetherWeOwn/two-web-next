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

  it("keeps the safe alphabet untouched", () => {
    expect(sanitizeQueueCode("foo.bar-baz_1")).toBe("foo.bar-baz_1");
  });

  it("replaces unsafe characters with underscores", () => {
    expect(sanitizeQueueCode("bad code!\nDROP")).toBe("bad_code__DROP");
    expect(sanitizeQueueCode("a b/c:d")).toBe("a_b_c_d");
  });

  it("bounds codes at 64 characters", () => {
    expect(sanitizeQueueCode("x".repeat(100))).toBe("x".repeat(64));
    expect(sanitizeQueueCode("x".repeat(64))).toHaveLength(64);
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
  it("botRefusalReason carries job and sanitized code only", () => {
    const providerMessage = "token=abc123 leaked\nsecond line";
    const reason = botRefusalReason("sync-event", providerMessage);
    expect(reason).toBe("The bot refused sync-event with `token_abc123_leaked_second_line`");
    expect(reason).not.toContain(providerMessage);
  });

  it("botRetryExhaustedReason carries job, sanitized code and attempt count", () => {
    const reason = botRetryExhaustedReason("call-internal-action", "boom!", 5);
    expect(reason).toBe(
      "The bot refused call-internal-action with a retryable `boom_` on all 5 attempts.",
    );
  });

  it("sanitizes non-string codes in refusal reasons", () => {
    expect(botRefusalReason("sync-event", null)).toBe("The bot refused sync-event with `unknown`");
  });

  it("terminalFailureReason is a fixed class with no message", () => {
    expect(terminalFailureReason()).toBe("BotTerminalError");
  });
});
