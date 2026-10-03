// Pure unit tests for the staging QA helpers: no database, session store or network is contacted.
import { describe, expect, it } from "vitest";
import { STAGING_APP_URL, qaEnabled, qaIdentity, qaTokenMatches } from "../src/qa";

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
