/** Bound sanitized URI log values, not the raw input before parsing. */
export const MAX_CSP_REPORT_URI_LENGTH = 512;

const CSP_TOKENS = new Set(["inline", "eval", "wasm-eval"]);

/**
 * Keep only network origin/path or exact CSP tokens. Relative, malformed and
 * opaque URLs collapse to null: their contents may themselves be credentials.
 * Paths remain diagnostic data; this does not redact secrets embedded in paths.
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
    return `${url.origin}${url.pathname}`.slice(0, MAX_CSP_REPORT_URI_LENGTH);
  } catch {
    return null;
  }
}
