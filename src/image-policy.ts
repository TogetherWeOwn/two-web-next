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
