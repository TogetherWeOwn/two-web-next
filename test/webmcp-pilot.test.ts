// B1 WebMCP pilot flag. The pilot script tag is injected by middleware only
// when WEBMCP_PILOT_ENABLED is exactly "true"/"1" and only on the four pilot
// pages (/ events list, /e/:key detail, /join, /). The middleware reads no
// session, no cookie and no database, so it adds no session-dependent markup
// of its own: a signed-in moderator gets the same island (hence the same
// four tools, no extras) as an anonymous viewer. Pages that already
// personalize on the session (homepage, event detail) keep their pre-existing
// per-viewer differences; only /join is pinned byte-identical end to end.
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { isWebmcpPilotPath, webmcpPilotEnabled, WEBMCP_PILOT_SCRIPT } from "../src/webmcp-pilot";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

const baseEnv: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

const onEnv: Env = { ...baseEnv, WEBMCP_PILOT_ENABLED: "true" };

// Real signed moderator session through the app's SESSION_STORE test seam
// (src/index.tsx storeFor), not a junk cookie: this proves the pilot markup
// is identical for a session the app genuinely recognizes as moderator.
async function moderatorEnvs() {
  const store: SessionStore = createMemorySessionStore();
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: "100000000000000171",
    username: "pilot-mod",
    avatar: null,
    member: true,
    moderator: true,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const signed = (
    await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
  const cookie = `__Host-two_session=${signed}`;
  return {
    anonOff: baseEnv,
    modOff: { ...baseEnv, SESSION_STORE: store, cookie },
    anonOn: onEnv,
    modOn: { ...onEnv, SESSION_STORE: store, cookie },
  };
}

type TestEnv = Env & { SESSION_STORE?: SessionStore; cookie?: string };

async function get(path: string, env: TestEnv) {
  const { cookie, ...bindings } = env;
  return app.request(path, cookie ? { headers: { cookie } } : {}, bindings as Env);
}

describe("webmcp pilot flag", () => {
  it.each(["true", "1"])("flag %s enables the pilot", (flag) => {
    expect(webmcpPilotEnabled({ WEBMCP_PILOT_ENABLED: flag })).toBe(true);
  });

  it.each([undefined, "", "false", "0", "yes", "TRUE"])("flag %s stays off", (flag) => {
    expect(webmcpPilotEnabled({ WEBMCP_PILOT_ENABLED: flag })).toBe(false);
  });

  it.each(["/", "/events", "/events/past", "/e/01ARZ3NDEKTSV4RRFFQ69G5FAV", "/join"])(
    "pilot page %s carries the island",
    (path) => {
      expect(isWebmcpPilotPath(path)).toBe(true);
    },
  );

  it.each([
    "/about",
    "/faq",
    "/rules",
    "/privacy",
    "/login",
    "/auth/discord",
    "/admin",
    "/api/public/events",
    "/api/public/join",
    "/openapi.json",
    "/events.json",
  ])("non-pilot path %s carries no island", (path) => {
    expect(isWebmcpPilotPath(path)).toBe(false);
  });

  it("script tag is the deferred island with no inline code", () => {
    expect(WEBMCP_PILOT_SCRIPT).toBe('<script src="/islands/model-context.js" defer></script>');
  });

  it("flag off leaves the join page byte-identical for a signed-in moderator", async () => {
    const { anonOff, modOff } = await moderatorEnvs();
    const anon = await get("/join", anonOff);
    expect(anon.status).toBe(200);
    const anonHtml = await anon.text();
    expect(anonHtml).not.toContain("/islands/model-context.js");
    const mod = await get("/join", modOff);
    expect(mod.status).toBe(200);
    expect(await mod.text()).toBe(anonHtml);
  });

  it("flag on injects the island before </body>, identically for a signed-in moderator", async () => {
    const { anonOn, modOn } = await moderatorEnvs();
    const anon = await get("/join", anonOn);
    expect(anon.status).toBe(200);
    const anonHtml = await anon.text();
    expect(anonHtml).toContain(`${WEBMCP_PILOT_SCRIPT}</body>`);
    const mod = await get("/join", modOn);
    expect(mod.status).toBe(200);
    expect(await mod.text()).toBe(anonHtml);
  });

  it("flag on leaves non-pilot pages untouched", async () => {
    const res = await app.request("/about", {}, onEnv);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("/islands/model-context.js");
  });

  // One injection assertion per pilot page (needs agent-testdb: the homepage,
  // the events list and the event detail page read published rows).
  describe.skipIf(!process.env.DATABASE_URL)("pilot page injection", () => {
    const EVENT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    let fixture: MemberDataFixture;
    let db: MemberDataFixture["db"];

    const source = {
      upcoming: async () => [],
      lastReadFailed: () => false,
    };
    const envFor = (flag: boolean): Env =>
      ({
        ...baseEnv,
        ...(flag ? { WEBMCP_PILOT_ENABLED: "true" } : {}),
        ADMIN_DB: db as unknown as Db,
        DISCORD_EVENTS: source,
      }) as unknown as Env;

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      db = fixture.db;
    });

    beforeEach(async () => {
      await fixture.reset();
      await db.insert(events).values({
        eventKey: EVENT_KEY,
        title: "Pilot night",
        status: "published",
        startsAt: new Date(Date.UTC(2099, 4, 4, 20)),
        endsAt: new Date(Date.UTC(2099, 4, 4, 22)),
      });
    });

    afterAll(async () => {
      await fixture?.dispose();
    });

    it.each(["/", "/events", `/e/${EVENT_KEY}`])(
      "flag on injects the island on %s, flag off leaves it untouched",
      async (path) => {
        __resetAnonEventCacheForTests();
        const off = await app.request(path, {}, envFor(false));
        expect(off.status).toBe(200);
        expect(await off.text()).not.toContain("/islands/model-context.js");
        __resetAnonEventCacheForTests();
        const on = await app.request(path, {}, envFor(true));
        expect(on.status).toBe(200);
        expect(await on.text()).toContain(`${WEBMCP_PILOT_SCRIPT}</body>`);
      },
    );
  });
});
