// route-inventory: GET /auth/status
// route-inventory: GET /auth/recover
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeSigned } from "hono/utils/cookie";
import { AUTH_STATUS_COOKIE } from "../src/auth-status";
import { EXPIRED_WRITE_COOKIE } from "../src/write-recovery";
import { fixtureDiscord, MEMBER, mergeCookies, recoveryFixture, SECRET } from "./fixtures/session-recovery";

afterEach(() => vi.unstubAllGlobals());
const only = (cookies: string, name: string) => cookies.split("; ").find(c => c.startsWith(name + "="))!;
const signed = async (name: string, value: string) => (await serializeSigned(name, value, SECRET, { path: "/", secure: true })).split(";")[0]!;

describe("read-only bool-only auth status", () => {
  it("guests and members disclose no identity, rotate nothing and forbid caches", async () => {
    const f = recoveryFixture();
    const login = await f.login();
    for (const [cookie, authenticated] of [["", false], [login.cookie, true]] as const) {
      const response = await f.request("/auth/status", { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ authenticated });
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      expect(response.headers.get("vary")).toBe("Cookie");
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(await f.sessions.get(login.tokenHash)).not.toBeNull();
  });

  it("a stable probe stays live before the rotating page's Set-Cookie is delivered; old login is dead", async () => {
    const f = recoveryFixture();
    const login = await f.login();
    const profile = await f.request("/profile", { headers: { cookie: login.cookie } });
    const oldJar = mergeCookies(login.cookie, profile);
    const rotating = await f.request("/", { headers: { cookie: oldJar } });
    // Deliberately do not deliver rotating.headers to this cookie jar yet.
    expect(await f.sessions.get(login.tokenHash)).toBeNull();
    const probe = await f.request("/auth/status", { headers: { cookie: oldJar } });
    expect(await probe.json()).toEqual({ authenticated: true });
    expect(probe.headers.getSetCookie()).toEqual([]);
    const replay = await f.request("/profile", { headers: { cookie: oldJar } });
    expect(replay.status).toBe(302);
    const probeOnly = await f.request("/profile", { headers: { cookie: only(oldJar, AUTH_STATUS_COOKIE) } });
    expect(probeOnly.status).toBe(302);
    const newJar = mergeCookies(oldJar, rotating);
    expect((await f.request("/profile", { headers: { cookie: newJar } })).status).toBe(200);
    const logout = await f.request("/logout", { method: "POST", headers: { cookie: newJar, origin: f.env.APP_URL } });
    expect(logout.status).toBe(303);
    expect(logout.headers.getSetCookie().some(c => c.startsWith(AUTH_STATUS_COOKIE + "=") && c.includes("Max-Age=0"))).toBe(true);
    expect(await (await f.request("/auth/status", { headers: { cookie: oldJar } })).json()).toEqual({ authenticated: false });
  });

  it("expiry/revocation return false; a store outage is 503 rather than an authoritative logout", async () => {
    const f = recoveryFixture();
    const dead = await f.login(new Date(0));
    expect(await (await f.request("/auth/status", { headers: { cookie: dead.cookie } })).json()).toEqual({ authenticated: false });
    const live = await f.login();
    const jar = mergeCookies(live.cookie, await f.request("/profile", { headers: { cookie: live.cookie } }));
    vi.spyOn(f.sessions, "isActive").mockRejectedValueOnce(new Error("storage unavailable"));
    const outage = await f.request("/auth/status", { headers: { cookie: jar } });
    expect(outage.status).toBe(503);
    expect(await outage.json()).toEqual({ authenticated: false });
    await f.sessions.revoke(live.tokenHash);
    expect(await (await f.request("/auth/status", { headers: { cookie: jar } })).json()).toEqual({ authenticated: false });
    expect(await (await f.request("/auth/status", { headers: { cookie: AUTH_STATUS_COOKIE + "=forged" } })).json()).toEqual({ authenticated: false });
  });

  it("only allowed authenticated full GET documents emit exactly one controller and preserve headers", async () => {
    const f = recoveryFixture();
    expect(await (await f.request("/")).text()).not.toContain("auth-tab-sync");
    const login = await f.login();
    const response = await f.request("/profile", { headers: { cookie: login.cookie } });
    expect((await response.text()).match(/data-testid="auth-tab-sync"/g)).toHaveLength(1);
    expect(response.headers.getSetCookie().some(c => c.startsWith(AUTH_STATUS_COOKIE + "="))).toBe(true);
    const head = await f.request("/profile", { method: "HEAD", headers: { cookie: login.cookie } });
    expect(await head.text()).not.toContain("auth-tab-sync");
    const home = await f.request("/", { headers: { cookie: login.cookie } });
    expect(home.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(home.headers.getSetCookie().filter(c => c.startsWith("__Host-two_session="))).toHaveLength(1);
  });
});

describe("explicit expired-write recovery, never replay", () => {
  it("an expired JSON PATCH remains 401 and native POST reaches durable recovery without any write", async () => {
    const f = recoveryFixture();
    const dead = await f.login(new Date(0));
    const patch = await f.request(`/members/${MEMBER}`, { method: "PATCH", headers: { cookie: dead.cookie, origin: f.env.APP_URL, referer: f.env.APP_URL + "/profile?edit=1", "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ bio: "Unsaved secret draft", games_text: "Go", timezone: "UTC" }) });
    expect(patch.status).toBe(401);
    expect(await patch.json()).toEqual({ error: "Unauthorized", recovery: "/auth/recover?next=%2Fprofile%3Fedit%3D1" });
    expect(patch.headers.getSetCookie()).toEqual([]);
    const native = await f.request(`/members/${MEMBER}`, { method: "POST", headers: { cookie: dead.cookie, origin: f.env.APP_URL, referer: "https://hostile.example/profile", "content-type": "application/x-www-form-urlencoded" }, body: "_method=PATCH&bio=Unsaved+secret+draft" });
    expect(native.status).toBe(303);
    expect(native.headers.get("location")).toBe("/auth/recover?next=%2Fprofile");
    const landing = await f.request(native.headers.get("location")!);
    expect(await landing.text()).toContain("Your earlier changes were not saved");
    const jar = mergeCookies("", landing);
    expect(jar).not.toContain("Unsaved");
    expect(f.state.writes).toBe(0);
    expect(f.profiles.rows.get(MEMBER)?.bio).toBe("Accepted bio");
  });

  it.each(["https://evil.example/", "//evil.example/", "/\\evil", "javascript:alert(1)", "", " /profile"])("revalidates hostile/blank next %s", async next => {
    const f = recoveryFixture();
    const response = await f.request("/auth/recover?next=" + encodeURIComponent(next));
    expect(await response.text()).toContain('href="/auth/discord?next=%2Fprofile"');
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });

  it("OAuth returns to the safe original page, banner is consumed once, HEAD and audit failures leave it pending", async () => {
    vi.stubGlobal("fetch", fixtureDiscord);
    const f = recoveryFixture();
    let jar = mergeCookies("", await f.request("/auth/recover?next=%2Fprofile%3Fedit%3D1"));
    const start = await f.request("/auth/discord?next=%2Fprofile%3Fedit%3D1", { headers: { cookie: jar } });
    jar = mergeCookies(jar, start);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const callback = await f.request(`/auth/discord/callback?state=${state}&code=fixture`, { headers: { cookie: jar } });
    expect(callback.headers.get("location")).toBe("/profile?edit=1");
    jar = mergeCookies(jar, callback);
    expect(only(jar, EXPIRED_WRITE_COOKIE)).toContain("restored");
    const head = await f.request("/profile", { method: "HEAD", headers: { cookie: jar } });
    expect(head.headers.getSetCookie().some(c => c.startsWith(EXPIRED_WRITE_COOKIE + "="))).toBe(false);
    f.state.logDown = true;
    const refused = await f.request("/members/100000000000000002", { headers: { cookie: jar } });
    expect(refused.status).toBe(503);
    expect(refused.headers.getSetCookie().some(c => c.startsWith(EXPIRED_WRITE_COOKIE + "="))).toBe(false);
    f.state.logDown = false;
    const page = await f.request("/profile?edit=1", { headers: { cookie: jar } });
    expect(await page.text()).toContain('role="status" tabindex="-1" data-testid="auth-error"');
    jar = mergeCookies(jar, page);
    expect(await (await f.request("/profile", { headers: { cookie: jar } })).text()).not.toContain('data-testid="auth-error"');
    expect(f.state.writes).toBe(0);
  });

  it.each(["error=access_denied", "code=fixture&state=wrong"])("terminal failure %s clears pending notice and cannot flash success later", async query => {
    const f = recoveryFixture();
    const jar = mergeCookies("", await f.request("/auth/recover?next=%2Fprofile"));
    const failed = await f.request("/auth/discord/callback?" + query, { headers: { cookie: jar } });
    expect(failed.headers.getSetCookie().some(c => c.startsWith(EXPIRED_WRITE_COOKIE + "=") && c.includes("Max-Age=0"))).toBe(true);
    expect(mergeCookies(jar, failed)).not.toContain(EXPIRED_WRITE_COOKIE);
  });

  it("signed hostile and tampered notice values cannot inject markup or produce a success banner", async () => {
    const f = recoveryFixture();
    for (const cookie of [EXPIRED_WRITE_COOKIE + "=forged", await signed(EXPIRED_WRITE_COOKIE, 'restored|https://evil.example/\"<script>')]) {
      const response = await f.request("/", { headers: { cookie } });
      expect(await response.text()).not.toContain('data-testid="auth-error"');
    }
  });
});
