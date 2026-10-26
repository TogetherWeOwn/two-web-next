// Shared-game match for profile reads: the member's displayed game strings
// the viewer also plays, in member-list order. One matcher for both twins so
// Hono and Kit can never mark different entries. Matching is trim plus
// case-insensitive (the schedule game-facet rule); the view marks entries
// exactly equal to a returned value, so case/whitespace variants each render
// marked while duplicates collapse in the match, never by dropping entries.
export const normalizeGameName = (name: string): string => name.trim().toLowerCase();

export function findSharedGames(memberGames: string[], viewerGames: string[]): string[] {
  const viewer = new Set(viewerGames.map(normalizeGameName));
  return memberGames.filter((game) => viewer.has(normalizeGameName(game)));
}

/** Exact displayed entries mapped to their first published spelling, matching
 * the schedule facet. Object.fromEntries keeps free-text keys such as __proto__
 * as own data properties; unmatched and blank entries never become links. */
export function findScheduledGames(
  memberGames: string[],
  publishedGames: string[],
): Record<string, string> {
  const published = new Map<string, string>();
  for (const game of publishedGames) {
    const key = normalizeGameName(game);
    if (key && !published.has(key)) published.set(key, game);
  }
  return Object.fromEntries(
    memberGames.flatMap((game) => {
      const canonical = published.get(normalizeGameName(game));
      return canonical === undefined ? [] : [[game, canonical]];
    }),
  );
}
