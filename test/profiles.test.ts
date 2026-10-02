// route-inventory: GET /profile
// route-inventory: GET /members/:user
// route-inventory: PATCH /members/:user
// route-inventory: POST /members/:user
// W7 member journeys: /profile, /members/:user, PATCH /members/:user (TOG-9686).
//
// Exposure tests come first by design: the matrix pins what a guest, a signed-in
// non-member, a member and a moderator can each see BEFORE anyone reads the
// implementation. Two layers, same seams as the admin slice:
// - Matrix (memory doubles, always runs in CI): exposure, access-log
//   attribution, fail-closed log, owner-only PATCH, 30/min throttle.
// - Live (agent-testdb, skipped without DATABASE_URL): real users/profiles/
//   member_data_access_logs rows through the drizzle store.

import { Hono, type Context } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccessEntry } from "../src/access-log";
import { memberDataAccessLogs } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { profiles, users } from "../src/db/schema";
import type { Env } from "../src/env";
import { sameOrigin } from "../src/same-origin";
import { JOIN_RESULT_COOKIE } from "../src/return-journey";
import { recordAccess } from "../src/admin/store";
import { profilesApp, PROFILE_WRITE_THROTTLE_PER_MINUTE } from "../src/profiles/routes";
import {
  createDbProfileStore,
  createMemoryProfileStore,
  type MemberView,
} from "../src/profiles/store";
import { validateProfile } from "../src/profiles/validation";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

const ALICE = { userId: "100000000000000001", username: "alice", member: true, moderator: false };
const BOB = { userId: "100000000000000002", username: "bob", member: true, moderator: false };
const MOD = { userId: "100000000000000003", username: "mod", member: true, moderator: true };
const OUTSIDER = {
  userId: "100000000000000004",
  username: "outsider",
  member: false,
  moderator: false,
};

async function cookieFor(store: SessionStore, row: typeof ALICE): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.username,
    avatar: null,
    member: row.member,
    moderator: row.moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const serialized = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return serialized.split(";")[0]!;
}

const seedMembers = (): MemberView[] => [
  {
    id: ALICE.userId,
    username: "alice",
    avatar: null,
    bio: "Alice bio <b>x</b>",
    games: ["Chess", "Go"],
    timezone: "Europe/London",
  },
  { id: BOB.userId, username: "bob", avatar: "abc123", bio: null, games: [], timezone: null },
  { id: MOD.userId, username: "mod", avatar: null, bio: null, games: [], timezone: null },
];

function harness(
  opts: {
    logDown?: boolean;
    throttle?: (b: string) => Promise<{ limited: false } | { limited: true; retryAfter: number }>;
  } = {},
) {
  const sessions = createMemorySessionStore();
  const store = createMemoryProfileStore(seedMembers());
  const log: AccessEntry[] = [];
  const app = profilesApp({
    sessionStore: sessions,
    store,
    accessLog: async (e) => {
      if (opts.logDown) throw new Error("log down");
      // Same attribution rule as the real recorder: viewer is never a subject, empty writes nothing.
      const subjects = [...new Set(e.subjectUserIds.filter((s) => s !== e.viewerUserId))];
      if (subjects.length === 0) return false;
      log.push({ ...e, subjectUserIds: subjects });
      return true;
    },
    ...(opts.throttle ? { throttle: opts.throttle } : {}),
  });
  return { app, sessions, store, log };
}

describe("exposure matrix: who sees what (memory doubles)", () => {
  it("guest: reads go to OAuth, writes to explicit recovery, nothing rendered or logged", async () => {
    const { app, log } = harness();
    for (const [method, path] of [
      ["GET", "/profile"],
      ["GET", `/members/${ALICE.userId}`],
      ["PATCH", `/members/${ALICE.userId}`],
    ] as const) {
      const res = await app.request(path, { method }, env);
      expect(res.status, `${method} ${path}`).toBe(method === "PATCH" ? 303 : 302);
      expect(res.headers.get("location")).toBe(
        method === "PATCH" ? "/auth/recover?next=%2Fprofile" : "/auth/discord",
      );
      expect(await res.text()).not.toContain("alice");
    }
    expect(log).toHaveLength(0);
  });

  it("a cookie with no live session row is a guest (revoked/expired/forged)", async () => {
    const { app } = harness();
    const res = await app.request(
      "/profile",
      { headers: { cookie: "__Host-two_session=garbage" } },
      env,
    );
    expect(res.status).toBe(302);
  });

  it("session failure refuses contents with no-store and class-only diagnostics", async () => {
    const { app, sessions, store, log } = harness();
    const cookie = await cookieFor(sessions, BOB);
    const find = vi.spyOn(store, "find");
    const fail = vi
      .spyOn(sessions, "get")
      .mockRejectedValue(new Error(`private-query ${BOB.userId} ${ALICE.userId}`));
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await app.request(`/members/${ALICE.userId}`, { headers: { cookie } }, env);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).not.toMatch(/alice|private-query|10000000000000000/);
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
        "profiles could not resolve the session; refusing.",
        { exception: "Error" },
      );
      expect(find).not.toHaveBeenCalled();
      expect(log).toHaveLength(0);
    } finally {
      fail.mockRestore();
      find.mockRestore();
      diagnostic.mockRestore();
    }
  });

  it("signed-in non-member: 403 on every route, nothing rendered, nothing logged", async () => {
    const { app, sessions, log } = harness();
    const headers = { cookie: await cookieFor(sessions, OUTSIDER) };
    for (const path of ["/profile", `/members/${ALICE.userId}`]) {
      const res = await app.request(path, { headers }, env);
      expect(res.status, path).toBe(403);
      expect(await res.text()).not.toContain("alice");
    }
    expect(log).toHaveLength(0);
  });

  it("member sees another member's public profile, escaped, private-no-store, noindex", async () => {
    const { app, sessions } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}`,
      { headers: { cookie: await cookieFor(sessions, BOB) } },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const html = await res.text();
    expect(html).toContain("alice");
    expect(html).toContain("Chess");
    expect(html).toContain("Europe/London");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    // Not the owner: no edit form.
    expect(html).not.toContain("Edit your profile");
  });

  it("moderator sees exactly what a member sees on a profile (no extra fields, no edit form on others)", async () => {
    const { app, sessions } = harness();
    const asMember = await (
      await app.request(
        `/members/${ALICE.userId}`,
        { headers: { cookie: await cookieFor(sessions, BOB) } },
        env,
      )
    ).text();
    const asMod = await (
      await app.request(
        `/members/${ALICE.userId}`,
        { headers: { cookie: await cookieFor(sessions, MOD) } },
        env,
      )
    ).text();
    expect(asMod).toBe(asMember);
  });

  it("owner sees the edit form on their own profile; /profile is the viewer's own", async () => {
    const { app, sessions } = harness();
    const res = await app.request(
      "/profile",
      { headers: { cookie: await cookieFor(sessions, ALICE) } },
      env,
    );
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Edit your profile");
    expect(html).toContain("alice");
  });

  it("unknown and malformed ids are 404 with no log row", async () => {
    const { app, sessions, log } = harness();
    const headers = { cookie: await cookieFor(sessions, ALICE) };
    for (const id of ["999999999999999999", "not-a-snowflake", "1"]) {
      expect((await app.request(`/members/${id}`, { headers }, env)).status, id).toBe(404);
    }
    expect(log).toHaveLength(0);
  });
});

describe("member-access-log (memory doubles)", () => {
  it("reading another member writes exactly one row naming viewer, subject and route name", async () => {
    const { app, sessions, log } = harness();
    await app.request(
      `/members/${ALICE.userId}`,
      { headers: { cookie: await cookieFor(sessions, BOB) } },
      env,
    );
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      viewerDiscordId: BOB.userId,
      resource: "profile",
      action: "view",
      subjectUserIds: [ALICE.userId],
      route: "profiles.show",
    });
  });

  it.each(["/profile", `/members/${ALICE.userId}`])(
    "HEAD %s leaves the banner for exactly one visible GET",
    async (path) => {
      const { app, sessions } = harness();
      const session = await cookieFor(sessions, BOB);
      const flash = (
        await serializeSigned(JOIN_RESULT_COOKIE, "already_member", SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
      const cookie = `${session}; ${flash}`;
      const head = await app.request(path, { method: "HEAD", headers: { cookie } }, env);
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(head.headers.getSetCookie().some((c) => c.startsWith(`${JOIN_RESULT_COOKIE}=`))).toBe(
        false,
      );

      const first = await app.request(path, { headers: { cookie } }, env);
      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toBe("private, no-store");
      expect(await first.text()).toContain('data-testid="join-result"');
      expect(first.headers.getSetCookie().join("\n")).toContain(
        `${JOIN_RESULT_COOKIE}=; Max-Age=0`,
      );
      const second = await app.request(path, { headers: { cookie: session } }, env);
      expect(await second.text()).not.toContain('data-testid="join-result"');
    },
  );

  it("a moderator's read is logged the same as a member's", async () => {
    const { app, sessions, log } = harness();
    await app.request(
      `/members/${ALICE.userId}`,
      { headers: { cookie: await cookieFor(sessions, MOD) } },
      env,
    );
    expect(log.map((l) => l.viewerDiscordId)).toEqual([MOD.userId]);
  });

  it("reading your own profile names no other member, so writes no row (viewer is never their own subject)", async () => {
    const { app, sessions, log } = harness();
    await app.request("/profile", { headers: { cookie: await cookieFor(sessions, ALICE) } }, env);
    expect(log).toHaveLength(0);
  });

  it("never records a URL, username or bio: the row carries ids and a route name only", async () => {
    const { app, sessions, log } = harness();
    await app.request(
      `/members/${ALICE.userId}?q=secret-search`,
      { headers: { cookie: await cookieFor(sessions, BOB) } },
      env,
    );
    const dump = JSON.stringify(log);
    expect(dump).not.toContain("secret-search");
    expect(dump).not.toContain("alice");
    expect(dump).not.toContain("Chess");
  });

  it("fails closed: log down → 503 and the profile is not served (enforce is the default)", async () => {
    const { app, sessions } = harness({ logDown: true });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request(
      `/members/${ALICE.userId}`,
      { headers: { cookie: await cookieFor(sessions, BOB) } },
      env,
    );
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).not.toContain("alice");
    expect(JSON.stringify(spy.mock.calls)).not.toContain(ALICE.userId);
    spy.mockRestore();
  });

  it.each(["already_member", "added"])(
    "audit-failure 503 preserves %s until one successful display",
    async (result) => {
      const opts = { logDown: true };
      const { app, sessions, log } = harness(opts);
      const session = await cookieFor(sessions, BOB);
      const flash = (
        await serializeSigned(JOIN_RESULT_COOKIE, result, SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
      const jar = new Map([session, flash].map((pair) => [pair.slice(0, pair.indexOf("=")), pair]));
      const apply = (res: Response) => {
        for (const cookie of res.headers.getSetCookie()) {
          const pair = cookie.split(";")[0]!;
          const name = pair.slice(0, pair.indexOf("="));
          if (/max-age=0/i.test(cookie)) jar.delete(name);
          else jar.set(name, pair);
        }
      };
      const get = () =>
        app.request(
          `/members/${ALICE.userId}`,
          {
            headers: { cookie: [...jar.values()].join("; ") },
          },
          env,
        );
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const refused = await get();
        expect(refused.status).toBe(503);
        expect(refused.headers.get("cache-control")).toBe("private, no-store");
        const refusedBody = await refused.text();
        expect(refusedBody).toContain("Together We Own");
        expect(refusedBody).toContain('<a class="brand" href="/"');
        expect(refusedBody).not.toContain("alice");
        expect(log).toHaveLength(0);
        expect(spy).toHaveBeenCalled();
        apply(refused);
        expect(jar.get(JOIN_RESULT_COOKIE)).toBe(flash);

        opts.logDown = false;
        const first = await get();
        expect(first.status).toBe(200);
        expect(first.headers.get("cache-control")).toBe("private, no-store");
        const html = await first.text();
        expect(html).toContain('data-testid="join-result"');
        if (result === "already_member") expect(html).toContain('data-testid="reinvite-link"');
        else
          expect(html).toContain(
            "You are in. Finish Discord&#39;s rules screening before you can post.",
          );
        expect(log).toHaveLength(1);
        expect(log[0]?.subjectUserIds).toEqual([ALICE.userId]);
        apply(first);
        expect(jar.has(JOIN_RESULT_COOKIE)).toBe(false);

        const second = await get();
        expect(second.status).toBe(200);
        expect(await second.text()).not.toContain('data-testid="join-result"');
        expect(log).toHaveLength(2);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("MEMBER_ACCESS_LOG_ENFORCE=false cannot bypass the keyed read boundary", async () => {
    const { app, sessions } = harness({ logDown: true });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request(
      `/members/${ALICE.userId}`,
      { headers: { cookie: await cookieFor(sessions, BOB) } },
      { ...env, MEMBER_ACCESS_LOG_ENFORCE: "false" },
    );
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("alice");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("PATCH /members/:user (memory doubles)", () => {
  const form = (
    cookie: string,
    fields: Record<string, string>,
    extra: Record<string, string> = {},
  ) => ({
    method: "PATCH" as const,
    headers: {
      cookie,
      origin: APP_URL,
      "content-type": "application/x-www-form-urlencoded",
      ...extra,
    },
    body: new URLSearchParams(fields),
  });

  it("owner saves bio/games/timezone: trimmed, de-duplicated, 303 back to the profile", async () => {
    const { app, sessions, store } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}`,
      form(await cookieFor(sessions, ALICE), {
        bio: "  hello  ",
        games_text: "Chess\n Go \n\nChess\r\nDoom",
        timezone: "America/New_York",
      }),
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/members/${ALICE.userId}`);
    expect(store.rows.get(ALICE.userId)).toMatchObject({
      bio: "hello",
      games: ["Chess", "Go", "Doom"],
      timezone: "America/New_York",
    });
  });

  it("the edit form's POST + _method=PATCH works the same", async () => {
    const { app, sessions, store } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}`,
      {
        ...form(await cookieFor(sessions, ALICE), {
          _method: "PATCH",
          bio: "via form",
          games_text: "",
          timezone: "",
        }),
        method: "POST",
      },
      env,
    );
    expect(res.status).toBe(303);
    expect(store.rows.get(ALICE.userId)).toMatchObject({
      bio: "via form",
      games: [],
      timezone: null,
    });
  });

  it("a member cannot edit someone else's profile, and neither can a moderator", async () => {
    const { app, sessions, store } = harness();
    for (const who of [BOB, MOD]) {
      const res = await app.request(
        `/members/${ALICE.userId}`,
        form(await cookieFor(sessions, who), { bio: "pwned", games_text: "" }),
        env,
      );
      expect(res.status, who.username).toBe(403);
    }
    expect(store.rows.get(ALICE.userId)!.bio).toBe("Alice bio <b>x</b>");
  });

  it("wrong origin is refused before anything else", async () => {
    const { app, sessions, store } = harness();
    const mounted = new Hono<{ Bindings: Env }>().use("*", sameOrigin).route("/", app);
    const res = await mounted.request(
      `/members/${ALICE.userId}`,
      form(
        await cookieFor(sessions, ALICE),
        { bio: "x", games_text: "" },
        { origin: "https://evil.example" },
      ),
      env,
    );
    expect(res.status).toBe(403);
    expect(store.rows.get(ALICE.userId)!.bio).not.toBe("x");
  });

  it("validation failures are 422, re-render the form with errors, and change nothing", async () => {
    const { app, sessions, store } = harness();
    const cookie = await cookieFor(sessions, ALICE);
    const bad: Record<string, string>[] = [
      { bio: "x".repeat(1001), games_text: "" },
      { bio: "", games_text: "g".repeat(81) },
      { bio: "", games_text: Array.from({ length: 21 }, (_, i) => `game${i}`).join("\n") },
      { bio: "", games_text: "", timezone: "Mars/Olympus" },
    ];
    for (const fields of bad) {
      const res = await app.request(`/members/${ALICE.userId}`, form(cookie, fields), env);
      expect(res.status).toBe(422);
      const html = await res.text();
      expect(html).toContain('<div role="alert" tabindex="-1" data-testid="profile-error"><ul>');
      expect(html).not.toContain('<ul role="alert"');
    }
    expect(store.rows.get(ALICE.userId)!.bio).toBe("Alice bio <b>x</b>");
  });

  it.each([false, true])(
    "upload read failures return 400 without saving (partial: %s)",
    async (partial) => {
      const { app, sessions, store } = harness();
      const escaped = vi.fn((_err: Error, c: Context) => c.text("Internal Server Error", 500));
      app.onError(escaped);
      const save = vi.spyOn(store, "save");
      let reads = 0;
      const body = new ReadableStream(
        {
          pull(controller) {
            if (partial && reads++ === 0) controller.enqueue(new TextEncoder().encode('{"bio":'));
            else controller.error(new Error("fixture upload failure, do not expose"));
          },
        },
        { highWaterMark: 0 },
      );
      const response = await app.request(
        new Request(`http://localhost/members/${ALICE.userId}`, {
          method: "PATCH",
          body,
          duplex: "half",
          headers: { cookie: await cookieFor(sessions, ALICE), "content-type": "application/json" },
        } as RequestInit),
        undefined,
        env,
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Bad request");
      expect(escaped).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(store.rows.get(ALICE.userId)!.bio).toBe("Alice bio <b>x</b>");
    },
  );

  it("throttles at 30/min per member with the one 429 envelope", async () => {
    let n = 0;
    const { app, sessions } = harness({
      throttle: async () =>
        ++n > PROFILE_WRITE_THROTTLE_PER_MINUTE
          ? { limited: true, retryAfter: 17 }
          : { limited: false },
    });
    const cookie = await cookieFor(sessions, ALICE);
    let last!: Response;
    for (let i = 0; i < PROFILE_WRITE_THROTTLE_PER_MINUTE + 1; i++) {
      last = await app.request(
        `/members/${ALICE.userId}`,
        form(cookie, { bio: `b${i}`, games_text: "" }, { accept: "application/json" }),
        env,
      );
    }
    expect(last.status).toBe(429);
    expect(last.headers.get("retry-after")).toBe("17");
    expect(await last.json()).toMatchObject({ reason: "rate_limited", retry_after: 17 });
  });
});

describe("validateProfile", () => {
  it("accepts the array shape and the legacy limits", () => {
    expect(validateProfile({ bio: "  ", games: [" a ", "a", "b"], timezone: "" })).toEqual({
      ok: true,
      attrs: { bio: null, games: ["a", "b"], timezone: null },
    });
    expect(validateProfile({ bio: "x".repeat(1000), games: [], timezone: "UTC" }).ok).toBe(true);
  });
  it("rejects non-string games and non-list games", () => {
    expect(validateProfile({ games: [1] }).ok).toBe(false);
    expect(validateProfile({ games: "nope" }).ok).toBe(false);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("member journeys, live rows (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
  });
  afterEach(() => fixture?.reset());
  afterAll(() => fixture?.dispose());
  const wipe = () => fixture.reset();
  const setup = async () => {
    await wipe();
    await db.insert(users).values([
      { id: ALICE.userId, username: "alice", member: true },
      { id: BOB.userId, username: "bob", member: true },
    ]);
    await db
      .insert(profiles)
      .values({ userId: ALICE.userId, bio: "live bio", games: ["Chess"], timezone: "UTC" });
    const sessions = createMemorySessionStore();
    const app = profilesApp({
      sessionStore: sessions,
      store: createDbProfileStore(db),
      accessLog: (e) => recordAccess(db, e),
      throttle: async () => ({ limited: false }),
    });
    return { app, sessions };
  };

  it("every member-data read writes an access-log row; self-reads and 404s write none", async () => {
    const { app, sessions } = await setup();
    const bob = { cookie: await cookieFor(sessions, BOB) };
    expect((await app.request(`/members/${ALICE.userId}`, { headers: bob }, env)).status).toBe(200);
    expect((await app.request(`/members/${ALICE.userId}`, { headers: bob }, env)).status).toBe(200);
    expect((await app.request(`/members/999999999999999999`, { headers: bob }, env)).status).toBe(
      404,
    );
    expect((await app.request(`/profile`, { headers: bob }, env)).status).toBe(200);
    const rows = await db.select().from(memberDataAccessLogs);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({
        viewerDiscordId: BOB.userId,
        resource: "profile",
        action: "view",
        subjectUserIds: [ALICE.userId],
        subjectCount: 1,
        route: "profiles.show",
      });
    }
  });

  it("guest and non-member reads write no row and expose no data", async () => {
    const { app, sessions } = await setup();
    expect((await app.request(`/members/${ALICE.userId}`, {}, env)).status).toBe(302);
    const out = { cookie: await cookieFor(sessions, OUTSIDER) };
    expect((await app.request(`/members/${ALICE.userId}`, { headers: out }, env)).status).toBe(403);
    expect(await db.select().from(memberDataAccessLogs)).toHaveLength(0);
  });

  it("PATCH persists through Postgres, survives a roster refresh, and is visible on the next read", async () => {
    const { app, sessions } = await setup();
    const cookie = await cookieFor(sessions, BOB);
    const res = await app.request(
      `/members/${BOB.userId}`,
      {
        method: "PATCH",
        headers: { cookie, origin: APP_URL, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          bio: "bob writes",
          games_text: "Doom\nQuake",
          timezone: "Europe/Paris",
        }),
      },
      env,
    );
    expect(res.status).toBe(303);
    const again = await app.request(`/members/${BOB.userId}`, { headers: { cookie } }, env);
    const html = await again.text();
    expect(html).toContain("bob writes");
    expect(html).toContain("Quake");
    // A second save is an update, not a duplicate row.
    await app.request(
      `/members/${BOB.userId}`,
      {
        method: "PATCH",
        headers: { cookie, origin: APP_URL, "content-type": "application/json" },
        body: JSON.stringify({ bio: "v2", games: [], timezone: null }),
      },
      env,
    );
    expect((await db.select().from(profiles)).filter((p) => p.userId === BOB.userId)).toHaveLength(
      1,
    );
  });

  it("a throwing sink with real profile rows refuses the read (503)", async () => {
    await setup();
    const sessions = createMemorySessionStore();
    const app = profilesApp({
      sessionStore: sessions,
      store: createDbProfileStore(db),
      accessLog: async () => {
        throw new Error("insert failed");
      },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request(
      `/members/${ALICE.userId}`,
      { headers: { cookie: await cookieFor(sessions, BOB) } },
      env,
    );
    expect(res.status).toBe(503);
    spy.mockRestore();
  });
});
