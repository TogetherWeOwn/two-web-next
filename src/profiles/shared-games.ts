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
