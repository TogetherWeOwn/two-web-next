// route-inventory: GET /auth/recover
// route-inventory: GET /auth/discord
// route-inventory: GET /auth/discord/callback
// route-inventory: POST /members/:user
// Acceptance: only genuine expired-write bounces arm the pending notice.
//
// A bare visit to GET /auth/recover must never plant the `pending|<next>`
// notice: today it does, so an attacker link pre-arms a visitor's jar and
// their next ordinary login shows a false "changes were not saved" banner
// (and the landing itself is unthrottled). After the fix the landing renders
// recovery with only the intended destination, the HTML expired-write bounce
// arms `pending|<next>` itself before the 303, and the landing spends the
// shared auth throttle budget (oversized ?next= keeps the no-arm refusal
// without spend). The retry link still carries the destination in its own
// ?next= query; the journey never relies on the landing-minted cookie.
//
// Failing-first handoff: the RED tests below fail on current main and pass
// after the fix; the controls already pass and must stay green. Owned by the
// Test Author: the Builder builds on this branch/history and never edits
// this file — suspect assertions go back to the Test Author.
//
// Hermetic only: real routes with in-memory session/throttle stores and a
// stubbed Discord fetch. No database, no network, no live credentials.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";
import { EXPIRED_WRITE_COOKIE } from "../src/write-recovery";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import { fixtureDiscord, MEMBER, mergeCookies, recoveryFixture } from "./fixtures/session-recovery";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const DEST = "/profile?edit=1";
const DEST_ENC = encodeURIComponent(DEST);
const INTENDED_COOKIE = "__Host-two_login_intended";
const BANNER = 'data-testid="auth-error"';
const LANDING_COPY = "Your earlier changes were not saved";
const BANNER_COPY =
  "You signed in again. Your earlier changes were not saved. Review and submit them again.";

/** The unsigned payload of a signed `name=value.signature` cookie pair. */
const payloadOf = (pair: string | undefined) =>
  pair === undefined
    ? undefined
    : decodeURIComponent(pair.slice(pair.indexOf("=") + 1).split(".")[0]!);

const pairOf = (jar: string, name: string) => jar.split("; ").find((c) => c.startsWith(name + "="));

/** Live (non-clearing) Set-Cookie lines for one name on a response. */
const liveSetCookies = (res: Response, name: string) =>
  res.headers.getSetCookie().filter((c) => c.startsWith(name + "=") && !/Max-Age=0/i.test(c));

type Fixture = ReturnType<typeof recoveryFixture>;

/** One full Discord sign-in round from the given start path. */
async function loginRound(f: Fixture, jar: string, startPath: string) {
  const start = await f.request(startPath, { headers: { cookie: jar } });
  expect(start.status).toBe(302);
  jar = mergeCookies(jar, start);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const callback = await f.request(`/auth/discord/callback?state=${state}&code=fixture`, {
    headers: { cookie: jar },
  });
  return { callback, jar: mergeCookies(jar, callback) };
}

/** Follow a same-origin redirect target the way a browser would. */
async function follow(f: Fixture, jar: string, res: Response) {
  const page = await f.request(res.headers.get("location")!, { headers: { cookie: jar } });
  return { page, html: await page.text(), jar: mergeCookies(jar, page) };
}

/** A genuine expired write: native form POST on a dead session. */
async function genuineBounce(f: Fixture) {
  const dead = await f.login(new Date(0));
  return f.request(`/members/${MEMBER}`, {
    method: "POST",
    headers: {
      cookie: dead.cookie,
      origin: f.env.APP_URL,
      referer: f.env.APP_URL + DEST,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "_method=PATCH&bio=Unsaved+secret+draft",
  });
}

// In-memory stand-in for the shared Postgres fixed-window counter. Records
// every debited bucket so tests assert exactly what a request spent.
function fakeThrottleStore() {
  const hits: { bucket: string; at: number }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const head = strings.join("?");
    if (head.includes("pg_advisory_xact_lock")) return [];
    if (head.includes("SELECT count(*)")) {
      const rows = hits.filter((h) => h.bucket === v[0] && h.at > Date.now() - 60_000);
      return [{ n: rows.length, wait: 30 }];
    }
    if (head.includes("INSERT INTO web_throttle_hits")) {
      hits.push({ bucket: v[0] as string, at: Date.now() });
      return [];
    }
    if (head.includes("DELETE FROM web_throttle_hits")) return [];
    throw new Error(`fakeThrottle: unexpected statement ${head.slice(0, 80)}`);
  }) as unknown as Sql & { begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown> };
  sql.begin = (run) => run(sql);
  (sql as unknown as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  return { sql: withThrottleTx(sql), hits };
}

function exhaustedThrottleStore() {
  return withThrottleTx((async (strings: TemplateStringsArray) => {
    const head = strings.join("?");
    if (head.includes("pg_advisory_xact_lock")) return [];
    if (head.includes("SELECT count(*)")) return [{ n: 999, wait: 30 }];
    return [];
  }) as unknown as Sql);
}

function withFakeThrottle(f: Fixture) {
  const fake = fakeThrottleStore();
  (f.env as unknown as EnvWithThrottle).THROTTLE_STORE = async () => fake.sql;
  return fake;
}

function withExhaustedThrottle(f: Fixture) {
  const sql = exhaustedThrottleStore();
  (f.env as unknown as EnvWithThrottle).THROTTLE_STORE = async () => sql;
}

/** The retry href the landing page offers, carrying the destination itself. */
function retryHref(html: string): string {
  const href = html.match(/href="(\/auth\/discord\?next=[^"]+)"/)?.[1];
  expect(href).toBeDefined();
  return href!;
}

describe("recovery landing never pre-arms the pending notice", () => {
  it("RED: direct GET /auth/recover renders recovery with the intended destination but arms no pending notice", async () => {
    const f = recoveryFixture();
    const res = await f.request(`/auth/recover?next=${DEST_ENC}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("vary")).toBe("Cookie");
    const html = await res.text();
    // Recovery copy and the retry link are unchanged: only the arming goes.
    expect(html).toContain(LANDING_COPY);
    expect(html).toContain("Log in with Discord");
    expect(retryHref(html)).toBe(`/auth/discord?next=${DEST_ENC}`);
    // The intended destination is still recorded for the retry ...
    const intended = liveSetCookies(res, INTENDED_COOKIE);
    expect(intended).toHaveLength(1);
    expect(payloadOf(intended[0]!.split(";")[0]!)).toBe(DEST);
    // ... but no pending notice is minted by a mere link visit.
    expect(liveSetCookies(res, EXPIRED_WRITE_COOKIE)).toEqual([]);
    expect(pairOf(mergeCookies("", res), EXPIRED_WRITE_COOKIE)).toBeUndefined();
  });

  it("RED: pre-arm regression — armed-by-link then a clean login shows no restored banner", async () => {
    vi.stubGlobal("fetch", fixtureDiscord);
    const f = recoveryFixture();
    // The attacker link: a bare landing visit with no expired write behind it.
    const jar0 = mergeCookies("", await f.request(`/auth/recover?next=${DEST_ENC}`));

    // A clean login (no ?next=): whatever the landing recorded must not
    // surface as a "changes were not saved" banner.
    const { callback, jar } = await loginRound(f, jar0, "/auth/discord");
    expect(callback.status).toBe(302);
    expect(pairOf(jar, "__Host-two_session")).toBeDefined();
    expect(liveSetCookies(callback, EXPIRED_WRITE_COOKIE)).toEqual([]);
    expect(payloadOf(pairOf(jar, EXPIRED_WRITE_COOKIE))).toBeUndefined();

    const landed = await follow(f, jar, callback);
    expect(landed.page.status).toBe(200);
    expect(landed.html).not.toContain(BANNER);
    expect(f.state.writes).toBe(0);
  });

  it("RED: a genuine expired-write bounce arms pending itself, and the login banners exactly once", async () => {
    vi.stubGlobal("fetch", fixtureDiscord);
    const f = recoveryFixture();
    const bounce = await genuineBounce(f);
    expect(bounce.status).toBe(303);
    expect(bounce.headers.get("location")).toBe(`/auth/recover?next=${DEST_ENC}`);
    expect(bounce.headers.get("cache-control")).toBe("no-store, private");
    expect(bounce.headers.get("vary")).toBe("Cookie");

    // The bounce itself arms the notice before the 303, with the same
    // signed-cookie attributes the landing uses today.
    const armed = liveSetCookies(bounce, EXPIRED_WRITE_COOKIE);
    expect(armed).toHaveLength(1);
    expect(armed[0]).toContain("HttpOnly");
    expect(armed[0]).toContain("Secure");
    expect(armed[0]).toContain("SameSite=Lax");
    expect(armed[0]).toContain("Max-Age=600");
    expect(payloadOf(armed[0]!.split(";")[0]!)).toBe(`pending|${DEST}`);

    // The landing renders recovery but mints nothing further: the bounce's
    // notice rides through untouched.
    let jar = mergeCookies("", bounce);
    const landing = await f.request(bounce.headers.get("location")!, {
      headers: { cookie: jar },
    });
    expect(landing.status).toBe(200);
    const landingHtml = await landing.text();
    expect(landingHtml).toContain(LANDING_COPY);
    expect(liveSetCookies(landing, EXPIRED_WRITE_COOKIE)).toEqual([]);
    jar = mergeCookies(jar, landing);
    expect(payloadOf(pairOf(jar, EXPIRED_WRITE_COOKIE)!)).toBe(`pending|${DEST}`);

    // The retry link carries the destination in its own ?next= query.
    const retry = retryHref(landingHtml);
    expect(retry).toBe(`/auth/discord?next=${DEST_ENC}`);
    const { callback, jar: loggedIn } = await loginRound(f, jar, retry);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(DEST);
    jar = loggedIn;
    expect(payloadOf(pairOf(jar, EXPIRED_WRITE_COOKIE)!)).toBe(`restored|${DEST}`);

    const landed = await follow(f, jar, callback);
    expect(landed.page.status).toBe(200);
    expect(landed.html).toContain(BANNER_COPY);
    expect(landed.html.match(new RegExp(BANNER, "g"))).toHaveLength(1);
    // Shown once, then gone — no sticky or double banner.
    const again = await f.request(DEST, { headers: { cookie: landed.jar } });
    expect(await again.text()).not.toContain(BANNER);
    expect(pairOf(landed.jar, EXPIRED_WRITE_COOKIE)).toBeUndefined();
    // Recovery never replays the bounced write.
    expect(f.state.writes).toBe(0);
  });

  it("retry destination rides the ?next= query, not the landing-minted intended cookie", async () => {
    vi.stubGlobal("fetch", fixtureDiscord);
    const f = recoveryFixture();
    const bounce = await genuineBounce(f);
    expect(bounce.status).toBe(303);
    let jar = mergeCookies("", bounce);
    const landing = await f.request(bounce.headers.get("location")!, {
      headers: { cookie: jar },
    });
    expect(landing.status).toBe(200);
    jar = mergeCookies(jar, landing);

    // Drop the landing-minted intended cookie: the retry link alone must
    // still carry the member back to the page they came from.
    const withoutIntended = jar
      .split("; ")
      .filter((c) => c && !c.startsWith(INTENDED_COOKIE + "="))
      .join("; ");
    expect(pairOf(withoutIntended, INTENDED_COOKIE)).toBeUndefined();
    const { callback, jar: loggedIn } = await loginRound(
      f,
      withoutIntended,
      retryHref(await landing.text()),
    );
    expect(callback.headers.get("location")).toBe(DEST);
    const landed = await follow(f, loggedIn, callback);
    expect(landed.html.match(new RegExp(BANNER, "g"))).toHaveLength(1);
    expect(f.state.writes).toBe(0);
  });

  it("RED: the landing spends the shared auth throttle budget (10/min shape)", async () => {
    const f = recoveryFixture();
    const fake = withFakeThrottle(f);
    const first = await f.request(`/auth/recover?next=${DEST_ENC}`);
    expect(first.status).toBe(200);
    expect(fake.hits).toHaveLength(1);
    expect(fake.hits[0]!.bucket).toMatch(/:anon$/);

    // Nine more landings exhaust the 10/min budget; the eleventh refuses.
    for (let i = 0; i < 9; i++) {
      const res = await f.request(`/auth/recover?next=${DEST_ENC}`);
      expect(res.status).toBe(200);
    }
    expect(fake.hits).toHaveLength(10);
    const refused = await f.request(`/auth/recover?next=${DEST_ENC}`);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBeDefined();
    // A refusal charges no hit and arms nothing.
    expect(fake.hits).toHaveLength(10);
    expect(liveSetCookies(refused, EXPIRED_WRITE_COOKIE)).toEqual([]);
  });

  it("RED: a throttle-exhausted landing answers 429 with the shared shape and sets nothing", async () => {
    const f = recoveryFixture();
    withExhaustedThrottle(f);
    const res = await f.request(`/auth/recover?next=${DEST_ENC}`);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeDefined();
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await res.text()).not.toContain(LANDING_COPY);
  });

  it("RED: oversized ?next= keeps the no-arm fallback without throttle spend", async () => {
    const f = recoveryFixture();
    const fake = withFakeThrottle(f);
    const big = `/${"p".repeat(600)}`;
    const res = await f.request(`/auth/recover?next=${encodeURIComponent(big)}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Today's fallback destination, without today's arming.
    expect(retryHref(html)).toBe("/auth/discord?next=%2Fprofile");
    expect(html).not.toContain(big.slice(0, 32));
    expect(liveSetCookies(res, EXPIRED_WRITE_COOKIE)).toEqual([]);
    expect(pairOf(mergeCookies("", res), EXPIRED_WRITE_COOKIE)).toBeUndefined();
    // Refused before the throttle: zero budget spent, even on this hit.
    expect(fake.hits).toHaveLength(0);
  });

  it("control: a JSON expired-write bounce keeps the 401 shape and arms nothing", async () => {
    const f = recoveryFixture();
    const dead = await f.login(new Date(0));
    const patch = await f.request(`/members/${MEMBER}`, {
      method: "PATCH",
      headers: {
        cookie: dead.cookie,
        origin: f.env.APP_URL,
        referer: f.env.APP_URL + DEST,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ bio: "Unsaved secret draft" }),
    });
    expect(patch.status).toBe(401);
    expect(patch.headers.get("location")).toBeNull();
    expect(await patch.json()).toEqual({
      error: "Unauthorized",
      recovery: `/auth/recover?next=${DEST_ENC}`,
    });
    expect(patch.headers.getSetCookie()).toEqual([]);
    expect(f.state.writes).toBe(0);
  });

  it("control: the landing performs no session-store reads", async () => {
    const f = recoveryFixture();
    const spies = [
      vi.spyOn(f.sessions, "get"),
      vi.spyOn(f.sessions, "create"),
      vi.spyOn(f.sessions, "replace"),
      vi.spyOn(f.sessions, "renew"),
      vi.spyOn(f.sessions, "statusHash"),
      vi.spyOn(f.sessions, "isActive"),
      vi.spyOn(f.sessions, "rotate"),
      vi.spyOn(f.sessions, "revoke"),
      vi.spyOn(f.sessions, "revokeLineage"),
      vi.spyOn(f.sessions, "revokeUserSessions"),
      vi.spyOn(f.sessions, "sweepExpired"),
      vi.spyOn(f.sessions.journeys, "issue"),
      vi.spyOn(f.sessions.journeys, "consume"),
      vi.spyOn(f.sessions.journeys, "sweepExpired"),
    ];
    const res = await f.request(`/auth/recover?next=${DEST_ENC}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(LANDING_COPY);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
