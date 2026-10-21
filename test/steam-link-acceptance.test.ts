// Steam account linking via Steam OpenID 2.0: acceptance suite (RED-first).
//
// Spec: member profiles with public/private fields + Steam linking (owner-approved).
// Steam is link-only: Discord stays the only sign-in. Linking starts from the
// profile page, verifies the assertion server-side with check_authentication,
// and stores one generic linked_accounts row (provider "steam") per member.
// Unlinking deletes all synced Steam data immediately. Every link, unlink and
// moderator unlink is audit-logged. Steam renders per the visibility map with
// a members-only default.
//
// Contract pinned here (the builder implements exactly this):
// - GET /profile/steam/link (member) -> 302 to
//   https://steamcommunity.com/openid/login with openid.ns, openid.mode =
//   checkid_setup, openid.return_to pointing at /profile/steam/callback,
//   openid.realm, and identifier_select claimed_id/identity.
// - GET /profile/steam/callback (member) verifies server-side: one POST to the
//   Steam endpoint whose form body carries openid.mode=check_authentication.
//   Valid -> 303 /profile and the profile shows the Steam identity. Forged
//   (Steam says is_valid:false) -> 422 naming Steam and the failed
//   verification. Replayed (same assertion twice, any session) -> 422 naming
//   the reuse. Steam unreachable -> 503 naming Steam, nothing linked.
//   Assertion from another provider, or with a non-Steam claimed id, -> 422.
// - One Steam account per member, both directions: the same SteamID linked by
//   a second member -> 409 "already linked", original link intact; re-linking
//   your own SteamID -> 303 idempotent, one row; linking a different Steam
//   account while one is linked -> 409 "already linked".
// - POST /profile/steam/unlink (member) -> 303 /profile; the page shows
//   "Link Steam" again and no Steam remnant. Unlinking with nothing linked
//   -> 404.
// - POST /members/:user/steam/unlink (moderator only) -> 303 to that member;
//   non-moderator on another member -> 403; moderator on an unlinked member
//   -> 404 auditing nothing.
// - Visibility default members-only: a fellow member (or moderator) sees the
//   linked Steam identity with no opt-in; the owner sees it plus the unlink
//   control; a non-owner view carries no unlink control; guests bounce before
//   any Steam bytes render. Guest filtering on the public handle page belongs
//   to the public-profile acceptance suite, not this one.
// - Copy pins: "Link Steam" plus the /profile/steam/link path when unlinked;
//   the SteamID64, the word "Steam", and
//   https://steamcommunity.com/profiles/<steamid64> when linked; the unlink
//   control posts to a steam/unlink action.
// - Persistence + audit (agent-testdb section): link inserts one
//   linked_accounts row (user_id, provider "steam", provider_user_id); unlink
//   deletes it entirely; each link/unlink/moderator-unlink writes one
//   activity_log row with subjectType "LinkedAccount", subjectId the
//   SteamID64, causerId the actor, a description naming the link/unlink, and a
//   properties.provider_user_id {before, after} pair. Refused attempts
//   (forged, duplicate, missing row) audit nothing.
//
// Seams, so the builder never has to guess:
// - Outbound Steam HTTP goes through the global fetch: these tests stub it
//   and answer recorded check_authentication verdicts. No dep to invent.
// - Link state MUST be reachable through today's ProfileDeps (the injected
//   `store`) or the ADMIN_DB binding the db-backed stores already resolve via
//   dbFor. The memory layer injects only sessionStore/store/accessLog and
//   supplies no ADMIN_DB, so a new required dep or an ADMIN_DB-only store
//   fails these tests even when correct. Extend the profile store (memory
//   double + db store over linked_accounts), not the dep list.
// - Each callback test starts linking first and derives return_to (plus any
//   state cookies) from that redirect, so stateful and stateless verifiers
//   both satisfy the suite.
// - Do NOT add // route-inventory comments here: the inventory guard fails on
//   references to routes that do not exist yet. The implementation PR adds
//   them (in its own endpoint tests), plus the parity/URL doc entries and the
//   route-inventory.json rows.
//
// The builder builds on this branch and never edits this file. If a pin here
// contradicts the spec, the correction comes back to the test author; a green
// suite with a weakened pin is a failure, not a pass.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { AccessEntry } from "../src/access-log";
import type { EnvWithAdminDb } from "../src/admin/db";
import { activityLog } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { users } from "../src/db/schema";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore, type MemberView } from "../src/profiles/store";
import { SESSION_COOKIE } from "../src/session-cookie";
import { createMemorySessionStore, type SessionStore } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { cookieFor, env, MEMBER, MODERATOR, OUTSIDER, SUBJECT } from "./helpers/member-data";

const ALICE = SUBJECT;
const BOB = MEMBER;
const MOD = MODERATOR;

const STEAM_OPENID_URL = "https://steamcommunity.com/openid/login";
// Recorded-fixture SteamIDs: well-formed SteamID64 values reserved for tests.
const STEAM_ALICE = "76561198000000042";
const STEAM_BOB = "76561198000000043";
const STEAM_OTHER = "76561198000000044";
const steamProfileUrl = (steamId: string) => `https://steamcommunity.com/profiles/${steamId}`;

let nonceSeq = 0;
const freshNonce = () => `2026-10-21T20:00:00Z-fixture-${nonceSeq++}`;

function seedMembers(): MemberView[] {
  return [
    {
      id: ALICE.userId,
      username: ALICE.username,
      avatar: null,
      bio: null,
      games: [],
      timezone: null,
    },
    {
      id: BOB.userId,
      username: BOB.username,
      avatar: null,
      bio: null,
      games: [],
      timezone: null,
    },
    { id: MOD.userId, username: MOD.username, avatar: null, bio: null, games: [], timezone: null },
  ];
}

function harness() {
  const sessions = createMemorySessionStore();
  const store = createMemoryProfileStore(seedMembers());
  const log: AccessEntry[] = [];
  const app = profilesApp({
    sessionStore: sessions,
    store,
    accessLog: async (e) => {
      // Same attribution rule as the real recorder: viewer is never a
      // subject, empty writes nothing.
      const subjects = [...new Set(e.subjectUserIds.filter((s) => s !== e.viewerUserId))];
      if (subjects.length === 0) return false;
      log.push({ ...e, subjectUserIds: subjects });
      return true;
    },
  });
  return { app, sessions, store, log };
}

type SteamCall = { url: string; method: string; body: string };

function installSteamStub() {
  const calls: SteamCall[] = [];
  const behavior = { valid: true, throws: false };
  vi.stubGlobal("fetch", async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
    calls.push({ url, method, body });
    if (behavior.throws) throw new Error("steam unreachable (fixture)");
    const verdict = behavior.valid ? "true" : "false";
    return new Response(`ns:http://specs.openid.net/auth/2.0\nis_valid:${verdict}\n`, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  });
  return { calls, behavior };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

type TestApp = ReturnType<typeof profilesApp>;

/** Forward every link-start cookie except the session bearer (OpenID state). */
function startCookies(res: Response): string {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const raw: string[] =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (() => {
          const single = headers.get("set-cookie");
          return single ? [single] : [];
        })();
  return raw
    .map((c) => (c.split(";")[0] ?? "").trim())
    .filter((pair) => pair && !pair.startsWith(`${SESSION_COOKIE}=`))
    .join("; ");
}

async function startLink(app: TestApp, cookie: string) {
  const res = await app.request("/profile/steam/link", { headers: { cookie } }, env);
  expect(res.status).toBe(302);
  const location = res.headers.get("location") ?? "";
  const returnTo = new URL(location).searchParams.get("openid.return_to") ?? "";
  const extra = startCookies(res);
  return { returnTo, callbackCookie: extra ? `${cookie}; ${extra}` : cookie };
}

/** Recorded OpenID 2.0 assertion shape, as Steam returns it to return_to. */
function assertionFor(
  steamId: string,
  nonce: string,
  returnTo: string,
  overrides: Record<string, string> = {},
) {
  const claimedId = `https://steamcommunity.com/openid/id/${steamId}`;
  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": STEAM_OPENID_URL,
    "openid.claimed_id": claimedId,
    "openid.identity": claimedId,
    "openid.return_to": returnTo,
    "openid.response_nonce": nonce,
    "openid.assoc_handle": "fixture-assoc-handle",
    "openid.signed": "op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "recorded-fixture-signature",
    ...overrides,
  });
  return `/profile/steam/callback?${params.toString()}`;
}

async function linkSteam(
  app: TestApp,
  cookie: string,
  steamId: string,
  stub: { calls: SteamCall[]; behavior: { valid: boolean; throws: boolean } },
  nonce = freshNonce(),
) {
  const { returnTo, callbackCookie } = await startLink(app, cookie);
  const res = await app.request(
    assertionFor(steamId, nonce, returnTo),
    { headers: { cookie: callbackCookie } },
    env,
  );
  expect(stub.calls.length).toBeGreaterThan(0);
  return res;
}

describe("steam link start", () => {
  it("member gets a Steam OpenID 2.0 redirect with a callback return_to", async () => {
    const { app, sessions } = harness();
    const alice = await cookieFor(sessions, ALICE);

    const res = await app.request("/profile/steam/link", { headers: { cookie: alice } }, env);

    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location") ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(STEAM_OPENID_URL);
    expect(url.searchParams.get("openid.ns")).toBe("http://specs.openid.net/auth/2.0");
    expect(url.searchParams.get("openid.mode")).toBe("checkid_setup");
    expect(url.searchParams.get("openid.claimed_id")).toBe(
      "http://specs.openid.net/auth/2.0/identifier_select",
    );
    expect(url.searchParams.get("openid.identity")).toBe(
      "http://specs.openid.net/auth/2.0/identifier_select",
    );
    expect(url.searchParams.get("openid.realm")).toContain("https://next.example.test");
    expect(url.searchParams.get("openid.return_to")).toContain("/profile/steam/callback");
  });

  it("guest bounces to sign-in without touching Steam", async () => {
    const { app } = harness();
    const steam = installSteamStub();

    const res = await app.request("/profile/steam/link", {}, env);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
    expect(steam.calls).toHaveLength(0);
  });

  it("signed-in non-member is refused", async () => {
    const { app, sessions } = harness();
    const outsider = await cookieFor(sessions, OUTSIDER);

    const res = await app.request("/profile/steam/link", { headers: { cookie: outsider } }, env);

    expect(res.status).toBe(403);
  });
});

describe("steam callback verification", () => {
  it("valid assertion links and the profile shows the Steam identity", async () => {
    const { app, sessions } = harness();
    const steam = installSteamStub();
    const alice = await cookieFor(sessions, ALICE);

    const res = await linkSteam(app, alice, STEAM_ALICE, steam);

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/profile");
    const page = await app.request("/profile", { headers: { cookie: alice } }, env);
    const html = await page.text();
    expect(html).toContain("Steam");
    expect(html).toContain(STEAM_ALICE);
    expect(html).toContain(steamProfileUrl(STEAM_ALICE));
  });

  it("verification POSTs check_authentication to Steam server-side", async () => {
    const { app, sessions } = harness();
    const steam = installSteamStub();
    const alice = await cookieFor(sessions, ALICE);

    const res = await linkSteam(app, alice, STEAM_ALICE, steam);

    expect(res.status).toBe(303);
    expect(steam.calls).toHaveLength(1);
    expect(steam.calls[0]!.url).toBe(STEAM_OPENID_URL);
    expect(steam.calls[0]!.method).toBe("POST");
    expect(steam.calls[0]!.body).toContain("openid.mode=check_authentication");
    // The server echoes the received assertion for direct verification.
    expect(steam.calls[0]!.body).toContain(STEAM_ALICE);
  });

  it("forged assertion (Steam says invalid) is refused and links nothing", async () => {
    const { app, sessions } = harness();
    const steam = installSteamStub();
    steam.behavior.valid = false;
    const alice = await cookieFor(sessions, ALICE);
    const { returnTo, callbackCookie } = await startLink(app, alice);

    const res = await app.request(
      assertionFor(STEAM_ALICE, freshNonce(), returnTo),
      { headers: { cookie: callbackCookie } },
      env,
    );

    expect(res.status).toBe(422);
    // The forgery still went through server-side verification.
    expect(steam.calls).toHaveLength(1);
    const body = await res.text();
    expect(body).toMatch(/Steam/);
    expect(body).toMatch(/verif/i);
    const page = await app.request("/profile", { headers: { cookie: alice } }, env);
    const html = await page.text();
    expect(html).toContain("Link Steam");
    expect(html).not.toContain(STEAM_ALICE);
  });

  it("replayed assertion is refused the second time", async () => {
    const { app, sessions } = harness();
    installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    const { returnTo, callbackCookie } = await startLink(app, alice);
    const replay = assertionFor(STEAM_ALICE, freshNonce(), returnTo);

    const first = await app.request(replay, { headers: { cookie: callbackCookie } }, env);
    expect(first.status).toBe(303);
    const second = await app.request(replay, { headers: { cookie: callbackCookie } }, env);

    expect(second.status).toBe(422);
    expect(await second.text()).toMatch(/already used/i);
    const page = await app.request("/profile", { headers: { cookie: alice } }, env);
    expect(await page.text()).toContain(STEAM_ALICE);
  });

  it("an assertion is single-use across members", async () => {
    const { app, sessions } = harness();
    installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    const bob = await cookieFor(sessions, BOB);
    const { returnTo, callbackCookie } = await startLink(app, alice);
    const assertion = assertionFor(STEAM_ALICE, freshNonce(), returnTo);

    const first = await app.request(assertion, { headers: { cookie: callbackCookie } }, env);
    expect(first.status).toBe(303);
    const replay = await app.request(assertion, { headers: { cookie: bob } }, env);

    expect(replay.status).toBe(422);
    expect(await replay.text()).toMatch(/already used/i);
    const bobPage = await app.request("/profile", { headers: { cookie: bob } }, env);
    const bobHtml = await bobPage.text();
    expect(bobHtml).toContain("Link Steam");
    expect(bobHtml).not.toContain(STEAM_ALICE);
  });

  it("Steam outage fails closed without linking", async () => {
    const { app, sessions } = harness();
    const steam = installSteamStub();
    steam.behavior.throws = true;
    const alice = await cookieFor(sessions, ALICE);
    const { returnTo, callbackCookie } = await startLink(app, alice);

    const res = await app.request(
      assertionFor(STEAM_ALICE, freshNonce(), returnTo),
      { headers: { cookie: callbackCookie } },
      env,
    );

    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/Steam/);
    const page = await app.request("/profile", { headers: { cookie: alice } }, env);
    const html = await page.text();
    expect(html).toContain("Link Steam");
    expect(html).not.toContain(STEAM_ALICE);
  });

  it("assertion from another provider is refused", async () => {
    const { app, sessions } = harness();
    installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    const { returnTo, callbackCookie } = await startLink(app, alice);

    const res = await app.request(
      assertionFor(STEAM_ALICE, freshNonce(), returnTo, {
        "openid.op_endpoint": "https://evil.test/openid/login",
      }),
      { headers: { cookie: callbackCookie } },
      env,
    );

    // The rogue endpoint "confirms" (stub says valid): the refusal must come
    // from provider validation, not from the verification verdict.
    expect(res.status).toBe(422);
    const page = await app.request("/profile", { headers: { cookie: alice } }, env);
    expect(await page.text()).not.toContain(STEAM_ALICE);
  });

  it("assertion with a non-Steam claimed id is refused", async () => {
    const { app, sessions } = harness();
    installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    const { returnTo, callbackCookie } = await startLink(app, alice);
    const rogue = "https://evil.test/id/12345";

    const res = await app.request(
      assertionFor(STEAM_ALICE, freshNonce(), returnTo, {
        "openid.claimed_id": rogue,
        "openid.identity": rogue,
      }),
      { headers: { cookie: callbackCookie } },
      env,
    );

    expect(res.status).toBe(422);
    const page = await app.request("/profile", { headers: { cookie: alice } }, env);
    const html = await page.text();
    expect(html).toContain("Link Steam");
    expect(html).not.toContain(STEAM_ALICE);
  });

  it("guest callback bounces to sign-in without touching Steam", async () => {
    const { app } = harness();
    const steam = installSteamStub();

    const res = await app.request(
      assertionFor(STEAM_ALICE, freshNonce(), "https://next.example.test/profile/steam/callback"),
      {},
      env,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
    expect(steam.calls).toHaveLength(0);
  });
});

describe("one Steam account per member", () => {
  it("same SteamID for a second member is refused with a clear message", async () => {
    const { app, sessions } = harness();
    const steam = installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    const bob = await cookieFor(sessions, BOB);
    const linked = await linkSteam(app, alice, STEAM_ALICE, steam);
    expect(linked.status).toBe(303);

    const { returnTo, callbackCookie } = await startLink(app, bob);
    const res = await app.request(
      assertionFor(STEAM_ALICE, freshNonce(), returnTo),
      { headers: { cookie: callbackCookie } },
      env,
    );

    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/already linked/i);
    const alicePage = await app.request("/profile", { headers: { cookie: alice } }, env);
    expect(await alicePage.text()).toContain(STEAM_ALICE);
    const bobPage = await app.request("/profile", { headers: { cookie: bob } }, env);
    const bobHtml = await bobPage.text();
    expect(bobHtml).toContain("Link Steam");
    expect(bobHtml).not.toContain(STEAM_ALICE);
  });

  it("re-linking your own SteamID is idempotent", async () => {
    const { app, sessions } = harness();
    const steam = installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    const first = await linkSteam(app, alice, STEAM_ALICE, steam);
    expect(first.status).toBe(303);

    const { returnTo, callbackCookie } = await startLink(app, alice);
    const second = await app.request(
      assertionFor(STEAM_ALICE, freshNonce(), returnTo),
      { headers: { cookie: callbackCookie } },
      env,
    );

    expect(second.status).toBe(303);
    expect(second.headers.get("location")).toBe("/profile");
    const page = await app.request("/profile", { headers: { cookie: alice } }, env);
    expect(await page.text()).toContain(STEAM_ALICE);
  });

  it("linking a different Steam account while linked is refused", async () => {
    const { app, sessions } = harness();
    const steam = installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    const first = await linkSteam(app, alice, STEAM_ALICE, steam);
    expect(first.status).toBe(303);

    const { returnTo, callbackCookie } = await startLink(app, alice);
    const res = await app.request(
      assertionFor(STEAM_OTHER, freshNonce(), returnTo),
      { headers: { cookie: callbackCookie } },
      env,
    );

    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/already linked/i);
    const page = await app.request("/profile", { headers: { cookie: alice } }, env);
    const html = await page.text();
    expect(html).toContain(STEAM_ALICE);
    expect(html).not.toContain(STEAM_OTHER);
  });
});

describe("unlink", () => {
  const unlink = (app: TestApp, cookie: string) =>
    app.request(
      "/profile/steam/unlink",
      { method: "POST", headers: { cookie, origin: env.APP_URL } },
      env,
    );

  it("unlink removes the link and every Steam remnant from the page", async () => {
    const { app, sessions } = harness();
    const steam = installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    const linked = await linkSteam(app, alice, STEAM_ALICE, steam);
    expect(linked.status).toBe(303);

    const res = await unlink(app, alice);

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/profile");
    const page = await app.request("/profile", { headers: { cookie: alice } }, env);
    const html = await page.text();
    expect(html).toContain("Link Steam");
    expect(html).toContain("/profile/steam/link");
    expect(html).not.toContain(STEAM_ALICE);
    expect(html).not.toContain(steamProfileUrl(STEAM_ALICE));
  });

  it("unlink with nothing linked is 404", async () => {
    const { app, sessions } = harness();
    const steam = installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    // Link then unlink first, so this 404 proves "nothing linked" rather
    // than a missing route: pre-implementation it fails at the link.
    const linked = await linkSteam(app, alice, STEAM_ALICE, steam);
    expect(linked.status).toBe(303);
    expect((await unlink(app, alice)).status).toBe(303);

    expect((await unlink(app, alice)).status).toBe(404);
  });

  it("guest cannot unlink", async () => {
    const { app } = harness();

    const res = await app.request(
      "/profile/steam/unlink",
      { method: "POST", headers: { origin: env.APP_URL } },
      env,
    );

    // Bounced write: back to the page via recovery, never a re-submit.
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/auth/recover");
  });

  it("non-member cannot unlink", async () => {
    const { app, sessions } = harness();
    const outsider = await cookieFor(sessions, OUTSIDER);

    expect((await unlink(app, outsider)).status).toBe(403);
  });
});

describe("moderator unlink", () => {
  const modUnlink = (app: TestApp, cookie: string, userId: string) =>
    app.request(
      `/members/${userId}/steam/unlink`,
      { method: "POST", headers: { cookie, origin: env.APP_URL } },
      env,
    );

  it("moderator unlinks another member", async () => {
    const { app, sessions } = harness();
    const steam = installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    const mod = await cookieFor(sessions, MOD);
    const linked = await linkSteam(app, alice, STEAM_ALICE, steam);
    expect(linked.status).toBe(303);

    const res = await modUnlink(app, mod, ALICE.userId);

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/members/${ALICE.userId}`);
    const page = await app.request("/profile", { headers: { cookie: alice } }, env);
    const html = await page.text();
    expect(html).toContain("Link Steam");
    expect(html).not.toContain(STEAM_ALICE);
  });

  it("non-moderator cannot unlink another member", async () => {
    const { app, sessions } = harness();
    const steam = installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    const bob = await cookieFor(sessions, BOB);
    const linked = await linkSteam(app, alice, STEAM_ALICE, steam);
    expect(linked.status).toBe(303);

    const res = await modUnlink(app, bob, ALICE.userId);

    expect(res.status).toBe(403);
    const page = await app.request("/profile", { headers: { cookie: alice } }, env);
    expect(await page.text()).toContain(STEAM_ALICE);
  });

  it("moderator unlink of an unlinked member is 404", async () => {
    const { app, sessions } = harness();
    const steam = installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    const mod = await cookieFor(sessions, MOD);
    // Prove the routes exist first: pre-implementation this fails at the
    // link, so the 404 below can only mean "member has no link".
    const linked = await linkSteam(app, alice, STEAM_ALICE, steam);
    expect(linked.status).toBe(303);

    expect((await modUnlink(app, mod, BOB.userId)).status).toBe(404);
  });
});

describe("steam visibility (default members-only)", () => {
  it("fellow member sees the linked Steam identity with no opt-in", async () => {
    const { app, sessions } = harness();
    const steam = installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    const bob = await cookieFor(sessions, BOB);
    const linked = await linkSteam(app, alice, STEAM_ALICE, steam);
    expect(linked.status).toBe(303);

    const res = await app.request(`/members/${ALICE.userId}`, { headers: { cookie: bob } }, env);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Steam");
    expect(html).toContain(STEAM_ALICE);
    expect(html).toContain(steamProfileUrl(STEAM_ALICE));
  });

  it("moderator sees the same linked Steam identity", async () => {
    const { app, sessions } = harness();
    const steam = installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    const mod = await cookieFor(sessions, MOD);
    const linked = await linkSteam(app, alice, STEAM_ALICE, steam);
    expect(linked.status).toBe(303);

    const res = await app.request(`/members/${ALICE.userId}`, { headers: { cookie: mod } }, env);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain(STEAM_ALICE);
  });

  it("owner sees the Steam identity and the unlink control", async () => {
    const { app, sessions } = harness();
    const steam = installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    const linked = await linkSteam(app, alice, STEAM_ALICE, steam);
    expect(linked.status).toBe(303);

    const res = await app.request("/profile", { headers: { cookie: alice } }, env);

    const html = await res.text();
    expect(html).toContain(STEAM_ALICE);
    expect(html).toContain("steam/unlink");
    expect(html).toMatch(/unlink/i);
  });

  it("non-owner view carries no unlink control", async () => {
    const { app, sessions } = harness();
    const steam = installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    const bob = await cookieFor(sessions, BOB);
    const linked = await linkSteam(app, alice, STEAM_ALICE, steam);
    expect(linked.status).toBe(303);

    const res = await app.request(`/members/${ALICE.userId}`, { headers: { cookie: bob } }, env);

    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("steam/unlink");
  });

  it("unlinked profile offers Link Steam and no unlink control", async () => {
    const { app, sessions } = harness();
    const alice = await cookieFor(sessions, ALICE);

    const res = await app.request("/profile", { headers: { cookie: alice } }, env);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Link Steam");
    expect(html).toContain("/profile/steam/link");
    expect(html).not.toContain("steam/unlink");
  });

  it("guest bounce leaks no Steam data", async () => {
    const { app, sessions } = harness();
    const steam = installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    const linked = await linkSteam(app, alice, STEAM_ALICE, steam);
    expect(linked.status).toBe(303);

    for (const path of ["/profile", `/members/${ALICE.userId}`]) {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(302);
      expect(await res.text()).not.toContain(STEAM_ALICE);
    }
  });
});

type LinkedAccountRow = { user_id: string; provider: string; provider_user_id: string };
type AuditProps = Record<string, { before: unknown; after: unknown }>;

async function linkedAccountRows(db: Db, userId: string): Promise<LinkedAccountRow[]> {
  // Raw SQL on purpose: the linked_accounts table lands with the schema slice,
  // and a drizzle import would fail this file's collection instead of failing
  // these tests. Column names are spec-bound (user_id, provider,
  // provider_user_id).
  return (await db.execute(
    sql`SELECT user_id, provider, provider_user_id FROM linked_accounts WHERE user_id = ${userId}`,
  )) as unknown as LinkedAccountRow[];
}

async function linkedAccountRowsBySteamId(db: Db, steamId: string): Promise<LinkedAccountRow[]> {
  return (await db.execute(
    sql`SELECT user_id, provider, provider_user_id FROM linked_accounts WHERE provider_user_id = ${steamId}`,
  )) as unknown as LinkedAccountRow[];
}

describe.skipIf(!process.env.DATABASE_URL)("steam link persistence + audit (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let sessions: SessionStore;
  const bindings = () => ({ ...env, ADMIN_DB: fixture.db }) as EnvWithAdminDb;
  // No injected store: the db-backed profile store (and the Steam persistence
  // behind it) resolves through ADMIN_DB exactly like production.
  const appFor = () => profilesApp({ sessionStore: sessions, accessLog: async () => true });

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });
  beforeEach(async () => {
    await fixture.reset();
    sessions = createMemorySessionStore();
    await fixture.db.insert(users).values([
      { id: ALICE.userId, username: ALICE.username, member: true },
      { id: BOB.userId, username: BOB.username, member: true },
      { id: MOD.userId, username: MOD.username, member: true },
    ]);
  });
  afterAll(() => fixture?.dispose());

  async function dbLink(cookie: string, steamId: string, nonce = freshNonce()) {
    const app = appFor();
    const started = await app.request("/profile/steam/link", { headers: { cookie } }, bindings());
    expect(started.status).toBe(302);
    const returnTo =
      new URL(started.headers.get("location") ?? "").searchParams.get("openid.return_to") ?? "";
    const extra = startCookies(started);
    return app.request(
      assertionFor(steamId, nonce, returnTo),
      { headers: { cookie: extra ? `${cookie}; ${extra}` : cookie } },
      bindings(),
    );
  }

  it("link persists a linked_accounts row", async () => {
    installSteamStub();
    const alice = await cookieFor(sessions, ALICE);

    const res = await dbLink(alice, STEAM_ALICE);

    expect(res.status).toBe(303);
    const rows = await linkedAccountRows(fixture.db, ALICE.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: ALICE.userId,
      provider: "steam",
      provider_user_id: STEAM_ALICE,
    });
  });

  it("unlink deletes the linked_accounts row entirely", async () => {
    installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    const linked = await dbLink(alice, STEAM_BOB);
    expect(linked.status).toBe(303);
    expect(await linkedAccountRows(fixture.db, ALICE.userId)).toHaveLength(1);

    const res = await appFor().request(
      "/profile/steam/unlink",
      { method: "POST", headers: { cookie: alice, origin: env.APP_URL } },
      bindings(),
    );

    expect(res.status).toBe(303);
    expect(await linkedAccountRows(fixture.db, ALICE.userId)).toHaveLength(0);
    // No orphan by SteamID either: the synced data is gone, not detached.
    expect(await linkedAccountRowsBySteamId(fixture.db, STEAM_BOB)).toHaveLength(0);
  });

  it("re-linking your own keeps a single row", async () => {
    installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    expect((await dbLink(alice, STEAM_OTHER)).status).toBe(303);
    expect((await dbLink(alice, STEAM_OTHER)).status).toBe(303);

    expect(await linkedAccountRows(fixture.db, ALICE.userId)).toHaveLength(1);
  });

  it("link writes an audit row", async () => {
    installSteamStub();
    const alice = await cookieFor(sessions, ALICE);

    expect((await dbLink(alice, "76561198000000051")).status).toBe(303);

    const audits = await fixture.db.select().from(activityLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      subjectType: "LinkedAccount",
      subjectId: "76561198000000051",
      causerId: ALICE.userId,
    });
    expect(audits[0]!.description).toMatch(/linked Steam/);
    const props = audits[0]!.properties as AuditProps;
    expect(props["provider_user_id"]).toEqual({ before: null, after: "76561198000000051" });
  });

  it("unlink writes an audit row", async () => {
    installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    expect((await dbLink(alice, "76561198000000052")).status).toBe(303);

    const res = await appFor().request(
      "/profile/steam/unlink",
      { method: "POST", headers: { cookie: alice, origin: env.APP_URL } },
      bindings(),
    );

    expect(res.status).toBe(303);
    const audits = await fixture.db.select().from(activityLog);
    const unlink = audits.filter((row) => /unlinked Steam/.test(row.description));
    expect(unlink).toHaveLength(1);
    expect(unlink[0]).toMatchObject({
      subjectType: "LinkedAccount",
      subjectId: "76561198000000052",
      causerId: ALICE.userId,
    });
    const props = unlink[0]!.properties as AuditProps;
    expect(props["provider_user_id"]).toEqual({ before: "76561198000000052", after: null });
  });

  it("moderator unlink writes an audit row naming the moderator as causer", async () => {
    installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    const mod = await cookieFor(sessions, MOD);
    expect((await dbLink(alice, "76561198000000053")).status).toBe(303);

    const res = await appFor().request(
      `/members/${ALICE.userId}/steam/unlink`,
      { method: "POST", headers: { cookie: mod, origin: env.APP_URL } },
      bindings(),
    );

    expect(res.status).toBe(303);
    const audits = await fixture.db.select().from(activityLog);
    const unlink = audits.filter((row) => /unlinked Steam/.test(row.description));
    expect(unlink).toHaveLength(1);
    expect(unlink[0]).toMatchObject({
      subjectType: "LinkedAccount",
      subjectId: "76561198000000053",
      causerId: MOD.userId,
    });
  });

  it("forged assertion audits nothing", async () => {
    const steam = installSteamStub();
    steam.behavior.valid = false;
    const alice = await cookieFor(sessions, ALICE);

    expect((await dbLink(alice, "76561198000000054")).status).toBe(422);
    expect(await fixture.db.select().from(activityLog)).toHaveLength(0);
  });

  it("refused duplicate audits nothing", async () => {
    installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    const bob = await cookieFor(sessions, BOB);
    expect((await dbLink(alice, "76561198000000055")).status).toBe(303);
    expect(await fixture.db.select().from(activityLog)).toHaveLength(1);

    expect((await dbLink(bob, "76561198000000055")).status).toBe(409);
    expect(await fixture.db.select().from(activityLog)).toHaveLength(1);
  });

  it("moderator unlink of an unlinked member audits nothing", async () => {
    installSteamStub();
    const alice = await cookieFor(sessions, ALICE);
    const mod = await cookieFor(sessions, MOD);
    // Prove the routes exist first (one link audit row): the 404 below must
    // add no row of its own.
    expect((await dbLink(alice, "76561198000000056")).status).toBe(303);

    const res = await appFor().request(
      `/members/${BOB.userId}/steam/unlink`,
      { method: "POST", headers: { cookie: mod, origin: env.APP_URL } },
      bindings(),
    );

    expect(res.status).toBe(404);
    expect(await fixture.db.select().from(activityLog)).toHaveLength(1);
  });
});
