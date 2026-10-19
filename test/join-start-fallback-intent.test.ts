/// <reference types="vite/client" />
// route-inventory: GET /join
// route-inventory: GET /join/discord
// Acceptance: when the journey store fails transiently, GET /join/discord
// degrades to /join (never a 500, never a minted state) — and the fallback
// target must carry the already-sanitized ?next= return target and ?source=
// attribution the request arrived with, so a retry keeps both. Hostile or
// absent values keep the bare /join target and are never echoed.
//
// Hermetic: mounted app with an in-memory session store whose journey leg is
// broken per test, plus a fake journey Sql double. No database, no network.
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import type { Env } from "../src/env";
import { createMemorySessionStore, type Sql } from "../src/sessions";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: "1546777856984481792",
};

// A safe return target with a query string and a second parameter: a fallback
// target built by raw concatenation would truncate it at the '&', so the
// parsed-value assertions below only pass when the value rides as a single
// encoded ?next= parameter.
const SAFE_NEXT = "/events?month=2026-10&view=list";
// A valid source exercising the whole legacy charset at once: mixed case
// (recorded verbatim, never case-folded), a colon, a dash, an underscore and
// digits. A fallback that drops, lowercases or truncates any of it fails the
// parsed-value assertions below.
const SAFE_SOURCE = "Partner:fall-drive_01";

function fakeSql() {
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head.includes("count(*)")) return [{ n: 0, wait: 1 }];
    if (head.includes("INSERT INTO web_throttle_hits")) return [];
    if (head.includes("DELETE FROM web_throttle_hits")) return [];
    if (head.includes("INSERT INTO join_attempts")) return [];
    throw new Error(`fakeSql: unexpected statement: ${head.slice(0, 80)}`);
  }) as unknown as Sql;
  (sql as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  return withThrottleTx(sql);
}

function isolated() {
  const sql = fakeSql();
  const store = createMemorySessionStore();
  const e = {
    ...env,
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => sql },
  } as unknown as Env;
  return { store, env: e };
}

type FailureMode = "sweep-rejects" | "issue-rejects" | "issue-refuses";

function breakJourneys(store: ReturnType<typeof createMemorySessionStore>, mode: FailureMode) {
  if (mode === "sweep-rejects") {
    store.journeys.sweepExpired = async () => {
      throw new Error("journey store down");
    };
  } else if (mode === "issue-rejects") {
    store.journeys.issue = async () => {
      throw new Error("journey store down");
    };
  } else {
    store.journeys.issue = async () => false;
  }
}

function startQuery(intent: { source?: string; next?: string } = {}) {
  const params = new URLSearchParams();
  if (intent.source !== undefined) params.set("source", intent.source);
  if (intent.next !== undefined) params.set("next", intent.next);
  const query = params.toString() === "" ? "" : `?${params.toString()}`;
  return `/join/discord${query}`;
}

async function expectFallback(
  res: Response,
  expected: { next: string | null; source: string | null },
) {
  expect(res.status).toBe(302);
  expect(res.headers.get("cache-control")).toContain("no-store");
  // The fallback still never mints state — and, as today, it mints no intent
  // cookies either: the target URL, not a cookie, carries the retry intent.
  const set = res.headers.getSetCookie().join("\n");
  expect(set).not.toMatch(/__Host-two_join_state=[^;]/);
  expect(set).not.toMatch(/__Host-two_join_source=[^;]/);
  expect(set).not.toMatch(/__Host-two_join_next=[^;]/);
  const location = res.headers.get("location");
  expect(location).not.toBeNull();
  if (expected.next === null && expected.source === null) {
    expect(location).toBe("/join");
    return location!;
  }
  const parsed = new URL(location!, "https://next.example.test");
  expect(parsed.origin).toBe("https://next.example.test");
  expect(parsed.pathname).toBe("/join");
  // Exactly the expected parameters ride along — no dropped intent, and
  // nothing extra leaks into the retry target either. Parameter order is
  // deliberately not pinned.
  const keys = [...parsed.searchParams.keys()].sort();
  const want = [
    ...(expected.next === null ? [] : ["next"]),
    ...(expected.source === null ? [] : ["source"]),
  ].sort();
  expect(keys).toEqual(want);
  expect(parsed.searchParams.get("next")).toBe(expected.next);
  expect(parsed.searchParams.get("source")).toBe(expected.source);
  return location!;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("join start fallback preserves sanitized intent", () => {
  it.each(["sweep-rejects", "issue-rejects", "issue-refuses"] as FailureMode[])(
    "%s fallback carries ?next= and ?source=",
    async (mode) => {
      const { store, env: e } = isolated();
      breakJourneys(store, mode);
      const res = await app.request(startQuery({ source: SAFE_SOURCE, next: SAFE_NEXT }), {}, e);
      await expectFallback(res, { next: SAFE_NEXT, source: SAFE_SOURCE });
    },
  );

  it("sweep-rejects fallback carries ?next= alone when source was absent", async () => {
    const { store, env: e } = isolated();
    breakJourneys(store, "sweep-rejects");
    const res = await app.request(startQuery({ next: SAFE_NEXT }), {}, e);
    await expectFallback(res, { next: SAFE_NEXT, source: null });
  });

  it("sweep-rejects fallback carries ?source= alone when next was absent", async () => {
    const { store, env: e } = isolated();
    breakJourneys(store, "sweep-rejects");
    const res = await app.request(startQuery({ source: SAFE_SOURCE }), {}, e);
    await expectFallback(res, { next: null, source: SAFE_SOURCE });
  });

  it("sweep-rejects fallback keeps the bare target when neither value was carried", async () => {
    const { store, env: e } = isolated();
    breakJourneys(store, "sweep-rejects");
    const res = await app.request(startQuery(), {}, e);
    await expectFallback(res, { next: null, source: null });
  });

  it.each(["https://evil.test/", "//evil.test/", "/\\evil.test", "javascript:alert(1)"])(
    "sweep-rejects fallback drops hostile next %s and never echoes it",
    async (hostile) => {
      const { store, env: e } = isolated();
      breakJourneys(store, "sweep-rejects");
      const res = await app.request(startQuery({ next: hostile }), {}, e);
      const location = await expectFallback(res, { next: null, source: null });
      expect(location).not.toContain("evil.test");
      expect(location).not.toContain("javascript");
    },
  );

  it.each(["a/b", "bad source", "-leading-dash", "source&next=/evil", "a".repeat(65)])(
    "sweep-rejects fallback drops hostile source %s and never echoes it",
    async (hostile) => {
      const { store, env: e } = isolated();
      breakJourneys(store, "sweep-rejects");
      const res = await app.request(startQuery({ source: hostile }), {}, e);
      const location = await expectFallback(res, { next: null, source: null });
      expect(location).not.toContain(hostile.slice(0, 8));
      expect(location).not.toContain(encodeURIComponent(hostile.slice(0, 8)));
    },
  );

  it("sweep-rejects fallback keeps a safe ?next= when the source was hostile", async () => {
    const { store, env: e } = isolated();
    breakJourneys(store, "sweep-rejects");
    const res = await app.request(startQuery({ source: "a/b", next: SAFE_NEXT }), {}, e);
    const location = await expectFallback(res, { next: SAFE_NEXT, source: null });
    expect(location).not.toContain("a/b");
  });

  it("sweep-rejects fallback keeps a safe ?source= when next was hostile", async () => {
    const { store, env: e } = isolated();
    breakJourneys(store, "sweep-rejects");
    const res = await app.request(
      startQuery({ source: SAFE_SOURCE, next: "https://evil.test/" }),
      {},
      e,
    );
    const location = await expectFallback(res, { next: null, source: SAFE_SOURCE });
    expect(location).not.toContain("evil.test");
  });

  it("following the fallback keeps the return target on the one-click retry link", async () => {
    const { store, env: e } = isolated();
    breakJourneys(store, "sweep-rejects");
    const res = await app.request(startQuery({ source: SAFE_SOURCE, next: SAFE_NEXT }), {}, e);
    const location = await expectFallback(res, { next: SAFE_NEXT, source: SAFE_SOURCE });
    // A browser landing on the fallback target gets the journey page, whose
    // one-click button re-enters the funnel with the same return target.
    const page = await app.request(location, {}, e);
    expect(page.status).toBe(200);
    const html = await page.text();
    const href = html
      .match(/<a[^>]*data-testid="join-oneclick"[^>]*>/)?.[0]
      .match(/href="([^"]*)"/)?.[1];
    expect(href).not.toBeUndefined();
    const retry = new URL(href!.replace(/&amp;/g, "&"), "https://next.example.test");
    expect(retry.pathname).toBe("/join/discord");
    expect(retry.searchParams.get("next")).toBe(SAFE_NEXT);
  });

  it("steady path is unchanged: an admitted journey still mints the same cookies", async () => {
    const { env: e } = isolated();
    const res = await app.request(startQuery({ source: SAFE_SOURCE, next: SAFE_NEXT }), {}, e);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(location.searchParams.get("state")).toMatch(/^[0-9a-f-]{36}$/);
    const set = res.headers.getSetCookie().join("\n");
    expect(set).toMatch(/__Host-two_join_state=[^;]/);
    expect(set).toMatch(/__Host-two_join_source=[^;]/);
    expect(set).toMatch(/__Host-two_join_next=[^;]/);
  });
});
