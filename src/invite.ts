// The Discord invite floor: configured URL when usable, hardcoded fallback otherwise.
//
// Split out of the app module so the join journey (which the app module mounts)
// can sanitize its recovery-page invite link with the same rule as /discord.
// Ports two-web DiscordInviteController::FALLBACK_INVITE.

// The last resort, hardcoded on purpose (ports two-web DiscordInviteController::FALLBACK_INVITE).
// The WEB-HOMEPAGE campaign code: never expires, unlimited uses, so the join button has an invite
// that cannot rot and web arrivals attribute to the website. An invite code is not a secret: it is
// a public join link that grants nothing but membership of a server anyone can ask to join.
export const FALLBACK_INVITE = "https://discord.gg/4GwEDNRTtx";

function landsInDiscord(url: string): boolean {
  // URL parsing normalizes these, but the original value becomes the Location header or href.
  if (/[\u0000-\u001f\u007f\\]/.test(url)) return false;
  let parts: URL;
  try {
    parts = new URL(url);
  } catch {
    return false;
  }
  return parts.protocol === "https:" && !parts.username && !parts.password && !parts.port &&
    ((parts.hostname === "discord.gg" && /^\/[\w-]+$/.test(parts.pathname)) ||
      (parts.hostname === "discord.com" && /^\/invite\/[\w-]+$/.test(parts.pathname)));
}

// The configured invite if usable, the hardcoded one otherwise. Never throws: a member clicking
// the join link is the single most valuable request this site serves, and an error page is worse
// than an invite one rotation out of date.
export function inviteDestination(configured: string): string {
  if (landsInDiscord(configured)) return configured;
  console.error("services.discord.invite_url is unusable; serving the hardcoded fallback invite.");
  return FALLBACK_INVITE;
}
