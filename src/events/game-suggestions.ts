import type { Db } from "../db";
import { isDatabaseUnavailable } from "../db/errors";
import { listPublishedGames } from "./reads";
import { nonSensitiveRead } from "../member-reads";

/** Optional assistance only: callers admit and validate first, then pass one
 * snapshot to the renderer. Never use these names to validate submitted games. */
export async function loadGameSuggestions(db: Db | null): Promise<string[]> {
  if (!db) return [];
  try {
    return await nonSensitiveRead("published-games", () => listPublishedGames(db));
  } catch (err) {
    if (isDatabaseUnavailable(err)) return [];
    throw err;
  }
}
