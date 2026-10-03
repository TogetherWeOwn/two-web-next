// route-inventory: GET /auth/discord
// route-inventory: GET /auth/discord/callback
// route-inventory: GET /join/discord
// route-inventory: GET /join/callback
// route-inventory: POST /events
// route-inventory: PATCH /events/:key
// route-inventory: POST /events/:key/publish
// route-inventory: POST /events/:key/cancel
// route-inventory: GET /events.json
// route-inventory: PATCH /members/:user
//
// W15b (TOG-12088, slice of TOG-9697): exposure + throttle + race rows that do
// not need the RSVP islands (TOG-9839). Legacy source: TogetherWeOwn/two-web
// @ 4f5a0f2773e46de7e8ce8ca701427711c617cdee (read-only; no PHP was run).
// Line numbers below are `it()` declaration lines in that snapshot.
//
// Ported here (new behavior pins):
// | Legacy Pest row | Vitest row in this file |
// |---|---|
// | ThrottleEnvelopeTest.php:15,26,42,50 (one JSON 429 envelope on each OAuth throttle) | OAuth envelope table (budget then exact envelope) |
// | ThrottleEnvelopeTest.php:100 (branded browser 429, no stack) | browser 429 page test |
// | OAuthReplayAndThrottleTest.php:196,215,230 (429 past the limit, nothing revealed) | same table: no discord.com / no stack words in the 429 body |
// | OAuthReplayAndThrottleTest.php:246 (throttle on all four OAuth routes) | table covers all four, incl. GET /auth/discord (guard added in src/index.tsx) |
// | EventJsonAccessTest.php:27,39,50,71 (guest 401; member sees published/cancelled/past; moderator also drafts; allowlisted fields) | events.json matrix + exact-keys test |
// | EventPolicyTest.php:19,24,31,38,45 (moderator-only create/update/publish/cancel/pause) | moderator-write exposure matrix (guest 401 / member 403 / moderator passes gate) |
// | UserPolicyTest.php:30,38 (owner-only edit; moderator has no extra profile rights) | same matrix on PATCH /members/:user |
// | JoinDenialMatrixTest.php:107 (double-submitted callback is one idempotent join) | behavioral equivalent: profile first-save race converges on one row (roster upsert idempotence itself is proved in test/roster.test.ts) |
// | ProfileCreationRaceTest.php:121 (concurrent first saves serialize to one row) | same, via the Next upsert writer (mechanism differs: ON CONFLICT, not a parent lock) |
//
// Already ported elsewhere (cited, not duplicated; listed for traceability only):
// | Legacy row | Existing proof |
// |---|---|
// | ThrottleCoverageTest.php:60,74,97,106,127 (every-POST-throttled audit) | test/throttle.test.ts |
// | RsvpThrottleTest.php:21,42,78,104 (rsvp-writes bucket, 13th-write 429, bucket isolation) | test/throttle.test.ts budgets + test/rsvp.test.ts:319,333,346 |
// | RsvpAuthGateTest.php (guest PUT/DELETE 401, writes nothing) | test/rsvp.test.ts:155 |
// | EventJsonAccessTest.php:33 (browser guest redirect) | diverged: Next answers JSON 401 for every guest (no browser redirect); pinned as 401 here |
// | EventPolicyTest.php:55,64,73,81,88,97,109,116,124,130 + UserPolicyTest.php:16,24 | test/events.test.ts (draft 403/200, guest 401, /e/:key 403/200/410) + test/profiles.test.ts (owner-only PATCH, member/mod equality) |
// | MemberDirectoryExposureTest.php (guest redirects, public pages leak-free, 1-going count) | test/member-exposure.test.ts + test/profiles.test.ts exposure matrix |
// | NotFoundTest.php (real 404s, no catch-all) | test/seo-headers.test.ts URL-freeze + test/route-inventory.test.ts |
// | RsvpUniqueLockRaceTest.php (write-back lock never rolls back the answer) | test/commit-before-dispatch.test.ts |
// | RsvpCapacityRaceTest.php:110,177,198 (last-seat race, stand-down, re-answer) | test/rsvp.test.ts:355,365,375,384 |
// | SharedLogoutTest.php (logout form/CSRF) | diverged: Next uses same-origin guard, not CSRF tokens; covered by test/auth-acceptance.test.ts + test/e2e-db.test.ts |
// | ProductionRouteAllowlistTest.php:149,187 (exact production surface, QA absent) | test/route-inventory.test.ts + fixture |
//
// Intentional Next divergences (not gaps):
// - X-RateLimit-Limit / X-RateLimit-Remaining: legacy RsvpThrottleTest.php:42
//   asserts them, but no Next throttle emits them — the one 429 shape
//   (src/errors.tsx rateLimitExceeded) standardizes on Retry-After + the
//   {reason, message, retry_after} envelope across human and machine ingress.
// - Livewire mount gates (MemberDirectoryExposureTest.php:77, SpamTrap traps):
//   no Livewire endpoint exists; island HTML is served after the member gate.
// - PATCH /members/{user} guest 405: legacy deleted the writer (TOG-8440);
//   Next deliberately restored it as the owner-only island writer (guest 302).
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import { profiles, users } from "../src/db/schema";
import type { Env } from "../src/env";
import { createDbProfileStore } from "../src/profiles/store";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
  type Sql,
} from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";

const baseEnv = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

// In-memory Sql double speaking exactly the two statements checkJoinThrottle
// emits (same shape as test/join.test.ts fakeSql). Anything else is a test bug.
function fakeThrottleSql() {
  const hits: { bucket: string; at: number }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head.includes("count(*)")) {
      const [bucket] = values as [string];
      const cutoff = Date.now() - 60_000;
      const rows = hits.filter((h) => h.bucket === bucket && h.at > cutoff);
      const wait =
        rows.length === 0
          ? 1
          : Math.max(
              1,
              Math.ceil((Math.min(...rows.map((r) => r.at)) + 60_000 - Date.now()) / 1000),
            );
      return [{ n: rows.length, wait }];
    }
    if (head.includes("INSERT INTO web_throttle_hits")) {
      hits.push({ bucket: values[0] as string, at: Date.now() });
      return [];
    }
    if (head.includes("DELETE FROM web_throttle_hits")) return [];
    // The join callback records one attempt row per terminal path (denied,
    // expired, error, added...); the throttle under test never depends on it.
    if (head.includes("INSERT INTO join_attempts")) return [];
    throw new Error(`fakeThrottleSql: unexpected statement: ${head.slice(0, 80)}`);
  }) as unknown as Sql;
  return sql;
}

// Fresh memory sessions + both throttle seams per test, so budgets never leak
// across rows. No Discord stub is needed: every request below is refused before
// any token exchange (bad state) or never fetches (redirects).
function isolatedThrottle() {
  const loginSql = fakeThrottleSql();
  const joinSql = fakeThrottleSql();
  const store = createMemorySessionStore();
  const env = {
    ...baseEnv,
    SESSION_STORE: store,
    THROTTLE_STORE: async () => loginSql,
    JOIN_DEPS: { store: async () => joinSql, now: () => 1_791_000_000_000 },
  } as unknown as Env;
  return { env };
}

async function cookieFor(
  store: SessionStore,
  row: { userId: string; member: boolean; moderator: boolean },
): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.userId,
    avatar: null,
    member: row.member,
    moderator: row.moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (
    await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
}

const MOD = { userId: "100000000000000111", member: true, moderator: true };
const MEMBER = { userId: "100000000000000112", member: true, moderator: false };

describe("OAuth throttle envelope (DB-free)", () => {
  // Ports ThrottleEnvelopeTest.php:15,26,42,50 + OAuthReplayAndThrottleTest.php
  // :196,215,230,246: each OAuth route answers past its 10/min budget with the
  // one JSON envelope, revealing nothing about accounts (no OAuth URL, no stack
  // words). Table-driven like the Pest originals' repeated shape.
  const routes = [
    { name: "login redirect", path: "/auth/discord", budget: 10, success: 302 },
    {
      name: "login callback",
      path: "/auth/discord/callback?code=stale&state=wrong",
      budget: 10,
      success: 302,
    },
    { name: "join redirect", path: "/join/discord", budget: 10, success: 302 },
    {
      name: "join callback",
      path: "/join/callback?code=stale&state=wrong",
      budget: 10,
      success: 200,
    },
  ] as const;

  it.each(routes)("$name: budget then the one 429 envelope", async ({ path, budget, success }) => {
    const { env } = isolatedThrottle();
    for (let i = 0; i < budget; i++) {
      expect((await app.request(path, {}, env)).status, `hit ${i + 1}`).toBe(success);
    }
    const limited = await app.request(path, { headers: { accept: "application/json" } }, env);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
    const body = (await limited.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["message", "reason", "retry_after"]);
    expect(body).toMatchObject({ reason: "rate_limited" });
    expect(typeof body.message).toBe("string");
    expect((body.message as string).length).toBeGreaterThan(0);
    expect(body.retry_after).toBe(Number(limited.headers.get("retry-after")));
    const text = JSON.stringify(body);
    expect(text).not.toContain("discord.com");
    expect(text).not.toContain("ThrottleRequestsException");
  });

  it("renders the branded browser 429 page without a stack", async () => {
    // Ports ThrottleEnvelopeTest.php:100. The branded copy is Next's own
    // ("Slow down a little" + error-join CTA, not the legacy discord-join id);
    // the contract pinned is: 429 + Retry-After + noindex + no internals.
    const { env } = isolatedThrottle();
    const path = "/auth/discord/callback?code=stale&state=wrong";
    for (let i = 0; i < 10; i++) await app.request(path, {}, env);
    const res = await app.request(path, { headers: { accept: "text/html" } }, env);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Slow down a little");
    expect(html).toContain('data-testid="error-join"');
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).not.toContain("ThrottleRequestsException");
  });
});

describe("moderator-write exposure matrix (DB-free)", () => {
  // Ports the gate half of EventPolicyTest.php:19,24,31,38,45 and
  // UserPolicyTest.php:30,38 to HTTP: guests get 401, signed-in non-moderators
  // (and non-owners) get 403, and the moderator/owner passes the gate. With no
  // database wired the handler answers 503 after the gate — that 503 is the
  // assertion that the gate passed, not a failure under test.
  const writes = [
    ["POST", "/events"],
    ["PATCH", "/events/01AAAAAAAAAAAAAAAAAAAAAAAA"],
    ["POST", "/events/01AAAAAAAAAAAAAAAAAAAAAAAA/publish"],
    ["POST", "/events/01AAAAAAAAAAAAAAAAAAAAAAAA/cancel"],
    ["PATCH", "/members/100000000000000112"],
  ] as const;

  it.each(writes)(
    "guest 401, member 403, owner/moderator past the gate on %s %s",
    async (method, path) => {
      const store = createMemorySessionStore();
      const env = { ...baseEnv, SESSION_STORE: store } as unknown as Env;
      const json = {
        origin: APP_URL,
        "content-type": "application/json",
        accept: "application/json",
      };
      // Guests send the same JSON headers: the profile slice answers JSON
      // guests with 401 + recovery link (not the 303 HTML bounce), and every
      // other write answers JSON 401 at its gate.
      const call = (cookie?: string) =>
        app.request(
          path,
          {
            method,
            headers: cookie ? { ...json, cookie } : json,
            body: "{}",
          },
          env,
        );
      expect((await call()).status).toBe(401);
      // PATCH /members/:user is owner-gated, not moderator-gated: MEMBER owns
      // this profile, so the refused non-owner is the moderator (UserPolicy
      // parity — the dedicated row below pins the same 403 for every member).
      const refused = path.startsWith("/members/") ? MOD : MEMBER;
      expect((await call(await cookieFor(store, refused))).status).toBe(403);
      const owner = path.startsWith("/members/") ? MEMBER : MOD;
      expect((await call(await cookieFor(store, owner))).status).toBe(503);
    },
  );

  it("a moderator cannot PATCH someone else's profile", async () => {
    // Ports UserPolicyTest.php:38 (moderating events is not editing members).
    const store = createMemorySessionStore();
    const env = { ...baseEnv, SESSION_STORE: store } as unknown as Env;
    const res = await app.request(
      "/members/100000000000000112",
      {
        method: "PATCH",
        headers: {
          cookie: await cookieFor(store, MOD),
          origin: APP_URL,
          "content-type": "application/json",
        },
        body: "{}",
      },
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("events.json exposure (agent-testdb)", () => {
  // Ports EventJsonAccessTest.php:27,39,50,71. Owned disposable schema (W15
  // fixture): pools pin search_path to w15_<uuid>, and dispose() drops it.
  let fixture: MemberDataFixture;
  const store = createMemorySessionStore();
  const env = {
    ...baseEnv,
    get ADMIN_DB() {
      return fixture.db;
    },
    SESSION_STORE: store,
  } as unknown as Env;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });
  beforeEach(async () => {
    await fixture.reset();
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  const seedStatuses = async () => {
    for (const [i, status] of ["draft", "published", "cancelled", "past"].entries()) {
      await fixture.db.insert(events).values({
        eventKey: String(i + 1).padStart(26, "0"),
        title: `Game ${status}`,
        startsAt: new Date("2099-01-01T20:00:00Z"),
        endsAt: new Date("2099-01-01T22:00:00Z"),
        status,
      });
    }
  };
  const statusesOf = async (res: Response) =>
    ((await res.json()) as { data: { status: string }[] }).data.map((r) => r.status).sort();

  it("refuses a guest with 401 and no event data", async () => {
    await seedStatuses();
    const res = await app.request("/events.json", {}, env);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("Game published");
  });

  it("shows a member published, cancelled and past events but no drafts", async () => {
    await seedStatuses();
    const res = await app.request(
      "/events.json",
      { headers: { cookie: await cookieFor(store, MEMBER) } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await statusesOf(res)).toEqual(["cancelled", "past", "published"]);
  });

  it("shows a moderator drafts alongside everything else", async () => {
    await seedStatuses();
    const res = await app.request(
      "/events.json",
      { headers: { cookie: await cookieFor(store, MOD) } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await statusesOf(res)).toEqual(["cancelled", "draft", "past", "published"]);
  });

  it("exposes only the allowlisted fields on every row", async () => {
    // Legacy allowlist (EventJsonAccessTest.php:71): event_key, title, game,
    // description, starts_at, ends_at, starts_at_local, ends_at_local,
    // timezone, location, capacity, going_count, status, rsvp_open,
    // synced_to_discord. Next deliberately differs: no localized instants or
    // sync flag; waitlist_position rides along for the member viewer. The
    // invariant pinned is exactness — no autoincrement id, no creator id, no
    // raw Discord id may ever leave the server.
    await seedStatuses();
    for (const who of [MEMBER, MOD]) {
      const res = await app.request(
        "/events.json",
        { headers: { cookie: await cookieFor(store, who) } },
        env,
      );
      const { data } = (await res.json()) as { data: Record<string, unknown>[] };
      expect(data.length).toBeGreaterThan(0);
      for (const row of data) {
        expect(Object.keys(row).sort()).toEqual([
          "capacity",
          "description",
          "ends_at",
          "event_key",
          "game",
          "going_count",
          "location",
          "rsvp_open",
          "starts_at",
          "status",
          "timezone",
          "title",
          "waitlist_position",
        ]);
      }
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("profile first-save race (agent-testdb)", () => {
  // Ports ProfileCreationRaceTest.php:121 + JoinDenialMatrixTest.php:107
  // (double-submitted callback is one idempotent join). Mechanism differs from
  // legacy on purpose: legacy serializes behind lockForUpdate on the parent
  // users row; Next upserts (ON CONFLICT DO UPDATE, no FK on profiles.user_id),
  // so concurrent first saves converge without ever failing.
  let fixture: MemberDataFixture;

  beforeAll(async () => {
    // max: 2 so the two saves really overlap on separate connections; with the
    // default single connection they queue and a racy check-then-insert passes.
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 2 });
  });
  beforeEach(async () => {
    await fixture.reset();
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  it("concurrent first saves converge on exactly one row", async () => {
    const id = "100000000000000091";
    await fixture.db.insert(users).values({ id, username: "racer" });
    const store = createDbProfileStore(fixture.db);
    await Promise.all([
      store.save(id, { bio: "alpha", games: [], timezone: null }),
      store.save(id, { bio: "beta", games: [], timezone: null }),
    ]);
    const rows = await fixture.db.select().from(profiles);
    expect(rows).toHaveLength(1);
    expect(["alpha", "beta"]).toContain(rows[0]!.bio);
  });
});
