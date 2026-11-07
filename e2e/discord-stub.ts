// Shared Discord fixture for local test entrypoints (e2e/worker.ts and the
// route-parity harness in ci/parity/harness.ts). Answers only the fixed
// Discord calls the OAuth and join journeys make; returns undefined for every
// other request so each caller decides how to refuse it.
export async function discordFixtureResponse(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.origin !== "https://discord.com") return undefined;
  if (request.method === "POST" && url.pathname === "/api/v10/oauth2/token") {
    // Blocked-join arm for the offline recovery spec: one fixed,
    // non-secret code mints a marker token. Every other code keeps the
    // success token, so the existing journeys are unaffected.
    let code = "";
    try {
      code = new URLSearchParams(await request.clone().text()).get("code") ?? "";
    } catch {
      code = "";
    }
    if (code === "e2e-blocked-code") return Response.json({ access_token: "e2e-blocked-token" });
    if (code === "e2e-outage-code") return new Response("fixture outage", { status: 500 });
    return Response.json({ access_token: "e2e-member-token" });
  }
  if (request.method === "GET" && url.pathname === "/api/v10/users/@me") {
    // fetchUser rejects a missing global_name (TOG-206 hardening); mirror
    // the auth-worker fixture shape exactly.
    return Response.json({
      id: "900000000000001398",
      username: "E2E Discord Member",
      global_name: "E2E Discord Member",
      avatar: null,
    });
  }
  if (
    request.method === "GET" &&
    url.pathname === "/api/v10/guilds/326474832151838730/widget.json"
  ) {
    // Join-preview health probe: the /join leaf reads the verdict without
    // awaiting it, so the click-to-load link renders on a cold isolate and
    // the background re-probe must not count as forbidden upstream traffic.
    return Response.json({ id: "326474832151838730" });
  }
  if (url.pathname === "/api/v10/guilds/326474832151838730/members/900000000000001398") {
    if (request.method === "PUT") {
      // The blocked-join marker token is refused like a real bot refusal
      // (banned user / missing permission): the callback must degrade to
      // the blocked recovery page instead of signing in.
      let blocked = false;
      try {
        const body = (await request.clone().json()) as { access_token?: unknown };
        blocked = body.access_token === "e2e-blocked-token";
      } catch {
        blocked = false;
      }
      if (blocked) return new Response(null, { status: 403 });
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET") return Response.json({ roles: [] });
  }
  return undefined;
}
