// Composition feedback for the profile editors (bio/games), shared by the
// Hono ProfilePage and the Kit ProfileView so both renderers seed identical
// persistent hints and live counts. Mirrors src/profiles/validation.ts
// limits without changing them: bio <= 1000 Unicode code points, raw games
// text <= 1700, each trimmed game <= 80, at most 20 distinct nonblank names.

export const PROFILE_BIO_LIMIT = 1000;
export const PROFILE_GAMES_RAW_LIMIT = 1700;
export const PROFILE_GAME_NAME_LIMIT = 80;
export const PROFILE_GAMES_COUNT_LIMIT = 20;

export const PROFILE_BIO_HINT_ID = "profile-bio-hint";
export const PROFILE_BIO_COUNT_ID = "profile-bio-count";
export const PROFILE_GAMES_TEXT_HINT_ID = "profile-games-text-hint";
export const PROFILE_GAMES_TEXT_COUNT_ID = "profile-games-text-count";

export const PROFILE_BIO_HINT_COPY = "Up to 1000 characters.";
export const PROFILE_GAMES_TEXT_HINT_COPY =
  "Up to 20 games, one per line: 80 characters per game, 1700 characters total.";

export const codePoints = (value: string): number => [...value].length;

export type GamesComposition = {
  names: string[];
  raw: number;
  overlong: number[];
};

// Same split/trim/blank/dedupe as validateProfile: CRLF/CR/LF split, trim,
// blank omission, case-sensitive dedupe in order. `overlong` holds the
// 1-based line numbers whose trimmed length exceeds the per-name limit.
export const parseGamesText = (value: string): GamesComposition => {
  const names: string[] = [];
  const overlong: number[] = [];
  value.split(/\r\n|\r|\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if ([...trimmed].length > PROFILE_GAME_NAME_LIMIT) overlong.push(index + 1);
    if (trimmed !== "" && !names.includes(trimmed)) names.push(trimmed);
  });
  return { names, raw: [...value].length, overlong };
};

export const bioCountText = (count: number): string =>
  count <= PROFILE_BIO_LIMIT
    ? `${count} of 1000 characters`
    : `${count} of 1000 characters (${count - PROFILE_BIO_LIMIT} over the limit)`;

export const gamesCountText = (facts: GamesComposition): string => {
  const distinct = facts.names.length;
  const games =
    distinct <= PROFILE_GAMES_COUNT_LIMIT
      ? `${distinct} of 20 games`
      : `${distinct} of 20 games (${distinct - PROFILE_GAMES_COUNT_LIMIT} over the limit)`;
  const raw =
    facts.raw <= PROFILE_GAMES_RAW_LIMIT
      ? `${facts.raw} of 1700 characters`
      : `${facts.raw} of 1700 characters (${facts.raw - PROFILE_GAMES_RAW_LIMIT} over the limit)`;
  const lines =
    facts.overlong.length === 0
      ? ""
      : `, line${facts.overlong.length === 1 ? "" : "s"} ${facts.overlong.join(", ")} over 80 characters`;
  return `${games}, ${raw}${lines}`;
};
