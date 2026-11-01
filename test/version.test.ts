// route-inventory: GET /version
// The live deploy commit and upload time, read from the version_metadata
// binding. Local fixtures only; no deployed Worker is contacted.
import { describe, expect, it } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { versionBody } from "../src/version";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const VERSION_ID = "81da0f67-1e2c-4b6e-9a53-0c7c1d2e3f40";
const UPLOADED = "2026-10-31T12:34:56.789Z";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

describe("GET /version", () => {
  it("returns the staging-tagged commit and upload time as uncached JSON", async () => {
    const res = await app.request(
      "/version",
      {},
      {
        ...env,
        CF_VERSION_METADATA: { id: VERSION_ID, tag: SHA, timestamp: UPLOADED },
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ sha: SHA, deployedAt: UPLOADED });
  });

  it("parses the production tag shape to the bare commit", async () => {
    const res = await app.request(
      "/version",
      {},
      {
        ...env,
        CF_VERSION_METADATA: { id: VERSION_ID, tag: `${SHA}-123456-2`, timestamp: UPLOADED },
      },
    );
    expect(await res.json()).toEqual({ sha: SHA, deployedAt: UPLOADED });
  });

  it("answers nulls, not an error, when the Worker has no binding (local dev)", async () => {
    const res = await app.request("/version", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sha: null, deployedAt: null });
  });
});

describe("versionBody", () => {
  it("normalizes the upload timestamp to ISO 8601 UTC", () => {
    expect(versionBody({ tag: SHA, timestamp: "2026-10-31T13:34:56.789+01:00" })).toEqual({
      sha: SHA,
      deployedAt: UPLOADED,
    });
  });

  it.each([
    ["a manual tag", { tag: "hotfix-please-read", timestamp: UPLOADED }, null, UPLOADED],
    ["an unparseable timestamp", { tag: SHA, timestamp: "yesterday" }, SHA, null],
    ["an empty timestamp", { tag: SHA, timestamp: "" }, SHA, null],
    ["a numeric timestamp", { tag: SHA, timestamp: 1 }, SHA, null],
    ["the epoch", { tag: SHA, timestamp: "1970-01-01T00:00:00Z" }, SHA, null],
    ["absent metadata", undefined, null, null],
  ])("never echoes %s", (_name, meta, sha, deployedAt) => {
    expect(versionBody(meta)).toEqual({ sha, deployedAt });
  });
});
