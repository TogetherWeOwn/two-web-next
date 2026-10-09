import { stripTrailingSlash } from "./seo";

// The only reporting channel SECURITY.md names: GitHub private vulnerability reporting.
const CONTACT = "https://github.com/TogetherWeOwn/two-web-next/security/advisories/new";
const POLICY = "https://github.com/TogetherWeOwn/two-web-next/blob/main/SECURITY.md";
// RFC 9116 §2.5.5: less than a year ahead. Rolled from the request clock, never a fixed date.
const EXPIRES_IN_MS = 364 * 24 * 60 * 60 * 1000;

export function buildSecurityTxt(appUrl: string, now: Date): string {
  const expires = new Date(now.getTime() + EXPIRES_IN_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  return [
    `Contact: ${CONTACT}`,
    `Expires: ${expires}`,
    "Preferred-Languages: en",
    `Canonical: ${stripTrailingSlash(appUrl)}/.well-known/security.txt`,
    `Policy: ${POLICY}`,
    "",
  ].join("\n");
}
