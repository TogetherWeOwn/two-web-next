// Shared homepage notice, flash and ladder-fallback copy: the single source
// the Hono home screen (src/screens/home.tsx via ./page-shell) and the Kit
// home route (web/src/routes/+page.svelte) both render. Plain TypeScript with
// type-only imports, so the Kit server and component bundles stay Hono-free.
// Sentences are byte-identical to the legacy meanings (legacy
// auth-discord.php, matched by meaning, not translation key); change them
// here once and both renderers follow.
import type { Rank } from "./counts";
import type { KitSession, KitSessionStatus } from "./kit-session";
import type { JoinResult } from "./return-journey";

// One actionable sentence per failure meaning: denied says "you cancelled",
// unavailable says "this is on Discord, not you — try again in a minute",
// the generic sentence covers an expired or otherwise incomplete attempt.
// Nobody's browser ever shows Discord's error_description.
export const HOME_NOTICES = {
  joined: "You're in. Welcome to the TWO Discord.",
  already_member: "Signed in. You're already in the TWO Discord.",
  join_failed:
    "Signed in, but we couldn't add you to the Discord automatically. Use the invite link below.",
  signin_failed: "Discord sign-in didn't complete. Please try again.",
  signin_denied:
    "You cancelled the Discord sign-in, so we didn't sign you in. Nothing changed — try again whenever you like.",
  signin_unavailable:
    "Discord did not answer just now, so we could not sign you in. This is on Discord, not you — please try again in a minute.",
} as const;

export type HomeNotice = keyof typeof HOME_NOTICES;

/** The `?n=` value Hono accepts: exactly one of the six keys, else no notice. */
export function parseHomeNotice(value: string | null): HomeNotice | null {
  // Own-key check, not a module-level key Set: the same accept/reject answers
  // (prototype names still rejected) with no module state for bundlers to
  // retain in graphs that only need the copy tables below.
  if (!value || !Object.hasOwn(HOME_NOTICES, value)) return null;
  return value as HomeNotice;
}

// A failure notice carries its own explanation: a stale success flash from an
// older journey must never override the current failure.
const FLASH_SUPPRESSED_NOTICES: ReadonlySet<string> = new Set([
  "join_failed",
  "signin_failed",
  "signin_denied",
  "signin_unavailable",
]);

/** The flashed join confirmation a notice slot may show, if any survives. */
export function resolveHomeFlash(
  notice: HomeNotice | null,
  flash: JoinResult | null,
): JoinResult | null {
  if (notice && FLASH_SUPPRESSED_NOTICES.has(notice)) return null;
  return flash;
}

// One-shot join confirmation (legacy join_result flash →
// data-testid="join-result", JoinResultCopyTest/AlreadyMemberReinviteTest). A
// member who was already in the guild gets the reinvite action — /discord
// resolves to the live invite — never the bare homepage "Open Discord".
export const HOME_JOIN_RESULT_COPY = {
  added: "You are in. Finish Discord's rules screening before you can post.",
  alreadyInServer: "You are already in the server.",
  reinvite: "Rejoin with the Discord invite",
} as const;

// The ladder names its ranks even when the bot views are dark: ranks stack,
// so an unnumbered stack still reads as the trust ladder, never as zeros.
// Plain literal, not a mapped construction: the same five rows, with no call
// for bundlers to retain in graphs that only need the copy tables.
export const FALLBACK_RANKS: Rank[] = [
  { key: "prospect", label: "Prospect", memberCount: null },
  { key: "member", label: "Member", memberCount: null },
  { key: "soldier", label: "Soldier", memberCount: null },
  { key: "veteran", label: "Veteran", memberCount: null },
  { key: "legend", label: "Legend", memberCount: null },
];

// Kit homepage decision core (SvelteKit migration; zero behavior change).
//
// The Kit load (web/src/routes/+page.server.ts) is a thin env binding; the
// session, notice and flash decisions live here so the root suite pins them
// with fake locals, the way src/join/kit-page.ts does for /join. Values mirror
// the Hono GET / handler in src/index.tsx exactly: an outage is never a logout
// (unknown renders the guest header with the invite-link hero), ?n= accepts
// exactly the six keys, and a failure notice drops a stale success flash.
export type HomePageStateInput = {
  // Undefined (bridge locals absent) renders as guest, matching the load's
  // previous inline `=== "authenticated"` / `=== "unknown"` checks.
  status: KitSessionStatus | undefined;
  noticeRaw: string | null;
  flash: JoinResult | null;
};

export type HomePageState = {
  sessionUnavailable: boolean;
  notice: HomeNotice | null;
  joinResult: JoinResult | null;
};

/** Session, notice and flash decisions for GET /, framework-free. */
export function resolveHomePageState(input: HomePageStateInput): HomePageState {
  const sessionUnavailable = input.status === "unknown";
  const notice = parseHomeNotice(input.noticeRaw);
  return { sessionUnavailable, notice, joinResult: resolveHomeFlash(notice, input.flash) };
}

export type HomeFlashConsumptionInput = {
  method: string;
  flash: JoinResult | null;
  cookieName: string;
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
};

/**
 * One-shot flash consumption (Hono takeJoinResult parity): the first GET that
 * can render the banner deletes the cookie with the same attributes Hono's
 * deleteOpts sets (path /, Secure, HttpOnly, SameSite Lax) — even when a
 * failure notice suppresses the banner, otherwise the flash repeats on the
 * next visit. HEAD/POST reads leave it pending, matching Hono's GET-only
 * readJoinResult. The cookie name rides in from the caller (the Kit load's
 * JOIN_RESULT_COOKIE) so this module keeps its type-only return-journey
 * import and stays runtime-free of Hono cookie helpers.
 */
export function applyHomeFlashConsumption(input: HomeFlashConsumptionInput): void {
  if (input.method !== "GET" || !input.flash) return;
  input.cookies.delete(input.cookieName, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
  });
}

// Kit home response policy (SvelteKit migration; zero behavior change).
//
// The Kit load (web/src/routes/+page.server.ts) is a thin env binding; the
// session mapping, notice/flash decisions, one-shot consumption and the
// viewer-specific cache header live here so the root suite pins them with fake
// locals, the way src/join/kit-page.ts does for /join via
// applyJoinPageResponsePolicy. Values mirror the Hono GET / handler exactly:
// an outage renders the guest header (unknown is never a logout), ?n= accepts
// exactly the six keys, the raw flash is consumed on the first GET even when a
// failure notice suppresses the banner, and every response stays
// viewer-specific (private, no-store).
export type HomeResponsePolicyLocals = {
  status?: KitSessionStatus | undefined;
  session?: KitSession | null;
  joinResult?: JoinResult | null;
};

export type HomeResponsePolicyInput = {
  locals: HomeResponsePolicyLocals;
  noticeRaw: string | null;
  method: string;
  cookieName: string;
  cookies: HomeFlashConsumptionInput["cookies"];
  setHeaders: (headers: Record<string, string>) => void;
};

export type HomeResponsePolicyOutput = {
  session: KitSession | null;
  sessionUnavailable: boolean;
  notice: HomeNotice | null;
  joinResult: JoinResult | null;
};

/** Session mapping, flash decisions, one-shot consumption and cache policy. */
export function applyHomeResponsePolicy(input: HomeResponsePolicyInput): HomeResponsePolicyOutput {
  const session = input.locals.status === "authenticated" ? (input.locals.session ?? null) : null;
  const flash = input.locals.joinResult ?? null;
  const { sessionUnavailable, notice, joinResult } = resolveHomePageState({
    status: input.locals.status,
    noticeRaw: input.noticeRaw,
    flash,
  });
  applyHomeFlashConsumption({
    method: input.method,
    flash,
    cookieName: input.cookieName,
    cookies: input.cookies,
  });
  input.setHeaders({ "cache-control": "private, no-store" });
  return { session, sessionUnavailable, notice, joinResult };
}
