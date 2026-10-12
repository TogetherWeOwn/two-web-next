/** Bound sanitized URI log values, not the raw input before parsing. */
export const MAX_CSP_REPORT_URI_LENGTH = 512;

const CSP_TOKENS = new Set(["inline", "eval", "wasm-eval"]);
const DISCORD_ID_RUN = /(?<!\d)\d{17,20}(?!\d)/;

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function redactPathShape(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => (DISCORD_ID_RUN.test(decodeSegment(segment)) ? ":id" : segment))
    .join("/");
}

/**
 * Keep only network origin/path or exact CSP tokens. Relative, malformed and
 * opaque URLs collapse to null: their contents may themselves be credentials.
 * A Discord-ID-sized digit run in a path segment becomes `:id`; other path
 * data stays diagnostic and is not redacted.
 */
export function redactCspReportUri(value: string | null): string | null {
  if (value === null) return null;
  if (CSP_TOKENS.has(value)) return value;
  // Require an explicit network authority; do not repair arbitrary strings
  // (e.g. https:token) into URLs or resolve them against a made-up base.
  if (!/^(?:https?|wss?):\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    // Reconstruct instead of logging href: userinfo, search and hash never
    // enter the result, even when very long credentials precede the hostname.
    return `${url.origin}${redactPathShape(url.pathname)}`.slice(0, MAX_CSP_REPORT_URI_LENGTH);
  } catch {
    return null;
  }
}
