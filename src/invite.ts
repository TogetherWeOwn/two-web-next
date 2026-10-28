// The Discord invite floor: configured URL when usable, hardcoded fallback otherwise.
//
// Split out of the app module so the join journey (which the app module mounts)
// can sanitize its recovery-page invite link with the same rule as /discord.
// Ports two-web DiscordInviteController::FALLBACK_INVITE.
import { FALLBACK_INVITE } from "./invite-fallback";
import { createRateLimitedWarn, type RateLimitedWarn } from "./log-budget";

// Re-exported from the import-free leaf: Kit error shells bundle the fallback
// without pulling this module's telemetry into client JavaScript.
export { FALLBACK_INVITE };

// Fixed class for the unusable-config warn and the /discord request-error
// alert. The message never carries the configured value.
export class InviteConfigError extends Error {
  constructor() {
    super("DISCORD_INVITE_URL is unusable");
    this.name = "InviteConfigError";
  }
}

// One bucket for the whole invite leg: a broken config warns bounded (at
// most burst warns, then one shed per window) instead of once per call, so a
// bad deploy pages via /discord instead of flooding. Usable configs stay
// silent and spend nothing. Created lazily on first refusal (not at import
// time) so importing this module has no side effects: client chunks that
// reach it through a shared barrel never pay for the bucket.
let inviteLog: RateLimitedWarn | null = null;
function log(): RateLimitedWarn {
  if (!inviteLog) inviteLog = createRateLimitedWarn({ shedLine: "invite.config.shed" });
  return inviteLog;
}

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
  log().warn("invite.config.unusable", { exception: InviteConfigError.name });
  return FALLBACK_INVITE;
}
