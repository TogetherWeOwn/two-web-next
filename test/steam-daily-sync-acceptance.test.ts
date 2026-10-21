import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
// @ts-expect-error Standalone CI tooling has no declaration file.
import { readWranglerConfig } from "../ci/wrangler-config.mjs";
import type { JobsEnv } from "../src/env";
import { PRUNE_CRON, RECONCILE_CRON, STEAM_SYNC_CRON } from "../src/jobs/constants";
import { runScheduled } from "../src/jobs/cron";
import { ProfilePage } from "../src/profiles/pages";
import type { MemberView } from "../src/profiles/store";
import { createSteamClient } from "../src/steam/client";
import {
  type SteamLinkedAccount,
  type SteamSyncedData,
  type SteamSyncStore,
  syncSteamAccounts,
} from "../src/steam/sync";
import { suggestionsFromOwnedGames } from "../src/steam/suggestions";
import {
  EMPTY_LIBRARY_STEAM_ID,
  FRIENDS_ONLY_STEAM_ID,
  OWNED_GAMES_PATH,
  PLAYING_STEAM_ID,
  PRIVATE_STEAM_ID,
  PUBLIC_STEAM_ID,
  STEAM_API_HOST,
  SUMMARIES_PATH,
  UNLINKED_STEAM_ID,
  emptyLibraryBody,
  hiddenLibraryBody,
  jsonResponse,
  ownedGamesBody,
  sevenGameLibrary,
  summariesBody,
  wireGame,
  wirePlayer,
  type SteamWirePlayer,
} from "./helpers/steam-wire-fixture";

// Acceptance contract for the profiles daily Steam sync (acceptance-owned;
// the implementation change must not edit this file). Each describe maps to
// one acceptance criterion: a daily Cron job, the stored v1 data set, private
// profiles, the missing-key no-op, unlinked accounts, batching/rate limits,
// and owned-game suggestions in the games editor.
//
// Spec interface pinned here (the Builder implements exactly these):
// - `src/steam/client.ts`: `createSteamClient({ apiKey, fetchFn?,
//   timeoutSeconds? })` with `getPlayerSummaries(steamIds)` and
//   `getOwnedGames(steamId)`, speaking the real Steam Web API endpoints
//   below over the injected `fetchFn` (default: global fetch).
// - `src/steam/sync.ts`: `syncSteamAccounts({ apiKey, store, fetchFn?,
//   now? })` over the `SteamSyncStore` port (`listSteamAccounts`,
//   `saveSteamSync`), returning `{ ok, status, synced, failed }`.
// - `src/steam/suggestions.ts`: pure `suggestionsFromOwnedGames(ownedNames,
//   currentGames)`.
// - `STEAM_SYNC_CRON` in `src/jobs/constants.ts`, routed by `runScheduled`
//   and owned in `wrangler.jobs.jsonc` like the prune daily.
// - Optional `STEAM_WEB_API_KEY` on `JobsEnv` (typecheck-enforced below).
// - Optional `steamSuggestions?: string[]` on `ProfilePage`, rendered for
//   the owner only.
// Steam caps GetPlayerSummaries at 100 steamids per call, so the sync chunks
// there; GetOwnedGames is one call per account. Playtimes stay in minutes
// (Steam's unit). RED state: collection error on the missing `src/steam/*`
// modules and `STEAM_SYNC_CRON`; every test then gates one behavior.

const TEST_KEY = "TEST_ONLY_STEAM_KEY";
const SYNC_NOW = new Date("2026-10-21T01:00:00.000Z");

const publicPlayer = (steamid: string, extra: Partial<SteamWirePlayer> = {}) =>
  wirePlayer({ steamid, ...extra });

const callsTo = (calls: { url: string }[], path: string) =>
  calls.filter(({ url }) => new URL(url).pathname === path);

function stubFetch(handler: (url: URL) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url: href, init });
    return handler(new URL(href));
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

function memorySteamStore(accounts: SteamLinkedAccount[]) {
  const saved = new Map<string, SteamSyncedData>();
  const store: SteamSyncStore = {
    listSteamAccounts: async () => accounts,
    saveSteamSync: async (userId, data) => {
      saved.set(userId, data);
    },
  };
  return { saved, store };
}

const accountFor = (userId: string, steamId: string): SteamLinkedAccount => ({
  userId,
  steamId,
});

function summariesRouter(players: SteamWirePlayer[]) {
  return (url: URL) => {
    if (url.pathname === SUMMARIES_PATH) {
      const wanted = new Set((url.searchParams.get("steamids") ?? "").split(","));
      return jsonResponse(summariesBody(players.filter((p) => wanted.has(p.steamid))));
    }
    return jsonResponse(hiddenLibraryBody());
  };
}

const playingPlayer = () =>
  publicPlayer(PLAYING_STEAM_ID, {
    personaname: "Currently Playing",
    gameextrainfo: "Counter-Strike 2",
    gameid: "730",
  });

const ownerMember = (games: string[] = []): MemberView => ({
  id: "100000000000000001",
  username: "alice",
  avatar: null,
  bio: null,
  games,
  timezone: null,
  joinedAt: new Date("2024-03-15T00:00:00Z"),
});

const renderOwnerPage = (props: { games?: string[]; steamSuggestions?: string[] }) =>
  ProfilePage({
    member: ownerMember(props.games),
    isOwner: true,
    appUrl: "https://next.example.test",
    steamSuggestions: props.steamSuggestions,
  })!.toString() as string;

describe("steam daily sync: scheduled job", () => {
  it("runs daily at 01:00 UTC, off the midnight prune", () => {
    expect(STEAM_SYNC_CRON).toBe("0 1 * * *");
    expect(STEAM_SYNC_CRON).not.toBe(PRUNE_CRON);
    expect(STEAM_SYNC_CRON).not.toBe(RECONCILE_CRON);
  });

  it("routes through runScheduled under the steam:sync single flight", async () => {
    const flight = vi.fn(async (name: string, fn: (db: never) => Promise<void>) => {
      await fn({} as never);
      return true;
    });
    const steam = vi.fn(async () => {});
    const ran = await runScheduled(
      STEAM_SYNC_CRON,
      flight as unknown as Parameters<typeof runScheduled>[1],
      {
        reconcile: async () => {},
        prune: async () => {},
        steam,
      } as unknown as Parameters<typeof runScheduled>[2],
    );
    expect(ran).toBe(true);
    expect(flight).toHaveBeenCalledTimes(1);
    expect(flight.mock.calls[0]?.[0]).toBe("steam:sync");
    expect(steam).toHaveBeenCalledTimes(1);
  });

  it("is owned by the staging and production jobs Workers, never preview or web", () => {
    const jobs = readWranglerConfig(readFileSync("wrangler.jobs.jsonc", "utf8"));
    const main = readWranglerConfig(readFileSync("wrangler.jsonc", "utf8"));
    const stagingKit = readWranglerConfig(readFileSync("web/wrangler.staging.jsonc", "utf8"));
    // Staging owns the daily run on the staging database, production its own.
    expect(jobs.triggers?.crons).toContain(STEAM_SYNC_CRON);
    expect(jobs.env?.production?.triggers?.crons).toContain(STEAM_SYNC_CRON);
    // Exactly one owner per environment: no double-run, no stolen schedule.
    expect(jobs.triggers?.crons?.filter((c: string) => c === STEAM_SYNC_CRON)).toHaveLength(1);
    // Preview shares the staging database, so it stays off the daily (the
    // prune precedent); the web Workers only produce, never own a cron.
    expect(jobs.env?.preview?.triggers?.crons ?? []).not.toContain(STEAM_SYNC_CRON);
    expect(main.triggers?.crons ?? []).not.toContain(STEAM_SYNC_CRON);
    expect(stagingKit.triggers?.crons ?? []).not.toContain(STEAM_SYNC_CRON);
  });
});

describe("steam client", () => {
  it("batches player summaries into one call with the key and ids in the query", async () => {
    const { calls, fetchFn } = stubFetch(
      summariesRouter([publicPlayer(PUBLIC_STEAM_ID), playingPlayer()]),
    );
    const client = createSteamClient({ apiKey: TEST_KEY, fetchFn });
    const summaries = await client.getPlayerSummaries([PUBLIC_STEAM_ID, PLAYING_STEAM_ID]);
    expect(summaries).toHaveLength(2);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.hostname).toBe(STEAM_API_HOST);
    expect(url.pathname).toBe(SUMMARIES_PATH);
    expect(url.searchParams.get("key")).toBe(TEST_KEY);
    expect(url.searchParams.get("steamids")).toBe(`${PUBLIC_STEAM_ID},${PLAYING_STEAM_ID}`);
  });

  it("parses persona, avatarfull, profileurl, currently playing and visibility", async () => {
    const { fetchFn } = stubFetch(summariesRouter([playingPlayer()]));
    const client = createSteamClient({ apiKey: TEST_KEY, fetchFn });
    const [summary] = await client.getPlayerSummaries([PLAYING_STEAM_ID]);
    expect(summary).toMatchObject({
      steamId: PLAYING_STEAM_ID,
      personaName: "Currently Playing",
      avatarUrl: expect.stringContaining("_full.jpg"),
      profileUrl: expect.stringContaining(PLAYING_STEAM_ID),
      currentlyPlaying: "Counter-Strike 2",
      communityVisibilityState: 3,
    });
  });

  it("reports no current game when gameextrainfo is absent", async () => {
    const { fetchFn } = stubFetch(summariesRouter([publicPlayer(PUBLIC_STEAM_ID)]));
    const client = createSteamClient({ apiKey: TEST_KEY, fetchFn });
    const [summary] = await client.getPlayerSummaries([PUBLIC_STEAM_ID]);
    expect(summary?.currentlyPlaying).toBeNull();
  });

  it("requests owned games with app info and parses playtimes in minutes", async () => {
    const { calls, fetchFn } = stubFetch((url) => {
      if (url.pathname === OWNED_GAMES_PATH)
        return jsonResponse(ownedGamesBody(sevenGameLibrary()));
      return jsonResponse(summariesBody([]), 404);
    });
    const client = createSteamClient({ apiKey: TEST_KEY, fetchFn });
    const owned = await client.getOwnedGames(PUBLIC_STEAM_ID);
    expect(owned.gameCount).toBe(7);
    expect(owned.games).toHaveLength(7);
    expect(owned.games[0]).toEqual({
      appId: 730,
      name: "Counter-Strike 2",
      playtimeMinutes: 12000,
    });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.hostname).toBe(STEAM_API_HOST);
    expect(url.pathname).toBe(OWNED_GAMES_PATH);
    expect(url.searchParams.get("key")).toBe(TEST_KEY);
    expect(url.searchParams.get("steamid")).toBe(PUBLIC_STEAM_ID);
    expect(url.searchParams.get("include_appinfo")).not.toBeNull();
  });

  it("rejects without a key and performs no fetch", async () => {
    const { calls, fetchFn } = stubFetch(() => jsonResponse(summariesBody([])));
    const client = createSteamClient({ fetchFn });
    await expect(client.getPlayerSummaries([PUBLIC_STEAM_ID])).rejects.toThrow(/STEAM_WEB_API_KEY/);
    await expect(client.getOwnedGames(PUBLIC_STEAM_ID)).rejects.toThrow(/STEAM_WEB_API_KEY/);
    expect(calls).toHaveLength(0);
  });
});

describe("syncSteamAccounts stores the v1 data set", () => {
  const syncedFixture = () => {
    const players = [playingPlayer()];
    const { calls, fetchFn } = stubFetch((url) => {
      if (url.pathname === SUMMARIES_PATH) return summariesRouter(players)(url);
      if (url.pathname === OWNED_GAMES_PATH)
        return jsonResponse(ownedGamesBody(sevenGameLibrary()));
      throw new Error(`unexpected Steam call: ${url.pathname}`);
    });
    return { calls, fetchFn };
  };

  it("stores persona, avatar, profile url, currently playing and the top 5 by playtime", async () => {
    const { fetchFn } = syncedFixture();
    const { saved, store } = memorySteamStore([accountFor("user-1", PLAYING_STEAM_ID)]);
    const result = await syncSteamAccounts({
      apiKey: TEST_KEY,
      store,
      fetchFn,
      now: () => SYNC_NOW,
    });
    expect(result).toEqual({ ok: true, status: "synced", synced: 1, failed: 0 });
    const data = saved.get("user-1");
    expect(data).toMatchObject({
      personaName: "Currently Playing",
      avatarUrl: expect.stringContaining("_full.jpg"),
      profileUrl: expect.stringContaining(PLAYING_STEAM_ID),
      currentlyPlaying: "Counter-Strike 2",
      privateProfile: false,
      syncedAt: SYNC_NOW,
    });
    expect(data?.topGames.map((g) => g.name)).toEqual([
      "Counter-Strike 2",
      "Dota 2",
      "PUBG: BATTLEGROUNDS",
      "Apex Legends",
      "Rust",
    ]);
    expect(data?.topGames.map((g) => g.playtimeMinutes)).toEqual([12000, 8000, 3000, 1500, 900]);
    // The full owned list feeds suggestions, beyond the displayed top 5.
    expect(data?.ownedGameNames).toHaveLength(7);
    expect(data?.ownedGameNames).toContain("Stardew Valley");
    expect(data?.ownedGameNames).toContain("Terraria");
  });

  it("stores an empty top 5 for a public account with an empty library", async () => {
    const { fetchFn } = stubFetch((url) => {
      if (url.pathname === SUMMARIES_PATH)
        return summariesRouter([publicPlayer(EMPTY_LIBRARY_STEAM_ID)])(url);
      if (url.pathname === OWNED_GAMES_PATH) return jsonResponse(emptyLibraryBody());
      throw new Error(`unexpected Steam call: ${url.pathname}`);
    });
    const { saved, store } = memorySteamStore([accountFor("user-1", EMPTY_LIBRARY_STEAM_ID)]);
    const result = await syncSteamAccounts({
      apiKey: TEST_KEY,
      store,
      fetchFn,
      now: () => SYNC_NOW,
    });
    expect(result).toEqual({ ok: true, status: "synced", synced: 1, failed: 0 });
    expect(saved.get("user-1")).toMatchObject({
      personaName: expect.any(String),
      topGames: [],
      ownedGameNames: [],
      privateProfile: false,
    });
  });
});

describe("syncSteamAccounts handles private Steam profiles gracefully", () => {
  it.each([
    ["private", PRIVATE_STEAM_ID, 1],
    ["friends-only", FRIENDS_ONLY_STEAM_ID, 2],
  ])(
    "keeps persona fields, clears game data and skips GetOwnedGames (%s)",
    async (_label, steamId, visibility) => {
      const { calls, fetchFn } = stubFetch(
        summariesRouter([
          publicPlayer(steamId, {
            communityvisibilitystate: visibility,
            personaname: "Private Persona",
          }),
        ]),
      );
      const { saved, store } = memorySteamStore([accountFor("user-1", steamId)]);
      const result = await syncSteamAccounts({
        apiKey: TEST_KEY,
        store,
        fetchFn,
        now: () => SYNC_NOW,
      });
      expect(result).toEqual({ ok: true, status: "synced", synced: 1, failed: 0 });
      expect(saved.get("user-1")).toMatchObject({
        personaName: "Private Persona",
        currentlyPlaying: null,
        topGames: [],
        ownedGameNames: [],
        privateProfile: true,
      });
      // No wasted library call for a profile that hides its games.
      expect(callsTo(calls, OWNED_GAMES_PATH)).toHaveLength(0);
    },
  );

  it("treats an empty owned-games response as hidden games, not a failure", async () => {
    const { fetchFn } = stubFetch((url) => {
      if (url.pathname === SUMMARIES_PATH)
        return summariesRouter([publicPlayer(PUBLIC_STEAM_ID)])(url);
      if (url.pathname === OWNED_GAMES_PATH) return jsonResponse(hiddenLibraryBody());
      throw new Error(`unexpected Steam call: ${url.pathname}`);
    });
    const { saved, store } = memorySteamStore([accountFor("user-1", PUBLIC_STEAM_ID)]);
    const result = await syncSteamAccounts({
      apiKey: TEST_KEY,
      store,
      fetchFn,
      now: () => SYNC_NOW,
    });
    expect(result).toEqual({ ok: true, status: "synced", synced: 1, failed: 0 });
    expect(saved.get("user-1")).toMatchObject({ topGames: [], ownedGameNames: [] });
  });
});

describe("syncSteamAccounts without STEAM_WEB_API_KEY", () => {
  it.each([["absent", undefined]])("is a no-op reporting %s", async (_label, apiKey) => {
    const { calls, fetchFn } = stubFetch(() => jsonResponse(summariesBody([])));
    const saves = vi.fn(async (_userId: string, _data: SteamSyncedData) => {});
    const store: SteamSyncStore = {
      listSteamAccounts: async () => [accountFor("user-1", PUBLIC_STEAM_ID)],
      saveSteamSync: saves,
    };
    const result = await syncSteamAccounts({ apiKey, store, fetchFn, now: () => SYNC_NOW });
    expect(result).toEqual({ ok: true, status: "steam key missing", synced: 0, failed: 0 });
    expect(calls).toHaveLength(0);
    expect(saves).not.toHaveBeenCalled();
  });

  it("treats a blank key as missing", async () => {
    const { calls, fetchFn } = stubFetch(() => jsonResponse(summariesBody([])));
    const saves = vi.fn(async (_userId: string, _data: SteamSyncedData) => {});
    const store: SteamSyncStore = {
      listSteamAccounts: async () => [accountFor("user-1", PUBLIC_STEAM_ID)],
      saveSteamSync: saves,
    };
    const result = await syncSteamAccounts({
      apiKey: "   ",
      store,
      fetchFn,
      now: () => SYNC_NOW,
    });
    expect(result).toEqual({ ok: true, status: "steam key missing", synced: 0, failed: 0 });
    expect(calls).toHaveLength(0);
    expect(saves).not.toHaveBeenCalled();
  });
});

describe("syncSteamAccounts never syncs unlinked accounts", () => {
  it("calls Steam and saves only for the listed linked accounts", async () => {
    const { calls, fetchFn } = stubFetch(summariesRouter([playingPlayer()]));
    const { saved, store } = memorySteamStore([accountFor("user-1", PLAYING_STEAM_ID)]);
    await syncSteamAccounts({ apiKey: TEST_KEY, store, fetchFn, now: () => SYNC_NOW });
    for (const { url } of calls) expect(url).not.toContain(UNLINKED_STEAM_ID);
    expect(saved.has("user-2")).toBe(false);
    expect([...saved.keys()]).toEqual(["user-1"]);
  });

  it("performs no fetch when no accounts are linked", async () => {
    const { calls, fetchFn } = stubFetch(() => jsonResponse(summariesBody([])));
    const { store } = memorySteamStore([]);
    const result = await syncSteamAccounts({
      apiKey: TEST_KEY,
      store,
      fetchFn,
      now: () => SYNC_NOW,
    });
    expect(result).toEqual({ ok: true, status: "synced", synced: 0, failed: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe("syncSteamAccounts batches within rate limits", () => {
  const bulkRouter = (players: SteamWirePlayer[]) => (url: URL) => {
    if (url.pathname === SUMMARIES_PATH) return summariesRouter(players)(url);
    if (url.pathname === OWNED_GAMES_PATH)
      return jsonResponse(ownedGamesBody([wireGame({ appid: 730, name: "Counter-Strike 2" })]));
    throw new Error(`unexpected Steam call: ${url.pathname}`);
  };

  it("chunks summaries at Steam's 100-id cap: 205 accounts take 3 calls", async () => {
    const steamIds = Array.from({ length: 205 }, (_, i) => `76561190100000${100 + i}`);
    const players = steamIds.map((steamid) => publicPlayer(steamid));
    const { calls, fetchFn } = stubFetch(bulkRouter(players));
    const { store } = memorySteamStore(steamIds.map((s, i) => accountFor(`user-${i}`, s)));
    const result = await syncSteamAccounts({
      apiKey: TEST_KEY,
      store,
      fetchFn,
      now: () => SYNC_NOW,
    });
    expect(result).toEqual({ ok: true, status: "synced", synced: 205, failed: 0 });
    const summaryCalls = callsTo(calls, SUMMARIES_PATH);
    expect(summaryCalls).toHaveLength(3);
    const sizes = summaryCalls.map(
      (c) => new URL(c.url).searchParams.get("steamids")!.split(",").length,
    );
    expect(sizes).toEqual([100, 100, 5]);
    // One library call per account, no more.
    expect(callsTo(calls, OWNED_GAMES_PATH)).toHaveLength(205);
  });

  it("syncs 3 accounts in exactly 4 calls: 1 summaries plus 1 library each", async () => {
    const players = [
      publicPlayer(PUBLIC_STEAM_ID),
      playingPlayer(),
      publicPlayer(EMPTY_LIBRARY_STEAM_ID),
    ];
    const { calls, fetchFn } = stubFetch(bulkRouter(players));
    const { store } = memorySteamStore([
      accountFor("user-1", PUBLIC_STEAM_ID),
      accountFor("user-2", PLAYING_STEAM_ID),
      accountFor("user-3", EMPTY_LIBRARY_STEAM_ID),
    ]);
    const result = await syncSteamAccounts({
      apiKey: TEST_KEY,
      store,
      fetchFn,
      now: () => SYNC_NOW,
    });
    expect(result).toEqual({ ok: true, status: "synced", synced: 3, failed: 0 });
    expect(calls).toHaveLength(4);
  });

  it("isolates a per-account library failure: others still sync", async () => {
    const { fetchFn } = stubFetch((url) => {
      if (url.pathname === SUMMARIES_PATH)
        return summariesRouter([publicPlayer(PUBLIC_STEAM_ID), playingPlayer()])(url);
      if (url.pathname === OWNED_GAMES_PATH) {
        if (url.searchParams.get("steamid") === PUBLIC_STEAM_ID)
          return new Response("boom", { status: 500 });
        return jsonResponse(ownedGamesBody(sevenGameLibrary()));
      }
      throw new Error(`unexpected Steam call: ${url.pathname}`);
    });
    const { saved, store } = memorySteamStore([
      accountFor("user-1", PUBLIC_STEAM_ID),
      accountFor("user-2", PLAYING_STEAM_ID),
    ]);
    const result = await syncSteamAccounts({
      apiKey: TEST_KEY,
      store,
      fetchFn,
      now: () => SYNC_NOW,
    });
    expect(result).toEqual({ ok: true, status: "synced", synced: 1, failed: 1 });
    expect(saved.has("user-1")).toBe(false);
    expect(saved.get("user-2")?.personaName).toBe("Currently Playing");
  });

  it("counts a rate-limited account as failed without failing the pass", async () => {
    const { fetchFn } = stubFetch((url) => {
      if (url.pathname === SUMMARIES_PATH)
        return summariesRouter([publicPlayer(PUBLIC_STEAM_ID), playingPlayer()])(url);
      if (url.pathname === OWNED_GAMES_PATH) {
        if (url.searchParams.get("steamid") === PUBLIC_STEAM_ID)
          return new Response("rate limited", { status: 429 });
        return jsonResponse(ownedGamesBody(sevenGameLibrary()));
      }
      throw new Error(`unexpected Steam call: ${url.pathname}`);
    });
    const { saved, store } = memorySteamStore([
      accountFor("user-1", PUBLIC_STEAM_ID),
      accountFor("user-2", PLAYING_STEAM_ID),
    ]);
    const result = await syncSteamAccounts({
      apiKey: TEST_KEY,
      store,
      fetchFn,
      now: () => SYNC_NOW,
    });
    expect(result).toEqual({ ok: true, status: "synced", synced: 1, failed: 1 });
    expect(saved.has("user-1")).toBe(false);
    expect(saved.has("user-2")).toBe(true);
  });

  it("skips the library call and counts failed when Steam omits the summary row", async () => {
    const { calls, fetchFn } = stubFetch(summariesRouter([playingPlayer()]));
    const { saved, store } = memorySteamStore([
      accountFor("user-1", PUBLIC_STEAM_ID),
      accountFor("user-2", PLAYING_STEAM_ID),
    ]);
    const result = await syncSteamAccounts({
      apiKey: TEST_KEY,
      store,
      fetchFn,
      now: () => SYNC_NOW,
    });
    expect(result).toEqual({ ok: true, status: "synced", synced: 1, failed: 1 });
    expect(saved.has("user-1")).toBe(false);
    for (const { url } of callsTo(calls, OWNED_GAMES_PATH))
      expect(new URL(url).searchParams.get("steamid")).not.toBe(PUBLIC_STEAM_ID);
  });

  it("counts a malformed summary row as failed without saving it", async () => {
    const { fetchFn } = stubFetch((url) => {
      if (url.pathname === SUMMARIES_PATH)
        return jsonResponse(
          summariesBody([
            { steamid: PUBLIC_STEAM_ID, communityvisibilitystate: 3 } as SteamWirePlayer,
            playingPlayer(),
          ]),
        );
      if (url.pathname === OWNED_GAMES_PATH)
        return jsonResponse(ownedGamesBody(sevenGameLibrary()));
      throw new Error(`unexpected Steam call: ${url.pathname}`);
    });
    const { saved, store } = memorySteamStore([
      accountFor("user-1", PUBLIC_STEAM_ID),
      accountFor("user-2", PLAYING_STEAM_ID),
    ]);
    const result = await syncSteamAccounts({
      apiKey: TEST_KEY,
      store,
      fetchFn,
      now: () => SYNC_NOW,
    });
    expect(result).toEqual({ ok: true, status: "synced", synced: 1, failed: 1 });
    expect(saved.has("user-1")).toBe(false);
    expect(saved.has("user-2")).toBe(true);
  });
});

describe("owned games as suggestions in the profile games editor", () => {
  it("offers owned games not already listed, in owned order", () => {
    expect(
      suggestionsFromOwnedGames(["Counter-Strike 2", "Dota 2", "Stardew Valley"], ["Dota 2"]),
    ).toEqual(["Counter-Strike 2", "Stardew Valley"]);
  });

  it("matches already-listed games case-insensitively and trims blanks", () => {
    expect(
      suggestionsFromOwnedGames(
        ["  Dota 2  ", "", "   ", "rust", "Rust", "Terraria"],
        ["dota 2", "RUST"],
      ),
    ).toEqual(["Terraria"]);
  });

  it("returns nothing when the library is empty or fully listed", () => {
    expect(suggestionsFromOwnedGames([], [])).toEqual([]);
    expect(suggestionsFromOwnedGames(["Dota 2"], ["Dota 2"])).toEqual([]);
  });

  it("renders suggestions inside the owner's games editor", () => {
    const html = renderOwnerPage({ steamSuggestions: ["Counter-Strike 2", "Dota 2"] });
    expect(html).toContain('data-testid="steam-game-suggestions"');
    expect(html).toContain("Counter-Strike 2");
    expect(html).toContain("Dota 2");
    // Next to the games control, as editing aids, never as form values.
    expect(html.indexOf("profile-games-text")).toBeLessThan(html.indexOf("steam-game-suggestions"));
    expect(html.match(/data-steam-suggestion/g)).toHaveLength(2);
    expect(html.match(/<button[^>]*data-steam-suggestion[^>]*type="button"/g)).toHaveLength(2);
  });

  it("renders no suggestions block without suggestions", () => {
    expect(renderOwnerPage({})).not.toContain("steam-game-suggestions");
    expect(renderOwnerPage({ steamSuggestions: [] })).not.toContain("steam-game-suggestions");
  });

  it("never renders owner suggestions to other viewers", () => {
    const html = ProfilePage({
      member: ownerMember(),
      isOwner: false,
      appUrl: "https://next.example.test",
      steamSuggestions: ["Counter-Strike 2"],
    })!.toString() as string;
    expect(html).not.toContain("steam-game-suggestions");
  });

  it("escapes suggestion names", () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const html = renderOwnerPage({ steamSuggestions: [evil] });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});

describe("steam secret wiring", () => {
  it("declares the optional STEAM_WEB_API_KEY secret on JobsEnv", () => {
    // Typecheck-enforced: the Worker secret is Operator-provisioned like the
    // BOT_* values, so local and test environments leave it unset.
    expectTypeOf<JobsEnv["STEAM_WEB_API_KEY"]>().toEqualTypeOf<string | undefined>();
  });
});
