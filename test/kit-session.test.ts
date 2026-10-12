// Kit session bridge pins (TOG-22116): the shared request/session service the
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
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import { AUTH_STATUS_COOKIE } from "../src/auth-status";
import { SESSION_COOKIE } from "../src/session-cookie";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
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
  readReturnJourney,
  resolveRequestSession,
} from "../src/kit-session";

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
    expect(
      await resolveRequestSession(requestWith([]), { sessionSecret: SECRET, store }),
    ).toEqual({ status: "guest", session: null });
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

  it.each(["added", "already_member"] as const)("reads the join flash %s without consuming", async (
    result,
  ) => {
    const journey = await readReturnJourney(
      requestWith([await pair(JOIN_RESULT_COOKIE, result)]),
      SECRET,
    );
    expect(journey.joinResult).toBe(result);
  });

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
