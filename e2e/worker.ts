import worker from "../src/worker";
import type { JobsEnv } from "../src/env";
import { STAGING_APP_URL } from "../src/qa";

const localOrigin = "https://localhost:8787";
const outbound: string[] = [];
const forbidden: string[] = [];

// Test entrypoint only. Production URLs and gates are unchanged; no upstream
// fetch is ever forwarded. OAuth deliberately exercises this Discord stub.
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const call = `${request.method} ${url.origin}${url.pathname}`;
  outbound.push(call);
  if (url.origin === "https://discord.com") {
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
  }
  forbidden.push(call);
  throw new Error(`E2E blocked unmocked outbound fetch: ${call}`);
};

export default {
  async fetch(request: Request, env: JobsEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.origin !== localOrigin) return new Response("Local CI only", { status: 403 });
    if (url.pathname === "/__e2e/network") return Response.json({ outbound, forbidden });
    if (url.pathname === "/__e2e/redirect-canary") {
      return Response.redirect("https://discord.com/__e2e/egress-canary", 302);
    }
    const db = new URL(env.DATABASE_URL ?? "");
    if (
      db.hostname !== "127.0.0.1" ||
      db.pathname !== "/two_web_next" ||
      db.username !== "agent_test"
    ) {
      throw new Error("E2E database must be the disposable CI service");
    }

    // The QA gate requires the staging APP_URL and writes validate Origin.
    // Translate only the local HTTPS transport into that virtual origin. The
    // browser still talks exclusively to localhost; Secure __Host cookies stay
    // real cookies, and arbitrary/foreign Origin headers are not translated.
    const headers = new Headers(request.headers);
    if (headers.get("origin") === localOrigin) headers.set("origin", STAGING_APP_URL);
    const virtual = new URL(url.pathname + url.search, STAGING_APP_URL);
    // TrustHosts (src/trust-hosts.ts, main #31) requires the Host header and
    // the request URL to share the environment's APP_URL hostname. The copied
    // browser Host (localhost:8787) would refuse every virtual request —
    // including the Playwright webServer readiness poll — before routing. This
    // header never leaves the local process: the mapped request goes straight
    // to worker.fetch in-process.
    headers.set("host", virtual.host);
    const mapped = new Request(virtual, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });
    const response = await worker.fetch(
      mapped,
      {
        ...env,
        DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
      } as JobsEnv,
      ctx,
    );
    // Complete the virtual-origin translation on the way back for the two
    // routes whose browser islands validate it: the past-events island
    // (assets/islands/past-events.js) and the events-calendar island
    // (assets/islands/events-calendar.js) require the fetched page's
    // canonical and og:url on window.location's origin. Deployed, APP_URL is
    // that origin (TrustHosts refuses any other Host), so the checks hold;
    // here the browser origin is localhost while APP_URL stays the staging
    // URL above, so every island page turn would be rejected as an invalid
    // page. Translating the island HTML's absolute staging URLs back to the
    // local origin restores the deployed invariant for the browser. Other
    // responses keep pinning the staging APP_URL, and the app worker's own
    // bytes (and its anonymous cache) are untouched.
    if (request.method !== "GET") return response;
    if (url.pathname !== "/events/past" && url.pathname !== "/events") return response;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return response;
    const body = (await response.text()).replaceAll(STAGING_APP_URL, localOrigin);
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    responseHeaders.delete("etag");
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  },
};
