// Error recovery only admits the GET pages owned by these boundaries, never
// an action suffix or a URL origin. Existing fixed exits handle unusable state.
export function adminReadRetryHref(
  url: unknown,
  boundary: "admin" | "join-attempts",
): string | null {
  try {
    if (!(url instanceof URL)) return null;
    const { pathname, search } = url;
    if (typeof pathname !== "string" || typeof search !== "string") return null;
    const readPath =
      boundary === "join-attempts"
        ? /^\/admin\/join-attempts(?:\/[1-9][0-9]*)?$/
        : /^\/admin(?:\/(?:events(?:\/[a-zA-Z0-9_-]+)?|featured(?:\/[1-9][0-9]*)?|activity-log))?$/;
    if (
      !readPath.test(pathname) ||
      /\/(?:delete|destroy|logout|redispatch)(?:\/|$)/i.test(pathname)
    )
      return null;
    const href = pathname + search;
    if ((search !== "" && !search.startsWith("?")) || /[\\\u0000- \u007f#]/.test(href)) return null;
    // Preserve the encoded query (including duplicates), but never the fragment.
    return href;
  } catch {
    // Even a malformed URL/getter must leave the error boundary recoverable.
    return null;
  }
}
