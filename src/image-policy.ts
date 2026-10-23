// Shared by featured-image validation and CSP: exact HTTPS hosts, never
// wildcards or user-supplied CSP source expressions. Discord avatars retain
// their existing CDN permission even when no featured hosts are configured.
const DISCORD_IMAGE_HOST = "cdn.discordapp.com";
const PRIVATE_SUFFIXES = [
  "localhost",
  "localdomain",
  "local",
  "internal",
  "lan",
  "home",
  "corp",
  "mail",
  "test",
  "invalid",
  "example",
  "onion",
  "arpa",
  "alt",
];

function isPublicHostname(host: string): boolean {
  if (host.length > 253) return false;
  const labels = host.split(".");
  if (labels.length < 2 || !/^[a-z]{2,63}$/.test(labels.at(-1)!)) return false;
  if (PRIVATE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)))
    return false;
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

/** Additional approved DNS hosts, comma-separated. Invalid entries fail closed. */
export function imageHosts(configured?: string): string[] {
  const hosts = new Set([DISCORD_IMAGE_HOST]);
  for (const entry of (configured ?? "").split(",")) {
    const host = entry.trim().toLowerCase();
    if (isPublicHostname(host)) hosts.add(host);
  }
  return [...hosts];
}

/** True when an absolute URL carries userinfo: new URL() silently drops an
 * empty username ("https://@host/…"), so the authority must be inspected
 * before parsing. Relative paths may legitimately contain "@". */
export function hasUrlUserinfo(raw: string): boolean {
  const schemeEnd = raw.indexOf("://");
  if (schemeEnd < 0) return false;
  return raw
    .slice(schemeEnd + 3)
    .split("/", 1)[0]!
    .includes("@");
}

export type FeaturedLinkRefusal = "control" | "whitespace" | "backslash" | "userinfo";

/**
 * Why a featured link's raw spelling is deceptive, or null. Lexical only: no
 * DNS lookup, fetch or redirect following. `new URL()` hides these spellings
 * (it strips tab/LF/CR, trims edge controls, reads a backslash as "/", and drops an
 * empty username), so the raw string is inspected before any parsing.
 * Unlike featured images, an explicit port is NOT refused for a link: a port
 * only matters for CSP image origins, and a plain navigation href is not
 * made misleading by one. Userinfo reuses hasUrlUserinfo above (one copy).
 */
export function featuredLinkRefusal(raw: string): FeaturedLinkRefusal | null {
  if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) return "control";
  if (/\s/.test(raw)) return "whitespace";
  if (raw.includes("\\")) return "backslash";
  if (hasUrlUserinfo(raw)) return "userinfo";
  return null;
}

/** True for a plain, non-deceptive absolute http(s) link (any explicit port). */
export function isSafeFeaturedLink(raw: string): boolean {
  if (featuredLinkRefusal(raw) !== null) return false;
  // Noncanonical scheme slashes ("https:///a@b", "https:a@b", "https:/a@b")
  // parse as https with userinfo yet hide it from the raw "://" authority
  // check above, so require the canonical shape and recheck the parsed
  // credentials (the image path already does the second half). The raw checks
  // stay: they catch empty userinfo ("https://@host") that new URL() drops.
  if (!/^https?:\/\/[^/]/i.test(raw)) return false;
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function isFeaturedImageUrl(raw: string, configured?: string): boolean {
  // URL() normalizes IP spellings, credentials and ports; reject ambiguous
  // backslashes/control characters — and any userinfo in the authority —
  // before parsing. No DNS or network fetch.
  if (!/^https:\/\//i.test(raw) || /[\\\u0000- \u007f]/.test(raw)) return false;
  if (hasUrlUserinfo(raw)) return false;
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      isPublicHostname(url.hostname) &&
      imageHosts(configured).includes(url.hostname)
    );
  } catch {
    return false;
  }
}
