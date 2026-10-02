// Every unknown URL renders the branded 404, and scanners probe hundreds of
// them. The optional "Happening soon" rows are the same guest view for every
// visitor (no session, no member data), so one per-isolate snapshot serves
// them all instead of one Postgres transaction per probe (TOG-12551).
import type { EnvWithAdminDb } from "./admin/db";
import { databaseUrl } from "./db/connection";
import type { Env } from "./env";
import { notFoundSuggestions, type SuggestedEvent } from "./events/suggestions";

export const NOT_FOUND_SUGGESTIONS_TTL_MS = 60_000;

// Probes for files (`/wp-login.php`, `/favicon.ico`, `/app.js.map`) or dot
// segments (`/.env`, `/.git/config`) never reach a page: no lookup at all.
const ASSET_LIKE_PATH = /(?:^|\/)\.|\.[a-z0-9]{1,8}$/i;

export function assetLikePath(path: string): boolean {
  return ASSET_LIKE_PATH.test(path);
}

// Same pattern as src/counts.ts: one settled entry, scoped to the DB source
// dbFor would use (injected ADMIN_DB, else DATABASE_URL/Hyperdrive). Never
// share pending I/O: Workers can cancel it with the owning invocation, so
// concurrent cold requests fill independently. Empty results (no events,
// DB error, 500 ms deadline) are cached too, so an outage is not amplified.
// A cached row may outlive its event's end by up to the TTL.
let cache: { source: unknown; value: SuggestedEvent[]; expiresAt: number } | undefined;
let nextFill = 0;
let publishedFill = 0;

export async function cachedNotFoundSuggestions(env: Env, path: string): Promise<SuggestedEvent[]> {
  if (assetLikePath(path)) return [];
  let source: unknown;
  try {
    source = (env as EnvWithAdminDb).ADMIN_DB ?? databaseUrl(env);
  } catch {
    return []; // An unreadable binding cannot reach a DB either.
  }
  if (!source) return [];
  if (cache?.source === source && Date.now() < cache.expiresAt) return cache.value;
  const fill = ++nextFill;
  const value = await notFoundSuggestions(env);
  // Only an already-published newer snapshot keeps an older fill out.
  if (fill > publishedFill) {
    publishedFill = fill;
    cache = { source, value, expiresAt: Date.now() + NOT_FOUND_SUGGESTIONS_TTL_MS };
  }
  return value;
}
