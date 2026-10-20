// Acceptance contract: Kit profile/member guest bounce retains the intended
// page through ordinary Discord sign-in (Hono url.intended parity).
//
// Defect at base: src/profiles/kit.ts calls its guest answer "the Hono
// intended-page bounce" but resolves only { kind: "redirect", location:
// "/auth/discord" }, and both +page.server.ts bindings redirect without
// recording the requested pathname+query. A guest who asked for /profile or
// /members/:user therefore lands on the default page after sign-in instead
// of the member page they asked for, once the (still disabled) Kit routes
// are enabled. Hono parity is src/return-journey.ts bounceToLogin: sign the
// safe, length-bounded pathname+search into the login_intended cookie before
// the same /auth/discord redirect; the callback (consumeLoginReturn) honors
// it exactly once and clears it on every terminal path.
//
// Required Builder seam (this file is the specification; do not edit it):
// - KitProfileRequest gains the full request URL (`url`), supplied by each
//   binding from the SvelteKit load event.
// - KitProfileDeps gains the cookie signer input (`sessionSecret`);
//   kitProfileDeps(env) supplies env.SESSION_SECRET and each binding
//   threads it through. No new secret, no session issuance.
// - A guest redirect outcome gains `intendedCookie`: the full Set-Cookie
//   serialization for LOGIN_INTENDED_COOKIE — a signed live value (same
//   secret, options and 600s TTL as bounceToLogin) when pathname+search
//   passes safeNext (including its 512-byte bound), and a clearing
//   serialization (empty value, Max-Age=0) when it does not, so a stale
//   intended cookie from an abandoned journey can never be honored.
// - Each binding emits that cookie on the redirect response (SvelteKit
//   cookies API or an equivalent Set-Cookie on the 302). The callback side
//   is unchanged: consumeLoginReturn / readReturnJourney must verify and
//   honor the cookie this bounce writes, which this suite proves by
//   round-tripping through those real consumers.
//
// Passing controls pin the surrounding contract the fix must not break:
// unknown session stays unavailable (503 mapping), signed-in non-member
// stays forbidden (403 mapping), guests/non-members never touch the store,
// authenticated reads still resolve, forged/hostile intended cookies still
// fall back to the default landing, and both route-ownership flags stay
// disabled (this is a pre-enablement parity fix, not an activation).
//
// Hermetic: memory stores, fixture secret, synthetic callback only. No
// database, no OAuth, no network, no route activation.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import type { Env } from "../src/env";
import { readReturnJourney } from "../src/kit-session";
import { memberReadResponse } from "../src/member-reads";
import {
  resolveKitProfile,
  type KitProfileDeps,
  type KitProfileOutcome,
  type KitProfileRequest,
} from "../src/profiles/kit";
import { createMemoryProfileStore, type MemberView } from "../src/profiles/store";
import {
  consumeLoginReturn,
  LOGIN_INTENDED_COOKIE,
  LOGIN_NEXT_COOKIE,
} from "../src/return-journey";
import { decideRoute } from "../src/route-ownership";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP = "https://next.example.test";
const ALICE = "100000000000000001";
const BOB = "100000000000000002";
const OUTSIDER = "100000000000000004";

const env: Env = {
  APP_URL: APP,
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  DISCORD_BOT_TOKEN: "fixture",
  SESSION_SECRET,
};

// The wished-for seam, expressed as intersections so this file typechecks
// both before and after the Builder adds the fields for real.
type ReqWithUrl = KitProfileRequest & { url?: string };
type DepsWithSecret = KitProfileDeps & { sessionSecret?: string };
type RedirectWithCookie = Extract<KitProfileOutcome, { kind: "redirect" }> & {
  intendedCookie?: string;
};

const seedMembers = (): MemberView[] => [
  { id: ALICE, username: "alice", avatar: null, bio: "Alice bio", games: [], timezone: null },
  { id: BOB, username: "bob", avatar: null, bio: null, games: [], timezone: null },
];

const guestSession = () => ({ status: "guest", session: null }) as KitProfileRequest["session"];
const unknownSession = () => ({ status: "unknown", session: null }) as KitProfileRequest["session"];
const memberSession = (userId: string) =>
  ({
    status: "authenticated",
    session: { userId, username: "viewer", avatar: null, member: true, moderator: false },
  }) as KitProfileRequest["session"];
const outsiderSession = () =>
  ({
    status: "authenticated",
    session: {
      userId: OUTSIDER,
      username: "outsider",
      avatar: null,
      member: false,
      moderator: false,
    },
  }) as KitProfileRequest["session"];

const depsFor = (overrides: Partial<DepsWithSecret> = {}): DepsWithSecret => ({
  store: createMemoryProfileStore(seedMembers()),
  sessionSecret: SESSION_SECRET,
  ...overrides,
});
const reqFor = (
  session: KitProfileRequest["session"],
  requestedId: string | null,
  url?: string,
): ReqWithUrl => ({ session, requestedId, joinResult: null, url });

// Minimal browser jar over Set-Cookie serializations: later wins,
// Max-Age=0 / empty value deletes — what a real browser sends back.
type Jar = Record<string, string>;
const applySetCookie = (jar: Jar, setCookie: string): Jar => {
  const [pair, ...attrs] = setCookie.split(";");
  const eq = pair!.indexOf("=");
  const name = pair!.slice(0, eq).trim();
  const value = pair!.slice(eq + 1);
  if (value === "" || attrs.some((a) => /max-age=0/i.test(a.trim()))) delete jar[name];
  else jar[name] = value;
  return jar;
};
const jarFromResponse = (res: Response, into: Jar = {}): Jar => {
  for (const c of res.headers.getSetCookie()) applySetCookie(into, c);
  return into;
};
const cookieHeader = (jar: Jar): string =>
  Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

// Synthetic sign-in completion: the real Hono callback consumer.
const callback = new Hono<{ Bindings: Env }>();
callback.get("/consume", async (c) => c.text((await consumeLoginReturn(c)) ?? "default"));
const consume = (jar: Jar) =>
  callback.request("/consume", { headers: { cookie: cookieHeader(jar) } }, env);

const guestBounce = async (url: string, requestedId: string | null) => {
  const deps = depsFor();
  const find = vi.spyOn(deps.store!, "find");
  const outcome = (await resolveKitProfile(
    reqFor(guestSession(), requestedId, url),
    deps,
  )) as RedirectWithCookie;
  return { outcome, find };
};

beforeEach(() => {
  __resetAlertRateLimitForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("guest bounce records the intended member page (signed, bounded)", () => {
  it("guest /profile with query: sign-in completion returns to pathname+search exactly", async () => {
    const { outcome, find } = await guestBounce(`${APP}/profile?tab=games`, null);
    expect(outcome.kind).toBe("redirect");
    expect(outcome.location).toBe("/auth/discord");
    expect(find).not.toHaveBeenCalled();
    expect(outcome.intendedCookie, "bounce must carry the intended cookie").toBeTruthy();
    const jar = applySetCookie({}, outcome.intendedCookie!);
    expect(jar[LOGIN_INTENDED_COOKIE]).toBeTruthy();
    const done = await consume(jar);
    expect(await done.text()).toBe("/profile?tab=games");
    // Terminal consume clears both journey cookies (existing contract).
    const cleared = done.headers.getSetCookie().join("\n");
    expect(cleared).toContain(`${LOGIN_INTENDED_COOKIE}=; Max-Age=0`);
    expect(cleared).toContain(`${LOGIN_NEXT_COOKIE}=; Max-Age=0`);
  });

  it("guest /members/:user with query: sign-in completion returns to that member page", async () => {
    const { outcome, find } = await guestBounce(`${APP}/members/${ALICE}?from=board`, ALICE);
    expect(outcome.kind).toBe("redirect");
    expect(outcome.location).toBe("/auth/discord");
    expect(find).not.toHaveBeenCalled();
    expect(outcome.intendedCookie, "bounce must carry the intended cookie").toBeTruthy();
    const jar = applySetCookie({}, outcome.intendedCookie!);
    const done = await consume(jar);
    expect(await done.text()).toBe(`/members/${ALICE}?from=board`);
  });

  it("the Kit read side agrees: readReturnJourney resolves the same destination", async () => {
    const { outcome } = await guestBounce(`${APP}/members/${BOB}`, BOB);
    expect(outcome.intendedCookie).toBeTruthy();
    const jar = applySetCookie({}, outcome.intendedCookie!);
    const journey = await readReturnJourney(
      new Request(`${APP}/auth/discord`, { headers: { cookie: cookieHeader(jar) } }),
      SESSION_SECRET,
    );
    expect(journey.returnTo).toBe(`/members/${BOB}`);
  });

  it("the intended cookie carries the Hono bounce attributes and a 600s TTL", async () => {
    const { outcome } = await guestBounce(`${APP}/profile`, null);
    const setCookie = outcome.intendedCookie ?? "";
    expect(setCookie.startsWith(`${LOGIN_INTENDED_COOKIE}=`)).toBe(true);
    expect(setCookie).toMatch(/path=\//i);
    expect(setCookie).toMatch(/httponly/i);
    expect(setCookie).toMatch(/secure/i);
    expect(setCookie).toMatch(/samesite=lax/i);
    expect(setCookie).toMatch(/max-age=600/i);
  });

  it("the recorded value is signed: a tampered cookie falls back to the default landing", async () => {
    const { outcome } = await guestBounce(`${APP}/profile`, null);
    expect(outcome.intendedCookie).toBeTruthy();
    const jar = applySetCookie({}, outcome.intendedCookie!);
    const value = jar[LOGIN_INTENDED_COOKIE]!;
    // The raw destination must not ride unsigned, and flipping the signature
    // tail must destroy verification (a plaintext value would survive this).
    expect(decodeURIComponent(value)).not.toBe("/profile");
    jar[LOGIN_INTENDED_COOKIE] = `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
    const done = await consume(jar);
    expect(await done.text()).toBe("default");
  });

  it("a destination at exactly 512 bytes records a live cookie", async () => {
    const dest = `/profile?x=${"a".repeat(512 - "/profile?x=".length)}`;
    expect(dest.length).toBe(512);
    const { outcome } = await guestBounce(`${APP}${dest}`, null);
    expect(outcome.intendedCookie).toBeTruthy();
    const jar = applySetCookie({}, outcome.intendedCookie!);
    expect(jar[LOGIN_INTENDED_COOKIE]).toBeTruthy();
    const done = await consume(jar);
    expect(await done.text()).toBe(dest);
  });

  it.each([
    ["513-byte pathname+search", `/profile?x=${"a".repeat(513 - "/profile?x=".length)}`],
    ["8192-byte query", `/members/${ALICE}?x=${"a".repeat(8192)}`],
    ["multibyte query past the byte bound once serialized", `/profile?x=${"中".repeat(200)}`],
  ])(
    "oversized %s: still enters OAuth, records no live cookie, and clears stale intended state",
    async (_label, dest) => {
      // A stale live intended cookie from an abandoned earlier journey.
      const stale = (
        await serializeSigned(LOGIN_INTENDED_COOKIE, "/events?stale=1", SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
          maxAge: 600,
        })
      ).split(";")[0]!;
      const jar: Jar = { [LOGIN_INTENDED_COOKIE]: stale.slice(LOGIN_INTENDED_COOKIE.length + 1) };
      const { outcome, find } = await guestBounce(`${APP}${dest}`, ALICE);
      expect(outcome.kind).toBe("redirect");
      expect(outcome.location).toBe("/auth/discord");
      expect(find).not.toHaveBeenCalled();
      expect(outcome.intendedCookie, "oversized bounce must clear, not stay silent").toBeTruthy();
      applySetCookie(jar, outcome.intendedCookie!);
      expect(jar[LOGIN_INTENDED_COOKIE]).toBeUndefined();
      const done = await consume(jar);
      expect(await done.text()).toBe("default");
    },
  );

  it("guest refusal inside the member-read boundary: 302 out, no audit row, no member bytes", async () => {
    const sink = vi.fn(async () => true);
    const res = await memberReadResponse(
      { method: "GET", route: "/members/:user" },
      { resource: "profile", action: "view", route: "profiles.show", viewer: null },
      sink,
      async () => {
        const { outcome } = await guestBounce(`${APP}/members/${ALICE}`, ALICE);
        const headers = new Headers({ location: outcome.location });
        if (outcome.intendedCookie) headers.append("set-cookie", outcome.intendedCookie);
        return new Response(null, { status: 302, headers });
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
    expect(sink).not.toHaveBeenCalled();
    expect(await res.text()).toBe("");
    const jar = jarFromResponse(res);
    expect(jar[LOGIN_INTENDED_COOKIE], "boundary must release the intended cookie").toBeTruthy();
    const done = await consume(jar);
    expect(await done.text()).toBe(`/members/${ALICE}`);
  });
});

describe("passing controls: gate order and callback safety are unchanged", () => {
  it("guest still bounces to ordinary /auth/discord, never the join journey, store untouched", async () => {
    const { outcome, find } = await guestBounce(`${APP}/profile`, null);
    expect(outcome).toMatchObject({ kind: "redirect", location: "/auth/discord" });
    expect(outcome.location).not.toContain("/join");
    expect(find).not.toHaveBeenCalled();
  });

  it("unknown session (outage) is unavailable, not a bounce, with no store read", async () => {
    const deps = depsFor();
    const find = vi.spyOn(deps.store!, "find");
    const outcome = await resolveKitProfile(
      reqFor(unknownSession(), ALICE, `${APP}/profile`),
      deps,
    );
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(find).not.toHaveBeenCalled();
  });

  it("signed-in non-member is forbidden on both reads with no store read", async () => {
    for (const [requestedId, url] of [
      [OUTSIDER, `${APP}/profile`],
      [ALICE, `${APP}/members/${ALICE}`],
    ] as const) {
      const deps = depsFor();
      const find = vi.spyOn(deps.store!, "find");
      const outcome = await resolveKitProfile(reqFor(outsiderSession(), requestedId, url), deps);
      expect(outcome).toEqual({ kind: "forbidden" });
      expect(find).not.toHaveBeenCalled();
    }
  });

  it("authenticated member reads still resolve (self is owner, other is not)", async () => {
    const self = await resolveKitProfile(
      reqFor(memberSession(ALICE), ALICE, `${APP}/profile`),
      depsFor(),
    );
    expect(self.kind).toBe("ok");
    if (self.kind === "ok") {
      expect(self.member.username).toBe("alice");
      expect(self.isOwner).toBe(true);
    }
    const other = await resolveKitProfile(
      reqFor(memberSession(BOB), ALICE, `${APP}/members/${ALICE}`),
      depsFor(),
    );
    expect(other.kind).toBe("ok");
    if (other.kind === "ok") expect(other.isOwner).toBe(false);
  });

  it("a legacy call without url/secret still resolves the plain redirect (no crash)", async () => {
    const outcome = await resolveKitProfile(
      { session: guestSession(), requestedId: ALICE, joinResult: null },
      { store: createMemoryProfileStore(seedMembers()) },
    );
    expect(outcome).toMatchObject({ kind: "redirect", location: "/auth/discord" });
  });

  it.each([
    ["unsigned", "/profile"],
    ["garbage", "not-a-signed-value"],
  ])("a forged %s intended cookie is ignored at consume time", async (_label, value) => {
    const done = await consume({ [LOGIN_INTENDED_COOKIE]: value });
    expect(await done.text()).toBe("default");
  });

  it.each([
    ["absolute URL", "https://evil.test/phish"],
    ["protocol-relative", "//evil.test/phish"],
    ["oversized", `/profile?x=${"a".repeat(9000)}`],
  ])(
    "a signed-but-hostile intended value (%s) can never become an open redirect",
    async (_label, hostile) => {
      const signed = (
        await serializeSigned(LOGIN_INTENDED_COOKIE, hostile, SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
          maxAge: 600,
        })
      ).split(";")[0]!;
      const jar: Jar = { [LOGIN_INTENDED_COOKIE]: signed.slice(LOGIN_INTENDED_COOKIE.length + 1) };
      const done = await consume(jar);
      expect(await done.text()).toBe("default");
      expect(done.headers.getSetCookie().join("\n")).toContain(
        `${LOGIN_INTENDED_COOKIE}=; Max-Age=0`,
      );
      const journey = await readReturnJourney(
        new Request(`${APP}/auth/discord`, { headers: { cookie: cookieHeader(jar) } }),
        SESSION_SECRET,
      );
      expect(journey.returnTo).toBeNull();
    },
  );

  it("both profile route-ownership flags stay disabled (pre-enablement only)", () => {
    const get = (path: string) => decideRoute(new Request(`${APP}${path}`));
    expect(get("/profile")).toBeUndefined();
    expect(get(`/members/${ALICE}`)).toBeUndefined();
  });
});

describe("bindings thread the request through (source pins)", () => {
  const bindings: ReadonlyArray<readonly [string, string]> = [
    ["/profile", "web/src/routes/profile/+page.server.ts"],
    ["/members/:user", "web/src/routes/members/[user]/+page.server.ts"],
  ];

  it("the Kit model signs the recorded destination with the journey contract", () => {
    const kit = read("src/profiles/kit.ts");
    expect(kit).toContain("intendedCookie");
    expect(kit).toContain("sessionSecret");
    expect(kit).toContain("LOGIN_INTENDED_COOKIE");
    expect(kit).toContain("safeNext");
  });

  it.each(bindings)(
    "%s binding passes its request URL and the signer into the model",
    (_r, path) => {
      const src = read(path);
      expect(src).toMatch(/resolveKitProfile\([\s\S]*?url/);
      expect(src).toContain("sessionSecret");
    },
  );

  it.each(bindings)("%s guest redirect emits the intended cookie", (_r, path) => {
    const src = read(path);
    const bindingEmits =
      src.includes("intendedCookie") && /(cookies\.|set-cookie|setHeaders)/i.test(src);
    // Equivalent placement: the hook layer appends it to the 302 instead.
    const hookEmits = /intendedCookie/.test(
      `${read("web/src/hooks.server.ts")}\n${read("src/route-ownership.ts")}`,
    );
    expect(bindingEmits || hookEmits, `${path} must emit outcome.intendedCookie`).toBe(true);
  });

  it("the read-only session bridge gains no session issuance", () => {
    const hooks = read("web/src/hooks.server.ts");
    expect(hooks).toContain("kitSessionBridge");
    expect(hooks).not.toMatch(/createSession|mintSession|issueSession/);
    const bridge = read("src/kit-session.ts");
    expect(bridge).not.toMatch(/ export (async )?function (create|mint|issue)Session/);
  });
});
