// Kit session bridge pins: the shared request/session service the
// Kit hook uses while Hono retains OAuth/session authority.
//
// The bridge is read-only: it verifies the signed __Host session cookie with
// the same hono primitive Hono uses (parseSigned), hashes the token, and makes
// exactly one store.get per request (memoized, so concurrent reads share one
// decision). It never rotates, revokes, or sets cookies — rotation stays
// route-specific in Hono's readSession, and flashes stay Hono-consumed until a
// Kit route needs to consume them.
//
// Decision contract:
// - authenticated: valid signature, two_ token, live row (bits from the row).
// - guest: missing/tampered cookie, non-two_ token, unknown/expired/revoked row.
// - unknown: the store failed (outage) or no secret is configured. An outage
//   is never reported as a logout, so the UI can show "unknown" instead of
//   flipping a member to logged-out.
// Local fixtures only: memory store, serializeSigned-minted cookies, no DB.
import { parseSigned, serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import { AUTH_STATUS_COOKIE } from "../src/auth-status";
import { SESSION_COOKIE } from "../src/session-cookie";
import type { Env } from "../src/env";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  SESSION_TTL_SECONDS,
  type SessionStore,
} from "../src/sessions";
import {
  JOIN_RESULT_COOKIE,
  LOGIN_INTENDED_COOKIE,
  LOGIN_NEXT_COOKIE,
} from "../src/return-journey";
import { EXPIRED_WRITE_COOKIE } from "../src/write-recovery";
import {
  createRequestSessionCache,
  kitAuthStatusCookieFor,
  kitSessionBridge,
  readReturnJourney,
  resolveRequestSession,
  type KitLocals,
} from "../src/kit-session";
import {
  dispatchHookRequest,
  ROUTE_MANIFEST,
  type HookDispatchDeps,
  type HookEventLike,
} from "../src/route-ownership";
import type { AccessEntry } from "../src/access-log";
import { declareMemberResult, keyedMemberRead, memberQueryPermit } from "../src/member-reads";

const SECRET = "test-session-secret-at-least-32-bytes-long";
const WRONG_SECRET = "a-different-secret-at-least-32-bytes-long";

const pair = async (name: string, value: string, secret: string = SECRET) =>
  (await serializeSigned(name, value, secret, { path: "/", secure: true })).split(";")[0]!;

const requestWith = (pairs: string[], method = "GET", path = "/events/past") =>
  new Request(`https://next.example.test${path}`, {
    method,
    headers: pairs.length ? { cookie: pairs.join("; ") } : {},
  });

const liveRow = (overrides: Partial<Parameters<SessionStore["create"]>[0]> = {}) => ({
  tokenHash: `hash-${Math.random().toString(36).slice(2)}`,
  userId: "42",
  username: "Rick",
  avatar: null as string | null,
  member: true,
  moderator: false,
  expiresAt: new Date(Date.now() + 3600_000),
  ...overrides,
});

// A live session minted the Hono way: random token, hashed row, signed cookie.
const seedSession = async (
  store: SessionStore,
  overrides: Partial<ReturnType<typeof liveRow>> = {},
) => {
  const token = newSessionToken();
  const row = liveRow({ tokenHash: await hashToken(token), ...overrides });
  await store.create(row);
  return { token, row };
};

describe("resolveRequestSession (one request, one session decision)", () => {
  it("resolves a valid signed session with the row's member/moderator bits", async () => {
    const store = createMemorySessionStore();
    const { token } = await seedSession(store, { moderator: true });
    const decision = await resolveRequestSession(requestWith([await pair(SESSION_COOKIE, token)]), {
      sessionSecret: SECRET,
      store,
    });
    expect(decision).toEqual({
      status: "authenticated",
      session: {
        userId: "42",
        username: "Rick",
        avatar: null,
        member: true,
        moderator: true,
      },
    });
  });

  it("reports guest when no session cookie is presented", async () => {
    const store = createMemorySessionStore();
    expect(await resolveRequestSession(requestWith([]), { sessionSecret: SECRET, store })).toEqual({
      status: "guest",
      session: null,
    });
  });

  it("reports guest for a tampered signature, not an outage", async () => {
    const store = createMemorySessionStore();
    const { token } = await seedSession(store);
    const good = await pair(SESSION_COOKIE, token);
    const tampered = `${good.slice(0, -1)}${good.endsWith("A") ? "B" : "A"}`;
    expect(
      await resolveRequestSession(requestWith([tampered]), { sessionSecret: SECRET, store }),
    ).toEqual({ status: "guest", session: null });
  });

  it("reports guest when the cookie was signed with another secret", async () => {
    const store = createMemorySessionStore();
    const { token } = await seedSession(store);
    expect(
      await resolveRequestSession(requestWith([await pair(SESSION_COOKIE, token, WRONG_SECRET)]), {
        sessionSecret: SECRET,
        store,
      }),
    ).toEqual({ status: "guest", session: null });
  });

  it("reports guest for a signed token without the two_ prefix", async () => {
    const store = createMemorySessionStore();
    expect(
      await resolveRequestSession(requestWith([await pair(SESSION_COOKIE, "not-a-session")]), {
        sessionSecret: SECRET,
        store,
      }),
    ).toEqual({ status: "guest", session: null });
  });

  it("reports guest for a valid signature over an unknown token hash", async () => {
    const store = createMemorySessionStore();
    expect(
      await resolveRequestSession(requestWith([await pair(SESSION_COOKIE, newSessionToken())]), {
        sessionSecret: SECRET,
        store,
      }),
    ).toEqual({ status: "guest", session: null });
  });

  it("reports guest for an expired row", async () => {
    let now = Date.now();
    const store = createMemorySessionStore(() => now);
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId: "42",
      username: "Rick",
      avatar: null,
      member: true,
      moderator: false,
      expiresAt: new Date(now + 1000),
    });
    now += 2000;
    expect(
      await resolveRequestSession(requestWith([await pair(SESSION_COOKIE, token)]), {
        sessionSecret: SECRET,
        store,
      }),
    ).toEqual({ status: "guest", session: null });
  });

  it("reports guest for a revoked row", async () => {
    const store = createMemorySessionStore();
    const { token, row } = await seedSession(store);
    await store.revoke(row.tokenHash);
    expect(
      await resolveRequestSession(requestWith([await pair(SESSION_COOKIE, token)]), {
        sessionSecret: SECRET,
        store,
      }),
    ).toEqual({ status: "guest", session: null });
  });

  it("reports unknown — never a false logout — when the store fails", async () => {
    const store = createMemorySessionStore();
    const { token } = await seedSession(store);
    const failing: SessionStore = {
      ...store,
      get: async () => {
        throw new Error("connection refused");
      },
    };
    expect(
      await resolveRequestSession(requestWith([await pair(SESSION_COOKIE, token)]), {
        sessionSecret: SECRET,
        store: failing,
      }),
    ).toEqual({ status: "unknown", session: null });
  });

  it("reports unknown when no session secret is configured", async () => {
    const store = createMemorySessionStore();
    const { token } = await seedSession(store);
    expect(
      await resolveRequestSession(requestWith([await pair(SESSION_COOKIE, token)]), {
        sessionSecret: "",
        store,
      }),
    ).toEqual({ status: "unknown", session: null });
  });

  it("ignores the auth-status probe cookie: it never authenticates", async () => {
    const store = createMemorySessionStore();
    const { row } = await seedSession(store);
    const statusKey = (await store.statusHash(row.tokenHash))!;
    expect(
      await resolveRequestSession(requestWith([await pair(AUTH_STATUS_COOKIE, statusKey)]), {
        sessionSecret: SECRET,
        store,
      }),
    ).toEqual({ status: "guest", session: null });
  });
});

describe("one decision per request (memoized, strand-free)", () => {
  it("shares a single store.get across concurrent reads of the same request", async () => {
    const store = createMemorySessionStore();
    const { token } = await seedSession(store);
    const get = vi.spyOn(store, "get");
    const cached = createRequestSessionCache();
    const request = requestWith([await pair(SESSION_COOKIE, token)]);
    const deps = { sessionSecret: SECRET, store };
    const [first, second, third] = await Promise.all([
      cached(request, deps),
      cached(request, deps),
      cached(request, deps),
    ]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first.status).toBe("authenticated");
  });

  it("a dropped (cancelled) read strands nothing: the next read still authenticates", async () => {
    const store = createMemorySessionStore();
    const { token, row } = await seedSession(store);
    const cached = createRequestSessionCache();
    const deps = { sessionSecret: SECRET, store };
    // Fire and abandon: no rotation or revocation exists in the read path, so
    // there is no in-flight mutation to strand the session.
    void cached(requestWith([await pair(SESSION_COOKIE, token)]), deps);
    const decision = await cached(requestWith([await pair(SESSION_COOKIE, token)]), deps);
    expect(decision.status).toBe("authenticated");
    expect(await store.get(row.tokenHash)).not.toBeNull();
  });

  it("reflects role changes across requests: memoization never crosses a Request", async () => {
    const store = createMemorySessionStore();
    const token = newSessionToken();
    const tokenHash = await hashToken(token);
    const base = {
      tokenHash,
      userId: "42",
      username: "Rick",
      avatar: null as string | null,
      member: true,
      moderator: false,
      expiresAt: new Date(Date.now() + 3600_000),
    };
    await store.create(base);
    const cached = createRequestSessionCache();
    const deps = { sessionSecret: SECRET, store };
    const cookie = await pair(SESSION_COOKIE, token);
    expect((await cached(requestWith([cookie]), deps)).session?.moderator).toBe(false);
    // Discord role recompute flips the flag on the next sign-in write.
    await store.create({ ...base });
    await store.revoke(tokenHash);
    const rotated = newSessionToken();
    await store.create({ ...base, tokenHash: await hashToken(rotated), moderator: true });
    const fresh = await cached(requestWith([await pair(SESSION_COOKIE, rotated)]), deps);
    expect(fresh.status).toBe("authenticated");
    expect(fresh.session?.moderator).toBe(true);
  });
});

describe("readReturnJourney (Kit-visible return state, read-only)", () => {
  it("an explicit next beats the recorded intended page", async () => {
    const journey = await readReturnJourney(
      requestWith([
        await pair(LOGIN_NEXT_COOKIE, "/e/two"),
        await pair(LOGIN_INTENDED_COOKIE, "/events"),
      ]),
      SECRET,
    );
    expect(journey).toEqual({ returnTo: "/e/two", joinResult: null, expiredWrite: null });
  });

  it("falls back to the intended page, then to null", async () => {
    expect(
      (
        await readReturnJourney(
          requestWith([await pair(LOGIN_INTENDED_COOKIE, "/profile")]),
          SECRET,
        )
      ).returnTo,
    ).toBe("/profile");
    expect((await readReturnJourney(requestWith([]), SECRET)).returnTo).toBeNull();
  });

  it("a signed-but-hostile next never verifies into a destination", async () => {
    const journey = await readReturnJourney(
      requestWith([await pair(LOGIN_NEXT_COOKIE, "https://evil.test/")]),
      SECRET,
    );
    expect(journey.returnTo).toBeNull();
  });

  it("a tampered journey cookie reads as absent", async () => {
    const good = await pair(LOGIN_NEXT_COOKIE, "/events");
    const tampered = `${good.slice(0, -1)}${good.endsWith("A") ? "B" : "A"}`;
    expect((await readReturnJourney(requestWith([tampered]), SECRET)).returnTo).toBeNull();
  });

  it.each(["added", "already_member"] as const)(
    "reads the join flash %s without consuming",
    async (result) => {
      const journey = await readReturnJourney(
        requestWith([await pair(JOIN_RESULT_COOKIE, result)]),
        SECRET,
      );
      expect(journey.joinResult).toBe(result);
    },
  );

  it("a signed-but-unknown join value reads as nothing", async () => {
    const journey = await readReturnJourney(
      requestWith([await pair(JOIN_RESULT_COOKIE, "denied")]),
      SECRET,
    );
    expect(journey.joinResult).toBeNull();
  });

  it("a non-GET read leaves the flash pending (Hono parity)", async () => {
    const journey = await readReturnJourney(
      requestWith([await pair(JOIN_RESULT_COOKIE, "added")], "POST"),
      SECRET,
    );
    expect(journey.joinResult).toBeNull();
  });

  it("a pending expired-write notice resolves, a restored one does not (Hono parity)", async () => {
    expect(
      (
        await readReturnJourney(
          requestWith([await pair(EXPIRED_WRITE_COOKIE, "pending|/profile")]),
          SECRET,
        )
      ).expiredWrite,
    ).toBe("/profile");
    expect(
      (
        await readReturnJourney(
          requestWith([await pair(EXPIRED_WRITE_COOKIE, "restored|/profile")]),
          SECRET,
        )
      ).expiredWrite,
    ).toBeNull();
  });

  it("reads nothing without a secret, and never throws on garbage", async () => {
    expect(await readReturnJourney(requestWith([]), "")).toEqual({
      returnTo: null,
      joinResult: null,
      expiredWrite: null,
    });
    expect(
      await readReturnJourney(
        new Request("https://next.example.test/", { headers: { cookie: "%%%" } }),
        SECRET,
      ),
    ).toEqual({ returnTo: null, joinResult: null, expiredWrite: null });
  });
});

describe("dispatchHookRequest session bridge (Kit branch only)", () => {
  const APP_URL = "https://next.example.test";
  // Public Kit routes skip the bridge by design (no session, no flash); the
  // shipped archive is public, so the Kit branch is pinned with an explicit
  // override (same convention as hook-route-ownership; member merge detail
  // lives in kit-member-dispatch).
  const KIT_MANIFEST = [
    { method: "GET", path: "/events/past", enabled: true, reads: "public" as const },
  ];

  const eventFor = (
    path: string,
    pairs: string[] = [],
    host = "next.example.test",
    routeId = "/events/past",
  ): HookEventLike => {
    const request = new Request(new URL(path, APP_URL).href, {
      headers: { host, ...(pairs.length ? { cookie: pairs.join("; ") } : {}) },
    });
    return { request, url: new URL(request.url), route: { id: routeId } };
  };

  const depsFor = (overrides: Partial<HookDispatchDeps> = {}): HookDispatchDeps => ({
    appUrl: APP_URL,
    featuredImageHosts: "",
    honoFetch: vi.fn(async () => new Response("hono", { status: 200 })),
    resolve: vi.fn(async () => new Response("kit", { status: 200 })),
    ...overrides,
  });

  const guestLocals = (): KitLocals => ({
    status: "guest",
    session: null,
    returnTo: null,
    joinResult: null,
    expiredWrite: null,
  });

  it("a Hono-owned request never invokes the session bridge, cookies or not", async () => {
    // The archive is Kit-owned now, so the Hono-owned half of this pin uses
    // the still-disabled privacy route with the shipped manifest.
    const store = createMemorySessionStore();
    const { token } = await seedSession(store);
    const sessionFor = vi.fn(async (_event: HookEventLike) => guestLocals());
    const event = eventFor(
      "/privacy",
      [await pair(SESSION_COOKIE, token)],
      "next.example.test",
      "/privacy",
    );
    const deps = depsFor({ sessionFor });
    const res = await dispatchHookRequest(event, deps);
    expect(sessionFor).not.toHaveBeenCalled();
    expect(deps.honoFetch).toHaveBeenCalledTimes(1);
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(await res.text()).toBe("hono");
    // Static and Hono leaves stay cookie-free: the pass-through adds nothing.
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("a public Kit-owned request never invokes the session bridge and resolves without locals", async () => {
    // Public routes render outside the member-read boundary: even a session
    // cookie must not trigger a bridge read. Member-merge detail is pinned in
    // kit-member-dispatch; the real-bridge composition is pinned below.
    const store = createMemorySessionStore();
    const { token } = await seedSession(store);
    const seen: HookEventLike[] = [];
    const sessionFor = vi.fn(async (_event: HookEventLike) => guestLocals());
    const deps = depsFor({
      manifest: KIT_MANIFEST,
      sessionFor,
      resolve: vi.fn(async (hookEvent: HookEventLike) => {
        seen.push(hookEvent);
        return new Response("kit", { status: 200 });
      }),
    });
    const event = eventFor("/events/past", [await pair(SESSION_COOKIE, token)]);
    const res = await dispatchHookRequest(event, deps);
    expect(sessionFor).not.toHaveBeenCalled();
    expect(deps.resolve).toHaveBeenCalledTimes(1);
    expect(seen[0]!.locals).toBeUndefined();
    expect(res.status).toBe(200);
  });

  it("a failing bridge never 500s a Kit render: resolve still runs without locals", async () => {
    const deps = depsFor({
      manifest: KIT_MANIFEST,
      sessionFor: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    });
    const event = eventFor("/events/past");
    const res = await dispatchHookRequest(event, deps);
    expect(deps.resolve).toHaveBeenCalledTimes(1);
    expect(event.locals).toBeUndefined();
    expect(res.status).toBe(200);
  });

  it("a throwing probe never fails an authorized admin render: 200 with no Set-Cookie", async () => {
    const body = "<h1>admin</h1>";
    const resolve = vi.fn(
      async () => new Response(body, { headers: { "content-type": "text/html" } }),
    );
    const authStatusCookieFor = vi.fn(async (_event: HookEventLike) => {
      throw new Error("probe unavailable");
    });
    const deps = depsFor({
      manifest: [{ method: "GET", path: "/admin", enabled: true, reads: "public" as const }],
      authStatusCookieFor,
      resolve,
    });
    const request = new Request("https://next.example.test/admin", {
      headers: { host: "next.example.test" },
    });
    const event: HookEventLike = {
      request,
      url: new URL(request.url),
      route: { id: "/admin" },
      locals: {
        status: "authenticated",
        session: { userId: "42", username: "Rick", avatar: null, member: true, moderator: true },
        returnTo: null,
        joinResult: null,
        expiredWrite: null,
      },
    };
    const res = await dispatchHookRequest(event, deps);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(authStatusCookieFor).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("an untrusted host bypasses the bridge straight to Hono", async () => {
    const sessionFor = vi.fn(async (_event: HookEventLike) => guestLocals());
    const event = eventFor("/events/past", [], "evil.test");
    const deps = depsFor({ manifest: KIT_MANIFEST, sessionFor });
    await dispatchHookRequest(event, deps);
    expect(sessionFor).not.toHaveBeenCalled();
    expect(deps.honoFetch).toHaveBeenCalledTimes(1);
  });

  it("without a bridge the dispatch behaves exactly as before (no locals)", async () => {
    const deps = depsFor({ manifest: KIT_MANIFEST });
    const event = eventFor("/events/past");
    await dispatchHookRequest(event, deps);
    expect(deps.resolve).toHaveBeenCalledTimes(1);
    expect(event.locals).toBeUndefined();
  });
});

describe("kitSessionBridge (production hook composition)", () => {
  // The exact wiring web/src/hooks.server.ts passes as sessionFor: the real
  // secret, the shared store selection and the session/journey merge. Each
  // mutant below (empty journey secret, unknown remapped to guest, store
  // forced to the memory fallback) stays green without these pins.
  const bridgeEnvFor = (store: SessionStore, sessionSecret: string = SECRET) =>
    ({ SESSION_SECRET: sessionSecret, SESSION_STORE: store }) as unknown as Env;

  const bridgeEventFor = (pairs: string[] = [], method = "GET"): HookEventLike => {
    const request = new Request("https://next.example.test/events/past", {
      method,
      headers: pairs.length ? { cookie: pairs.join("; ") } : {},
    });
    return { request, url: new URL(request.url), route: { id: "/events/past" } };
  };

  it("resolves an authenticated session with the row's bits and the signed journey", async () => {
    const store = createMemorySessionStore();
    const { token } = await seedSession(store, { moderator: true });
    const locals = await kitSessionBridge(bridgeEnvFor(store))(
      bridgeEventFor([
        await pair(SESSION_COOKIE, token),
        await pair(LOGIN_NEXT_COOKIE, "/e/two"),
        await pair(JOIN_RESULT_COOKIE, "added"),
        await pair(EXPIRED_WRITE_COOKIE, "pending|/profile"),
      ]),
    );
    expect(locals.status).toBe("authenticated");
    expect(locals.session).toEqual({
      userId: "42",
      username: "Rick",
      avatar: null,
      member: true,
      moderator: true,
    });
    expect(locals.returnTo).toBe("/e/two");
    expect(locals.joinResult).toBe("added");
    expect(locals.expiredWrite).toBe("/profile");
  });

  it("reports unknown — never a false logout — when the store fails, keeping the journey", async () => {
    const store = createMemorySessionStore();
    const { token } = await seedSession(store);
    const failing: SessionStore = {
      ...store,
      get: async () => {
        throw new Error("connection refused");
      },
    };
    const locals = await kitSessionBridge(bridgeEnvFor(failing))(
      bridgeEventFor([await pair(SESSION_COOKIE, token), await pair(LOGIN_NEXT_COOKIE, "/events")]),
    );
    expect(locals.status).toBe("unknown");
    expect(locals.session).toBeNull();
    expect(locals.returnTo).toBe("/events");
  });

  it("reports unknown with an empty journey when no secret is configured", async () => {
    const store = createMemorySessionStore();
    const { token } = await seedSession(store);
    const locals = await kitSessionBridge(bridgeEnvFor(store, ""))(
      bridgeEventFor([await pair(SESSION_COOKIE, token)]),
    );
    expect(locals).toEqual({
      status: "unknown",
      session: null,
      returnTo: null,
      joinResult: null,
      expiredWrite: null,
    });
  });

  it("reports guest for a tampered session cookie while the journey still reads", async () => {
    const store = createMemorySessionStore();
    const { token } = await seedSession(store);
    const good = await pair(SESSION_COOKIE, token);
    const tampered = `${good.slice(0, -1)}${good.endsWith("A") ? "B" : "A"}`;
    const locals = await kitSessionBridge(bridgeEnvFor(store))(
      bridgeEventFor([tampered, await pair(LOGIN_NEXT_COOKIE, "/events")]),
    );
    expect(locals.status).toBe("guest");
    expect(locals.session).toBeNull();
    expect(locals.returnTo).toBe("/events");
  });

  it("a signed-but-hostile next never becomes a destination on an authenticated read", async () => {
    const store = createMemorySessionStore();
    const { token } = await seedSession(store);
    const locals = await kitSessionBridge(bridgeEnvFor(store))(
      bridgeEventFor([
        await pair(SESSION_COOKIE, token),
        await pair(LOGIN_NEXT_COOKIE, "https://evil.test/"),
      ]),
    );
    expect(locals.status).toBe("authenticated");
    expect(locals.returnTo).toBeNull();
  });

  it("plugs into the dispatch as sessionFor: a member request merges real bridge locals", async () => {
    // Public routes skip the bridge, so the production composition is pinned
    // on a member route: the real bridge names the viewer, the keyed read
    // declares its subject, and the audit row is written before release.
    const store = createMemorySessionStore();
    const viewer = "100000000000000101";
    const subject = "100000000000000102";
    const { token } = await seedSession(store, { userId: viewer });
    const request = new Request(`https://next.example.test/members/${subject}`, {
      headers: { host: "next.example.test", cookie: await pair(SESSION_COOKIE, token) },
    });
    const event: HookEventLike = {
      request,
      url: new URL(request.url),
      route: { id: "/members/[id]" },
    };
    const seen: HookEventLike[] = [];
    const resolve = vi.fn(async (hookEvent: HookEventLike) => {
      seen.push(hookEvent);
      return new Response(
        await keyedMemberRead(async () => {
          memberQueryPermit();
          declareMemberResult([subject]);
          return "kit";
        }),
      );
    });
    const audited: AccessEntry[] = [];
    const res = await dispatchHookRequest(event, {
      appUrl: "https://next.example.test",
      honoFetch: async () => new Response("hono", { status: 200 }),
      resolve,
      manifest: [
        {
          method: "GET",
          path: "/members/:id",
          enabled: true,
          reads: { resource: "profile", action: "view" as const, route: "profile" },
        },
      ],
      sessionFor: kitSessionBridge(bridgeEnvFor(store)),
      accessSink: async () => async (entry: AccessEntry) => {
        audited.push(entry);
        return true;
      },
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect((seen[0]!.locals as KitLocals).status).toBe("authenticated");
    expect((seen[0]!.locals as KitLocals).session?.userId).toBe(viewer);
    expect(res.status).toBe(200);
    expect(audited).toHaveLength(1);
  });

  it("preserves a valid join flash on a released non-profile member page", async () => {
    const store = createMemorySessionStore();
    const viewer = "100000000000000101";
    const { token } = await seedSession(store, { userId: viewer });
    const request = new Request("https://next.example.test/leaderboards/members", {
      headers: {
        host: "next.example.test",
        cookie: [await pair(SESSION_COOKIE, token), await pair(JOIN_RESULT_COOKIE, "added")].join(
          "; ",
        ),
      },
    });
    const event: HookEventLike = {
      request,
      url: new URL(request.url),
      route: { id: "/leaderboards/members" },
    };
    const audited: AccessEntry[] = [];
    const res = await dispatchHookRequest(event, {
      appUrl: "https://next.example.test",
      honoFetch: async () => new Response("hono", { status: 200 }),
      manifest: ROUTE_MANIFEST,
      resolve: async () =>
        new Response(
          await keyedMemberRead(async () => {
            memberQueryPermit();
            declareMemberResult(["100000000000000102"]);
            return "<html>members</html>";
          }),
          {
            status: 200,
            headers: { "content-type": "text/html" },
          },
        ),
      sessionFor: kitSessionBridge(bridgeEnvFor(store)),
      accessSink: async () => async (entry) => {
        audited.push(entry);
        return true;
      },
    });

    expect((event.locals as KitLocals).status).toBe("authenticated");
    expect((event.locals as KitLocals).joinResult).toBe("added");
    expect(res.status).toBe(200);
    expect(audited).toHaveLength(1);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(
      res.headers.getSetCookie().some((cookie) => cookie.startsWith(`${JOIN_RESULT_COOKIE}=`)),
    ).toBe(false);
  });
});

describe("kitAuthStatusCookieFor (moderator admin documents only)", () => {
  it("signs the live session lineage with the Hono cookie scope", async () => {
    const store = createMemorySessionStore();
    const { token, row } = await seedSession(store, { moderator: true });
    const request = new Request("https://next.example.test/admin", {
      headers: { cookie: await pair(SESSION_COOKIE, token) },
    });
    const event: HookEventLike = {
      request,
      url: new URL(request.url),
      route: { id: "/admin" },
      locals: {
        status: "authenticated",
        session: {
          userId: row.userId,
          username: row.username,
          avatar: row.avatar,
          member: row.member,
          moderator: true,
        },
        returnTo: null,
        joinResult: null,
        expiredWrite: null,
      },
    };
    expect((await parseSigned(request.headers.get("cookie") ?? "", SECRET))[SESSION_COOKIE]).toBe(
      token,
    );
    expect(await store.statusHash(row.tokenHash)).not.toBeNull();
    const write = await kitAuthStatusCookieFor({
      SESSION_SECRET: SECRET,
      SESSION_STORE: store,
    } as unknown as Env)(event);

    expect(write).toContain(`${AUTH_STATUS_COOKIE}=`);
    for (const flag of [
      "Path=/",
      "Secure",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${SESSION_TTL_SECONDS}`,
    ]) {
      expect(write).toContain(flag);
    }
    expect(write).not.toMatch(/Domain=/i);
    const cookies = await parseSigned(write!, SECRET);
    expect(cookies[AUTH_STATUS_COOKIE]).toBe(await store.statusHash(row.tokenHash));
  });

  it("does not read or sign a probe for non-moderators or non-admin routes", async () => {
    const store = createMemorySessionStore();
    const { token } = await seedSession(store, { moderator: true });
    const statusHash = vi.spyOn(store, "statusHash");
    const writeCookie = kitAuthStatusCookieFor({
      SESSION_SECRET: SECRET,
      SESSION_STORE: store,
    } as unknown as Env);
    const request = new Request("https://next.example.test/admin", {
      headers: { cookie: await pair(SESSION_COOKIE, token) },
    });
    const moderatorLocals: KitLocals = {
      status: "authenticated",
      session: { userId: "42", username: "Rick", avatar: null, member: true, moderator: true },
      returnTo: null,
      joinResult: null,
      expiredWrite: null,
    };
    const base: HookEventLike = {
      request,
      url: new URL(request.url),
      route: { id: "/admin" },
      locals: moderatorLocals,
    };
    expect(
      await writeCookie({
        ...base,
        locals: {
          ...moderatorLocals,
          session: { ...moderatorLocals.session!, moderator: false },
        },
      }),
    ).toBeNull();
    expect(
      await writeCookie({
        ...base,
        url: new URL("https://next.example.test/events/past"),
      }),
    ).toBeNull();
    expect(
      await writeCookie({
        ...base,
        request: new Request(request.url, { method: "POST", headers: request.headers }),
      }),
    ).toBeNull();
    expect(statusHash).not.toHaveBeenCalled();
  });

  it("returns no probe when the status hash lookup throws", async () => {
    const store = createMemorySessionStore();
    const { token } = await seedSession(store, { moderator: true });
    const statusHash = vi.spyOn(store, "statusHash").mockRejectedValueOnce(new Error("store down"));
    const request = requestWith([await pair(SESSION_COOKIE, token)], "GET", "/admin");
    const event: HookEventLike = {
      request,
      url: new URL(request.url),
      route: { id: "/admin" },
      locals: {
        status: "authenticated",
        session: { userId: "42", username: "Rick", avatar: null, member: true, moderator: true },
        returnTo: null,
        joinResult: null,
        expiredWrite: null,
      },
    };
    const writeCookie = kitAuthStatusCookieFor({
      SESSION_SECRET: SECRET,
      SESSION_STORE: store,
    } as unknown as Env);

    expect(await writeCookie(event)).toBeNull();
    expect(statusHash).toHaveBeenCalledTimes(1);
  });

  it("refuses to sign a probe value that is not a 64-hex status hash", async () => {
    const store = createMemorySessionStore();
    const { token } = await seedSession(store, { moderator: true });
    const request = requestWith([await pair(SESSION_COOKIE, token)], "GET", "/admin");
    const event: HookEventLike = {
      request,
      url: new URL(request.url),
      route: { id: "/admin" },
      locals: {
        status: "authenticated",
        session: { userId: "42", username: "Rick", avatar: null, member: true, moderator: true },
        returnTo: null,
        joinResult: null,
        expiredWrite: null,
      },
    };
    const writeCookie = kitAuthStatusCookieFor({
      SESSION_SECRET: SECRET,
      SESSION_STORE: store,
    } as unknown as Env);
    // The recorded cookie-write boundary: the writer asserts the 64-hex
    // shape before signing, so a bearer, short value, or uppercase hash a
    // broken store might return is never signed into a probe cookie (the
    // read path accepts only lowercase 64-hex, src/auth-status.ts).
    for (const bad of [token, "abc123", "A".repeat(64), "g".repeat(64), `${"a".repeat(63)} `]) {
      vi.spyOn(store, "statusHash").mockResolvedValueOnce(bad);
      expect(await writeCookie(event)).toBeNull();
    }
  });
});
