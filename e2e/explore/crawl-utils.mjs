// Pure helpers for the staging explorer (e2e/explore/explore.spec.ts).
import { createHash } from "node:crypto";
import { STAGING_ORIGIN } from "../../ci/operator-constants.mjs";

export const EXPLORE_ORIGIN = STAGING_ORIGIN;

// Paths the explorer never follows: they start sign-in or Discord flows, or are
// non-HTML feeds the explorer cannot judge visually.
const SKIP_PREFIXES = ["/auth/", "/join/", "/discord", "/login", "/profile", "/admin", "/cdn-cgi/"];
const SKIP_SUFFIXES = [".ics", ".rss", ".json", ".xml", ".txt"];

/**
 * Normalizes a link found on `fromUrl` to a same-origin path worth crawling, or
 * null. Query strings are kept only for pagination (`?page=N`, N <= 3) so the
 * crawl stays bounded; fragments are dropped.
 */
export function crawlablePath(href, fromUrl, origin = EXPLORE_ORIGIN) {
  let url;
  try {
    url = new URL(href, fromUrl);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (
    SKIP_PREFIXES.some((p) => url.pathname === p.replace(/\/$/, "") || url.pathname.startsWith(p))
  )
    return null;
  if (SKIP_SUFFIXES.some((s) => url.pathname.endsWith(s))) return null;
  const page = url.searchParams.get("page");
  const keepPage =
    page !== null && /^[1-3]$/.test(page) && [...url.searchParams.keys()].length === 1;
  return url.pathname + (keepPage ? `?page=${page}` : "");
}

/**
 * True when a crawled page landed off staging after a redirect (for example
 * /discord 302s to a Discord invite). Only http(s) landings count: a failed
 * navigation leaves page.url() at chrome-error://chromewebdata/ or
 * about:blank, which must fall through to the status branch (status 0) so the
 * QA routine still files a card.
 */
export function landedOffOrigin(pageUrl, origin = EXPLORE_ORIGIN) {
  let url;
  try {
    url = new URL(pageUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.origin !== origin;
}

/** Stable id for a finding, so the QA routine can dedupe across days. */
export function findingId({ kind, path, viewport, detail }) {
  return createHash("sha256")
    .update(`${kind}\n${path}\n${viewport}\n${String(detail).replace(/\d{4,}/g, "N")}`)
    .digest("hex")
    .slice(0, 16);
}

export function severityFor(kind, detail = "") {
  if (kind === "status" && /^5\d\d/.test(String(detail))) return "high";
  if (kind === "pageerror") return "high";
  if (kind === "axe" && /critical/.test(String(detail))) return "high";
  if (["status", "subresource", "broken-image", "write-attempt", "overflow", "axe"].includes(kind))
    return "medium";
  return "low";
}

/** A Markdown table cell: backslash, pipe and backtick escaped, newlines flattened, length capped. */
export function mdCell(value, max = 120) {
  return String(value)
    .slice(0, max)
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`");
}
