// Discord scheduled-events list-reader proof: invalid-row filtering on the live
// and cached sources with stubbed fetch, sanitized failure logging, invalid
// cached-payload failure, and failure reset after a clean empty read. Hermetic:
// stubbed fetch and in-memory snapshot bytes only, no Discord and no database.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import {
  cachedDiscordEventsSource,
  liveDiscordEventsSource,
} from "../src/events/discord-transients";
import type {
  DiscordSnapshotStore,
  SnapshotClaim,
  SnapshotView,
} from "../src/events/discord-snapshot";
import { memoryDiscordBacking, memoryDiscordStore } from "./helpers/discord-snapshot-store";

const NOW = new Date("2030-01-01T00:00:00Z");

const env = {
  APP_URL: "https://calendar.example.test",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_BOT_TOKEN: "fixture-bot-token",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
} as unknown as Env;

function row(over: Record<string, unknown> = {}) {
  return {
    id: "1545955994972987422",
    name: "Sunday Squad",
    description: "Fall Guys for about an hour.",
    scheduled_start_time: "2030-01-02T20:00:00Z",
    scheduled_end_time: "2030-01-02T21:00:00Z",
    status: 1,
    entity_metadata: { location: "Lobby" },
    ...over,
  };
}

function mixedRows() {
  return [
    row(),
    row({
      id: "1545955994972987423",
      name: "Live Raid",
      description: null,
      scheduled_start_time: "2030-01-01T19:00:00Z",
      scheduled_end_time: null,
      status: 2,
      entity_metadata: { location: null },
    }),
    row({ id: "blank-name", name: "   " }),
    row({ id: "bad-start", scheduled_start_time: "not-a-time" }),
    row({ id: "bad-end", scheduled_end_time: "also-not-a-time" }),
    row({ id: "", name: "Missing id" }),
    row({ id: 42, name: "Numeric id" }),
  ];
}

function expectValidSiblings(rows: { discordId: string }[]) {
  expect(rows.map((r) => r.discordId)).toEqual(["1545955994972987422", "1545955994972987423"]);
}

describe("Discord scheduled-events invalid-filter, sanitized-log and failure-reset", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("drops whitespace-name and unparsable-time rows on the live source and keeps valid rows intact", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json(mixedRows()));
    const source = liveDiscordEventsSource(env);
    const rows = await source.upcoming(NOW);
    expectValidSiblings(rows);
    expect(rows[0]).toMatchObject({
      discordId: "1545955994972987422",
      status: "scheduled",
      title: "Sunday Squad",
      description: "Fall Guys for about an hour.",
      location: "Lobby",
    });
    expect(rows[0]!.startsAt.toISOString()).toBe("2030-01-02T20:00:00.000Z");
    expect(rows[0]!.endsAt?.toISOString()).toBe("2030-01-02T21:00:00.000Z");
    expect(rows[1]).toMatchObject({
      discordId: "1545955994972987423",
      status: "active",
      title: "Live Raid",
      description: null,
      location: null,
    });
    expect(rows[1]!.startsAt.toISOString()).toBe("2030-01-01T19:00:00.000Z");
    expect(rows[1]!.endsAt).toBeNull();
    expect(source.lastReadFailed()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("drops the same rows through the cached source with stubbed fetch", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => Response.json(mixedRows()));
      const backing = memoryDiscordBacking(() => Date.now());
      const source = cachedDiscordEventsSource(
        env,
        liveDiscordEventsSource(env),
        memoryDiscordStore(backing),
      );
      const rows = await source.upcoming(NOW);
      expectValidSiblings(rows);
      expect(rows[0]).toMatchObject({
        title: "Sunday Squad",
        description: "Fall Guys for about an hour.",
        location: "Lobby",
      });
      expect(rows[1]).toMatchObject({ status: "active", endsAt: null });
      expect(source.lastReadFailed()).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith(
        "Discord snapshot outcome",
        expect.objectContaining({ completionFailed: false }),
      );
    } finally {
      info.mockRestore();
    }
  });

  it("logs only keys and elapsed on a transport failure, never URL, header, token or message bytes", async () => {
    const canary = "canary-7f3a9c2e5b1d4a6f";
    const guild = `guild-${canary}`;
    const token = `token-${canary}-secret`;
    const message = `boom-${canary}-message`;
    const scoped = { ...env, DISCORD_GUILD_ID: guild, DISCORD_BOT_TOKEN: token };
    const seen: { url: unknown; init: RequestInit | undefined } = { url: null, init: undefined };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      seen.url = url;
      seen.init = init as RequestInit | undefined;
      throw new Error(message);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const source = liveDiscordEventsSource(scoped);
      expect(await source.upcoming(NOW)).toEqual([]);
      expect(source.lastReadFailed()).toBe(true);
      // The plant reached the transport, so absence from the log is meaningful.
      expect(String(seen.url)).toContain(guild);
      expect(JSON.stringify((seen.init?.headers as Record<string, string>) ?? {})).toContain(token);
      expect(warn).toHaveBeenCalledTimes(1);
      const [first, second] = warn.mock.calls[0]!;
      expect(first).toBe("Discord scheduled-events read failed.");
      expect(second).toBeTypeOf("object");
      const logged = second as Record<string, unknown>;
      expect(typeof logged.elapsedMs).toBe("number");
      expect(logged.reason).toBe("exception");
      for (const key of Object.keys(logged)) {
        expect(["reason", "status", "retryAfter", "exception", "elapsedMs"]).toContain(key);
      }
      expect(logged).not.toHaveProperty("url");
      expect(logged).not.toHaveProperty("headers");
      expect(logged).not.toHaveProperty("authorization");
      expect(logged).not.toHaveProperty("token");
      expect(logged).not.toHaveProperty("message");
      expect(logged).not.toHaveProperty("body");
      const serialized = JSON.stringify(warn.mock.calls);
      expect(serialized).not.toContain(canary);
      expect(serialized).not.toContain(guild);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(message);
      expect(source.lastReadFailure?.()).toEqual({ reason: "exception", exception: "Error" });
    } finally {
      warn.mockRestore();
    }
  });

  it("logs only keys and elapsed on a status failure, never the error body bytes", async () => {
    const canary = "canary-3b9e51a7c4d84f0a";
    const guild = `guild-${canary}`;
    const token = `token-${canary}-secret`;
    const body = `error-body-${canary}-bytes`;
    const scoped = { ...env, DISCORD_GUILD_ID: guild, DISCORD_BOT_TOKEN: token };
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(body, { status: 500 }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const source = liveDiscordEventsSource(scoped);
      expect(await source.upcoming(NOW)).toEqual([]);
      expect(source.lastReadFailed()).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      const [first, second] = warn.mock.calls[0]!;
      expect(first).toBe("Discord scheduled-events read failed.");
      const logged = second as Record<string, unknown>;
      expect(logged.reason).toBe("status");
      expect(logged.status).toBe(500);
      expect(typeof logged.elapsedMs).toBe("number");
      for (const key of Object.keys(logged)) {
        expect(["reason", "status", "retryAfter", "exception", "elapsedMs"]).toContain(key);
      }
      const serialized = JSON.stringify(warn.mock.calls);
      expect(serialized).not.toContain(canary);
      expect(serialized).not.toContain(guild);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(body);
    } finally {
      warn.mockRestore();
    }
  });

  it("surfaces an invalid cached payload as failure and resets after a clean empty read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      let calls = 0;
      const corruptPayload = [{ raw: "corruption" }];
      const store: DiscordSnapshotStore = {
        async claim(): Promise<SnapshotClaim> {
          calls += 1;
          const anchor = performance.now();
          if (calls === 1) {
            const at = Date.now();
            return {
              payload: corruptPayload,
              succeededAt: at,
              retryAt: 0,
              leaseExpiresAt: null,
              now: at,
              token: null,
              nowQueryStartedAt: anchor,
            };
          }
          const at = Date.now();
          return {
            payload: [],
            succeededAt: at,
            retryAt: 0,
            leaseExpiresAt: null,
            now: at,
            token: null,
            nowQueryStartedAt: anchor,
          };
        },
        async complete(_key: string): Promise<SnapshotView> {
          const at = Date.now();
          return { payload: [], succeededAt: at, retryAt: 0, leaseExpiresAt: null, now: at };
        },
      };
      const inner = { upcoming: vi.fn(async () => []), lastReadFailed: () => false };
      const source = cachedDiscordEventsSource(env, inner, store);
      expect(await source.upcoming(NOW)).toEqual([]);
      expect(source.lastReadFailed()).toBe(true);
      expect(calls).toBe(1);
      expect(inner.upcoming).not.toHaveBeenCalled();
      expect(await source.upcoming(NOW)).toEqual([]);
      expect(source.lastReadFailed()).toBe(false);
      expect(calls).toBe(2);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });
});
