import { stripTrailingSlash } from "./seo";

// The only reporting channel SECURITY.md names: GitHub private vulnerability reporting.
const CONTACT = "https://github.com/TogetherWeOwn/two-web-next/security/advisories/new";
const POLICY = "https://github.com/TogetherWeOwn/two-web-next/blob/main/SECURITY.md";
// Pinned review date (CISO decision 2026-10-10, option B): RFC 9116 §5.3 warns
// stale contact data misroutes reports, so Expires is a fixed date reviewed
// before it lapses, not a rolling clock. Must stay in RFC 3339 UTC.
export const SECURITY_TXT_EXPIRES = "2027-10-01T00:00:00Z";

export function buildSecurityTxt(appUrl: string): string {
  const base = stripTrailingSlash(appUrl);
  return [
    `Contact: ${CONTACT}`,
    `Expires: ${SECURITY_TXT_EXPIRES}`,
    "Preferred-Languages: en",
    // RFC 9116 §2.5.2: a web Canonical must be https, so an http-only origin omits it.
    ...(base.startsWith("https://") ? [`Canonical: ${base}/.well-known/security.txt`] : []),
    `Policy: ${POLICY}`,
    "",
  ].join("\n");
}
