// route-inventory: GET /auth/status
// route-inventory: GET /auth/recover
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { AUTH_STATUS_COOKIE, authStatusScript } from "../src/auth-status";
import { SESSION_COOKIE } from "../src/session-cookie";
import { hashToken } from "../src/sessions";
import {
  EXPIRED_WRITE_COOKIE,
  expiredWriteBanner,
  expiredWriteBounce,
} from "../src/write-recovery";
import {
  fixtureDiscord,
  MEMBER,
  mergeCookies,
  recoveryFixture,
  SECRET,
} from "./fixtures/session-recovery";

afterEach(() => vi.unstubAllGlobals());
const only = (cookies: string, name: string) =>
  cookies.split("; ").find((c) => c.startsWith(name + "="))!;
/** The bearer inside a `name=signed` cookie pair (unsigned half). */
const bearerOf = (pair: string): string => {
  const signedValue = decodeURIComponent(pair.slice(pair.indexOf("=") + 1).split(";")[0]!);
  return signedValue.slice(0, signedValue.lastIndexOf("."));
};
const signed = async (name: string, value: string) =>
  (await serializeSigned(name, value, SECRET, { path: "/", secure: true })).split(";")[0]!;

/** A genuine expired write: native form POST on a dead session, arming pending|. */
async function genuineBounceJar(
  f: ReturnType<typeof recoveryFixture>,
  refererPath: string | null,
): Promise<string> {
  const dead = await f.login(new Date(0));
  const bounce = await f.request(`/members/${MEMBER}`, {
    method: "POST",
    headers: {
      cookie: dead.cookie,
      origin: f.env.APP_URL,
      ...(refererPath === null ? {} : { referer: f.env.APP_URL + refererPath }),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "_method=PATCH&bio=Unsaved+secret+draft",
  });
  expect(bounce.status).toBe(303);
  let jar = mergeCookies("", bounce);
  const landing = await f.request(bounce.headers.get("location")!, {
    headers: { cookie: jar },
  });
  expect(landing.status).toBe(200);
  return mergeCookies(jar, landing);
}

describe("read-only bool-only auth status", () => {
  it("guests and members disclose no identity, rotate nothing and forbid caches", async () => {
    const f = recoveryFixture();
    const login = await f.login();
    for (const [cookie, authenticated] of [
      ["", false],
      [login.cookie, true],
    ] as const) {
      const response = await f.request("/auth/status", { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ authenticated });
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      expect(response.headers.get("vary")).toBe("Cookie");
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(await f.sessions.get(login.tokenHash)).not.toBeNull();
  });

  it("a stable probe stays live before the rotating page's Set-Cookie is delivered; predecessors then dead", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.parse("2030-01-01T12:00:00Z"));
      const f = recoveryFixture();
      const login = await f.login();
      const profile = await f.request("/profile", { headers: { cookie: login.cookie } });
      const oldJar = mergeCookies(login.cookie, profile);
      const rotating = await f.request("/", { headers: { cookie: oldJar } });
      // Deliberately do not deliver rotating.headers to this cookie jar yet.
      // The profile view already rotated once, so the login bearer is a
      // pruned grandparent; the profile bearer keeps grace with its
      // successor live.
      expect(await f.sessions.get(login.tokenHash)).toBeNull();
      const profileHash = await hashToken(bearerOf(only(oldJar, SESSION_COOKIE)));
      expect(await f.sessions.get(profileHash)).toMatchObject({ userId: MEMBER });
      const probe = await f.request("/auth/status", { headers: { cookie: oldJar } });
      expect(await probe.json()).toEqual({ authenticated: true });
      expect(probe.headers.getSetCookie()).toEqual([]);
      const replay = await f.request("/profile", { headers: { cookie: oldJar } });
      expect(replay.status).toBe(200);
      const probeOnly = await f.request("/profile", {
        headers: { cookie: only(oldJar, AUTH_STATUS_COOKIE) },
      });
      expect(probeOnly.status).toBe(302);
      // Past grace the predecessor is a guest while its successor stays live.
      vi.setSystemTime(Date.parse("2030-01-01T12:01:00Z"));
      expect(await f.sessions.get(login.tokenHash)).toBeNull();
      const replayAfter = await f.request("/profile", { headers: { cookie: oldJar } });
      expect(replayAfter.status).toBe(302);
      const newJar = mergeCookies(oldJar, rotating);
      expect((await f.request("/profile", { headers: { cookie: newJar } })).status).toBe(200);
      const logout = await f.request("/logout", {
        method: "POST",
        headers: { cookie: newJar, origin: f.env.APP_URL },
      });
      expect(logout.status).toBe(303);
      expect(
        logout.headers
          .getSetCookie()
          .some((c) => c.startsWith(AUTH_STATUS_COOKIE + "=") && c.includes("Max-Age=0")),
      ).toBe(true);
      expect(
        await (await f.request("/auth/status", { headers: { cookie: oldJar } })).json(),
      ).toEqual({ authenticated: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("expiry/revocation return false; a store outage is 503 rather than an authoritative logout", async () => {
    const f = recoveryFixture();
    const dead = await f.login(new Date(0));
    expect(
      await (await f.request("/auth/status", { headers: { cookie: dead.cookie } })).json(),
    ).toEqual({ authenticated: false });
    const live = await f.login();
    const jar = mergeCookies(
      live.cookie,
      await f.request("/profile", { headers: { cookie: live.cookie } }),
    );
    vi.spyOn(f.sessions, "isActive").mockRejectedValueOnce(new Error("storage unavailable"));
    const outage = await f.request("/auth/status", { headers: { cookie: jar } });
    expect(outage.status).toBe(503);
    expect(await outage.json()).toEqual({ authenticated: false });
    // Revoke the jar's live bearer (the profile view already rotated the
    // login bearer): the lineage dies and the probe answers false.
    await f.sessions.revoke(await hashToken(bearerOf(only(jar, SESSION_COOKIE))));
    expect(await (await f.request("/auth/status", { headers: { cookie: jar } })).json()).toEqual({
      authenticated: false,
    });
    expect(
      await (
        await f.request("/auth/status", { headers: { cookie: AUTH_STATUS_COOKIE + "=forged" } })
      ).json(),
    ).toEqual({ authenticated: false });
  });

  it("only allowed authenticated full GET documents emit exactly one controller and preserve headers", async () => {
    const f = recoveryFixture();
    expect(await (await f.request("/")).text()).not.toContain("auth-tab-sync");
    const login = await f.login();
    const response = await f.request("/profile", { headers: { cookie: login.cookie } });
    expect((await response.text()).match(/data-testid="auth-tab-sync"/g)).toHaveLength(1);
    expect(
      response.headers.getSetCookie().some((c) => c.startsWith(AUTH_STATUS_COOKIE + "=")),
    ).toBe(true);
    // Later requests follow the fresh jar: the profile view rotated the
    // login bearer, so the login cookie alone now reads grace without
    // re-stamping.
    const jar = mergeCookies(login.cookie, response);
    const head = await f.request("/profile", { method: "HEAD", headers: { cookie: jar } });
    expect(await head.text()).not.toContain("auth-tab-sync");
    const home = await f.request("/", { headers: { cookie: jar } });
    expect(home.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(
      home.headers.getSetCookie().filter((c) => c.startsWith("__Host-two_session=")),
    ).toHaveLength(1);
  });
});

describe("explicit expired-write recovery, never replay", () => {
  it.each<{ headers: Record<string, string>; jsonOnly: boolean; status: number }>([
    { headers: {}, jsonOnly: false, status: 303 },
    { headers: { accept: "application/json" }, jsonOnly: false, status: 401 },
    { headers: { "content-type": "application/json" }, jsonOnly: false, status: 401 },
    { headers: {}, jsonOnly: true, status: 401 },
  ])("the bounce itself forbids caching ($status, $headers, $jsonOnly)", async (test) => {
    const app = new Hono();
    app.post("/members/:user", (c) => expiredWriteBounce(c, test.jsonOnly));
    const response = await app.request(
      `https://next.example.test/members/${MEMBER}`,
      { method: "POST", headers: test.headers },
      { APP_URL: "https://next.example.test", SESSION_SECRET: SECRET },
    );
    expect(response.status).toBe(test.status);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("vary")).toBe("Cookie");
    if (test.status === 303) {
      expect(response.headers.get("location")).toBe("/auth/recover?next=%2Fprofile");
      // The genuine HTML bounce arms its own pending notice before the 303.
      const armed = response.headers
        .getSetCookie()
        .filter((c) => c.startsWith(EXPIRED_WRITE_COOKIE + "="));
      expect(armed).toHaveLength(1);
      const pair = armed[0]!.split(";")[0]!;
      const payload = decodeURIComponent(pair.slice(pair.indexOf("=") + 1).split(".")[0]!);
      expect(payload).toBe("pending|/profile");
    } else {
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.json()).toEqual({
        error: "unauthenticated",
        recovery: "/auth/recover?next=%2Fprofile",
      });
    }
  });

  it("an expired JSON PATCH remains 401 and native POST reaches durable recovery without any write", async () => {
    const f = recoveryFixture();
    const dead = await f.login(new Date(0));
    const patch = await f.request(`/members/${MEMBER}`, {
      method: "PATCH",
      headers: {
        cookie: dead.cookie,
        origin: f.env.APP_URL,
        referer: f.env.APP_URL + "/profile?edit=1",
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ bio: "Unsaved secret draft", games_text: "Go", timezone: "UTC" }),
    });
    expect(patch.status).toBe(401);
    expect(patch.headers.get("cache-control")).toBe("no-store, private");
    expect(patch.headers.get("vary")).toBe("Cookie");
    expect(await patch.json()).toEqual({
      error: "unauthenticated",
      recovery: "/auth/recover?next=%2Fprofile%3Fedit%3D1",
    });
    expect(patch.headers.getSetCookie()).toEqual([]);
    const native = await f.request(`/members/${MEMBER}`, {
      method: "POST",
      headers: {
        cookie: dead.cookie,
        origin: f.env.APP_URL,
        referer: "https://hostile.example/profile",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "_method=PATCH&bio=Unsaved+secret+draft",
    });
    expect(native.status).toBe(303);
    expect(native.headers.get("cache-control")).toBe("no-store, private");
    expect(native.headers.get("vary")).toBe("Cookie");
    // The genuine bounce arms pending| for the fallback destination (the
    // hostile referer is refused); the JSON 401 above arms nothing.
    const armed = native.headers
      .getSetCookie()
      .filter((c) => c.startsWith(EXPIRED_WRITE_COOKIE + "="));
    expect(armed).toHaveLength(1);
    expect(native.headers.get("location")).toBe("/auth/recover?next=%2Fprofile");
    const landing = await f.request(native.headers.get("location")!);
    expect(landing.status).toBe(200);
    expect(landing.headers.get("cache-control")).toBe("no-store, private");
    expect(landing.headers.get("vary")).toBe("Cookie");
    expect(await landing.text()).toContain("Your earlier changes were not saved");
    const jar = mergeCookies("", landing);
    expect(jar).not.toContain("Unsaved");
    expect(f.state.writes).toBe(0);
    expect(f.profiles.rows.get(MEMBER)?.bio).toBe("Accepted bio");
  });

  it.each([
    "https://evil.example/",
    "//evil.example/",
    "/\\evil",
    "javascript:alert(1)",
    "",
    " /profile",
  ])("revalidates hostile/blank next %s", async (next) => {
    const f = recoveryFixture();
    const response = await f.request("/auth/recover?next=" + encodeURIComponent(next));
    expect(await response.text()).toContain('href="/auth/discord?next=%2Fprofile"');
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("vary")).toBe("Cookie");
  });

  it("OAuth returns to the safe original page, banner is consumed once, HEAD and audit failures leave it pending", async () => {
    vi.stubGlobal("fetch", fixtureDiscord);
    const f = recoveryFixture();
    // A genuine expired write arms pending|; a bare landing visit no longer does.
    let jar = await genuineBounceJar(f, "/profile?edit=1");
    const start = await f.request("/auth/discord?next=%2Fprofile%3Fedit%3D1", {
      headers: { cookie: jar },
    });
    jar = mergeCookies(jar, start);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const callback = await f.request(`/auth/discord/callback?state=${state}&code=fixture`, {
      headers: { cookie: jar },
    });
    expect(callback.headers.get("location")).toBe("/profile?edit=1");
    jar = mergeCookies(jar, callback);
    expect(only(jar, EXPIRED_WRITE_COOKIE)).toContain("restored");
    const head = await f.request("/profile", { method: "HEAD", headers: { cookie: jar } });
    expect(head.headers.getSetCookie().some((c) => c.startsWith(EXPIRED_WRITE_COOKIE + "="))).toBe(
      false,
    );
    f.state.logDown = true;
    const refused = await f.request("/members/100000000000000002", { headers: { cookie: jar } });
    expect(refused.status).toBe(503);
    expect(
      refused.headers.getSetCookie().some((c) => c.startsWith(EXPIRED_WRITE_COOKIE + "=")),
    ).toBe(false);
    f.state.logDown = false;
    const page = await f.request("/profile?edit=1", { headers: { cookie: jar } });
    expect(await page.text()).toContain('role="status" tabindex="-1" data-testid="auth-error"');
    jar = mergeCookies(jar, page);
    expect(await (await f.request("/profile", { headers: { cookie: jar } })).text()).not.toContain(
      'data-testid="auth-error"',
    );
    expect(f.state.writes).toBe(0);
  });

  it("the restored banner never returns a signed-in member to the expired-session page", async () => {
    vi.stubGlobal("fetch", fixtureDiscord);
    const f = recoveryFixture();
    // A genuine expired write arms pending|; a bare landing visit no longer does.
    let jar = await genuineBounceJar(f, "/profile?edit=1");
    const start = await f.request("/auth/discord?next=%2Fprofile%3Fedit%3D1", {
      headers: { cookie: jar },
    });
    jar = mergeCookies(jar, start);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const callback = await f.request(`/auth/discord/callback?state=${state}&code=fixture`, {
      headers: { cookie: jar },
    });
    expect(callback.headers.get("location")).toBe("/profile?edit=1");
    jar = mergeCookies(jar, callback);
    expect(only(jar, EXPIRED_WRITE_COOKIE)).toContain("restored");
    const page = await f.request("/profile?edit=1", { headers: { cookie: jar } });
    const html = await page.text();
    expect(html).toContain('role="status" tabindex="-1" data-testid="auth-error"');
    expect(html).toContain(
      "You signed in again. Your earlier changes were not saved. Review and submit them again.",
    );
    const banner = html.match(/<div[^>]*data-testid="auth-error"[^>]*>.*?<\/div>/s)?.[0];
    expect(banner).toBeDefined();
    expect(banner).not.toContain("/auth/recover");
    // Follow every link in the banner: none may render the expired-session
    // page or plant a fresh expired-write or intended cookie.
    const hrefs = [...banner!.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
    jar = mergeCookies(jar, page);
    for (const href of hrefs) {
      expect(href).not.toContain("/auth/recover");
      const followed = await f.request(href, { headers: { cookie: jar } });
      expect(await followed.text()).not.toContain("Your session expired");
      const set = followed.headers.getSetCookie();
      expect(
        set.some((c) => c.startsWith(EXPIRED_WRITE_COOKIE + "=") && !/Max-Age=0/i.test(c)),
      ).toBe(false);
      expect(
        set.some((c) => c.startsWith("__Host-two_login_intended=") && !/Max-Age=0/i.test(c)),
      ).toBe(false);
    }
    // The one-shot banner still clears on first render.
    expect(await (await f.request("/profile", { headers: { cookie: jar } })).text()).not.toContain(
      'data-testid="auth-error"',
    );
    expect(f.state.writes).toBe(0);
  });

  it.each(["error=access_denied", "code=fixture&state=wrong"])(
    "stray failure %s leaves the pending notice for the real hit",
    async (query) => {
      const f = recoveryFixture();
      // A genuine expired write arms pending|; a bare landing visit no longer does.
      const jar = await genuineBounceJar(f, null);
      const stray = await f.request("/auth/discord/callback?" + query, {
        headers: { cookie: jar },
      });
      expect(stray.status).toBe(302);
      expect(stray.headers.get("location")).toBe("/?n=signin_failed");
      // The pending notice survives the stray: it is neither re-set nor
      // cleared, so the jar still carries it for the real hit.
      expect(
        stray.headers.getSetCookie().some((c) => c.startsWith(EXPIRED_WRITE_COOKIE + "=")),
      ).toBe(false);
      expect(mergeCookies(jar, stray)).toContain(EXPIRED_WRITE_COOKIE);
    },
  );

  it("an admitted denial clears the pending notice and cannot flash success later", async () => {
    const f = recoveryFixture();
    // A genuine expired write arms pending|; a bare landing visit no longer does.
    let jar = await genuineBounceJar(f, null);
    const start = await f.request("/auth/discord?next=%2Fprofile", {
      headers: { cookie: jar },
    });
    expect(start.status).toBe(302);
    jar = mergeCookies(jar, start);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const denied = await f.request(`/auth/discord/callback?error=access_denied&state=${state}`, {
      headers: { cookie: jar },
    });
    expect(denied.headers.get("location")).toBe("/?n=signin_denied");
    expect(
      denied.headers
        .getSetCookie()
        .some((c) => c.startsWith(EXPIRED_WRITE_COOKIE + "=") && c.includes("Max-Age=0")),
    ).toBe(true);
    expect(mergeCookies(jar, denied)).not.toContain(EXPIRED_WRITE_COOKIE);
  });

  it("logout clears the pending/restored recovery notice only after successful revocation", async () => {
    const f = recoveryFixture();
    const login = await f.login();
    const jar = login.cookie + "; " + (await signed(EXPIRED_WRITE_COOKIE, "restored|/profile"));
    vi.spyOn(f.sessions, "revoke").mockRejectedValueOnce(new Error("storage unavailable"));
    const failed = await f.request("/logout", {
      method: "POST",
      headers: { cookie: jar, origin: f.env.APP_URL },
    });
    expect(failed.status).toBe(503);
    expect(failed.headers.getSetCookie()).toEqual([]);
    expect(await f.sessions.get(login.tokenHash)).not.toBeNull();
    const success = await f.request("/logout", {
      method: "POST",
      headers: { cookie: jar, origin: f.env.APP_URL },
    });
    expect(success.status).toBe(303);
    const cleared = mergeCookies(jar, success);
    expect(cleared).not.toContain(EXPIRED_WRITE_COOKIE);
    expect(await (await f.request("/", { headers: { cookie: cleared } })).text()).not.toContain(
      'data-testid="auth-error"',
    );
  });

  it("fragments neither start a controller nor consume the restored banner", async () => {
    const app = new Hono<{ Variables: { authStatusEnabled: boolean } }>();
    app.use("*", authStatusScript);
    app.use("*", expiredWriteBanner);
    app.use("*", async (c, next) => {
      c.set("authStatusEnabled", true);
      await next();
    });
    app.get("/fragment", (c) => c.html("<main>Fragment only</main>"));
    app.get("/document", (c) => c.html("<html><body><main>Document</main></body></html>"));
    const cookie = await signed(EXPIRED_WRITE_COOKIE, "restored|/profile");
    const env = { SESSION_SECRET: SECRET };
    const fragment = await app.request("/fragment", { headers: { cookie } }, env);
    expect(await fragment.text()).toBe("<main>Fragment only</main>");
    expect(fragment.headers.getSetCookie()).toEqual([]);
    const document = await app.request("/document", { headers: { cookie } }, env);
    const html = await document.text();
    expect(html).toContain('data-testid="auth-error"');
    expect(html.match(/data-testid="auth-tab-sync"/g)).toHaveLength(1);
    expect(
      document.headers
        .getSetCookie()
        .some((c) => c.startsWith(EXPIRED_WRITE_COOKIE + "=") && c.includes("Max-Age=0")),
    ).toBe(true);
  });

  it("signed hostile and tampered notice values cannot inject markup or produce a success banner", async () => {
    const f = recoveryFixture();
    for (const cookie of [
      EXPIRED_WRITE_COOKIE + "=forged",
      await signed(EXPIRED_WRITE_COOKIE, 'restored|https://evil.example/\"<script>'),
    ]) {
      const response = await f.request("/", { headers: { cookie } });
      expect(await response.text()).not.toContain('data-testid="auth-error"');
    }
  });
});
