import worker from "../src/worker";
import { discordFixtureResponse } from "./discord-stub";
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
  const fixture = await discordFixtureResponse(request);
  if (fixture) return fixture;
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
    // The served wire now gzips HTML at the outermost seam; the translation
    // needs the document bytes, so decode before the URL rewrite. The
    // response headers below already drop the content-encoding marker, so
    // the rewritten body always answers identity.
    const raw = response.body;
    const document =
      raw && response.headers.get("content-encoding") === "gzip"
        ? await new Response(raw.pipeThrough(new DecompressionStream("gzip"))).text()
        : await response.text();
    const body = document.replaceAll(STAGING_APP_URL, localOrigin);
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
