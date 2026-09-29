import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/env";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

async function startSignIn() {
  const res = await app.request("/auth/discord", {}, env);
  const location = new URL(res.headers.get("location")!);
  return { res, location, state: location.searchParams.get("state")!, cookie: cookiesFrom(res) };
}

function mockDiscord(joinStatus: number) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "user-token" });
      if (url.endsWith("/users/@me")) return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
      if (url.includes("/guilds/326474832151838730/members/42")) return new Response(null, { status: joinStatus });
      return new Response("unexpected", { status: 500 });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("health", () => {
  it("returns 200 { ok: true } on /health", async () => {
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("homepage", () => {
  it("renders with a Discord sign-in link and security headers", async () => {
    const res = await app.request("/", {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in with Discord");
    expect(html).toContain('href="/auth/discord"');
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });
});

describe("Discord sign-in", () => {
  it("redirects to Discord with identify + guilds.join and a state bound to a cookie", async () => {
    const { res, location, state, cookie } = await startSignIn();
    expect(res.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(location.searchParams.get("scope")).toBe("identify guilds.join");
    expect(location.searchParams.get("redirect_uri")).toBe("https://next.example.test/auth/discord/callback");
    expect(state).toMatch(/^[0-9a-f-]{36}$/);
    expect(cookie).toContain("__Host-two_oauth_state=");
  });

  it("signs in and auto-joins the guild", async () => {
    const calls = mockDiscord(201);
    const { state, cookie } = await startSignIn();
    const res = await app.request(`/auth/discord/callback?code=abc&state=${state}`, { headers: { cookie } }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=joined");
    const join = calls.find((c) => c.url.includes("/members/42"))!;
    expect(join.init?.method).toBe("PUT");
    expect((join.init?.headers as Record<string, string>).authorization).toBe("Bot bot-token");
    expect(JSON.parse(join.init?.body as string)).toEqual({ access_token: "user-token" });

    const home = await app.request("/", { headers: { cookie: cookiesFrom(res) } }, env);
    const html = await home.text();
    expect(html).toContain("Rick");
    expect(html).toContain("Open Discord");
  });

  it("treats 204 as already a member", async () => {
    mockDiscord(204);
    const { state, cookie } = await startSignIn();
    const res = await app.request(`/auth/discord/callback?code=abc&state=${state}`, { headers: { cookie } }, env);
    expect(res.headers.get("location")).toBe("/?n=already_member");
  });

  it("still signs in when the auto-join fails, and offers the invite link", async () => {
    mockDiscord(403);
    const { state, cookie } = await startSignIn();
    const res = await app.request(`/auth/discord/callback?code=abc&state=${state}`, { headers: { cookie } }, env);
    expect(res.headers.get("location")).toBe("/?n=join_failed");
    const home = await app.request("/?n=join_failed", { headers: { cookie: cookiesFrom(res) } }, env);
    expect(await home.text()).toContain("https://discord.gg/invite");
  });

  it("refuses a callback whose state does not match the cookie", async () => {
    const calls = mockDiscord(201);
    const { cookie } = await startSignIn();
    const res = await app.request("/auth/discord/callback?code=abc&state=forged", { headers: { cookie } }, env);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(calls).toHaveLength(0);
  });

  it("refuses a callback with no state cookie", async () => {
    const calls = mockDiscord(201);
    const res = await app.request("/auth/discord/callback?code=abc&state=x", {}, env);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(calls).toHaveLength(0);
  });

  it("ignores a tampered session cookie", async () => {
    const forged = `__Host-two_session=${encodeURIComponent(JSON.stringify({ id: "1", username: "evil", exp: 9e9 }))}.bad`;
    const html = await (await app.request("/", { headers: { cookie: forged } }, env)).text();
    expect(html).not.toContain("evil");
    expect(html).toContain("Sign in with Discord");
  });

  it("refuses a cross-origin logout", async () => {
    const res = await app.request("/logout", { method: "POST", headers: { origin: "https://evil.test" } }, env);
    expect(res.status).toBe(403);
  });
});
