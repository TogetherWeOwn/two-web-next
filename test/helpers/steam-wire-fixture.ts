// Recorded-shape fixtures for the Steam Web API surface the daily profile
// sync uses: ISteamUser/GetPlayerSummaries v0002 and
// IPlayerService/GetOwnedGames v0001. Field names and nesting follow the
// public Steam Web API docs; every id, persona name, game title and URL below
// is synthetic. Tests must never call api.steampowered.com: inject a stub
// `fetchFn` that answers from these builders instead.

export const STEAM_API_HOST = "api.steampowered.com";
export const SUMMARIES_PATH = "/ISteamUser/GetPlayerSummaries/v0002/";
export const OWNED_GAMES_PATH = "/IPlayerService/GetOwnedGames/v0001/";

// Clearly synthetic SteamID64s (never real accounts).
export const PUBLIC_STEAM_ID = "76561190000000001";
export const PLAYING_STEAM_ID = "76561190000000002";
export const PRIVATE_STEAM_ID = "76561190000000003";
export const FRIENDS_ONLY_STEAM_ID = "76561190000000004";
export const EMPTY_LIBRARY_STEAM_ID = "76561190000000005";
export const UNLINKED_STEAM_ID = "76561190000000999";

export type SteamWirePlayer = {
  steamid: string;
  communityvisibilitystate: number;
  profilestate?: number;
  personaname: string;
  profileurl: string;
  avatar: string;
  avatarmedium: string;
  avatarfull: string;
  personastate?: number;
  gameextrainfo?: string;
  gameid?: string;
};

export type SteamWireGame = {
  appid: number;
  name: string;
  playtime_forever: number;
  playtime_windows_forever?: number;
  playtime_mac_forever?: number;
  playtime_linux_forever?: number;
  rtime_last_played?: number;
};

export const wirePlayer = (overrides: Partial<SteamWirePlayer> & { steamid: string }) => ({
  communityvisibilitystate: 3,
  profilestate: 1,
  personaname: `Persona ${overrides.steamid.slice(-4)}`,
  profileurl: `https://steamcommunity.com/profiles/${overrides.steamid}/`,
  avatar: `https://avatars.steamstatic.com/${overrides.steamid.slice(-4)}_small.jpg`,
  avatarmedium: `https://avatars.steamstatic.com/${overrides.steamid.slice(-4)}_medium.jpg`,
  avatarfull: `https://avatars.steamstatic.com/${overrides.steamid.slice(-4)}_full.jpg`,
  personastate: 1,
  ...overrides,
});

export const wireGame = (overrides: Partial<SteamWireGame> & { appid: number; name: string }) => ({
  playtime_forever: 0,
  playtime_windows_forever: 0,
  playtime_mac_forever: 0,
  playtime_linux_forever: 0,
  rtime_last_played: 1729460000,
  ...overrides,
});

/** Seven-game library with distinct playtimes, so the top-5 cut is exact. */
export const sevenGameLibrary = () => [
  wireGame({ appid: 730, name: "Counter-Strike 2", playtime_forever: 12000 }),
  wireGame({ appid: 570, name: "Dota 2", playtime_forever: 8000 }),
  wireGame({ appid: 578080, name: "PUBG: BATTLEGROUNDS", playtime_forever: 3000 }),
  wireGame({ appid: 1172470, name: "Apex Legends", playtime_forever: 1500 }),
  wireGame({ appid: 252490, name: "Rust", playtime_forever: 900 }),
  wireGame({ appid: 413150, name: "Stardew Valley", playtime_forever: 400 }),
  wireGame({ appid: 105600, name: "Terraria", playtime_forever: 0 }),
];

export const summariesBody = (players: SteamWirePlayer[]) => ({ response: { players } });

export const ownedGamesBody = (games: SteamWireGame[]) => ({
  response: { game_count: games.length, games },
});

/** A public account with a genuinely empty library still reports game_count. */
export const emptyLibraryBody = () => ({ response: { game_count: 0 } });

/** A private profile hides the library: GetOwnedGames answers `{response:{}}`. */
export const hiddenLibraryBody = () => ({ response: {} });

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
