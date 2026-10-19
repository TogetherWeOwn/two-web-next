// Pure unit tests for the staging QA helpers: no database, session store or network is contacted.
import { describe, expect, it, vi } from "vitest";
import {
  MAX_QA_PRESENTED_TOKEN_LENGTH,
  STAGING_APP_URL,
  qaEnabled,
  qaIdentity,
  qaTokenMatches,
} from "../src/qa";

const CONFIGURED = "test-only-qa-token-match";
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
});
