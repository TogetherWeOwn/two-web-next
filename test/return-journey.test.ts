// Direct unit pins for the login/join/event-CTA return journey.
//
// src/return-journey.ts carries the OAuth round-trip state on short-lived
// signed cookies: an explicit ?next= (login_next), the gate-recorded intended
// page (url.intended), and the one-shot join_result flash. The full-stack
// journeys ride through test/login-return.test.ts and the safeNext guard
// itself is pinned in test/join.test.ts and
// test/safe-next-control-bytes.test.ts; this file pins the module directly
// with local fixtures only — no database, no Discord, no staging.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { safeNext } from "../src/join/service";
import {
  bounceToLogin,
  consumeLoginReturn,
  JOIN_RESULT_COOKIE,
  LOGIN_INTENDED_COOKIE,
  LOGIN_NEXT_COOKIE,
  readJoinResult,
  recordJoinResult,
  rememberLoginNext,
  takeJoinResult,
} from "../src/return-journey";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  DISCORD_BOT_TOKEN: "fixture",
  SESSION_SECRET,
};

// Minimal cookie jar: later Set-Cookie wins, Max-Age=0 deletes — mirrors what
// a real browser sends back.
type Jar = Record<string, string>;
const jarFrom = (res: Response, into: Jar = {}): Jar => {
  for (const c of res.headers.getSetCookie()) {
    const [pair, ...attrs] = c.split(";");
    const eq = pair!.indexOf("=");
    const name = pair!.slice(0, eq);
    const value = pair!.slice(eq + 1);
    if (value === "" || attrs.some((a) => /max-age=0/i.test(a.trim()))) delete into[name];
    else into[name] = value;
  }
  return into;
};
const sendJar = (j: Jar) =>
  Object.entries(j)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
const setCookies = (res: Response) => res.headers.getSetCookie().join("\n");
const withJar = (j: Jar): { headers: Record<string, string> } =>
  sendJar(j) ? { headers: { cookie: sendJar(j) } } : { headers: {} };

function journey() {
  const fixture = new Hono<{ Bindings: Env }>();
  fixture.get("/remember", async (c) => {
    await rememberLoginNext(c, c.req.query("next"));
    return c.text("ok");
  });
  fixture.get("/consume", async (c) => {
    const dest = await consumeLoginReturn(c);
    return c.text(dest ?? "default");
  });
  fixture.get("/bounce", (c) => bounceToLogin(c));
  fixture.post("/bounce", (c) => bounceToLogin(c));
  fixture.get("/record/:result", async (c) => {
    const result = c.req.param("result");
    if (result !== "added" && result !== "already_member") return c.text("bad result", 400);
    await recordJoinResult(c, result);
    return c.text("ok");
  });
  fixture.get("/read", async (c) => c.text((await readJoinResult(c)) ?? "none"));
  fixture.get("/take", async (c) => c.text((await takeJoinResult(c)) ?? "none"));
  fixture.post("/take", async (c) => c.text((await takeJoinResult(c)) ?? "none"));
  return fixture;
}

const app = journey();

const remember = async (query: string, jar: Jar = {}) => {
  const res = await app.request(`/remember${query}`, withJar(jar), env);
  return { res, jar: jarFrom(res) };
};
const consume = (jar: Jar) => app.request("/consume", withJar(jar), env);

describe("guarded next allowlist (login/join/event-CTA returns)", () => {
  it.each([
    "/events",
    "/events?view=calendar&month=2099-11",
    "/events/past?page=3",
    "/e/sunday-squad-01",
    "/join",
    "/profile",
  ])("a CTA destination %s survives the guard unchanged", (next) => {
    expect(safeNext(next)).toBe(next);
  });

  it.each([
    ["absolute URL", "https://evil.test/"],
    ["protocol-relative", "//evil.test/x"],
    ["backslash", "/\\evil.test"],
    ["scheme", "javascript:alert(1)"],
    ["bare relative", "events"],
    ["whitespace only", "   "],
    ["empty", ""],
  ])("a hostile %s next leaves no trace", (_label, next) => {
    expect(safeNext(next)).toBeNull();
  });

  it.each([null, undefined, 42, ["/events"], { next: "/events" }])(
    "non-string input %j leaves no trace",
    (next) => {
      expect(safeNext(next)).toBeNull();
    },
  );
});

describe("safeNext control-byte rejection (Location-header safety)", () => {
  // A surviving value lands in the callback's Location header, where
  // Headers.set throws on control bytes and turns a login into a 500.
  it.each(["%00", "%01", "%1F", "%7F"])("percent-encoded control %s is rejected", (encoded) => {
    expect(safeNext(`/events${decodeURIComponent(encoded)}`)).toBeNull();
  });

  it.each([
    ["vertical tab", String.fromCharCode(11)],
    ["form feed", String.fromCharCode(12)],
  ])("a %s inside the path is rejected", (_label, ch) => {
    expect(safeNext(`/events${ch}x`)).toBeNull();
  });

  it("a control byte in the query is rejected too", () => {
    expect(safeNext(`/events?q=a${String.fromCharCode(0)}b`)).toBeNull();
  });
});

describe("rememberLoginNext (explicit ?next= rides OAuth)", () => {
  it("a safe event return rides and consumes exactly once", async () => {
    const start = await remember("?next=%2Fe%2Fsunday-squad-01");
    expect(start.jar[LOGIN_NEXT_COOKIE]).toBeTruthy();
    const cb = await consume(start.jar);
    expect(await cb.text()).toBe("/e/sunday-squad-01");
    const cleared = setCookies(cb);
    expect(cleared).toContain(`${LOGIN_NEXT_COOKIE}=; Max-Age=0`);
    expect(cleared).toContain(`${LOGIN_INTENDED_COOKIE}=; Max-Age=0`);
  });

  it.each([
    ["absolute URL", "?next=https%3A%2F%2Fevil.test"],
    ["protocol-relative", "?next=%2F%2Fevil.test%2Fx"],
    ["backslash", "?next=%5C%5Cevil.test"],
    ["scheme", "?next=javascript%3Aalert(1)"],
    ["NUL control", "?next=%2Fevents%00"],
    ["DEL control", "?next=%2Fevents%7F"],
    ["empty", "?next="],
    ["missing", ""],
  ])("a hostile %s next leaves no live cookie", async (_label, query) => {
    const start = await remember(query);
    expect(start.jar[LOGIN_NEXT_COOKIE]).toBeUndefined();
    const cb = await consume(start.jar);
    expect(await cb.text()).toBe("default");
  });

  it("a restarted login without next forgets the abandoned explicit next", async () => {
    const first = await remember("?next=%2Fevents");
    expect(first.jar[LOGIN_NEXT_COOKIE]).toBeTruthy();
    const fresh = await remember("", first.jar);
    const browser = jarFrom(fresh.res, first.jar);
    expect(browser[LOGIN_NEXT_COOKIE]).toBeUndefined();
    expect(setCookies(fresh.res)).toContain(`${LOGIN_NEXT_COOKIE}=; Max-Age=0`);
  });
});

describe("consumeLoginReturn (explicit next, then intended, then default)", () => {
  it("an explicit next beats the recorded intended page, which is still cleared", async () => {
    const bounce = await app.request("/bounce?from=card", {}, env);
    const jar = jarFrom(bounce);
    expect(jar[LOGIN_INTENDED_COOKIE]).toBeTruthy();
    const start = await remember("?next=%2Fe%2Ftwo", jar);
    const cb = await consume({ ...jar, ...start.jar });
    expect(await cb.text()).toBe("/e/two");
    expect(setCookies(cb)).toContain(`${LOGIN_INTENDED_COOKIE}=; Max-Age=0`);
  });

  it("falls back to the recorded intended page when no explicit next exists", async () => {
    const gated = await app.request("/bounce?from=card", {}, env);
    const cb = await consume(jarFrom(gated));
    expect(await cb.text()).toBe("/bounce?from=card");
  });

  it("answers the default landing when neither cookie exists", async () => {
    const cb = await consume({});
    expect(await cb.text()).toBe("default");
  });

  it("rejects a signed-but-hostile explicit next and falls back to intended", async () => {
    const bounce = await app.request("/bounce?from=card", {}, env);
    const jar = jarFrom(bounce);
    const forged = (
      await serializeSigned(LOGIN_NEXT_COOKIE, "https://evil.test/", SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
    const cb = await consume({
      ...jar,
      [LOGIN_NEXT_COOKIE]: forged.slice(LOGIN_NEXT_COOKIE.length + 1),
    });
    expect(await cb.text()).toBe("/bounce?from=card");
  });

  it("ignores an unsigned explicit cookie entirely", async () => {
    const cb = await consume({ [LOGIN_NEXT_COOKIE]: "%2Fprofile" });
    expect(await cb.text()).toBe("default");
  });
});

describe("bounceToLogin (auth-gate records the intended page)", () => {
  it("a guest GET records pathname plus search and enters OAuth", async () => {
    const bounce = await app.request("/bounce?from=card", {}, env);
    expect(bounce.status).toBe(302);
    expect(bounce.headers.get("location")).toBe("/auth/discord");
    expect(jarFrom(bounce)[LOGIN_INTENDED_COOKIE]).toBeTruthy();
  });

  it("a HEAD bounce records the page the same way", async () => {
    const bounce = await app.request("/bounce?from=card", { method: "HEAD" }, env);
    expect(bounce.status).toBe(302);
    expect(bounce.headers.get("location")).toBe("/auth/discord");
    expect(jarFrom(bounce)[LOGIN_INTENDED_COOKIE]).toBeTruthy();
  });

  it("a POST bounce records nothing and goes to write recovery", async () => {
    const bounce = await app.request("/bounce", { method: "POST" }, env);
    expect(bounce.status).toBe(303);
    expect(bounce.headers.get("location")).toBe("/auth/recover?next=%2Fevents");
    expect(setCookies(bounce)).not.toContain(LOGIN_INTENDED_COOKIE);
  });
});

describe("join_result flash (join/event-CTA landing confirmation)", () => {
  const record = async (result: string, jar: Jar = {}) => {
    const res = await app.request(`/record/${result}`, withJar(jar), env);
    return { res, jar: jarFrom(res, jar) };
  };

  it.each(["added", "already_member"])(
    "records %s and consumes it exactly once",
    async (result) => {
      const { jar } = await record(result);
      expect(jar[JOIN_RESULT_COOKIE]).toBeTruthy();
      const first = await app.request("/take", withJar(jar), env);
      expect(await first.text()).toBe(result);
      expect(setCookies(first)).toContain(`${JOIN_RESULT_COOKIE}=; Max-Age=0`);
      const second = await app.request("/take", withJar(jarFrom(first, jar)), env);
      expect(await second.text()).toBe("none");
    },
  );

  it("a HEAD read leaves the flash pending for the visible GET", async () => {
    const { jar } = await record("already_member");
    const pending = jar[JOIN_RESULT_COOKIE];
    const head = await app.request("/read", { method: "HEAD", ...withJar(jar) }, env);
    expect(head.status).toBe(200);
    expect(setCookies(head)).not.toContain(`${JOIN_RESULT_COOKIE}=; Max-Age=0`);
    expect(jarFrom(head, jar)[JOIN_RESULT_COOKIE]).toBe(pending);
    const first = await app.request("/read", withJar(jar), env);
    expect(await first.text()).toBe("already_member");
  });

  it("a non-GET take reads nothing and leaves the flash pending", async () => {
    const { jar } = await record("added");
    const pending = jar[JOIN_RESULT_COOKIE];
    const post = await app.request("/take", { method: "POST", ...withJar(jar) }, env);
    expect(await post.text()).toBe("none");
    expect(setCookies(post)).not.toContain(`${JOIN_RESULT_COOKIE}=; Max-Age=0`);
    expect(jarFrom(post, jar)[JOIN_RESULT_COOKIE]).toBe(pending);
  });

  it("a forged unsigned value reads as nothing", async () => {
    const res = await app.request(
      "/read",
      { headers: { cookie: `${JOIN_RESULT_COOKIE}=already_member` } },
      env,
    );
    expect(await res.text()).toBe("none");
  });

  it("a signed-but-unknown value reads as nothing", async () => {
    const signed = (
      await serializeSigned(JOIN_RESULT_COOKIE, "denied", SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
    const res = await app.request("/read", { headers: { cookie: signed } }, env);
    expect(await res.text()).toBe("none");
  });
});
