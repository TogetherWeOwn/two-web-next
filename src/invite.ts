// The Discord invite floor: configured URL when usable, hardcoded fallback otherwise.
//
// Split out of the app module so the join journey (which the app module mounts)
// can sanitize its recovery-page invite link with the same rule as /discord.
// Ports two-web DiscordInviteController::FALLBACK_INVITE.
import { createRateLimitedWarn } from "./log-budget";

// The last resort, hardcoded on purpose (ports two-web DiscordInviteController::FALLBACK_INVITE).
// The WEB-HOMEPAGE campaign code: never expires, unlimited uses, so the join button has an invite
// that cannot rot and web arrivals attribute to the website. An invite code is not a secret: it is
// a public join link that grants nothing but membership of a server anyone can ask to join.
export const FALLBACK_INVITE = "https://discord.gg/4GwEDNRTtx";

// Fixed class for the unusable-config warn and the /discord request-error
// alert. The message never carries the configured value.
export class InviteConfigError extends Error {
  constructor() {
    super("services.discord.invite_url is unusable");
    this.name = "InviteConfigError";
  }
}

// One bucket for the whole invite leg: a broken config warns bounded (at
// most burst warns, then one shed per window) instead of once per call, so a
// bad deploy pages via /discord instead of flooding. Usable configs stay
// silent and spend nothing.
const inviteLog = createRateLimitedWarn({ shedLine: "invite.config.shed" });

function discordInvite(url: string): string | null {
  // Require a real HTTPS authority, not missing or extra slashes repaired by URL parsing.
  if (!/^https:\/\/[^/?#@\s]+(?:[/?#]|$)/i.test(url) || /[\u0000-\u001f\u007f\\]/.test(url))
    return null;
  let parts: URL;
  try {
    parts = new URL(url);
  } catch {
    return null;
  }
  if (parts.protocol !== "https:" || parts.username || parts.password || parts.port) return null;
  if (
    !(
      (parts.hostname === "discord.gg" && /^\/[\w-]+$/.test(parts.pathname)) ||
      (parts.hostname === "discord.com" && /^\/invite\/[\w-]+$/.test(parts.pathname))
    )
  )
    return null;
  // Serialize Unicode before Hono redirects, preserving existing query and fragment escapes.
  return parts.href;
}

// True when the configured value is a usable invite link. Lets routes that
// page on a broken config (GET /discord) ask without parsing twice in the
// warn path; the destination rule below stays the single serving decision.
export function isInviteConfigUsable(configured: string): boolean {
  return discordInvite(configured) !== null;
}

// The configured invite if usable, the hardcoded one otherwise. Never throws: a member clicking
// the join link is the single most valuable request this site serves, and an error page is worse
// than an invite one rotation out of date. A broken config warns rate-limited
// (class only, never the configured value) and sheds bounded; fallback
// serving is unchanged.
export function inviteDestination(configured: string): string {
  const destination = discordInvite(configured);
  if (destination) return destination;
  inviteLog.warn("invite.config.unusable", { exception: InviteConfigError.name });
  return FALLBACK_INVITE;
}
