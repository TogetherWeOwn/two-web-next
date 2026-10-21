// Acceptance contract: Kit member-board guest bounce carries the return
// destination through ordinary Discord sign-in (Hono bounceToLogin parity).
//
// Defect at base: web/src/routes/leaderboards/members/+page.server.ts maps
// the helper's branded 302 to a bare redirect(302, "/auth/discord"), and
// src/kit-members.ts loadMembersBoardData throws membersGuestBounce() with
// no destination recorded. A guest who deep-linked the Kit-served board —
// plain or with ?season=&scope=&activity= filters — therefore lands on the
// default page after sign-in instead of the exact board view they asked
// for. The Hono twin records pathname+search into the signed
// login_intended cookie before the same redirect (src/return-journey.ts
// bounceToLogin): length-bounded at write time, stale state cleared when
// the destination is rejected, oversized falls back to the bare bounce,
// and the callback (consumeLoginReturn) honors it exactly once.
//
// One mechanism, deliberately: the signed intended cookie, not the admin
// guard's ?next= form. A bare ?next-less bounce for a hostile/oversized
// destination would leave a stale login_intended cookie from an abandoned
// earlier journey in place for the callback to honor (explicit next >
// intended > default), so only the intended-cookie mechanism can both
// record the destination and clear stale state on rejection, byte-for-byte
// the Hono contract this suite pins as a differential.
//
// Required Builder seam (this file is the specification; do not edit it):
// - MembersBoardArgs gains the full request URL (`url?: string`), supplied
//   by the binding from the SvelteKit load event (`url.href`). It stays
//   optional: a legacy call without it resolves the plain branded 302.
// - No new signer input: the helper already receives `env`, and
//   env.SESSION_SECRET is the same secret bounceToLogin signs with. When
//   no url is supplied, or the secret is absent/empty, the bounce stays
//   plain (no signing attempt, no crash).
// - When a url and secret are present, the guest branded error gains
//   `intendedCookie`: the full Set-Cookie serialization for
//   LOGIN_INTENDED_COOKIE — a signed live value (same secret, options and
//   600s TTL as bounceToLogin) when pathname+search of the parsed url
//   passes safeNext including its 512-byte bound, and a clearing
//   serialization (empty value, Max-Age=0, same attributes) when it does
//   not — oversized, backslash/control-hostile, or an unparseable url all
//   clear, so stale intended state can never be honored. Only
//   pathname+search is ever recorded: a foreign-origin url contributes
//   its rooted path+search, never its host (no open redirect).
// - The binding emits that cookie on the 302 (SvelteKit cookies API on
//   the guest branch, or an equivalent Set-Cookie appended at the hook
//   layer) and still redirects to the bare "/auth/discord". Non-guest
//   outcomes (403/400/503/200) write no journey cookie. The callback side
//   is unchanged: consumeLoginReturn / readReturnJourney must verify and
//   honor the cookie this bounce writes, which this suite proves by
//   round-tripping through those real consumers and by diffing against
//   the real bounceToLogin for the same URL.
//
// Passing controls pin the surrounding contract the fix must not break:
// gate order (unknown session 503, non-member 403, bad grammar 400, read
// failure 503, all before/without the reads they gate), an authenticated
// member still serving the board, forged/hostile intended cookies still
// falling back to the default landing, explicit login_next still winning
// over a recorded intended destination, and the binding's branded status
// mapping staying in place.
//
// Hermetic: synthetic session states and URLs through the real helper,
// fixture secret, synthetic Hono consumers only. No database, no OAuth,
// no network, no route-enablement change.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import type { Env } from "../src/env";
import { MAX_RETURN_DESTINATION_BYTES } from "../src/join/service";
import {
  loadMembersBoardData,
  membersGuestBounce,
  type MembersBoardArgs,
} from "../src/kit-members";
import { readReturnJourney } from "../src/kit-session";
import { memberReadResponse } from "../src/member-reads";
import {
  bounceToLogin,
  consumeLoginReturn,
  JOURNEY_TTL_SECONDS,
  LOGIN_INTENDED_COOKIE,
  LOGIN_NEXT_COOKIE,
  rememberLoginNext,
} from "../src/return-journey";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP = "https://next.example.test";
const BOARD = "/leaderboards/members";

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
type ArgsWithUrl = MembersBoardArgs & { url?: string };
type GuestError = Error & { status: number; intendedCookie?: string };

const ranked = [
  { userId: "u-a", username: "Ana", count: 5 },
  { userId: "u-viewer", username: "Vic", count: 3 },
  { userId: "u-b", username: "Bo", count: 1 },
];

const guestSession = { status: "guest", userId: null, member: false } as const;
const unknownSession = { status: "unknown", userId: null, member: false } as const;
const memberSession = { status: "authenticated", userId: "u-viewer", member: true } as const;
const outsiderSession = { status: "authenticated", userId: "u-x", member: false } as const;

function args(overrides: Record<string, unknown> = {}): ArgsWithUrl {
  return {
    env,
    session: guestSession,
    seasonParam: null,
    scopeParam: null,
    activityParam: null,
    setHeaders: vi.fn((_headers: Record<string, string>) => {}),
    dbForFn: vi.fn(async () => ({}) as never),
    loadRankingFn: vi.fn(async () => ranked),
    queueBoardViewFn: vi.fn(() => {}),
    ...overrides,
  } as ArgsWithUrl;
}

// Run the helper expecting a branded throw; return the error plus the
// spies that prove the gate fired before any read or header write.
async function bounce(overrides: Record<string, unknown> = {}) {
  const a = args(overrides);
  let err: GuestError | undefined;
  try {
    await loadMembersBoardData(a);
  } catch (e) {
    err = e as GuestError;
  }
  expect(err, "helper must throw a branded error").toBeDefined();
  return { err: err!, a };
}

const guestBounce = (url?: string, overrides: Record<string, unknown> = {}) =>
  bounce({ ...(url === undefined ? {} : { url }), ...overrides });

// Minimal browser jar over Set-Cookie serializations: later wins,
// Max-Age=0 / empty value deletes — what a real browser sends back.
type Jar = Record<string, string>;
const applySetCookie = (jar: Jar, setCookie: string): Jar => {
  const [pair, ...attrs] = setCookie.split(";");
  const eq = pair!.indexOf("=");
  const name = pair!.slice(0, eq).trim();
  const value = pair!.slice(eq + 1);
  if (value === "" || attrs.some((x) => /max-age=0/i.test(x.trim()))) delete jar[name];
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

// Parse one Set-Cookie serialization into value + attribute map, so the
// differential pins the contract (value, attributes, TTL) without
// depending on serialization attribute order.
const parseSetCookie = (setCookie: string) => {
  const [pair, ...rest] = setCookie.split(";").map((s) => s.trim());
  const eq = pair!.indexOf("=");
  const attrs = new Map<string, string>();
  for (const attr of rest) {
    const i = attr.indexOf("=");
    if (i === -1) attrs.set(attr.toLowerCase(), "");
    else attrs.set(attr.slice(0, i).trim().toLowerCase(), attr.slice(i + 1).trim());
  }
  return { name: pair!.slice(0, eq).trim(), value: pair!.slice(eq + 1), attrs };
};

// The real Hono side: the board path lives behind bounceToLogin exactly
// as memberGate bounces guests there, plus the real callback consumers.
const hono = new Hono<{ Bindings: Env }>();
hono.get(BOARD, (c) => bounceToLogin(c));
hono.get("/consume", async (c) => c.text((await consumeLoginReturn(c)) ?? "default"));
hono.get("/remember", async (c) => {
  await rememberLoginNext(c, c.req.query("next"));
  return c.text("ok");
});
const consume = (jar: Jar) =>
  hono.request("/consume", { headers: { cookie: cookieHeader(jar) } }, env);
const honoBounce = (url: string) => hono.request(url, {}, env);

const signedJar = async (name: string, value: string): Promise<Jar> => {
  const pair = (
    await serializeSigned(name, value, SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      maxAge: JOURNEY_TTL_SECONDS,
    })
  ).split(";")[0]!;
  return { [name]: pair.slice(name.length + 1) };
};

beforeEach(() => {
  __resetAlertRateLimitForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("guest bounce records the exact board destination (signed, bounded)", () => {
  it("plain guest deep link: sign-in completion returns to the board exactly", async () => {
    const { err, a } = await guestBounce(`${APP}${BOARD}`);
    expect(err.status).toBe(302);
    expect(a.dbForFn).not.toHaveBeenCalled();
    expect(a.loadRankingFn).not.toHaveBeenCalled();
    expect(a.setHeaders).not.toHaveBeenCalled();
    expect(a.queueBoardViewFn).not.toHaveBeenCalled();
    expect(err.intendedCookie, "bounce must carry the intended cookie").toBeTruthy();
    const jar = applySetCookie({}, err.intendedCookie!);
    expect(jar[LOGIN_INTENDED_COOKIE]).toBeTruthy();
    const done = await consume(jar);
    expect(await done.text()).toBe(BOARD);
    // Terminal consume clears both journey cookies (existing contract).
    const cleared = done.headers.getSetCookie().join("\n");
    expect(cleared).toContain(`${LOGIN_INTENDED_COOKIE}=; Max-Age=0`);
    expect(cleared).toContain(`${LOGIN_NEXT_COOKIE}=; Max-Age=0`);
  });

  it("filtered guest deep link: season/scope/activity survive sign-in verbatim", async () => {
    const dest = `${BOARD}?season=2026-Q3&scope=relative&activity=valheim`;
    const { err, a } = await guestBounce(`${APP}${dest}`, {
      seasonParam: "2026-Q3",
      scopeParam: "relative",
      activityParam: "valheim",
    });
    expect(err.status).toBe(302);
    expect(a.loadRankingFn).not.toHaveBeenCalled();
    expect(err.intendedCookie, "bounce must carry the intended cookie").toBeTruthy();
    const jar = applySetCookie({}, err.intendedCookie!);
    const done = await consume(jar);
    expect(await done.text()).toBe(dest);
  });

  it("query spelling is recorded as requested, not re-normalized", async () => {
    // The raw search rides through: percent-encoding and parameter order
    // are the guest's exact deep link, whatever the grammar would make
    // of them after sign-in (the gate runs before any grammar).
    const dest = `${BOARD}?activity=deep%20rock&scope=overall`;
    const { err } = await guestBounce(`${APP}${dest}`);
    expect(err.intendedCookie).toBeTruthy();
    const jar = applySetCookie({}, err.intendedCookie!);
    const done = await consume(jar);
    expect(await done.text()).toBe(dest);
  });

  it("a guest with bad grammar still bounces (gate before grammar) and records the link", async () => {
    const dest = `${BOARD}?season=bogus`;
    const { err, a } = await guestBounce(`${APP}${dest}`, { seasonParam: "bogus" });
    expect(err.status).toBe(302);
    expect(a.dbForFn).not.toHaveBeenCalled();
    expect(err.intendedCookie).toBeTruthy();
    const jar = applySetCookie({}, err.intendedCookie!);
    expect(await (await consume(jar)).text()).toBe(dest);
  });

  it("the Kit read side agrees: readReturnJourney resolves the same destination", async () => {
    const dest = `${BOARD}?scope=relative`;
    const { err } = await guestBounce(`${APP}${dest}`);
    expect(err.intendedCookie).toBeTruthy();
    const jar = applySetCookie({}, err.intendedCookie!);
    const journey = await readReturnJourney(
      new Request(`${APP}/auth/discord`, { headers: { cookie: cookieHeader(jar) } }),
      SESSION_SECRET,
    );
    expect(journey.returnTo).toBe(dest);
  });

  it("the intended cookie carries the Hono bounce attributes and a 600s TTL", async () => {
    const { err } = await guestBounce(`${APP}${BOARD}`);
    const setCookie = err.intendedCookie ?? "";
    expect(setCookie.startsWith(`${LOGIN_INTENDED_COOKIE}=`)).toBe(true);
    const { attrs } = parseSetCookie(setCookie);
    expect(attrs.get("path")).toBe("/");
    expect(attrs.has("httponly")).toBe(true);
    expect(attrs.has("secure")).toBe(true);
    expect(attrs.get("samesite")?.toLowerCase()).toBe("lax");
    expect(attrs.get("max-age")).toBe(String(JOURNEY_TTL_SECONDS));
  });

  it("the recorded value is signed: a tampered cookie falls back to the default landing", async () => {
    const { err } = await guestBounce(`${APP}${BOARD}`);
    expect(err.intendedCookie).toBeTruthy();
    const jar = applySetCookie({}, err.intendedCookie!);
    const value = jar[LOGIN_INTENDED_COOKIE]!;
    // The raw destination must not ride unsigned, and flipping the
    // signature tail must destroy verification (a plaintext value
    // would survive this).
    expect(decodeURIComponent(value)).not.toBe(BOARD);
    jar[LOGIN_INTENDED_COOKIE] = `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
    const done = await consume(jar);
    expect(await done.text()).toBe("default");
  });

  it(`a destination at exactly ${MAX_RETURN_DESTINATION_BYTES} bytes records a live cookie`, async () => {
    const prefix = `${BOARD}?x=`;
    const dest = `${prefix}${"a".repeat(MAX_RETURN_DESTINATION_BYTES - prefix.length)}`;
    expect(dest.length).toBe(MAX_RETURN_DESTINATION_BYTES);
    const { err } = await guestBounce(`${APP}${dest}`);
    expect(err.intendedCookie).toBeTruthy();
    const jar = applySetCookie({}, err.intendedCookie!);
    expect(jar[LOGIN_INTENDED_COOKIE]).toBeTruthy();
    expect(await (await consume(jar)).text()).toBe(dest);
  });

  it.each([
    [
      `${MAX_RETURN_DESTINATION_BYTES + 1}-byte pathname+search`,
      `${BOARD}?x=${"a".repeat(MAX_RETURN_DESTINATION_BYTES + 1 - `${BOARD}?x=`.length)}`,
    ],
    ["8192-byte query", `${BOARD}?x=${"a".repeat(8192)}`],
    ["multibyte query past the byte bound once serialized", `${BOARD}?x=${"中".repeat(200)}`],
    ["backslash-hostile query", `${BOARD}?x=\\evil`],
  ])(
    "rejected %s: still a 302 bounce, records no live cookie, clears stale intended state",
    async (_label, dest) => {
      // A stale live intended cookie from an abandoned earlier journey.
      const jar = await signedJar(LOGIN_INTENDED_COOKIE, "/events?stale=1");
      const { err, a } = await guestBounce(`${APP}${dest}`);
      expect(err.status).toBe(302);
      expect(a.loadRankingFn).not.toHaveBeenCalled();
      expect(err.intendedCookie, "rejected bounce must clear, not stay silent").toBeTruthy();
      const { name, value, attrs } = parseSetCookie(err.intendedCookie!);
      expect(name).toBe(LOGIN_INTENDED_COOKIE);
      expect(value).toBe("");
      expect(attrs.get("max-age")).toBe("0");
      applySetCookie(jar, err.intendedCookie!);
      expect(jar[LOGIN_INTENDED_COOKIE]).toBeUndefined();
      expect(await (await consume(jar)).text()).toBe("default");
    },
  );

  it.each(["not a url", "//evil.test/leaderboards/members"])(
    "unparseable url %j: still a 302 bounce, clears stale intended state, never throws open",
    async (url) => {
      const jar = await signedJar(LOGIN_INTENDED_COOKIE, "/events?stale=1");
      const { err } = await guestBounce(url);
      expect(err.status).toBe(302);
      expect(err.intendedCookie, "unparseable bounce must clear, not stay silent").toBeTruthy();
      applySetCookie(jar, err.intendedCookie!);
      expect(jar[LOGIN_INTENDED_COOKIE]).toBeUndefined();
      expect(await (await consume(jar)).text()).toBe("default");
    },
  );

  it("a foreign-origin url contributes only its rooted path+search (no open redirect)", async () => {
    const { err } = await guestBounce(`https://evil.test${BOARD}?season=all`);
    expect(err.status).toBe(302);
    expect(err.intendedCookie).toBeTruthy();
    const jar = applySetCookie({}, err.intendedCookie!);
    const done = await consume(jar);
    expect(await done.text()).toBe(`${BOARD}?season=all`);
  });

  it("guest refusal inside the member-read boundary: 302 out, no audit row, cookie released", async () => {
    const sink = vi.fn(async () => true);
    const res = await memberReadResponse(
      { method: "GET", route: BOARD },
      { resource: "leaderboard", action: "list", route: "leaderboards.members", viewer: null },
      sink,
      async () => {
        const { err } = await guestBounce(`${APP}${BOARD}?scope=relative`);
        const headers = new Headers({ location: "/auth/discord" });
        if (err.intendedCookie) headers.append("set-cookie", err.intendedCookie);
        return new Response(null, { status: 302, headers });
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
    expect(sink).not.toHaveBeenCalled();
    expect(await res.text()).toBe("");
    const jar = jarFromResponse(res);
    expect(jar[LOGIN_INTENDED_COOKIE], "boundary must release the intended cookie").toBeTruthy();
    expect(await (await consume(jar)).text()).toBe(`${BOARD}?scope=relative`);
  });
});

describe("Hono parity differential: same URL, same bounce contract", () => {
  const prefix = `${BOARD}?x=`;
  it.each([
    ["plain", BOARD],
    ["filtered", `${BOARD}?season=2026-Q3&scope=relative&activity=valheim`],
    [
      `exactly ${MAX_RETURN_DESTINATION_BYTES} bytes`,
      `${prefix}${"a".repeat(MAX_RETURN_DESTINATION_BYTES - prefix.length)}`,
    ],
    [
      `${MAX_RETURN_DESTINATION_BYTES + 1} bytes`,
      `${prefix}${"a".repeat(MAX_RETURN_DESTINATION_BYTES + 1 - prefix.length)}`,
    ],
    ["backslash-hostile query", `${BOARD}?x=\\evil`],
  ])("Kit guest bounce equals bounceToLogin for %s", async (_label, dest) => {
    const { err } = await guestBounce(`${APP}${dest}`);
    const honoRes = await honoBounce(`${APP}${dest}`);

    // Same bounce: 302 into the ordinary OAuth flow at the bare path.
    expect(err.status).toBe(302);
    expect(honoRes.status).toBe(302);
    expect(honoRes.headers.get("location")).toBe("/auth/discord");

    // Same recorded state: identical signed value (or identical
    // clearing), same cookie attributes and TTL.
    expect(err.intendedCookie, "Kit bounce must carry the intended cookie").toBeTruthy();
    const kit = parseSetCookie(err.intendedCookie!);
    const honoCookie = honoRes.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${LOGIN_INTENDED_COOKIE}=`));
    expect(honoCookie, "Hono bounce must carry the intended cookie").toBeTruthy();
    const honoParsed = parseSetCookie(honoCookie!);
    expect(kit.name).toBe(honoParsed.name);
    expect(kit.value).toBe(honoParsed.value);
    for (const key of ["path", "samesite", "max-age"]) {
      expect(kit.attrs.get(key)?.toLowerCase(), `attribute ${key}`).toBe(
        honoParsed.attrs.get(key)?.toLowerCase(),
      );
    }
    expect(kit.attrs.has("httponly")).toBe(honoParsed.attrs.has("httponly"));
    expect(kit.attrs.has("secure")).toBe(honoParsed.attrs.has("secure"));

    // Same journey outcome through the real callback consumer.
    const kitJar = applySetCookie({}, err.intendedCookie!);
    const honoJar = jarFromResponse(honoRes);
    expect(await (await consume(kitJar)).text()).toBe(await (await consume(honoJar)).text());
  });
});

describe("passing controls: gate order and callback safety are unchanged", () => {
  it("the plain legacy bounce still exists: membersGuestBounce is a bare branded 302", () => {
    const err = membersGuestBounce() as GuestError;
    expect(err.status).toBe(302);
    expect(err.intendedCookie).toBeUndefined();
  });

  it("a legacy call without url still resolves the plain branded 302 (no crash, no read)", async () => {
    const { err, a } = await guestBounce(undefined);
    expect(err.status).toBe(302);
    expect(a.loadRankingFn).not.toHaveBeenCalled();
    expect(a.setHeaders).not.toHaveBeenCalled();
  });

  it("a url with no signer available still resolves the plain branded 302 (no crash)", async () => {
    const { err, a } = await guestBounce(`${APP}${BOARD}`, {
      env: { APP_URL: APP } as never,
    });
    expect(err.status).toBe(302);
    expect(a.loadRankingFn).not.toHaveBeenCalled();
  });

  it("unknown session (outage) is a branded 503, never a bounce, with no read and no cookie", async () => {
    const { err, a } = await bounce({
      session: unknownSession,
      url: `${APP}${BOARD}?scope=relative`,
    });
    expect(err.status).toBe(503);
    expect(err.intendedCookie).toBeUndefined();
    expect(a.loadRankingFn).not.toHaveBeenCalled();
    expect(a.setHeaders).not.toHaveBeenCalled();
  });

  it("signed-in non-member is a branded 403 before grammar, with no read and no cookie", async () => {
    const { err, a } = await bounce({
      session: outsiderSession,
      seasonParam: "bogus",
      url: `${APP}${BOARD}?season=bogus`,
    });
    expect(err.status).toBe(403);
    expect(err.intendedCookie).toBeUndefined();
    expect(a.loadRankingFn).not.toHaveBeenCalled();
    expect(a.setHeaders).not.toHaveBeenCalled();
  });

  it("bad grammar for a member is a branded 400 before any read, with no cookie", async () => {
    for (const overrides of [
      { seasonParam: "bogus" },
      { scopeParam: "friends" },
      { activityParam: "a".repeat(101) },
    ]) {
      const { err, a } = await bounce({
        session: memberSession,
        url: `${APP}${BOARD}`,
        ...overrides,
      });
      expect(err.status).toBe(400);
      expect(err.intendedCookie).toBeUndefined();
      expect(a.dbForFn).not.toHaveBeenCalled();
      expect(a.loadRankingFn).not.toHaveBeenCalled();
    }
  });

  it("a failing board read for a member is a branded 503, with no cookie", async () => {
    const { err } = await bounce({
      session: memberSession,
      url: `${APP}${BOARD}`,
      loadRankingFn: vi.fn(async () => {
        throw new Error("down");
      }),
    });
    expect(err.status).toBe(503);
    expect(err.intendedCookie).toBeUndefined();
  });

  it("an authenticated member still serves the board (rows, headers, queued view)", async () => {
    const a = args({ session: memberSession, url: `${APP}${BOARD}?scope=relative` });
    const data = await loadMembersBoardData(a);
    expect(data.scope).toBe("overall");
    expect(data.rows.map((row) => row.username)).toEqual(["Ana", "Vic", "Bo"]);
    expect(a.setHeaders).toHaveBeenCalledTimes(1);
    expect(a.setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
    expect(a.queueBoardViewFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["unsigned", BOARD],
    ["garbage", "not-a-signed-value"],
  ])("a forged %s intended cookie is ignored at consume time", async (_label, value) => {
    const done = await consume({ [LOGIN_INTENDED_COOKIE]: value });
    expect(await done.text()).toBe("default");
  });

  it.each([
    ["absolute URL", "https://evil.test/phish"],
    ["protocol-relative", "//evil.test/phish"],
    ["oversized", `${BOARD}?x=${"a".repeat(9000)}`],
  ])(
    "a signed-but-hostile intended value (%s) can never become an open redirect",
    async (_label, hostile) => {
      const jar = await signedJar(LOGIN_INTENDED_COOKIE, hostile);
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

  it("an explicit login_next still wins over a recorded board destination", async () => {
    const jar = await signedJar(LOGIN_INTENDED_COOKIE, `${BOARD}?scope=relative`);
    const remembered = await hono.request(
      "/remember?next=%2Fevents",
      { headers: { cookie: cookieHeader(jar) } },
      env,
    );
    jarFromResponse(remembered, jar);
    expect(jar[LOGIN_NEXT_COOKIE]).toBeTruthy();
    expect(await (await consume(jar)).text()).toBe("/events");
  });
});

describe("bindings thread the request through (source pins)", () => {
  const bindingPath = "web/src/routes/leaderboards/members/+page.server.ts";

  it("the Kit helper signs the recorded destination with the journey contract", () => {
    const helper = read("src/kit-members.ts");
    expect(helper).toContain("intendedCookie");
    expect(helper).toContain("LOGIN_INTENDED_COOKIE");
    expect(helper).toContain("safeNext");
  });

  it("the board binding passes its request URL into the helper", () => {
    const src = read(bindingPath);
    expect(src).toMatch(/loadMembersBoardData\(\{[\s\S]*?url:\s*url\.href/);
  });

  it("the guest redirect emits the intended cookie", () => {
    const src = read(bindingPath);
    const bindingEmits =
      src.includes("intendedCookie") && /(cookies\.|set-cookie|setHeaders)/i.test(src);
    // Equivalent placement: the hook layer appends it to the 302 instead.
    const hookEmits = /intendedCookie/.test(
      `${read("web/src/hooks.server.ts")}\n${read("src/route-ownership.ts")}`,
    );
    expect(bindingEmits || hookEmits, `${bindingPath} must emit err.intendedCookie`).toBe(true);
  });

  it("control: the binding keeps the bare bounce and branded 403/400/503 mapping", () => {
    const src = read(bindingPath);
    expect(src).toContain('redirect(302, "/auth/discord")');
    expect(src).toContain("error(403");
    expect(src).toContain("error(400");
    expect(src).toContain("error(503");
  });

  it("control: the read-only session bridge gains no session issuance", () => {
    const hooks = read("web/src/hooks.server.ts");
    expect(hooks).toContain("kitSessionBridge");
    expect(hooks).not.toMatch(/createSession|mintSession|issueSession/);
    const bridge = read("src/kit-session.ts");
    expect(bridge).not.toMatch(/ export (async )?function (create|mint|issue)Session/);
  });
});
