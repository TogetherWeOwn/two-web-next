import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare, Response as WorkerResponse, type Request as WorkerRequest } from "miniflare";
import { QA_HEADER, STAGING_APP_URL } from "../src/qa";

// Workers runtime parity: no remote binding, deployment secrets or live HTTP.
// Discord is intercepted; unmatched network access is forbidden.
describe("W15 auth/join in Miniflare", () => {
  let mf: Miniflare;
  const calls: { path: string; method: string; auth: string | null; body: string }[] = [];
  const unexpected: string[] = [];
  let joinStatus: 201 | 204 = 201;
  const cookie = (res: { headers: { getSetCookie(): string[] } }) =>
    res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const request = (path: string, init: Parameters<Miniflare["dispatchFetch"]>[1] = {}) =>
    mf.dispatchFetch(`${STAGING_APP_URL}${path}`, { ...init, redirect: "manual" });

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
        const call = { path: url.pathname, method: request.method, auth: request.headers.get("authorization"), body: await request.text() };
        calls.push(call);
        if (url.origin === "https://discord.com") {
          if (call.path === "/api/v10/oauth2/token" && call.method === "POST") {
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
  beforeEach(() => { calls.length = 0; unexpected.length = 0; joinStatus = 201; });
  afterEach(() => expect(unexpected).toEqual([]));
  afterAll(async () => { await mf?.dispose(); });

  const expectedPaths = [
    "/api/v10/oauth2/token", "/api/v10/users/@me", "/api/v10/guilds/326474832151838730/members/42",
  ];

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

  it("completes the one-click already-member join and honors the signed return cookie", async () => {
    joinStatus = 204;
    const start = await request("/join/discord?source=web-homepage&next=%2Fevents");
    const url = new URL(start.headers.get("location")!);
    expect(url.searchParams.get("redirect_uri")).toBe(`${STAGING_APP_URL}/join/callback`);
    const result = await request(`/join/callback?code=test-code&state=${url.searchParams.get("state")}`, { headers: { cookie: cookie(start) } });
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toBe("/events");
    expect(result.headers.getSetCookie().join("\n")).toContain("__Host-two_join_next=; Max-Age=0");
    // The one-shot confirmation (legacy join_result): first render shows the
    // already-member banner with the real reinvite action, then it's gone.
    const view = await request("/", { headers: { cookie: cookie(result) } });
    const html = await view.text();
    expect(html).toContain("Worker Member");
    expect(html).toContain('data-testid="join-result"');
    expect(html).toContain('data-testid="reinvite-link"');
    const again = await request("/", { headers: { cookie: cookie(view) } });
    expect(await again.text()).not.toContain('data-testid="join-result"');
    expect(calls.map((c) => c.path)).toEqual(expectedPaths);
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

  it("renders consent-denial recovery with no upstream error echo", async () => {
    const res = await request("/join/callback?error=access_denied&error_description=never-echo");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Join cancelled");
    expect(html).not.toContain("never-echo");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("uses POST-only QA fixtures and byte-identical failure responses in the runtime", async () => {
    const headers = { [QA_HEADER]: "test-only-qa-token" };
    const get = await request("/auth/qa/qa-member", { headers });
    expect(get.status).toBe(404);
    expect(get.headers.getSetCookie()).toHaveLength(0);
    const bad = await request("/auth/qa/qa-member", { method: "POST" });
    const unknown = await request("/auth/qa/unknown", { method: "POST", headers });
    expect(bad.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await bad.text()).toBe(await unknown.text());
    const login = await request("/auth/qa/qa-moderator", { method: "POST", headers });
    expect(login.status).toBe(204);
    expect(await (await request("/", { headers: { cookie: cookie(login) } })).text()).toContain("QA Moderator");
  });
});
