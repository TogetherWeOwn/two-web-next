// Acceptance (parity spec slice 0b, operator override panel, view-only):
// control-token holders see the /ops record + epoch on the dashboard;
// everyone else is refused; no dashboard PUT path ships; the panel copy
// states a staleness bound. Failing-first: the 200 + record + epoch +
// staleness assertions fail until the build lands (today the route falls
// through to the session guard: 302/303 bounces for guests, 404 for
// moderators, 403 for non-moderators).
// Refusal-shape and no-PUT assertions are guards: green now, must stay
// green after the build. Owned by the Test Author: do not
// edit this file on the build card — return incorrect tests instead.
//
// Contract the build implements:
// - GET /admin/ops-overrides, session-free, registered before adminGuard
//   (the source-evidence pattern in src/admin/routes.tsx: bearer admission
//   in the handler, write verbs refused on the same path).
// - Authorization: Bearer <OPS_CONTROL_TOKEN>, constant-time compare,
//   configured token below 32 chars fails closed (bot mirror:
//   two-bot-next wrangler/src/ops-control.ts gateOpsRequest: dark 404
//   when unconfigured, 405 before auth, 401 on bad bearer).
// - Bad/missing/malformed bearer with a configured token -> 401 or 403
//   with no record bytes in the body. A moderator session without the
//   bearer is refused too: the token, not the Discord role, admits.
// - Unset/short OPS_CONTROL_TOKEN -> 404 dark (both precedents agree).
// - The 200 is text/html carrying the upstream epoch digits, one override
//   key + value, a staleness sentence with a concrete bound (e.g.
//   "refreshes every 30 seconds; the record may be up to 30 seconds
//   stale"), and a no-store cache-control.
// - PUT/POST/PATCH/DELETE on the path -> 404 or 405 before any upstream
//   contact. GET with a query string is not a 200 (exact-path gate).
// - Upstream failure degrades honestly: 502/503, or a 200 explicitly
//   marked stale/unavailable — never a silent current-looking record.
//
// The upstream stub answers any bot-origin fetch with the bot's real
// GET /ops/config shape ({ epoch, overrides, baseline, enforcement }).
// Run: npx vitest run test/dashboard-operator-override-panel-acceptance.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeSigned } from "hono/utils/cookie";
import { adminApp } from "../src/admin/routes";
import type { Env } from "../src/env";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const BOT_ORIGIN = "https://bot.example.test";
// 36 chars: satisfies the 32-char floor the build enforces.
const CONTROL_TOKEN = "test-ops-control-token-32-chars-min!";
const WRONG_TOKEN = "wrong-ops-control-token-32-chars-ok!!";

// Distinctive upstream record: the bot's GET /ops/config shape
// (two-bot-next wrangler/src/ops-control.ts readConfig).
const CANNED_EPOCH = 98741;
const CANNED_KEY = "TWO_AUTOMOD_MENTION_LIMIT";
const CANNED_VALUE = "ovr-acc-7";
const cannedRecord = () => ({
  epoch: CANNED_EPOCH,
  overrides: { [CANNED_KEY]: CANNED_VALUE },
  baseline: {},
  enforcement: "pending",
});

const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
  BOT_ENDPOINT_URL: BOT_ORIGIN,
};

/** Env with the control token configured (cast: the build adds the field). */
function envWithToken(token: string): Env {
  return { ...baseEnv, OPS_CONTROL_TOKEN: token } as Env;
}

async function cookieFor(
  store: SessionStore,
  row: { userId: string; username: string; moderator: boolean },
): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.username,
    avatar: null,
    member: true,
    moderator: row.moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const serialized = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return serialized.split(";")[0]!;
}

const MOD = { userId: "100000000000000111", username: "mod", moderator: true };
const MEMBER = { userId: "100000000000000222", username: "pleb", moderator: false };

/** Upstream stub: the bot answers its record shape; anything else is a bug. */
function stubBot(status = 200) {
  const seen: string[] = [];
  const stub = async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    if (!url.startsWith(BOT_ORIGIN)) throw new Error(`unexpected fetch: ${url}`);
    if (status !== 200) return new Response("bot down", { status });
    return Response.json(cannedRecord());
  };
  vi.stubGlobal("fetch", stub);
  return seen;
}

/** A refusal carries no record bytes: no value, key, or epoch digits. */
function expectNoLeak(body: string) {
  expect(body).not.toContain(CANNED_VALUE);
  expect(body).not.toContain(CANNED_KEY);
  expect(body).not.toContain(String(CANNED_EPOCH));
}

describe("operator override panel (view-only)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("control-token bearer with no session sees record + epoch", async () => {
    stubBot();
    const res = await adminApp(createMemorySessionStore()).request(
      "/ops-overrides",
      { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } },
      envWithToken(CONTROL_TOKEN),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain(String(CANNED_EPOCH));
    expect(body).toContain(CANNED_KEY);
    expect(body).toContain(CANNED_VALUE);
  });

  it("moderator session plus bearer still sees the panel", async () => {
    stubBot();
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MOD);
    const res = await adminApp(store).request(
      "/ops-overrides",
      { headers: { cookie, authorization: `Bearer ${CONTROL_TOKEN}` } },
      envWithToken(CONTROL_TOKEN),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(String(CANNED_EPOCH));
    expect(body).toContain(CANNED_VALUE);
  });

  it("non-moderator with the bearer sees the panel: the token admits, not the role", async () => {
    stubBot();
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MEMBER);
    const res = await adminApp(store).request(
      "/ops-overrides",
      { headers: { cookie, authorization: `Bearer ${CONTROL_TOKEN}` } },
      envWithToken(CONTROL_TOKEN),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(String(CANNED_EPOCH));
  });

  it("panel copy states a staleness bound with a concrete duration", async () => {
    stubBot();
    const res = await adminApp(createMemorySessionStore()).request(
      "/ops-overrides",
      { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } },
      envWithToken(CONTROL_TOKEN),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/stale|refresh|fresh/i);
    expect(body).toMatch(/\d+\s*(seconds?|minutes?)/i);
  });

  it("panel response is never edge-cacheable", async () => {
    stubBot();
    const res = await adminApp(createMemorySessionStore()).request(
      "/ops-overrides",
      { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } },
      envWithToken(CONTROL_TOKEN),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("missing bearer is refused with no record bytes", async () => {
    stubBot();
    const res = await adminApp(createMemorySessionStore()).request(
      "/ops-overrides",
      {},
      envWithToken(CONTROL_TOKEN),
    );
    expect([401, 403]).toContain(res.status);
    expectNoLeak(await res.text());
  });

  it("wrong bearer is refused with no record bytes", async () => {
    stubBot();
    const res = await adminApp(createMemorySessionStore()).request(
      "/ops-overrides",
      { headers: { authorization: `Bearer ${WRONG_TOKEN}` } },
      envWithToken(CONTROL_TOKEN),
    );
    expect([401, 403]).toContain(res.status);
    expectNoLeak(await res.text());
  });

  it("malformed authorization headers are refused", async () => {
    stubBot();
    for (const authorization of [`Token ${CONTROL_TOKEN}`, "Bearer ", `bearer ${CONTROL_TOKEN}`]) {
      const res = await adminApp(createMemorySessionStore()).request(
        "/ops-overrides",
        { headers: { authorization } },
        envWithToken(CONTROL_TOKEN),
      );
      expect([401, 403]).toContain(res.status);
      expectNoLeak(await res.text());
    }
  });

  it("moderator session without the bearer is refused: session is not admission", async () => {
    stubBot();
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MOD);
    const res = await adminApp(store).request(
      "/ops-overrides",
      { headers: { cookie } },
      envWithToken(CONTROL_TOKEN),
    );
    expect([401, 403]).toContain(res.status);
    expectNoLeak(await res.text());
  });

  it("PUT with a valid bearer is refused before any upstream contact", async () => {
    const seen = stubBot();
    const res = await adminApp(createMemorySessionStore()).request(
      "/ops-overrides",
      { method: "PUT", headers: { authorization: `Bearer ${CONTROL_TOKEN}` } },
      envWithToken(CONTROL_TOKEN),
    );
    expect([404, 405]).toContain(res.status);
    expect(seen).toHaveLength(0);
  });

  it("POST, PATCH and DELETE are refused too", async () => {
    stubBot();
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const res = await adminApp(createMemorySessionStore()).request(
        "/ops-overrides",
        { method, headers: { authorization: `Bearer ${CONTROL_TOKEN}` } },
        envWithToken(CONTROL_TOKEN),
      );
      expect([404, 405]).toContain(res.status);
    }
  });

  it("upstream failure degrades honestly, never as a silent current record", async () => {
    stubBot(500);
    const res = await adminApp(createMemorySessionStore()).request(
      "/ops-overrides",
      { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } },
      envWithToken(CONTROL_TOKEN),
    );
    const body = await res.text();
    const honest =
      res.status === 502 ||
      res.status === 503 ||
      (res.status === 200 && /stale|unavailable/i.test(body));
    expect(honest).toBe(true);
  });

  it("query string on the panel path is not a 200 (exact-path gate)", async () => {
    stubBot();
    const res = await adminApp(createMemorySessionStore()).request(
      "/ops-overrides?epoch=1",
      { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } },
      envWithToken(CONTROL_TOKEN),
    );
    expect(res.status).not.toBe(200);
    expectNoLeak(await res.text());
  });

  it("unconfigured token keeps the route dark", async () => {
    stubBot();
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MOD);
    const res = await adminApp(store).request(
      "/ops-overrides",
      { headers: { cookie, authorization: `Bearer ${CONTROL_TOKEN}` } },
      baseEnv,
    );
    expect(res.status).toBe(404);
  });

  it("short configured token fails closed even for its own bearer", async () => {
    stubBot();
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MOD);
    const res = await adminApp(store).request(
      "/ops-overrides",
      { headers: { cookie, authorization: "Bearer short" } },
      envWithToken("short"),
    );
    expect(res.status).toBe(404);
  });

  it("control: guest to the admin dashboard still bounces to login", async () => {
    const res = await adminApp(createMemorySessionStore()).request("/", {}, baseEnv);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
  });
});
