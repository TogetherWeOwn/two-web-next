import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { request as httpRequest } from "node:http";
import { convertV4MiniflareOptions, Miniflare, Response as WorkerResponse, type Request as WorkerRequest } from "miniflare";
import { QA_HEADER, STAGING_APP_URL } from "../src/qa";

// Workers runtime parity: no remote binding, deployment secrets or live HTTP.
// Discord is intercepted; unmatched network access is forbidden.
describe("W15 auth/join in Miniflare", () => {
  let mf: Miniflare;
  const calls: { path: string; method: string; auth: string | null; body: string }[] = [];
  const unexpected: string[] = [];
  // The /join widget health probe rides waitUntil, so it can land after the
  // test that caused it; it is kept apart from the auth-path ledger.
  const widgetProbes: { method: string; auth: string | null; cookie: string | null }[] = [];
  let joinStatus: 201 | 204 = 201;
  // TOG-10355: when set, the token endpoint answers with this instead of the
  // success body — the workerd fixture for expired-grant / outage responses.
  let tokenFailure: (() => WorkerResponse) | null = null;
  const cookie = (res: { headers: { getSetCookie(): string[] } }) =>
    res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  // Send the configured Host on the local HTTP socket. Miniflare's fetch/RPC
  // bridge restores the URL but substitutes its loopback transport Host.
  const request = async (path: string, init: RequestInit = {}) => {
    const input = new Request(`${STAGING_APP_URL}${path}`, init);
    if (!input.headers.has("host")) input.headers.set("host", new URL(STAGING_APP_URL).host);
    const body = input.body ? Buffer.from(await input.arrayBuffer()) : undefined;
    const localUrl = new URL(path, await mf.ready);
    return new Promise<WorkerResponse>((resolve, reject) => {
      const req = httpRequest(localUrl.toString(), { method: input.method, headers: Object.fromEntries(input.headers) }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const headers: [string, string][] = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) headers.push([res.rawHeaders[i]!, res.rawHeaders[i + 1]!]);
          resolve(new WorkerResponse(chunks.length ? Buffer.concat(chunks) : null, { status: res.statusCode!, headers }));
        });
      });
      req.on("error", reject);
      req.end(body);
    });
  };

  beforeAll(async () => {
    const bundle = await build({
      entryPoints: ["test/fixtures/auth-worker.ts"], bundle: true, write: false, format: "esm",
      platform: "browser", target: "es2022", conditions: ["workerd", "worker", "browser"],
      external: ["node:*", "cloudflare:*"],
    });
    mf = new Miniflare(convertV4MiniflareOptions({
      modules: true, script: bundle.outputFiles![0]!.text,
      compatibilityDate: "2026-09-29", compatibilityFlags: ["nodejs_compat"],
      outboundService: async (request: WorkerRequest) => {
        const url = new URL(request.url);
        if (url.origin === "https://discord.com" && url.pathname === "/api/v10/guilds/326474832151838730/widget.json") {
          widgetProbes.push({ method: request.method, auth: request.headers.get("authorization"), cookie: request.headers.get("cookie") });
          return WorkerResponse.json({ id: "326474832151838730", presence_count: 3 });
        }
        const call = { path: url.pathname, method: request.method, auth: request.headers.get("authorization"), body: await request.text() };
        calls.push(call);
        if (url.origin === "https://discord.com") {
          if (call.path === "/api/v10/oauth2/token" && call.method === "POST") {
            if (tokenFailure) return tokenFailure();
            return WorkerResponse.json({ access_token: "test-member-token" });
          }
          if (call.path === "/api/v10/users/@me" && call.auth === "Bearer test-member-token") {
            return WorkerResponse.json({ id: "42", username: "test-handle", global_name: "Worker Member", avatar: null });
          }
          if (call.path === "/api/v10/guilds/326474832151838730/members/42" && call.method === "PUT" &&
              call.auth === "Bot test-bot-token" && call.body === JSON.stringify({ access_token: "test-member-token" })) {
            return new WorkerResponse(null, { status: joinStatus });
          }
        }
        unexpected.push(request.url);
        throw new Error("Unmocked network request forbidden by W15 fixture");
      },
      bindings: {
        APP_URL: STAGING_APP_URL, DISCORD_CLIENT_ID: "test-client", DISCORD_CLIENT_SECRET: "test-client-secret",
        DISCORD_GUILD_ID: "326474832151838730", DISCORD_BOT_TOKEN: "test-bot-token",
        DISCORD_INVITE_URL: "https://discord.gg/test-invite", DISCORD_MODERATOR_ROLE_IDS: "",
        SESSION_SECRET: "test-session-signing-key-at-least-32-bytes", QA_AUTH_TOKEN: "test-only-qa-token",
      },
    }));
    await mf.ready;
  }, 30_000);
  beforeEach(() => { calls.length = 0; unexpected.length = 0; joinStatus = 201; tokenFailure = null; });
  afterEach(() => expect(unexpected).toEqual([]));
  afterAll(async () => { await mf?.dispose(); });

  const expectedPaths = [
    "/api/v10/oauth2/token", "/api/v10/users/@me", "/api/v10/guilds/326474832151838730/members/42",
  ];

  // Malformed authorities are covered by the raw-app suite: workerd rejects
  // those before dispatch. These valid but untrusted hosts reach the guard.
  it.each(["foreign.invalid", "localhost"])("refuses untrusted HTTP Host %s before auth in workerd", async (host) => {
    const res = await request("/auth/discord", { headers: { host } });
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).not.toContain(host);
    expect(calls).toHaveLength(0);
  });

  it("completes Discord login, rotates on the next view, logs out and rejects cookie replay", async () => {
    const start = await request("/auth/discord");
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const login = await request(`/auth/discord/callback?code=test-code&state=${state}`, { headers: { cookie: cookie(start) } });
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/?n=joined");
    expect(login.headers.getSetCookie().join("\n")).toContain("Max-Age=2592000");
    const view = await request("/", { headers: { cookie: cookie(login) } });
    expect(await view.text()).toContain("Worker Member");
    expect(cookie(view)).not.toBe(cookie(login));
    const replay = await request("/", { headers: { cookie: cookie(login) } });
    expect(await replay.text()).toContain("Sign in with Discord");
    const out = await request("/logout", { method: "POST", headers: { cookie: cookie(view), origin: STAGING_APP_URL } });
    expect(out.status).toBe(303);
    expect(out.headers.getSetCookie().join("\n")).toContain("Max-Age=0");
    expect(await (await request("/", { headers: { cookie: cookie(view) } })).text()).toContain("Sign in with Discord");
    expect(calls.map((c) => c.path)).toEqual(expectedPaths);
  });

  it("completes the one-click already-member join and renders the banner on the actual landing", async () => {
    joinStatus = 204;
    // Review CHANGES (45bc0ea): assert the callback's ACTUAL redirect
    // destination (/join is DB-free, so it renders in this fixture), not a
    // different page. First render shows the already-member banner with the
    // real reinvite action, then it's gone.
    const start = await request("/join/discord?source=web-homepage&next=%2Fjoin");
    const url = new URL(start.headers.get("location")!);
    expect(url.searchParams.get("redirect_uri")).toBe(`${STAGING_APP_URL}/join/callback`);
    const result = await request(`/join/callback?code=test-code&state=${url.searchParams.get("state")}`, { headers: { cookie: cookie(start) } });
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toBe("/join");
    expect(result.headers.getSetCookie().join("\n")).toContain("__Host-two_join_next=; Max-Age=0");
    const view = await request("/join", { headers: { cookie: cookie(result) } });
    const html = await view.text();
    expect(html).toContain('data-testid="join-result"');
    expect(html).toContain('data-testid="reinvite-link"');
    const again = await request("/join", { headers: { cookie: cookie(view) } });
    expect(await again.text()).not.toContain('data-testid="join-result"');
    expect(calls.map((c) => c.path)).toEqual(expectedPaths);
  });

  it("probes the public widget JSON off the /join response path as a bare GET", async () => {
    const res = await request("/join", { headers: { cookie: "__Host-two_session=member-cookie" } });
    expect(res.status).toBe(200);
    // One probe per verdict window per isolate: an earlier /join may own it.
    await vi.waitFor(() => expect(widgetProbes.length).toBeGreaterThan(0));
    for (const probe of widgetProbes) expect(probe).toEqual({ method: "GET", auth: null, cookie: null });
    expect(calls).toEqual([]);
  });

  it("carries an explicit ?next= through ordinary login and clears the journey cookies", async () => {
    const start = await request("/auth/discord?next=%2Fe%2Fsunday-squad-01");
    expect(start.headers.getSetCookie().join("\n")).toContain("__Host-two_login_next=");
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const login = await request(`/auth/discord/callback?code=test-code&state=${state}`, { headers: { cookie: cookie(start) } });
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/e/sunday-squad-01");
    const cleared = login.headers.getSetCookie().join("\n");
    expect(cleared).toContain("__Host-two_login_next=; Max-Age=0");
    expect(cleared).toContain("__Host-two_login_intended=; Max-Age=0");
    expect(calls.map((c) => c.path)).toEqual(expectedPaths);
  });

  it("returns a bounced guest to the page they asked for (legacy url.intended)", async () => {
    const bounce = await request("/profile");
    expect(bounce.status).toBe(302);
    expect(bounce.headers.get("location")).toBe("/auth/discord");
    expect(bounce.headers.getSetCookie().join("\n")).toContain("__Host-two_login_intended=");
    const start = await request("/auth/discord", { headers: { cookie: cookie(bounce) } });
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const login = await request(`/auth/discord/callback?code=test-code&state=${state}`, {
      headers: { cookie: `${cookie(bounce)}; ${cookie(start)}` },
    });
    expect(login.headers.get("location")).toBe("/profile");
    expect(calls.map((c) => c.path)).toEqual(expectedPaths);
  });

  it("rejects a signed-state mismatch without a Discord exchange", async () => {
    const start = await request("/auth/discord?next=%2Fprofile");
    const res = await request("/auth/discord/callback?code=test-code&state=forged", { headers: { cookie: cookie(start) } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    const cleared = res.headers.getSetCookie().join("\n");
    expect(cleared).not.toContain("__Host-two_session=");
    // The failure path still consumes the journey — a stale next never leaks
    // into a later sign-in.
    expect(cleared).toContain("__Host-two_login_next=; Max-Age=0");
    expect(cleared).toContain("__Host-two_login_intended=; Max-Age=0");
    expect(calls).toHaveLength(0);
  });

  // TOG-10355 worker-boundary fixtures: the classification contract holds in
  // workerd, not only in the raw-app suite. The provider body carries a
  // synthetic secret; it must never reach any response surface.
  const boundarySecret = "***synthetic-boundary-5e2c***";
  const grantAnswer = (status: number) =>
    () => new WorkerResponse(
      JSON.stringify({ error: "invalid_grant", error_description: `refresh ${boundarySecret} revoked` }),
      { status, headers: { "content-type": "application/json" } },
    );

  it("expired grant in workerd: 400 invalid_grant renders the immediate-retry recovery", async () => {
    tokenFailure = grantAnswer(400);
    const start = await request("/join/discord");
    const res = await request(`/join/callback?code=test-code&state=${new URL(start.headers.get("location")!).searchParams.get("state")}`,
      { headers: { cookie: cookie(start) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Join approval expired");
    expect(html).toContain('data-testid="recovery-retry"');
    expect(html).not.toContain("Discord is unreachable");
    expect(html).not.toContain(boundarySecret);
    expect(calls.map((c) => c.path)).toEqual(["/api/v10/oauth2/token"]);
  });

  it("outage in workerd: 503 whose body says invalid_grant still answers the discord-down 503", async () => {
    tokenFailure = grantAnswer(503);
    const start = await request("/join/discord");
    const res = await request(`/join/callback?code=test-code&state=${new URL(start.headers.get("location")!).searchParams.get("state")}`,
      { headers: { cookie: cookie(start) } });
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("Discord is unreachable");
    expect(html).not.toContain("approval expired");
    expect(html).not.toContain(boundarySecret);
    expect(calls.map((c) => c.path)).toEqual(["/api/v10/oauth2/token"]);
  });

  it("expired grant on login in workerd maps to the generic banner; outage to unavailable", async () => {
    tokenFailure = grantAnswer(400);
    const start = await request("/auth/discord");
    const expired = await request(`/auth/discord/callback?code=test-code&state=${new URL(start.headers.get("location")!).searchParams.get("state")}`,
      { headers: { cookie: cookie(start) } });
    expect(expired.headers.get("location")).toBe("/?n=signin_failed");
    expect(await (await request("/?n=signin_failed")).text()).not.toContain(boundarySecret);

    tokenFailure = grantAnswer(503);
    const start2 = await request("/auth/discord");
    const outage = await request(`/auth/discord/callback?code=test-code&state=${new URL(start2.headers.get("location")!).searchParams.get("state")}`,
      { headers: { cookie: cookie(start2) } });
    expect(outage.headers.get("location")).toBe("/?n=signin_unavailable");
    const home = await request("/?n=signin_unavailable");
    const html = await home.text();
    expect(html).toContain("This is on Discord, not you");
    expect(html).not.toContain(boundarySecret);
  });

  it("renders consent-denial recovery with no upstream error echo", async () => {
    const res = await request("/join/callback?error=access_denied&error_description=never-echo");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Join cancelled");
    expect(html).not.toContain("never-echo");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("uses POST-only QA fixtures and byte-identical failure responses in the runtime", async () => {
    const headers = { origin: STAGING_APP_URL, [QA_HEADER]: "test-only-qa-token" };
    const get = await request("/auth/qa/qa-member", { headers });
    expect(get.status).toBe(404);
    expect(get.headers.getSetCookie()).toHaveLength(0);
    const bad = await request("/auth/qa/qa-member", { method: "POST", headers: { origin: STAGING_APP_URL } });
    const unknown = await request("/auth/qa/unknown", { method: "POST", headers });
    expect(bad.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await bad.text()).toBe(await unknown.text());
    const login = await request("/auth/qa/qa-moderator", { method: "POST", headers });
    expect(login.status).toBe(204);
    expect(await (await request("/", { headers: { cookie: cookie(login) } })).text()).toContain("QA Moderator");
  });
});
