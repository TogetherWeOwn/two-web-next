// Kit GET /join shared core (SvelteKit migration; zero behavior change).
//
// The Kit load (web/src/routes/join/+page.server.ts) is a thin env binding;
// the cache contract lives here so the root suite pins it. Values mirror the
// Hono joinPage render in src/index.tsx exactly: carrying the join-result
// flash makes the response viewer-specific (a guest must never read another
// member's banner from a shared cache), and every other page keeps a 60 s
// shared TTL: a presence snapshot says "now" (matching
// DISCORD_WIDGET_VERDICT_TTL_MS) and the next-game-night card is derived from
// a schedule that moves, so neither may outlive a minute in a shared cache,
// whichever of them a given response happens to carry. Vary: Cookie is set by the load
// on every variant (the representation depends on the flash cookie even when
// the view has nothing to consume); only the max-age/no-store selection is
// a pure function, so only it lives here.
import type { DiscordWidgetSnapshot } from "../discord-widget";
import { readReturnJourney } from "../kit-session";
import type { JOIN_START_FAILED_NOTICE } from "./route-shared";
import { JOIN_RESULT_COOKIE, type JoinResult } from "../return-journey";

export type JoinPageCacheControl = "private, no-store" | "public, max-age=60";

/**
 * The `?notice=` value Kit accepts: exactly the store-down bounce value, else
 * no notice. Same exact-match rule as the Hono GET /join handler
 * (`./route-page.ts` against `JOIN_START_FAILED_NOTICE`): a hostile, mistyped
 * or empty value renders the plain page and leaves no trace in the HTML or
 * the load data. Type-only import keeps this module free of the journey
 * store's runtime graph for the Kit worker.
 */
export function parseJoinNotice(value: string | null): typeof JOIN_START_FAILED_NOTICE | null {
  return value === "start-failed" ? value : null;
}

export function joinPageCacheControl(
  joinResult: JoinResult | null,
  _snapshot: DiscordWidgetSnapshot | null | undefined,
): JoinPageCacheControl {
  return joinResult ? "private, no-store" : "public, max-age=60";
}

type JoinPagePolicyInput = {
  request: Request;
  sessionSecret: string;
  snapshot: DiscordWidgetSnapshot | null | undefined;
  cookies: {
    delete: (
      name: string,
      options: {
        path: string;
        secure: boolean;
        httpOnly: boolean;
        sameSite: "lax";
      },
    ) => void;
  };
  setHeaders: (headers: Record<string, string>) => void;
};

/** Apply the Kit /join flash-consumption and cache policy for a response. */
export async function applyJoinPageResponsePolicy({
  request,
  sessionSecret,
  snapshot,
  cookies,
  setHeaders,
}: JoinPagePolicyInput): Promise<{ joinResult: JoinResult | null }> {
  const { joinResult } = await readReturnJourney(request, sessionSecret);
  if (joinResult) {
    cookies.delete(JOIN_RESULT_COOKIE, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    });
  }
  setHeaders({
    "cache-control": joinPageCacheControl(joinResult, snapshot),
    vary: "Cookie",
  });
  return { joinResult };
}
