// route-inventory: GET /auth/recover
// route-inventory: GET /auth/discord
// route-inventory: GET /auth/discord/callback
// Acceptance: the expired-write notice survives a failed auto-join retry.
//
// Journey: a write bounces on a dead session, so /auth/recover plants a
// signed "pending|<destination>" expired-write notice plus the intended
// destination, and the member signs in again. The login callback consumes
// the pending notice on entry. When the guild auto-join (Discord PUT
// member) then fails, the callback signs the member in as a non-member,
// redirects to /?n=join_failed and re-records the intended destination —
// it must also re-set the consumed notice as pending for that same
// destination, so a later successful sign-in can still restore it.
// The pending notice is not a banner: the intermediate join_failed page
// must neither render it nor consume it. On the retry-to-success the
// callback lands on the intended destination with a "restored|<destination>"
// notice and that page renders the resubmit banner exactly once.
//
// Controls that already hold today: with no expired write, the same
// fail-then-retry journey never sets a live notice and never renders the
// banner; and a first-try successful sign-in after recovery renders the
// banner once, unchanged.
//
// Hermetic only: the recovery fixture mounts the real routes with
// in-memory stores and a stubbed Discord fetch. No database, no network,
// no live credentials.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXPIRED_WRITE_COOKIE } from "../src/write-recovery";
import { fixtureDiscord, MEMBER, mergeCookies, recoveryFixture } from "./fixtures/session-recovery";

afterEach(() => vi.unstubAllGlobals());

const DEST = "/profile?edit=1";
const DEST_ENC = encodeURIComponent(DEST);
const INTENDED_COOKIE = "__Host-two_login_intended";
const BANNER = 'data-testid="auth-error"';

/** Discord stub: the recovery fixture's, except the guild-member PUT
 * answers with the queued statuses (the last one repeats). */
function stubAutoJoin(statuses: number[]) {
  let puts = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes(`/guilds/326474832151838730/members/${MEMBER}`) && init?.method === "PUT") {
      const status = statuses[Math.min(puts, statuses.length - 1)] ?? 204;
      puts++;
      return new Response(null, { status });
    }
    return fixtureDiscord(input, init);
  });
  return () => puts;
}

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

/** GET /auth/recover for DEST: plants the pending notice + intended destination. */
async function recoveredJar(f: Fixture): Promise<string> {
  const landing = await f.request(`/auth/recover?next=${DEST_ENC}`);
  expect(landing.status).toBe(200);
  const jar = mergeCookies("", landing);
  // Precondition (holds today): the expired write left a pending notice.
  expect(payloadOf(pairOf(jar, EXPIRED_WRITE_COOKIE)!)).toBe(`pending|${DEST}`);
  expect(payloadOf(pairOf(jar, INTENDED_COOKIE)!)).toBe(DEST);
  return jar;
}

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

describe("expired-write notice survives failed auto-join retries", () => {
  it.each([403, 429, 503])(
    "failed auto-join (PUT %i) re-sets the pending notice for the intended destination, and the join_failed page neither renders nor consumes it",
    async (putStatus) => {
      const puts = stubAutoJoin([putStatus]);
      const f = recoveryFixture();
      const jar0 = await recoveredJar(f);

      const { callback, jar } = await loginRound(f, jar0, `/auth/discord?next=${DEST_ENC}`);
      expect(puts()).toBe(1);
      // Unchanged failure handling: non-member session, join_failed landing,
      // and the intended destination re-recorded for the retry.
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe("/?n=join_failed");
      expect(pairOf(jar, "__Host-two_session")).toBeDefined();
      const intended = liveSetCookies(callback, INTENDED_COOKIE);
      expect(intended).toHaveLength(1);
      expect(payloadOf(intended[0]!.split(";")[0]!)).toBe(DEST);

      // The consumed notice is re-set alongside it, still pending (not yet
      // a banner), with the same signed-cookie attributes as /auth/recover.
      const notice = liveSetCookies(callback, EXPIRED_WRITE_COOKIE);
      expect(notice).toHaveLength(1);
      expect(notice[0]).toContain("HttpOnly");
      expect(notice[0]).toContain("Secure");
      expect(notice[0]).toContain("SameSite=Lax");
      expect(notice[0]).toContain("Max-Age=600");
      expect(payloadOf(notice[0]!.split(";")[0]!)).toBe(`pending|${DEST}`);
      expect(payloadOf(pairOf(jar, EXPIRED_WRITE_COOKIE)!)).toBe(`pending|${DEST}`);

      // The page the browser is sent to must not flash or eat the notice:
      // it is spent only where the member can actually resubmit.
      const landed = await follow(f, jar, callback);
      expect(landed.page.status).toBe(200);
      expect(landed.html).not.toContain(BANNER);
      expect(payloadOf(pairOf(landed.jar, EXPIRED_WRITE_COOKIE)!)).toBe(`pending|${DEST}`);
      expect(f.state.writes).toBe(0);
    },
  );

  it("retry to success after a failed auto-join renders the resubmit banner once on the intended page", async () => {
    const puts = stubAutoJoin([403, 204]);
    const f = recoveryFixture();
    let jar = await recoveredJar(f);

    const failed = await loginRound(f, jar, `/auth/discord?next=${DEST_ENC}`);
    expect(failed.callback.headers.get("location")).toBe("/?n=join_failed");
    jar = (await follow(f, failed.jar, failed.callback)).jar;

    // Retry: a plain sign-in (no ?next=) — the re-recorded intended
    // destination carries the member back to the page they came from.
    const retried = await loginRound(f, jar, "/auth/discord");
    expect(puts()).toBe(2);
    expect(retried.callback.status).toBe(302);
    expect(retried.callback.headers.get("location")).toBe(DEST);
    jar = retried.jar;
    expect(payloadOf(pairOf(jar, EXPIRED_WRITE_COOKIE)!)).toBe(`restored|${DEST}`);

    const landed = await follow(f, jar, retried.callback);
    expect(landed.page.status).toBe(200);
    expect(landed.html.match(new RegExp(BANNER, "g"))).toHaveLength(1);
    // Shown once, then gone — no sticky or double banner.
    const again = await f.request(DEST, { headers: { cookie: landed.jar } });
    expect(await again.text()).not.toContain(BANNER);
    expect(pairOf(landed.jar, EXPIRED_WRITE_COOKIE)).toBeUndefined();
    // Recovery never replays the bounced write.
    expect(f.state.writes).toBe(0);
  });

  it("control: without an expired write, the same fail-then-retry journey sets no notice and renders no banner", async () => {
    const puts = stubAutoJoin([403, 204]);
    const f = recoveryFixture();

    const failed = await loginRound(f, "", `/auth/discord?next=${DEST_ENC}`);
    expect(failed.callback.headers.get("location")).toBe("/?n=join_failed");
    expect(liveSetCookies(failed.callback, EXPIRED_WRITE_COOKIE)).toEqual([]);
    const mid = await follow(f, failed.jar, failed.callback);
    expect(mid.html).not.toContain(BANNER);

    const retried = await loginRound(f, mid.jar, "/auth/discord");
    expect(puts()).toBe(2);
    expect(retried.callback.headers.get("location")).toBe(DEST);
    expect(liveSetCookies(retried.callback, EXPIRED_WRITE_COOKIE)).toEqual([]);
    const landed = await follow(f, retried.jar, retried.callback);
    expect(landed.page.status).toBe(200);
    expect(landed.html).not.toContain(BANNER);
    expect(f.state.writes).toBe(0);
  });

  it("control: first-try success after recovery still renders the banner exactly once", async () => {
    const puts = stubAutoJoin([204]);
    const f = recoveryFixture();
    const jar0 = await recoveredJar(f);

    const { callback, jar } = await loginRound(f, jar0, `/auth/discord?next=${DEST_ENC}`);
    expect(puts()).toBe(1);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(DEST);
    expect(payloadOf(pairOf(jar, EXPIRED_WRITE_COOKIE)!)).toBe(`restored|${DEST}`);

    const landed = await follow(f, jar, callback);
    expect(landed.html.match(new RegExp(BANNER, "g"))).toHaveLength(1);
    const again = await f.request(DEST, { headers: { cookie: landed.jar } });
    expect(await again.text()).not.toContain(BANNER);
    expect(f.state.writes).toBe(0);
  });
});
