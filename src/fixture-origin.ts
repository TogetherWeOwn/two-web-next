// Shared fail-closed eligibility for generated, loopback-only fixture Workers.
export function fixtureOrigin(appUrl: string | undefined): string | undefined {
  try {
    const app = new URL(appUrl ?? "");
    if (
      app.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(app.hostname) ||
      app.username ||
      app.password ||
      app.pathname !== "/" ||
      app.search ||
      app.hash ||
      (appUrl !== app.origin && appUrl !== `${app.origin}/`)
    )
      return undefined;
    return app.origin;
  } catch {
    return undefined;
  }
}

export function fixtureRequest(request: Request, appUrl: string | undefined): boolean {
  const origin = fixtureOrigin(appUrl);
  if (!origin) return false;
  const url = new URL(request.url);
  // Neither Host nor forwarding headers supply the origin. A request to a
  // deployed URL cannot opt in by presenting a local Host, cookie or query.
  return (
    url.origin === origin &&
    (!request.headers.has("host") || request.headers.get("host") === url.host)
  );
}
