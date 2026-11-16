export const UNSAFE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

// Exact method + path exemptions, never whole prefixes or cookie presence.
// These endpoints authenticate or validate their transport independently, or
// accept bounded, non-persistent CSP reports without a reliable Origin.
export const SAME_ORIGIN_EXEMPTIONS = [
  { method: "POST", path: "/api/agent-events" },
  { method: "POST", path: "/csp-reports" },
  { method: "POST", path: "/mcp" },
] as const;

export function isSameOriginAllowed(input: {
  method: string;
  path: string;
  requestUrl: string;
  appUrl: string;
  origin: string | undefined;
  fetchSite: string | undefined;
}): boolean {
  const method = input.method.toUpperCase();
  if (
    !UNSAFE_METHODS.some((unsafe) => unsafe === method) ||
    SAME_ORIGIN_EXEMPTIONS.some(
      ({ method: exempt, path }) => exempt === method && path === input.path,
    )
  ) {
    return true;
  }

  let expected: string | undefined;
  try {
    const url = new URL(input.appUrl);
    if (url.protocol === "https:" || url.protocol === "http:") expected = url.origin;
  } catch {
    /* Invalid configuration fails closed, never trusts the request host. */
  }

  // Explicit Origin takes precedence; Fetch Metadata is relative to the request host.
  return (
    expected !== undefined &&
    (input.origin !== undefined
      ? input.origin === expected
      : input.fetchSite === "same-origin" && new URL(input.requestUrl).origin === expected)
  );
}
