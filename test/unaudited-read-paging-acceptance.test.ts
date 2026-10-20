// Acceptance: page when degraded mode serves unaudited member reads, and
// retire the dead admin-guard enforcement helper.
//
// RED at the acceptance pin: the serve-unaudited path logs loudly but never
// pages, the dead export still exists, and the alerts runbook has no
// serve-unaudited row. The Builder implements on this branch without editing
// this file; this suite is the green proof. Controls (silence, byte-stability,
// guard behavior) already pass and must keep passing.
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enforceOn, memberAccessLog, type AccessDecl, type AccessSink } from "../src/access-log";
import { adminApp } from "../src/admin/routes";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import type { Env } from "../src/env";
import { databaseUnavailable } from "../src/errors";
import { bufferedMemberText, declareMemberResult, memberReadBoundary } from "../src/member-reads";
import { requestLog } from "../src/request-log";
import { SESSION_COOKIE } from "../src/session-cookie";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const RAY_ID = "0123456789abcdef-LHR";
const PERSONAL = "Bio that must never reach a pager 7f3a";
const SUBJECT_ID = "100000000000000101";
const VIEWER_ID = "100000000000000102";
const SEARCH_TOKEN = "private-search-token-5k";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

class AuditWriteError extends Error {}

const POISON_MESSAGE = [
  "insert into member_data_access_logs",
  "values ('secret-binding-9z7x', 'private-payload-q2')",
  PERSONAL,
  SUBJECT_ID,
  VIEWER_ID,
].join(" ");

function router(sink: () => Promise<AccessSink | null>) {
  const app = new Hono<{
    Bindings: Env;
    Variables: { viewerId: string; access: AccessDecl };
  }>();
  app.use("*", requestLog);
  app.use("*", async (c, next) => {
    c.set("viewerId", VIEWER_ID);
    await next();
  });
  app.use("*", memberAccessLog(sink));
  app.get("/read", (c) => {
    c.set("access", {
      resource: "member",
      action: "view",
      route: "test.member",
      subjects: [SUBJECT_ID],
    });
    return c.text(PERSONAL);
  });
  return app;
}

const failingSink = () => async () => {
  throw new AuditWriteError(POISON_MESSAGE);
};

type ErrorSpy = ReturnType<typeof vi.spyOn>;

function rawAlertLines(spy: ErrorSpy): string[] {
  const calls = spy.mock.calls as unknown[][];
  return calls.map((call) => String(call[0])).filter((line) => line.includes('"error.alert"'));
}

function alertLines(spy: ErrorSpy): Record<string, unknown>[] {
  return rawAlertLines(spy).map((line) => JSON.parse(line));
}

function loudLogCount(spy: ErrorSpy): number {
  const calls = spy.mock.calls as unknown[][];
  return calls.filter((call) => String(call[0]).includes("could not be recorded")).length;
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
  const serialized = await serializeSigned(SESSION_COOKIE, token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return serialized.split(";")[0]!;
}

const MOD = { userId: "100000000000000111", username: "mod", moderator: true };
const MEMBER = { userId: "100000000000000222", username: "pleb", moderator: false };

beforeEach(() => {
  __resetAlertRateLimitForTests();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("serve-unaudited paging (acceptance)", () => {
  it("a degraded serve-unaudited emits one class-only error.alert with route + request id", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await router(failingSink()).request(
      `/read?search=${SEARCH_TOKEN}`,
      {
        headers: { "cf-ray": RAY_ID },
      },
      { ...env, MEMBER_ACCESS_LOG_ENFORCE: "false" },
    );
    // Degraded serve is preserved: the read still goes out.
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(PERSONAL);
    expect(res.headers.get("x-request-id")).toBe(RAY_ID);
    // The loud log stays; the page is new.
    expect(loudLogCount(spy)).toBeGreaterThanOrEqual(1);
    const raw = rawAlertLines(spy);
    expect(raw).toHaveLength(1);
    expect(raw[0]).not.toContain("\n");
    const line = JSON.parse(raw[0]!);
    expect(line).toMatchObject({
      level: "critical",
      event: "error.alert",
      exception: "AuditWriteError",
      error_class: "AuditWriteError",
      method: "GET",
      request_id: RAY_ID,
    });
    expect(["test.member", "/read"]).toContain(line.route);
    expect(line.fingerprint).toBe(`AuditWriteError@${line.route}`);
  });

  it("a missing audit sink also pages when it serves unaudited", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await router(async () => null).request(
      "/read",
      { headers: { "cf-ray": RAY_ID } },
      { ...env, MEMBER_ACCESS_LOG_ENFORCE: "false" },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(PERSONAL);
    const lines = alertLines(spy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: "error.alert",
      exception: "Error",
      error_class: "Error",
      request_id: RAY_ID,
    });
    expect(lines[0]!.fingerprint).toBe(`Error@${lines[0]!.route}`);
  });

  it("a second serve-unaudited inside the mute window pages no second line", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = router(failingSink());
    const bindings = { ...env, MEMBER_ACCESS_LOG_ENFORCE: "false" };
    const headers = { "cf-ray": RAY_ID };
    const first = await app.request("/read", { headers }, bindings);
    const second = await app.request("/read", { headers }, bindings);
    // Both reads still serve; only the paging is muted.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(rawAlertLines(spy)).toHaveLength(1);
  });

  it("the serve-unaudited line leaks no SQL, bindings, messages, payloads or identities", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await router(failingSink()).request(
      `/read?search=${SEARCH_TOKEN}`,
      {
        headers: { "cf-ray": RAY_ID },
      },
      { ...env, MEMBER_ACCESS_LOG_ENFORCE: "false" },
    );
    const raw = rawAlertLines(spy);
    expect(raw).toHaveLength(1);
    for (const sentinel of [
      "insert into",
      "secret-binding-9z7x",
      "private-payload-q2",
      PERSONAL,
      SUBJECT_ID,
      VIEWER_ID,
      SEARCH_TOKEN,
      "client-secret",
      "bot-token",
    ]) {
      expect(raw[0]).not.toContain(sentinel);
    }
    const line = JSON.parse(raw[0]!);
    for (const key of [
      "message",
      "stack",
      "sql",
      "bindings",
      "payload",
      "subjects",
      "subjectUserIds",
      "viewerId",
    ]) {
      expect(line).not.toHaveProperty(key);
    }
  });
});

describe("enforced refusal and successful audit stay silent (acceptance)", () => {
  it("an enforced refusal keeps the loud log and the 503, but pages nothing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await router(failingSink()).request(
      "/read",
      { headers: { "cf-ray": RAY_ID } },
      { ...env, MEMBER_ACCESS_LOG_ENFORCE: "true" },
    );
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(PERSONAL);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(loudLogCount(spy)).toBeGreaterThanOrEqual(1);
    expect(rawAlertLines(spy)).toHaveLength(0);
  });

  it("a successful audit serves silently", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const write = vi.fn(async (_entry: Parameters<AccessSink>[0]) => true);
    const res = await router(async () => write).request(
      "/read",
      { headers: { "cf-ray": RAY_ID } },
      { ...env, MEMBER_ACCESS_LOG_ENFORCE: "false" },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(PERSONAL);
    expect(write).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
    expect(rawAlertLines(spy)).toHaveLength(0);
  });

  it("the enforce-on JSON 503 envelope is byte-stable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await router(failingSink()).request(
      "/read",
      { headers: { "cf-ray": RAY_ID, accept: "application/json" } },
      { ...env, MEMBER_ACCESS_LOG_ENFORCE: "true" },
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toContain("Accept");
    expect(await res.json()).toEqual({
      error: "db_unavailable",
      message: "The service is temporarily unavailable. Try again shortly.",
      request_id: RAY_ID,
    });
  });

  it("the enforce-on HTML 503 keeps the brand shell and support reference without leaking", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await router(failingSink()).request(
      `/read?search=${SEARCH_TOKEN}`,
      { headers: { "cf-ray": RAY_ID, accept: "text/html" } },
      { ...env, MEMBER_ACCESS_LOG_ENFORCE: "true" },
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toContain("Accept");
    const body = await res.text();
    expect(body).toContain("We will be right back");
    expect(body).toContain(RAY_ID);
    for (const sentinel of [PERSONAL, SUBJECT_ID, SEARCH_TOKEN, "insert into"]) {
      expect(body).not.toContain(sentinel);
    }
  });
});

describe("dead enforcement helper retirement (acceptance)", () => {
  it("the dead enforceEnabled export is gone", async () => {
    const guard = await import("../src/admin/guard");
    expect("enforceEnabled" in guard).toBe(false);
  });

  it.each([
    [undefined, true],
    ["", true],
    [" true ", true],
    ["garbage", true],
    [" false ", false],
    ["FALSE", false],
    ["0", false],
    [" No ", false],
  ])("the surviving enforceOn parsing is unchanged for %s => %s", (flag, expected) => {
    expect(enforceOn({ ...env, MEMBER_ACCESS_LOG_ENFORCE: flag })).toBe(expected);
  });

  it.each([["false"], ["true"], [undefined]])(
    "guest bounce is identical with the flag %s",
    async (flag) => {
      const res = await adminApp(createMemorySessionStore()).request(
        "/events?status=draft",
        {},
        { ...env, MEMBER_ACCESS_LOG_ENFORCE: flag },
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/auth/discord");
    },
  );

  it.each([["false"], ["true"], [undefined]])(
    "signed non-moderator 403 is identical with the flag %s",
    async (flag) => {
      const store = createMemorySessionStore();
      const cookie = await cookieFor(store, MEMBER);
      const res = await adminApp(store).request(
        "/events",
        { headers: { cookie } },
        { ...env, MEMBER_ACCESS_LOG_ENFORCE: flag },
      );
      expect(res.status).toBe(403);
      expect(res.headers.get("location")).toBeNull();
    },
  );

  it.each([["false"], ["true"], [undefined]])(
    "moderator dashboard pass is identical with the flag %s",
    async (flag) => {
      const store = createMemorySessionStore();
      const cookie = await cookieFor(store, MOD);
      const res = await adminApp(store).request(
        "/",
        { headers: { cookie } },
        { ...env, MEMBER_ACCESS_LOG_ENFORCE: flag },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(await res.text()).toContain("mod");
    },
  );

  it("the keyed read boundary still refuses a failed audit with the flag off", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = new Hono<{ Bindings: Env }>();
    app.get("/keyed", async (c) => {
      await memberReadBoundary(
        c,
        { resource: "member", action: "view", route: "test.member", viewer: VIEWER_ID },
        async () => {
          throw new AuditWriteError(POISON_MESSAGE);
        },
        async () => {
          declareMemberResult([SUBJECT_ID]);
          bufferedMemberText(c, PERSONAL);
        },
        databaseUnavailable,
      );
      return c.res;
    });
    const res = await app.request("/keyed", {}, { ...env, MEMBER_ACCESS_LOG_ENFORCE: "false" });
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.text();
    for (const sentinel of [PERSONAL, SUBJECT_ID, "insert into", "secret-binding-9z7x"]) {
      expect(body).not.toContain(sentinel);
    }
  });
});

describe("serve-unaudited runbook row (acceptance)", () => {
  it("the alerts runbook documents the serve-unaudited page with mute and triage", () => {
    const runbook = readFileSync("docs/runbook-alerts.md", "utf8");
    expect(runbook).toMatch(/serve-unaudited/i);
    const at = runbook.search(/serve-unaudited/i);
    const window = runbook.slice(Math.max(0, at - 3000), at + 3000);
    expect(window).toContain("error.alert");
    expect(window).toMatch(/mute/i);
    expect(window).toMatch(/5.?minutes?/i);
    expect(window).toContain("request_id");
    expect(window).toMatch(/wrangler tail/i);
    expect(window).toContain("scheduled.failing");
  });
});
