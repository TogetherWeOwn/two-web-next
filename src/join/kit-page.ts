// Kit GET /join shared core (SvelteKit migration; zero behavior change).
//
// The Kit load (web/src/routes/join/+page.server.ts) is a thin env binding;
// the cache contract lives here so the root suite pins it. Values mirror the
// Hono joinPage render in src/index.tsx exactly: carrying the join-result
// flash makes the response viewer-specific (a guest must never read another
// member's banner from a shared cache), a rendered presence snapshot says
// "now" (60 s shared TTL matching DISCORD_WIDGET_VERDICT_TTL_MS), and the
// static page without presence keeps 3600 s. Vary: Cookie is set by the load
// on every variant (the representation depends on the flash cookie even when
// the view has nothing to consume); only the max-age/no-store selection is
// a pure function, so only it lives here.
import type { DiscordWidgetSnapshot } from "../discord-widget";
import type { JoinResult } from "../return-journey";

export type JoinPageCacheControl =
  | "private, no-store"
  | "public, max-age=60"
  | "public, max-age=3600";

export function joinPageCacheControl(
  joinResult: JoinResult | null,
  snapshot: DiscordWidgetSnapshot | null | undefined,
): JoinPageCacheControl {
  if (joinResult) return "private, no-store";
  if (snapshot) return "public, max-age=60";
  return "public, max-age=3600";
}
