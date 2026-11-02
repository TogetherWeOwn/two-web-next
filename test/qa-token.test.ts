// Pure unit tests for the staging QA helpers: no database, session store or network is contacted.
import { describe, expect, it, vi } from "vitest";
import {
  MAX_QA_PRESENTED_TOKEN_LENGTH,
  MIN_QA_TOKEN_LENGTH,
  QA_ATTEMPT_CAPACITY,
  STAGING_APP_URL,
  qaEnabled,
  qaIdentity,
  qaTokenMatches,
  refundQaAttempt,
  takeQaAttempt,
} from "../src/qa";

const CONFIGURED = "test-only-qa-token-match-32-plus-chars";
const WRONG = "test-only-qa-token-mismatch";
const PRODUCTION_APP_URL = "https://togetherweown.com";

describe("qaTokenMatches", () => {
  it("matches the configured fixture token", async () => {
    expect(await qaTokenMatches(CONFIGURED, CONFIGURED)).toBe(true);
  });

  it("rejects a mismatched presented token", async () => {
    expect(await qaTokenMatches(CONFIGURED, WRONG)).toBe(false);
  });

  it.each([undefined, ""])("fails closed for configured token %j", async (configured) => {
    expect(await qaTokenMatches(configured, CONFIGURED)).toBe(false);
    expect(await qaTokenMatches(configured, "")).toBe(false);
  });

  it("caps presented tokens at 512 characters", () => {
    expect(MAX_QA_PRESENTED_TOKEN_LENGTH).toBe(512);
  });

  it.each([513, 1024, 8192])(
    "refuses a %i-character presented token without hashing it",
    async (len) => {
      const presented = "x".repeat(len);
      const digest = vi.spyOn(crypto.subtle, "digest");
      try {
        expect(await qaTokenMatches(CONFIGURED, presented)).toBe(false);
        expect(digest).not.toHaveBeenCalled();
      } finally {
        digest.mockRestore();
      }
    },
  );

  it("refuses an overlong presented token even when it equals the configured token", async () => {
    const overlong = "y".repeat(MAX_QA_PRESENTED_TOKEN_LENGTH + 1);
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      expect(await qaTokenMatches(overlong, overlong)).toBe(false);
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });

  it("still hashes a presented token at exactly the 512-character boundary", async () => {
    const atCap = "z".repeat(MAX_QA_PRESENTED_TOKEN_LENGTH);
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      expect(await qaTokenMatches(atCap, atCap)).toBe(true);
      expect(digest).toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
    expect(await qaTokenMatches(CONFIGURED, atCap)).toBe(false);
  });
});

describe("qaIdentity", () => {
  it.each([
    ["qa-member", "900000000000001396", "QA Member", false],
    ["qa-moderator", "900000000000001397", "QA Moderator", true],
  ] as const)(
    "returns the exact fixture identity for %s",
    (name, discordId, username, moderator) => {
      expect(qaIdentity(name)).toEqual({ discordId, username, moderator });
    },
  );

  it.each(["not-a-qa-identity", "", "qa-admin"])(
    "returns undefined for unknown identity %j",
    (name) => {
      expect(qaIdentity(name)).toBeUndefined();
    },
  );
});

describe("qaEnabled", () => {
  it("is enabled for the staging host with a configured token", () => {
    expect(qaEnabled(STAGING_APP_URL, CONFIGURED)).toBe(true);
  });

  it("is disabled for the production host even with a configured token", () => {
    expect(qaEnabled(PRODUCTION_APP_URL, CONFIGURED)).toBe(false);
  });

  it.each([undefined, ""])("is disabled without a configured token (%j)", (token) => {
    expect(qaEnabled(STAGING_APP_URL, token)).toBe(false);
  });

  it("floors the configured token at 32 characters", () => {
    expect(MIN_QA_TOKEN_LENGTH).toBe(32);
    expect(CONFIGURED.length).toBeGreaterThanOrEqual(MIN_QA_TOKEN_LENGTH);
  });

  it("is disabled for a configured token under the minimum length", () => {
    expect(qaEnabled(STAGING_APP_URL, "x".repeat(MIN_QA_TOKEN_LENGTH - 1))).toBe(false);
  });

  it("is enabled for a configured token at exactly the minimum length", () => {
    expect(qaEnabled(STAGING_APP_URL, "x".repeat(MIN_QA_TOKEN_LENGTH))).toBe(true);
  });
});

describe("QA attempt budget", () => {
  const T0 = 1_800_000_000_000;

  it("admits a burst up to capacity, then refuses until a refill", () => {
    const client = "attempt-burst";
    for (let i = 0; i < QA_ATTEMPT_CAPACITY; i++) expect(takeQaAttempt(client, T0)).toBe(true);
    expect(takeQaAttempt(client, T0)).toBe(false);
    expect(takeQaAttempt(client, T0 + 999)).toBe(false);
    expect(takeQaAttempt(client, T0 + 1_000)).toBe(true);
    expect(takeQaAttempt(client, T0 + 1_000)).toBe(false);
  });

  it("a refund returns the spent attempt", () => {
    const client = "attempt-refund";
    for (let i = 0; i < QA_ATTEMPT_CAPACITY; i++) expect(takeQaAttempt(client, T0)).toBe(true);
    expect(takeQaAttempt(client, T0)).toBe(false);
    refundQaAttempt(client);
    expect(takeQaAttempt(client, T0)).toBe(true);
  });

  it("budgets are per client", () => {
    for (let i = 0; i < QA_ATTEMPT_CAPACITY; i++) takeQaAttempt("attempt-client-a", T0);
    expect(takeQaAttempt("attempt-client-a", T0)).toBe(false);
    expect(takeQaAttempt("attempt-client-b", T0)).toBe(true);
  });

  it("refunding an unseen client is a no-op", () => {
    expect(() => refundQaAttempt("attempt-never-seen")).not.toThrow();
    expect(takeQaAttempt("attempt-never-seen", T0)).toBe(true);
  });

  it("evicts the least recently seen client past the client bound", () => {
    const first = "attempt-evict-first";
    for (let i = 0; i < QA_ATTEMPT_CAPACITY; i++) expect(takeQaAttempt(first, T0)).toBe(true);
    expect(takeQaAttempt(first, T0)).toBe(false);
    // Push past the 1024-client bound with other clients; the first client's
    // spent entry is evicted, so it presents with a fresh budget.
    for (let i = 0; i < 1100; i++) takeQaAttempt(`attempt-evict-other-${i}`, T0);
    expect(takeQaAttempt(first, T0)).toBe(true);
  });

  it("refilling never exceeds capacity after a long idle", () => {
    const client = "attempt-idle";
    expect(takeQaAttempt(client, T0)).toBe(true);
    for (let i = 0; i < QA_ATTEMPT_CAPACITY; i++)
      expect(takeQaAttempt(client, T0 + 3_600_000)).toBe(true);
    expect(takeQaAttempt(client, T0 + 3_600_000)).toBe(false);
  });
});
