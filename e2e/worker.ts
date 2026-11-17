import worker from "../src/worker";
import { discordFixtureResponse } from "./discord-stub";
import type { JobsEnv } from "../src/env";
import { STAGING_APP_URL } from "../src/qa";
import { rewriteFixtureHtml } from "./rewrite-fixture-html";

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

// Same-origin fixtures for e2e/proxy-policy.spec.ts, served by the real local
// Worker so the browser measures the configured https://localhost:8787 policy.
// The permissive CSP keeps a CSP block from standing in for a proxy refusal.
// Redirects are limited to loopback or reserved .invalid targets.
const NEGATIVE_CSP = "default-src * data: blob: 'unsafe-inline'; worker-src * blob:";
const WORKER_SCRIPT = `postMessage({ phase: "started" });
self.onmessage = async (event) => {
  try {
    await fetch(event.data, { mode: "no-cors" });
    postMessage({ phase: "result", ok: true });
  } catch (error) {
    postMessage({ phase: "result", ok: false, name: error.name });
  }
};`;

function proxyPolicyFixture(url: URL): Response | null {
  const headers = { "content-security-policy": NEGATIVE_CSP, "cache-control": "no-store" };
  if (url.pathname === "/__e2e/neg/page") {
    return new Response("<!doctype html><title>neg</title><body></body>", {
      headers: { ...headers, "content-type": "text/html" },
    });
  }
  if (url.pathname === "/__e2e/neg/worker.js") {
    return new Response(WORKER_SCRIPT, {
      headers: { ...headers, "content-type": "text/javascript" },
    });
  }
  if (url.pathname !== "/__e2e/neg/redirect") return null;
  let target: URL;
  try {
    target = new URL(url.searchParams.get("to") ?? "");
  } catch {
    return new Response("Bad target", { status: 400 });
  }
  const host = target.hostname;
  const allowed =
    host === "127.0.0.1" || host === "[::1]" || host === "localhost" || host.endsWith(".invalid");
  if (!allowed) return new Response("Target refused", { status: 400 });
  return new Response(null, { status: 302, headers: { ...headers, location: target.href } });
}

export default {
  async fetch(request: Request, env: JobsEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.origin !== localOrigin) return new Response("Local CI only", { status: 403 });
    if (url.pathname === "/__e2e/network") return Response.json({ outbound, forbidden });
    if (url.pathname === "/__e2e/redirect-canary") {
      return Response.redirect("https://discord.com/__e2e/egress-canary", 302);
    }
    const negative = proxyPolicyFixture(url);
    if (negative) return negative;
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
    return rewriteFixtureHtml(response, STAGING_APP_URL, localOrigin);
  },
};
