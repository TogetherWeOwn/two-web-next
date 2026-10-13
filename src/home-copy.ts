// Shared homepage notice, flash and ladder-fallback copy: the single source
// the Hono home screen (src/screens/home.tsx via ./page-shell) and the Kit
// home route (web/src/routes/+page.svelte) both render. Plain TypeScript with
// type-only imports, so the Kit server and component bundles stay Hono-free.
// Sentences are byte-identical to the legacy meanings (legacy
// auth-discord.php, matched by meaning, not translation key); change them
// here once and both renderers follow.
import type { Rank } from "./counts";
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

const HOME_NOTICE_KEYS = new Set<string>(Object.keys(HOME_NOTICES));

/** The `?n=` value Hono accepts: exactly one of the six keys, else no notice. */
export function parseHomeNotice(value: string | null): HomeNotice | null {
  if (!value || !HOME_NOTICE_KEYS.has(value)) return null;
  return value as HomeNotice;
}

// A failure notice carries its own explanation: a stale success flash from an
// older journey must never override the current failure (TOG-10356 review).
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
export const FALLBACK_RANKS: Rank[] = ["Prospect", "Member", "Soldier", "Veteran", "Legend"].map(
  (label) => ({ key: label.toLowerCase(), label, memberCount: null }),
);
