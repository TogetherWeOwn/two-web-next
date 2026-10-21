// Restoring either consume catch's unconditional false must fail that flow's
// matching-state outage cases. Keep the real mounted error/header boundaries;
// only persistence and outbound network are replaced by offline fixtures.
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken } from "../src/sessions";

const flows = ["join", "auth"] as const;
type Flow = (typeof flows)[number];
const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "fixture-client",
  DISCORD_CLIENT_SECRET: "fixture-client-secret-canary",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_BOT_TOKEN: "fixture-bot-secret-canary",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  SESSION_SECRET: "fixture signing key ".repeat(3),
  DISCORD_MODERATOR_ROLE_IDS: "",
};
const stateCookie = (flow: Flow) =>
  flow === "join" ? "__Host-two_join_state" : "__Host-two_oauth_state";
const callbackPath = (flow: Flow) =>
  flow === "join" ? "/join/callback" : "/auth/discord/callback";
const cookieNames = (flow: Flow) =>
  flow === "join"
    ? [stateCookie(flow), "__Host-two_join_source", "__Host-two_join_next"]
    : [stateCookie(flow), "__Host-two_login_next", "__Host-two_login_intended"];

async function fixture(flow: Flow) {
  const store = createMemorySessionStore();
  const create = vi.spyOn(store, "create");
  const replace = vi.spyOn(store, "replace");
  const bindings = { ...env, SESSION_STORE: store, JOIN_DEPS: { store: async () => null } };
  const start = await app.request(
    flow === "join" ? "/join/discord?next=/profile&source=fixture" : "/auth/discord?next=/profile",
    {},
    bindings,
  );
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const cookie = start.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  const fetch = vi.fn(() => {
    throw new Error("Unexpected outbound call in callback outage fixture");
  });
  vi.stubGlobal("fetch", fetch);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const consume = vi.spyOn(store.journeys, "consume");
  return {
    store,
    create,
    replace,
    fetch,
    consume,
    warn,
    error,
    info,
    log,
    state,
    cookie,
    request: (suffix = "", presentedState = state) =>
      app.request(
        `${callbackPath(flow)}?code=fixture-oauth-code-canary&state=${presentedState}${suffix}`,
        { headers: { cookie, accept: "text/html" } },
        bindings,
      ),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function assertNoAdmission(f: Fixture, res: Response) {
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
  expect(f.replace).not.toHaveBeenCalled();
  expect(res.headers.getSetCookie().some((line) => line.startsWith("__Host-two_session="))).toBe(
    false,
  );
}

function assertCookies(flow: Flow, res: Response) {
  // Every path covered here is unadmitted (outage, lost, replayed, or
  // unclassified consume failure), and only an admitted callback owns the
  // jar: the journey cookies stay in place so a retry or a newer tab's
  // journey survives (`src/join/route-callback.ts` clears only after
  // one-use admission; the auth callback likewise keeps return intent).
  const cookies = res.headers.getSetCookie();
  for (const name of cookieNames(flow))
    expect(cookies.some((c) => c.startsWith(`${name}=`))).toBe(false);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(flows)("%s callback journey failure classification", (flow) => {
  it.each(["", "&error=access_denied"])(
    "classified consume outage%s renders branded 503, never a stray",
    async (suffix) => {
      const f = await fixture(flow);
      const raw = "fixture-driver-message-canary";
      const coded = Object.assign(new Error(raw), { code: "ECONNREFUSED" });
      f.consume.mockRejectedValue(new Error("fixture-wrapped-message-canary", { cause: coded }));
      const res = await f.request(suffix);
      const body = await res.text();
      expect(res.status).toBe(503);
      expect(res.headers.get("location")).toBeNull();
      expect(body).toContain("We will be right back");
      expect(body).not.toContain("Join link expired");
      expect(body).not.toContain("signin_failed");
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.get("cache-control")).toContain("private");
      expect(res.headers.get("vary")).toContain("Accept");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-request-id")).toBeTruthy();
      expect(f.consume).toHaveBeenCalledExactlyOnceWith(await hashToken(f.state), flow);
      assertNoAdmission(f, res);
      assertCookies(flow, res);
      const logs = JSON.stringify(
        [f.warn.mock.calls, f.error.mock.calls, f.info.mock.calls, f.log.mock.calls],
        (_key, value) =>
          value instanceof Error
            ? {
                ...value,
                name: value.name,
                message: value.message,
                stack: value.stack,
                cause: value.cause,
              }
            : value,
      );
      expect(logs).not.toContain("InvalidState");
      for (const value of [
        raw,
        "fixture-wrapped-message-canary",
        f.state,
        f.cookie,
        "fixture-oauth-code-canary",
        env.SESSION_SECRET,
        env.DISCORD_CLIENT_SECRET,
        env.DISCORD_BOT_TOKEN,
      ]) {
        expect(body).not.toContain(value);
        expect(logs).not.toContain(value);
      }
    },
  );

  it.each(["lost", "replayed"])(
    "genuine %s journey retains the existing stray response",
    async (kind) => {
      const f = await fixture(flow);
      if (kind === "replayed") {
        expect(await f.store.journeys.consume(await hashToken(f.state), flow)).toBe(true);
        f.consume.mockClear();
      }
      const res = await f.request("", kind === "lost" ? "fixture-mismatched-state" : f.state);
      if (flow === "join") {
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("Join link expired");
        expect(f.warn).toHaveBeenCalledWith(
          "discord token exchange failed on the join journey",
          expect.objectContaining({ exception: "InvalidState", outcome: "expired" }),
        );
      } else {
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/?n=signin_failed");
      }
      expect(f.consume).toHaveBeenCalledTimes(kind === "lost" ? 0 : 1);
      assertNoAdmission(f, res);
      assertCookies(flow, res);
    },
  );

  it("unclassified consume failure retains the fallback instead of becoming an outage", async () => {
    const f = await fixture(flow);
    f.consume.mockRejectedValue(new Error("unclassified fixture failure"));
    const res = await f.request();
    expect(res.status).toBe(flow === "join" ? 200 : 302);
    if (flow === "join") expect(await res.text()).toContain("Join link expired");
    else expect(res.headers.get("location")).toBe("/?n=signin_failed");
    assertNoAdmission(f, res);
    assertCookies(flow, res);
  });
});

it("auth replayed denial retains signin_denied without upstream or session work", async () => {
  const f = await fixture("auth");
  expect(await f.store.journeys.consume(await hashToken(f.state), "auth")).toBe(true);
  f.consume.mockClear();
  const res = await f.request("&error=access_denied");
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/?n=signin_denied");
  assertNoAdmission(f, res);
  assertCookies("auth", res);
});
