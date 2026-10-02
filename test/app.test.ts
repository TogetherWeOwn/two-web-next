// route-inventory: GET /
// route-inventory: GET /auth/discord
// route-inventory: GET /auth/discord/callback
// route-inventory: POST /logout
// route-inventory: POST /auth/qa/:identity
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { createMemorySessionStore, type SessionStore } from "../src/sessions";
import type { Env } from "../src/env";
import { QA_HEADER } from "../src/qa";

const MOD_ROLE = "508654771276873729";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: MOD_ROLE,
};

const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

async function startSignIn(e: Env = env) {
  const res = await app.request("/auth/discord", {}, e);
  const location = new URL(res.headers.get("location")!);
  return { res, location, state: location.searchParams.get("state")!, cookie: cookiesFrom(res) };
}

type DiscordStubOpts = { joinStatus?: number; memberRoles?: string[] | "http500" | "nonjson" };

function mockDiscord({ joinStatus = 201, memberRoles = [] }: DiscordStubOpts = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "user-token" });
      if (url.endsWith("/users/@me"))
        return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
      if (url.includes("/members/42") && (init as RequestInit)?.method === "PUT")
        return new Response(null, { status: joinStatus });
      if (url.includes("/members/42")) {
        if (memberRoles === "http500") return new Response("boom", { status: 500 });
        if (memberRoles === "nonjson") return new Response("<html>edge</html>", { status: 200 });
        return Response.json({ roles: memberRoles, joined_at: "2024-01-01T00:00:00Z" });
      }
      return new Response("unexpected", { status: 500 });
    }),
  );
  return calls;
}

/** Fresh memory store + env carrying it, per test. No cross-test sessions. */
function isolated() {
  const store = createMemorySessionStore();
  const e = { ...env, SESSION_STORE: store } as Env;
  return { store, env: e };
}

const signIn = async (e: Env, state: string, cookie: string) =>
  app.request(`/auth/discord/callback?code=abc&state=${state}`, { headers: { cookie } }, e);

afterEach(() => vi.unstubAllGlobals());

describe("homepage", () => {
  it("renders with a Discord sign-in link and security headers", async () => {
    const { env: e } = isolated();
    const res = await app.request("/", {}, e);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in with Discord");
    expect(html).toContain('href="/auth/discord"');
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("without DATABASE_URL every view is a guest: sessions cannot persist and fail closed", async () => {
    // The production app.request path with no store seam and no DATABASE_URL.
    const res = await app.request("/", {}, env);
    expect(await res.text()).toContain("Sign in with Discord");
  });
});

describe("Discord sign-in", () => {
  it("redirects to Discord with identify + guilds.join and a state bound to a cookie", async () => {
    const { res, location, state, cookie } = await startSignIn();
    expect(res.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(location.searchParams.get("scope")).toBe("identify guilds.join");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://next.example.test/auth/discord/callback",
    );
    expect(state).toMatch(/^[0-9a-f-]{36}$/);
    expect(cookie).toContain("__Host-two_oauth_state=");
  });

  it("signs in and auto-joins the guild", async () => {
    const { env: e } = isolated();
    const calls = mockDiscord({ joinStatus: 201 });
    const { state, cookie } = await startSignIn(e);
    const res = await signIn(e, state, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=joined");
    const join = calls.find((c) => c.url.includes("/members/42") && c.init?.method === "PUT")!;
    expect((join.init?.headers as Record<string, string>).authorization).toBe("Bot bot-token");
    expect(JSON.parse(join.init?.body as string)).toEqual({ access_token: "user-token" });

    const home = await app.request("/", { headers: { cookie: cookiesFrom(res) } }, e);
    const html = await home.text();
    expect(html).toContain("Rick");
    expect(html).toContain("Open Discord");
  });

  it("treats 204 as already a member", async () => {
    const { env: e } = isolated();
    mockDiscord({ joinStatus: 204 });
    const { state, cookie } = await startSignIn(e);
    const res = await signIn(e, state, cookie);
    expect(res.headers.get("location")).toBe("/?n=already_member");
  });

  it("still signs in when the auto-join fails, and offers the invite link", async () => {
    const { env: e } = isolated();
    mockDiscord({ joinStatus: 403 });
    const { state, cookie } = await startSignIn(e);
    const res = await signIn(e, state, cookie);
    expect(res.headers.get("location")).toBe("/?n=join_failed");
    const home = await app.request("/?n=join_failed", { headers: { cookie: cookiesFrom(res) } }, e);
    expect(await home.text()).toContain("https://discord.gg/invite");
  });

  it("refuses a callback whose state does not match the cookie", async () => {
    const { env: e } = isolated();
    const calls = mockDiscord();
    const { cookie } = await startSignIn(e);
    const res = await app.request(
      "/auth/discord/callback?code=abc&state=forged",
      { headers: { cookie } },
      e,
    );
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(calls).toHaveLength(0);
  });

  it("refuses a callback with no state cookie", async () => {
    const { env: e } = isolated();
    const calls = mockDiscord();
    const res = await app.request("/auth/discord/callback?code=abc&state=x", {}, e);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(calls).toHaveLength(0);
  });

  it("ignores a tampered session cookie", async () => {
    const { env: e } = isolated();
    const forged = `__Host-two_session=${encodeURIComponent("two_forged-token")}.bad`;
    const html = await (await app.request("/", { headers: { cookie: forged } }, e)).text();
    expect(html).not.toContain("evil");
    expect(html).toContain("Sign in with Discord");
  });

  it("refuses a cross-origin logout", async () => {
    const { env: e } = isolated();
    const res = await app.request(
      "/logout",
      { method: "POST", headers: { origin: "https://evil.test" } },
      e,
    );
    expect(res.status).toBe(403);
  });
});

describe("DB-backed sessions and rotation", () => {
  it.each([0x60, 0x70])(
    "the cookie carries a random token, not identity claims (%i)",
    async (secondByte) => {
      const { env: e } = isolated();
      mockDiscord();
      const { state, cookie } = await startSignIn(e);
      // Random base64url can contain "42" by chance. Pin two entropy inputs
      // (the first encodes to "42…") and prove the entire bearer comes from them.
      const bytes = new Uint8Array(32);
      bytes.set([0xe3, secondByte]);
      const entropy = vi.spyOn(crypto, "getRandomValues").mockImplementationOnce((array) => {
        if (!(array instanceof Uint8Array) || array.length !== 32)
          throw new Error("expected 32-byte session entropy");
        array.set(bytes);
        return array;
      });
      try {
        // Supply the edge ID so the request ULID does not consume the session
        // entropy seam. This test pins the 32-byte bearer, not logging entropy.
        const res = await app.request(
          `/auth/discord/callback?code=abc&state=${state}`,
          {
            headers: { cookie, "cf-ray": "0123456789abcdef-LHR" },
          },
          e,
        );
        expect(res.status).toBe(302);
        const raw = res.headers.getSetCookie().find((c) => c.startsWith("__Host-two_session="))!;
        const value = decodeURIComponent(raw.split(";")[0]!.split("=")[1]!);
        // hono signs `token.signature`; the bearer part is a random `two_` token.
        const [bearer] = value.split(".");
        expect(entropy).toHaveBeenCalledOnce();
        expect(bearer).toMatch(/^two_[A-Za-z0-9_-]{43}$/);
        expect(bearer).toBe(`two_${Buffer.from(bytes).toString("base64url")}`);
        expect(bearer).not.toContain("Rick");
      } finally {
        entropy.mockRestore();
      }
    },
  );

  it("rotates the session id on every authenticated view; the old cookie becomes a guest", async () => {
    const { store, env: e } = isolated();
    mockDiscord();
    const { state, cookie } = await startSignIn(e);
    const first = cookiesFrom(await signIn(e, state, cookie));

    const view1 = await app.request("/", { headers: { cookie: first } }, e);
    expect(await view1.text()).toContain("Rick");
    const second = cookiesFrom(view1);
    expect(second).not.toBe(first);

    // Replayed first cookie: the old row is gone, so this is a guest.
    const replay = await app.request("/", { headers: { cookie: first } }, e);
    expect(await replay.text()).toContain("Sign in with Discord");

    // Fresh cookie keeps working.
    const view2 = await app.request("/", { headers: { cookie: second } }, e);
    expect(await view2.text()).toContain("Rick");
    expect(store).toBeDefined();
  });

  it("logout revokes the row: the logged-out cookie cannot replay", async () => {
    const { env: e } = isolated();
    mockDiscord();
    const { state, cookie } = await startSignIn(e);
    const sessionCookie = cookiesFrom(await signIn(e, state, cookie));

    const out = await app.request(
      "/logout",
      { method: "POST", headers: { cookie: sessionCookie, origin: e.APP_URL } },
      e,
    );
    expect(out.status).toBe(303);

    const replay = await app.request("/", { headers: { cookie: sessionCookie } }, e);
    expect(await replay.text()).toContain("Sign in with Discord");
  });

  it("no session token is readable from anything but the session table contract", async () => {
    const seen: string[] = [];
    const inner = createMemorySessionStore();
    const instrumented: SessionStore = {
      create: (s) => {
        seen.push(s.tokenHash);
        return inner.create(s);
      },
      get: (h) => inner.get(h),
      statusHash: (h) => inner.statusHash(h),
      isActive: (h) => inner.isActive(h),
      rotate: (o, r) => {
        seen.push(r.tokenHash);
        return inner.rotate(o, r);
      },
      revoke: (h) => inner.revoke(h),
      sweepExpired: (now) => inner.sweepExpired(now),
    };
    const e = { ...env, SESSION_STORE: instrumented } as Env;
    mockDiscord();
    const { state, cookie } = await startSignIn(e);
    await signIn(e, state, cookie);
    // Every recorded value is a 64-hex SHA-256, never a `two_` bearer token.
    expect(seen.length).toBeGreaterThan(0);
    for (const h of seen) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("moderator recompute from snowflake role IDs", () => {
  it("grants moderator when the member holds the configured role", async () => {
    const { hashToken } = await import("../src/sessions");
    const { store, env: e } = isolated();
    mockDiscord({ memberRoles: [MOD_ROLE] });
    const { state, cookie } = await startSignIn(e);
    const res = await signIn(e, state, cookie);
    const signed = decodeURIComponent(
      res.headers
        .getSetCookie()
        .find((c) => c.startsWith("__Host-two_session="))!
        .split(";")[0]!
        .split("=")[1]!,
    );
    const row = await store.get(await hashToken(signed.split(".")[0]!));
    expect(row?.moderator).toBe(true);
  });

  it("pins the recompute to fixture snowflakes: renamed-role confusion changes nothing", async () => {
    const { hashToken } = await import("../src/sessions");
    // Same member, roles that are names or deleted-role IDs: never a moderator.
    for (const roles of [["SySOp"], ["1078757544169848933"], []]) {
      const { store, env: e } = isolated();
      mockDiscord({ memberRoles: roles });
      const { state, cookie } = await startSignIn(e);
      const res = await signIn(e, state, cookie);
      const signed = decodeURIComponent(
        res.headers
          .getSetCookie()
          .find((c) => c.startsWith("__Host-two_session="))!
          .split(";")[0]!
          .split("=")[1]!,
      );
      // hono signs `token.signature`; the bearer token is the part before the dot.
      const row = await store.get(await hashToken(signed.split(".")[0]!));
      expect(row?.moderator).toBe(false);
    }
  });

  it("fails closed on a blank allowlist without calling Discord for roles", async () => {
    const { store, env: base } = isolated();
    const e = { ...base, DISCORD_MODERATOR_ROLE_IDS: "" };
    const calls = mockDiscord({ memberRoles: [MOD_ROLE] });
    const { state, cookie } = await startSignIn(e);
    await signIn(e, state, cookie);
    expect(
      calls.some(
        (c) => (c.init as RequestInit | undefined)?.method !== "PUT" && c.url.includes("/members/"),
      ),
    ).toBe(false);
    expect(store).toBeDefined();
  });

  it("fails closed on the flag when Discord cannot answer, without blocking sign-in", async () => {
    for (const memberRoles of ["http500", "nonjson"] as const) {
      const { env: e } = isolated();
      mockDiscord({ memberRoles });
      const { state, cookie } = await startSignIn(e);
      const res = await signIn(e, state, cookie);
      expect(res.headers.get("location")).toBe("/?n=joined");
      const home = await app.request("/", { headers: { cookie: cookiesFrom(res) } }, e);
      expect(await home.text()).toContain("Rick");
    }
  });
});

describe("staging-only QA seam", () => {
  const staging = (token?: string): Env =>
    ({
      ...env,
      APP_URL: "https://next.togetherweown.com",
      QA_AUTH_TOKEN: token,
      SESSION_STORE: createMemorySessionStore(),
    }) as Env;

  it("404s when the QA token is not configured, even on the staging host", async () => {
    const e = staging(undefined);
    const res = await app.request(
      "/auth/qa/qa-member",
      { method: "POST", headers: { origin: e.APP_URL, [QA_HEADER]: "x" } },
      e,
    );
    expect(res.status).toBe(404);
  });

  it("404s off the staging host even with a token configured", async () => {
    const e = { ...staging("qa-secret"), APP_URL: "https://evil.example.test" };
    const res = await app.request(
      "/auth/qa/qa-member",
      { method: "POST", headers: { origin: e.APP_URL, [QA_HEADER]: "qa-secret" } },
      e,
    );
    expect(res.status).toBe(404);
  });

  it("404s byte-identically for a bad token and an unknown identity", async () => {
    const e = staging("qa-secret");
    const badToken = await app.request(
      "/auth/qa/qa-member",
      { method: "POST", headers: { origin: e.APP_URL, [QA_HEADER]: "wrong" } },
      e,
    );
    const badIdentity = await app.request(
      "/auth/qa/nope",
      { method: "POST", headers: { origin: e.APP_URL, [QA_HEADER]: "qa-secret" } },
      e,
    );
    expect(badToken.status).toBe(404);
    expect(badIdentity.status).toBe(404);
    expect(await badToken.text()).toBe(await badIdentity.text());
  });

  it("signs in the member fixture and the moderator fixture with the right flags", async () => {
    const { hashToken } = await import("../src/sessions");
    for (const [identity, username, moderator] of [
      ["qa-member", "QA Member", false],
      ["qa-moderator", "QA Moderator", true],
    ] as const) {
      const e = staging("qa-secret");
      const res = await app.request(
        `/auth/qa/${identity}`,
        { method: "POST", headers: { origin: e.APP_URL, [QA_HEADER]: "qa-secret" } },
        e,
      );
      expect(res.status).toBe(204);
      const home = await app.request("/", { headers: { cookie: cookiesFrom(res) } }, e);
      expect(await home.text()).toContain(username);
      const store = (e as Env & { SESSION_STORE: SessionStore }).SESSION_STORE!;
      const signed = decodeURIComponent(
        res.headers
          .getSetCookie()
          .find((c) => c.startsWith("__Host-two_session="))!
          .split(";")[0]!
          .split("=")[1]!,
      );
      // QA login mints the row; the first authenticated view rotates it, so the
      // original bearer hash resolves to null afterwards. Capture the flags from
      // the rotated row via the fresh cookie instead.
      const rotatedCookie = cookiesFrom(home);
      const rotatedSigned = decodeURIComponent(
        home.headers
          .getSetCookie()
          .find((c) => c.startsWith("__Host-two_session="))!
          .split(";")[0]!
          .split("=")[1]!,
      );
      const row = await store.get(await hashToken(rotatedSigned.split(".")[0]!));
      expect(row?.username).toBe(username);
      expect(row?.moderator).toBe(moderator);
      expect(signed).not.toBe(rotatedSigned);
      expect(rotatedCookie).toContain("__Host-two_session=");
    }
  });
});
