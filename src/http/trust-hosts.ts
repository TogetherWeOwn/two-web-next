/** Parse a single host authority; never truncate a malformed or joined value. */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const value = raw.toLowerCase();
  const match = value.startsWith("[")
    ? /^\[([0-9a-f:.]+)\](?::([0-9]+))?$/.exec(value)
    : /^([a-z0-9.-]+)(?::([0-9]+))?$/.exec(value);
  if (!match) return null;
  if (match[2] !== undefined && Number(match[2]) > 65535) return null;
  if (value.startsWith("[")) {
    try {
      // URL validates and canonicalizes IPv6; strip brackets on both sides
      // of the comparison (URL.hostname retains them).
      return new URL(`http://${value}`).hostname.slice(1, -1);
    } catch {
      return null;
    }
  }
  const hostname = match[1];
  if (!hostname) return null;
  if (
    hostname.length > 253 ||
    hostname.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return null;
  return hostname;
}

/** The trusted hostname for this environment; null when misconfigured. */
export function trustedHost(appUrl: string): string | null {
  try {
    const url = new URL(appUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return normalizeHost(url.host);
  } catch {
    return null;
  }
}

/** Exact match only, with at least one valid authority and no untrusted signal. */
export function isTrustedHost(appUrl: string, hosts: Array<string | null | undefined>): boolean {
  const trusted = trustedHost(appUrl);
  if (trusted === null) return false;
  let seen = false;
  for (const host of hosts) {
    if (host == null) continue;
    const normalized = normalizeHost(host);
    if (normalized === null || normalized !== trusted) return false;
    seen = true;
  }
  return seen;
}
