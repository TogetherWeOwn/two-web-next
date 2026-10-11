// Discord transients: the request-level factory (structural split of
// ./discord-transients; zero behavior change).

import type { Env } from "../env";
import { cachedDiscordEventsSource } from "./discord-transients-cached";
import type { DiscordEventsSource } from "./discord-transients-types";

type EnvWithDiscord = Env & { DISCORD_EVENTS?: DiscordEventsSource };

/**
 * Resolve the source for this request. `DISCORD_EVENTS` is the test/dev seam
 * (like `ADMIN_DB`): injected fakes answer instead of the live read.
 */
export function discordEventsSource(env: Env): DiscordEventsSource {
  return (env as EnvWithDiscord).DISCORD_EVENTS ?? cachedDiscordEventsSource(env);
}
