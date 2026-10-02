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
      return Response.json({ access_token: "e2e-member-token" });
    }
    if (request.method === "GET" && url.pathname === "/api/v10/users/@me") {
      // fetchUser rejects a missing global_name (TOG-206 hardening); mirror
      // the auth-worker fixture shape exactly.
      return Response.json({ id: "900000000000001398", username: "E2E Discord Member", global_name: "E2E Discord Member", avatar: null });
    }
    if (url.pathname === "/api/v10/guilds/326474832151838730/members/900000000000001398") {
      if (request.method === "PUT") return new Response(null, { status: 204 });
      if (request.method === "GET") return Response.json({ roles: [] });
    }
  }
  forbidden.push(call);
  throw new Error(`E2E blocked unmocked outbound fetch: ${call}`);
};

export default {
  fetch(request: Request, env: JobsEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.origin !== localOrigin) return new Response("Local CI only", { status: 403 });
    if (url.pathname === "/__e2e/network") return Response.json({ outbound, forbidden });
    if (url.pathname === "/__e2e/redirect-canary") {
      return Response.redirect("https://discord.com/__e2e/egress-canary", 302);
    }
    const db = new URL(env.DATABASE_URL ?? "");
    if (db.hostname !== "127.0.0.1" || db.pathname !== "/two_web_next" || db.username !== "agent_test") {
      throw new Error("E2E database must be the disposable CI service");
    }

    // The QA gate requires the staging APP_URL and writes validate Origin.
    // Translate only the local HTTPS transport into that virtual origin. The
    // browser still talks exclusively to localhost; Secure __Host cookies stay
    // real cookies, and arbitrary/foreign Origin headers are not translated.
    const headers = new Headers(request.headers);
    if (headers.get("origin") === localOrigin) headers.set("origin", STAGING_APP_URL);
    const virtual = new URL(url.pathname + url.search, STAGING_APP_URL);
    const mapped = new Request(virtual, { method: request.method, headers, body: request.body, redirect: "manual" });
    return worker.fetch(mapped, {
      ...env,
      DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
    } as JobsEnv, ctx);
  },
};
