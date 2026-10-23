// Client-safe last-resort invite: the hardcoded fallback join link in an
// import-free leaf, so Kit error shells can offer recovery without bundling
// the invite telemetry (src/invite.ts) into client JavaScript. Ports two-web
// DiscordInviteController::FALLBACK_INVITE.
//
// The WEB-HOMEPAGE campaign code: never expires, unlimited uses, so the join
// button has an invite that cannot rot and web arrivals attribute to the
// website. An invite code is not a secret: it is a public join link that
// grants nothing but membership of a server anyone can ask to join.
//
// Keep this file import-free: every import here ships to browsers that render
// an error shell.
export const FALLBACK_INVITE = "https://discord.gg/4GwEDNRTtx";
