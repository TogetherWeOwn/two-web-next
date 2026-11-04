import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { HookEventLike } from "../src/route-ownership";
import { QA_HEADER, QA_IDENTITIES, STAGING_APP_URL } from "../src/qa";
import { SESSION_COOKIE } from "../src/session-cookie";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { generateSignedCookie } from "hono/cookie";

const ISSUED = Date.UTC(2026, 10, 4, 8) / 1000;
const E = ISSUED + 1470;
const STATUS = "__Host-two_session_status";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const descriptor = [
  "two.qa.run.v1",
  "123456",
  "TogetherWeOwn/two-web-next",
  "2035",
  "a".repeat(40),
  "b".repeat(40),
  "c".repeat(40),
  "456789",
  "1",
  "staging",
  STAGING_APP_URL,
  "candidate-qa-login",
];
const q = sha(JSON.stringify(descriptor));
const credential = `qa1.${q}.${Buffer.alloc(32, 7).toString("base64url")}`;
const binding = JSON.stringify({
  schema: "two.qa.verifier.v1",
  descriptor,
  q,
  credentialSha256: sha(`two.qa.credential.v1\0${JSON.stringify(descriptor)}\0${credential}`),
  issuedAt: ISSUED,
  notBefore: ISSUED,
  expiresAt: ISSUED + 1500,
});
const pairs = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
const valueOf = (response: Response, name = SESSION_COOKIE) => {
  const cookie = response.headers.getSetCookie().find((v) => v.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.split(";")[0]!.slice(name.length + 1)) : "";
};

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  let now = ISSUED;
  vi.spyOn(Date, "now").mockImplementation(() => now * 1000);
  // Leave the rows unexpired to distinguish application expiry from DB/GC.
  let storeNow = ISSUED;
  const store = createMemorySessionStore(() => storeNow * 1000);
  const env = {
    APP_URL: STAGING_APP_URL,
    DISCORD_CLIENT_ID: "fixture-client",
    DISCORD_GUILD_ID: "1545644954272137297",
    DISCORD_INVITE_URL: "https://discord.gg/test-invite",
    SESSION_STORE: store,
    QA_RUN_AUTH: binding,
  } as unknown as Env;
  const { default: app } = await import("../src/index");
  const kit = await import("../src/kit-session");
  const admission = await import("../src/session-admission");
  const request = (path: string, init: RequestInit = {}, e = env) =>
    app.request(new URL(path, e.APP_URL), init, e);
  const login = (identity = "qa-member", e = env, token = credential, headers = {}) =>
    request(
      `/auth/qa/${identity}`,
      {
        method: "POST",
        headers: { origin: STAGING_APP_URL, [QA_HEADER]: token, ...headers },
      },
      e,
    );
  const event = (cookie: string, path = "/e/fixture", e = env): HookEventLike => {
    const request = new Request(new URL(path, e.APP_URL), { headers: { cookie } });
    return { request, url: new URL(request.url), locals: {}, route: { id: path } };
  };
  const decision = (request: Request, e = env) =>
    kit.resolveRequestSession(request, {
      sessionSecret: e.SESSION_SECRET,
      store,
      roleRecheck: null,
      qaRun: e,
    });
  return {
    store,
    env,
    request,
    login,
    event,
    decision,
    kit,
    admission,
    advanceStore: (seconds: number) => {
      storeNow = ISSUED + seconds;
    },
    advance: (seconds: number) => {
      now = ISSUED + seconds;
    },
  };
}

describe("qualification route integration (memory fixtures, no external services)", () => {
  it.each(["qa-member", "qa-moderator"])(
    "issues key-free %s cookies and stores only qualified hashes",
    async (name) => {
      const f = await fixture();
      const create = vi.spyOn(f.store, "create");
      const result = await f.login(name);
      expect(result.status).toBe(204);
      const token = valueOf(result);
      expect(token).toMatch(new RegExp(`^q1s\\.${q}\\.[A-Za-z0-9_-]{43}$`));
      const status = valueOf(result, STATUS);
      expect(status).toBe(`q1p.${q}.${await hashToken(token)}`);
      for (const cookie of result.headers.getSetCookie()) {
        for (const flag of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=1470"])
          expect(cookie).toContain(flag);
        expect(cookie).not.toMatch(/Domain=/i);
      }
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenHash: await hashToken(token),
          expiresAt: new Date(E * 1000),
        }),
      );
      expect(JSON.stringify(create.mock.calls)).not.toContain(token);
      const statusResult = await f.request("/auth/status", { headers: { cookie: pairs(result) } });
      expect(await statusResult.json()).toEqual({ authenticated: true });
      const event = f.event(pairs(result));
      const decision = await f.decision(event.request);
      expect(decision.status).toBe("authenticated");
      expect(decision.session).toMatchObject({
        userId: QA_IDENTITIES[name]!.discordId,
        moderator: name === "qa-moderator",
      });
    },
  );

  it("retains the approved cancellation window, then refuses bearer, Hono/Kit read, status and renewal at original E", async () => {
    const f = await fixture();
    const result = await f.login("qa-moderator");
    const token = valueOf(result);
    f.advance(60); // terminal cancellation, cleanup unavailable; metadata/row unchanged
    expect((await f.login()).status).toBe(204);
    const event = f.event(pairs(result), "/admin");
    const decision = await f.decision(event.request);
    expect(decision.status).toBe("authenticated");
    event.locals = decision;
    const renewal = await f.kit.kitAdminRenewalFor(f.env)(event);
    expect(renewal).toContain("Max-Age=1410");
    expect(renewal).toContain("=q1s.");
    const successor = decodeURIComponent(renewal!.split(";")[0]!.slice(SESSION_COOKIE.length + 1));
    expect(await f.store.get(await hashToken(successor))).not.toBeNull();
    f.advance(1470);
    const get = vi.spyOn(f.store, "get");
    const rotate = vi.spyOn(f.store, "rotate");
    const active = vi.spyOn(f.store, "isActive");
    expect((await f.login()).status).toBe(404);
    expect((await f.decision(event.request)).status).toBe("guest");
    expect(await f.kit.kitAdminRenewalFor(f.env)(event)).toBeNull();
    expect(await f.kit.kitEventDetailRotationFor(f.env)(event)).toBeNull();
    expect(await f.kit.kitAuthStatusCookieFor(f.env)(event)).toBeNull();
    expect(
      await (await f.request("/auth/status", { headers: { cookie: pairs(result) } })).json(),
    ).toEqual({ authenticated: false });
    expect((await f.request("/events.json", { headers: { cookie: pairs(result) } })).status).toBe(
      401,
    );
    expect(get).not.toHaveBeenCalled();
    expect(rotate).not.toHaveBeenCalled();
    expect(active).not.toHaveBeenCalled();
    expect(await f.store.get(await hashToken(token))).not.toBeNull(); // grace row deliberately retained
  });

  it.each(["/logout", "/logout/everywhere"])(
    "revokes the qualified successor and status through %s with a grace predecessor",
    async (path) => {
      const f = await fixture();
      const login = await f.login();
      const token = valueOf(login);
      const boundary = f.admission.qaRunSessionsFor(f.event(pairs(login)).request, f.env, f.store);
      const successor = (await boundary.rotate(token))!;
      const status = (await boundary.status(successor.token))!;
      const result = await f.request(path, {
        method: "POST",
        headers: { origin: STAGING_APP_URL, cookie: pairs(login) },
      });
      expect(result.status).toBe(303);
      expect(
        result.headers.getSetCookie().filter((v) => v.includes("Max-Age=0")).length,
      ).toBeGreaterThanOrEqual(2);
      expect(await boundary.read(successor.token)).toBeNull();
      expect(await boundary.isActive(status)).toBe(false);
    },
  );

  it("logout retires an undelivered successor after the browser's predecessor grace expired", async () => {
    const f = await fixture();
    const login = await f.login();
    const boundary = f.admission.qaRunSessionsFor(f.event(pairs(login)).request, f.env, f.store);
    const token = valueOf(login);
    const successor = (await boundary.rotate(token))!;
    const status = (await boundary.status(successor.token))!;
    f.advance(11);
    f.advanceStore(11);
    expect(await boundary.read(token)).toBeNull();
    expect(await boundary.read(successor.token)).not.toBeNull();
    const result = await f.request("/logout", {
      method: "POST",
      headers: { origin: STAGING_APP_URL, cookie: pairs(login) },
    });
    expect(result.status).toBe(303);
    expect(await boundary.read(successor.token)).toBeNull();
    expect(await boundary.isActive(status)).toBe(false);
  });

  it("logout never uses duplicate, old-run or malformed status values to revoke a lineage", async () => {
    const f = await fixture();
    const boundary = f.admission.qaRunSessionsFor(f.event("").request, f.env, f.store);
    const grant = (await boundary.issue("qa-member"))!;
    const status = (await boundary.status(grant.token))!;
    const revoke = vi.spyOn(f.store, "revokeLineage");
    for (const cookie of [
      `${STATUS}=${status}; ${STATUS}=${status}`,
      `${STATUS}=${status.replace(q, "f".repeat(64))}`,
      `${STATUS}=q1p.bad`,
    ]) {
      // A same-Q but unknown bearer resolves no row. The status is only
      // considered for revocation after raw bearer admission, never login.
      const unknown = `q1s.${q}.${Buffer.alloc(32, 9).toString("base64url")}`;
      expect(
        (
          await f.request("/logout", {
            method: "POST",
            headers: { origin: STAGING_APP_URL, cookie: `${SESSION_COOKIE}=${unknown}; ${cookie}` },
          })
        ).status,
      ).toBe(303);
    }
    expect(revoke).not.toHaveBeenCalled();
    expect(await boundary.read(grant.token)).not.toBeNull();
    f.advance(1470);
    expect(await boundary.revokeStatus(status)).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("rejects duplicate, malformed and cross-run session values without a store read", async () => {
    const f = await fixture();
    const login = await f.login();
    const token = valueOf(login);
    const get = vi.spyOn(f.store, "get");
    for (const cookie of [
      `${SESSION_COOKIE}=${token}; ${SESSION_COOKIE}=${token}`,
      `${SESSION_COOKIE}=q1s.malformed`,
      `${SESSION_COOKIE}=${token.replace(q, "f".repeat(64))}`,
      `${SESSION_COOKIE}=%ZZ`,
      `${SESSION_COOKIE}="${token}"`,
    ]) {
      expect((await f.decision(f.event(cookie).request)).status).toBe("guest");
      expect(await f.admission.readSessionToken(f.event(cookie).request, f.env)).toBeNull();
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses copied production verifier/config, restored ordinary staging, and legacy sessions during qualification", async () => {
    const f = await fixture();
    const login = await f.login();
    const get = vi.spyOn(f.store, "get");
    const production = {
      ...f.env,
      SESSION_SECRET: "fixture-session-signing-key-at-least-32-bytes",
      QA_AUTH_TOKEN: credential,
    };
    const request = new Request("https://togetherweown.com/profile", {
      headers: { cookie: pairs(login) },
    });
    expect((await f.decision(request, production)).status).toBe("guest");
    expect(await f.admission.readSessionToken(request, production)).toBeNull();
    const restored = { ...production, QA_RUN_AUTH: undefined };
    expect(await f.admission.readSessionToken(f.event(pairs(login)).request, restored)).toBeNull();
    const legacy = newSessionToken();
    const cookie = (
      await generateSignedCookie(SESSION_COOKIE, legacy, production.SESSION_SECRET, {
        path: "/",
        secure: true,
      })
    ).split(";")[0]!;
    expect((await f.decision(f.event(cookie).request, production)).status).toBe("guest");
    expect(get).not.toHaveBeenCalled();
    expect((await f.login("qa-member", restored)).status).toBe(404); // qa1 never falls through to legacy
  });

  it.each(["", "{", "null"])(
    "present-invalid binding %# refuses legacy QA and all session fallback",
    async (bad) => {
      const f = await fixture();
      const env = {
        ...f.env,
        QA_RUN_AUTH: bad,
        QA_AUTH_TOKEN: "fixture-legacy-qa-token-at-least-32-bytes",
      };
      const create = vi.spyOn(f.store, "create");
      expect((await f.login("qa-member", env, env.QA_AUTH_TOKEN)).status).toBe(404);
      expect(create).not.toHaveBeenCalled();
      expect((await f.decision(f.event("").request, env)).status).toBe("guest");
    },
  );

  it("preserves failed-guess throttles, identity refusal and explicit Origin admission", async () => {
    const f = await fixture();
    const create = vi.spyOn(f.store, "create");
    expect((await f.login("toString")).status).toBe(404);
    expect((await f.login("qa-member", f.env, "x".repeat(513))).status).toBe(404);
    expect(
      (
        await f.request("/auth/qa/qa-member", {
          method: "POST",
          headers: { [QA_HEADER]: credential },
        })
      ).status,
    ).toBe(403);
    for (let i = 0; i < 10; i++)
      expect(
        (await f.login("qa-member", f.env, "bad", { "cf-connecting-ip": "198.51.100.11" })).status,
      ).toBe(404);
    expect(
      (await f.login("qa-member", f.env, credential, { "cf-connecting-ip": "198.51.100.11" }))
        .status,
    ).toBe(404);
    expect(create).not.toHaveBeenCalled();
    expect(
      (await f.login("qa-member", f.env, credential, { "cf-connecting-ip": "198.51.100.12" }))
        .status,
    ).toBe(204);
  });

  it("keeps anonymous OAuth entry redirects and bounded non-authoritative return state key-free", async () => {
    const f = await fixture();
    const notices = await import("../src/journey-cookie");
    for (const path of ["/auth/discord?next=%2Fprofile", "/join/discord?next=%2Fprofile"]) {
      const result = await f.request(path);
      expect(result.status).toBe(302);
      const url = new URL(result.headers.get("location")!);
      expect(url.origin).toBe("https://discord.com");
      expect(url.searchParams.get("scope")).toBe("identify guilds.join");
      expect(url.searchParams.get("state")).toBeTruthy();
      expect(result.headers.getSetCookie().some((cookie) => cookie.includes("q1n."))).toBe(true);
    }
    const recovery = await f.request("/auth/recover?next=%2Fprofile");
    expect(recovery.status).toBe(200);
    const request = f.event(pairs(recovery)).request;
    expect((await f.kit.readReturnJourney(request, f.env.SESSION_SECRET, f.env)).returnTo).toBe(
      "/profile",
    );
    const restored = {
      ...f.env,
      QA_RUN_AUTH: undefined,
      SESSION_SECRET: "fixture-session-secret-at-least-32-bytes",
    };
    expect(
      await notices.readJourneyCookie(request, restored, "__Host-two_login_intended"),
    ).toBeNull();
    f.advance(600);
    expect(await notices.readJourneyCookie(request, f.env, "__Host-two_login_intended")).toBeNull();
  });

  it.each(["member", "moderator"])(
    "uses the qualified row and original expiry in the Hono %s gate",
    async (role) => {
      const f = await fixture();
      const { Hono } = await import("hono");
      const { memberGate } = await import("../src/profiles/routes-gate");
      const { adminGuard } = await import("../src/admin/guard");
      const { bufferedMemberHtml } = await import("../src/member-reads");
      const login = await f.login(role === "moderator" ? "qa-moderator" : "qa-member");
      const gated = new Hono<any>();
      gated.use("/*", async (c, next) => {
        if (role === "member") return memberGate({ sessionStore: f.store })(c, next);
        return adminGuard({ sessionStore: f.store })(c, next);
      });
      const path = role === "member" ? "/profile" : "/admin";
      gated.get(path, (c) => {
        if (role === "moderator")
          c.set("access", { resource: "events", action: "view", route: "test.qualification" });
        return bufferedMemberHtml(c, "<p>fixture-only</p>");
      });
      const response = await gated.request(
        new URL(path, STAGING_APP_URL),
        { headers: { cookie: pairs(login) } },
        f.env,
      );
      expect(response.status).toBe(200);
      const token = valueOf(response);
      expect(token).toMatch(/^q1s\./);
      expect(token).not.toBe(valueOf(login));
      expect(
        response.headers.getSetCookie().find((v) => v.startsWith(`${SESSION_COOKIE}=`)),
      ).toContain("Max-Age=1470");
      expect(await f.store.get(await hashToken(token))).not.toBeNull();
      f.advance(1470);
      const get = vi.spyOn(f.store, "get");
      const expired = await gated.request(
        new URL(path, STAGING_APP_URL),
        { headers: { cookie: pairs(response) } },
        f.env,
      );
      expect(expired.status).toBe(302);
      expect(expired.headers.get("location")).toBe("/auth/discord");
      expect(get).not.toHaveBeenCalled();
      expect(valueOf(expired)).toBe("");
    },
  );

  it("refuses both OAuth callbacks before any external fetch or session issuance even with copied secrets", async () => {
    const f = await fixture();
    const fetch = vi.spyOn(globalThis, "fetch");
    const create = vi.spyOn(f.store, "create");
    for (const path of ["/auth/discord/callback?code=x&state=y", "/join/callback?code=x&state=y"]) {
      expect((await f.request(path)).status).toBe(404);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
