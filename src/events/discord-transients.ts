// Discord-native scheduled events for the calendar (legacy
// App\Support\Events\DiscordEventsSource, TOG-5168): the recurring community
// events live in the bot's database, so the page merges them in as
// display-only transients — expiring cache bytes, never canonical events,
// published, or handed to the write-back. Fail-open by contract: a dark collector is the error empty
// state on an otherwise-empty page, never a 500.
//
// One resolve per request (legacy render() resolve rule): the rows and the
// failure flag must come from the same instance — asking a second reader
// whether the first one's read failed is always "no".
//
// Discord transients barrel (structural split; zero behavior change). One
// module per concern lives beside this file: the outcome vocabulary, read
// deadline and source types in ./discord-transients-types, the live HTTP
// reader in ./discord-transients-live, the shared-snapshot reader in
// ./discord-transients-cached, and the request-level factory in
// ./discord-transients-source. This file re-exports the historic public names
// so existing importers keep working untouched.

export {
  DISCORD_CACHE_FRESH_MS,
  DISCORD_CACHE_STALE_MS,
  DISCORD_FAILURE_HOLD_MS,
} from "./discord-snapshot";
export {
  DISCORD_READ_DEADLINE_MS,
  DISCORD_SNAPSHOT_OUTCOMES,
  SAFE_SNAPSHOT_SQLSTATES,
} from "./discord-transients-types";
export type {
  DiscordEventsSource,
  DiscordSnapshotOutcome,
  ReadFailure,
} from "./discord-transients-types";
export { liveDiscordEventsSource } from "./discord-transients-live";
export { cachedDiscordEventsSource } from "./discord-transients-cached";
export { discordEventsSource } from "./discord-transients-source";
