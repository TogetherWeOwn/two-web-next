// route-inventory: GET /join/discord
// route-inventory: GET /join/callback
// Acceptance: a failed join callback renders the recovery page, and its
// "Try again" retry link must preserve the sanitized ?source= attribution
// the journey started with, alongside any ?next= return target. An
// admitted callback clears its own journey cookies, so its retry href is
// the only place the attribution can survive: it must carry
// "source=<sanitized value>" when the journey carried a valid source,
// and no source parameter at all when the source was hostile or absent.
// An unadmitted callback (its state does not bind to the jar's journey)
// renders the same sanitized retry href but must not touch the pending
// journey's cookies at all. Following the retry href must make the
// retried journey's join_attempts row record that source instead of
// null. The recovery title, message, invite fallback and retry label
// stay byte-identical.
//
// Hermetic: mounted app with in-memory stores and a stubbed Discord
// fetch only. No database, no network, no live Discord contact.
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// A valid source exercising the whole legacy charset at once: mixed case
// (attribution is recorded verbatim today, never case-folded), a colon, a
// dash, an underscore and digits. A retry href that drops, lowercases or
// truncates any of it fails the parsed-value assertions below.
const SAFE_SOURCE = "Partner:fall-drive_01";
// The same safe return target shape as the ?next= acceptance suite: a raw
// concatenation would truncate it at the '&'.
const SAFE_NEXT = "/events?month=2026-10&view=list";
const DESCRIPTION_SECRET = "provider-description-must-never-appear";

const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

function fakeSql() {
  const attempts: {
    outcome: string;
    source: string | null;
    requestId: string | null;
    discordId: string | null;
  }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head.includes("count(*)")) return [{ n: 0, wait: 1 }];
    if (head.includes("INSERT INTO web_throttle_hits")) return [];
    if (head.includes("DELETE FROM web_throttle_hits")) return [];
    if (head.includes("INSERT INTO join_attempts")) {
      const [outcome, source, requestId, discordId] = values as [
        string,
        string | null,
        string | null,
        string | null,
      ];
      attempts.push({ outcome, source, requestId, discordId });
      return [];
    }
    throw new Error(`fakeSql: unexpected statement: ${head.slice(0, 80)}`);
  }) as unknown as Sql;
  (sql as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  return { sql: withThrottleTx(sql), attempts };
}

function isolated() {
  const fake = fakeSql();
  const store = createMemorySessionStore();
  const e = {
    ...env,
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => fake.sql },
  } as unknown as Env;
  return { fake, env: e };
}

const urlOf = (input: string | URL | Request) =>
  typeof input === "string" ? input : input instanceof Request ? input.url : input.href;

type DiscordMode = "no-call" | "expired-grant" | "exchange-outage" | "bot-refuses" | "success";

function stubDiscord(mode: DiscordMode) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      calls.push(new URL(url).pathname);
      if (url.endsWith("/oauth2/token")) {
        if (mode === "expired-grant")
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        if (mode === "exchange-outage") return new Response("bad", { status: 500 });
        return Response.json({ access_token: "fixture-access-token" });
      }
      if (url.endsWith("/users/@me"))
        return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
      if (url.includes("/members/42") && init?.method === "PUT")
        return new Response(null, { status: mode === "bot-refuses" ? 403 : 201 });
      if (url.includes("/members/42"))
        return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
      return new Response("unexpected", { status: 500 });
    }),
  );
  return calls;
}

async function startJoin(e: Env, intent: { source?: string; next?: string } = {}) {
  const params = new URLSearchParams();
  if (intent.source !== undefined) params.set("source", intent.source);
  if (intent.next !== undefined) params.set("next", intent.next);
  const query = params.toString() === "" ? "" : `?${params.toString()}`;
  const res = await app.request(`/join/discord${query}`, {}, e);
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  return { res, state, cookie: cookiesFrom(res) };
}

// Replace the source segment of a real journey cookie jar with a
// correctly-signed but hostile value: the signature verifies, so only
// sanitization at the callback can keep it out of the retry href.
async function withSignedSource(jar: string, value: string): Promise<string> {
  const signed = (
    await serializeSigned("__Host-two_join_source", value, env.SESSION_SECRET, {
      path: "/",
      secure: true,
    })
  ).split(";")[0]!;
  const segments = jar
    .split("; ")
    .filter((segment) => !segment.startsWith("__Host-two_join_source="));
  return [...segments, signed].join("; ");
}

const callback = (e: Env, query: string, headers: Record<string, string>) =>
  app.request(`/join/callback?${query}`, { headers }, e);

type VariantKey =
  | "cancelled"
  | "discord-error"
  | "expired-state"
  | "expired-grant"
  | "outage"
  | "bot-refused";

// `admitted` records whether the callback binds to the jar's journey (its
// state matches the signed state cookie and consumes the stored journey).
// Only an admitted callback owns journey cleanup; `expired-state` submits a
// forged state against the real jar, so it is unadmitted and must preserve
// the pending journey's cookies.
const VARIANTS: {
  key: VariantKey;
  mode: DiscordMode;
  admitted: boolean;
  status: number;
  title: string;
  message: string;
}[] = [
  {
    key: "cancelled",
    mode: "no-call",
    admitted: true,
    status: 200,
    title: "Join cancelled",
    message: "You cancelled the Discord approval",
  },
  {
    key: "discord-error",
    mode: "no-call",
    admitted: true,
    status: 200,
    title: "Join didn&#39;t complete",
    message: "complete the approval. Try again",
  },
  {
    key: "expired-state",
    mode: "no-call",
    admitted: false,
    status: 200,
    title: "Join link expired",
    message: "That join link expired",
  },
  {
    key: "expired-grant",
    mode: "expired-grant",
    admitted: true,
    status: 200,
    title: "Join approval expired",
    message: "That Discord approval expired",
  },
  {
    key: "outage",
    mode: "exchange-outage",
    admitted: true,
    status: 503,
    title: "Discord is unreachable",
    message: "reach Discord to complete the join",
  },
  {
    key: "bot-refused",
    mode: "bot-refuses",
    admitted: true,
    status: 200,
    title: "We couldn&#39;t add you automatically",
    message: "use the invite link below",
  },
];

async function runVariant(
  e: Env,
  key: VariantKey,
  start: { state: string; cookie: string },
): Promise<Response> {
  switch (key) {
    case "cancelled":
      return callback(
        e,
        `error=access_denied&error_description=${DESCRIPTION_SECRET}&state=${start.state}`,
        { cookie: start.cookie },
      );
    case "discord-error":
      return callback(
        e,
        `error=server_error&error_description=${DESCRIPTION_SECRET}&state=${start.state}`,
        { cookie: start.cookie },
      );
    case "expired-state":
      return callback(e, "code=abc&state=forged", { cookie: start.cookie });
    case "expired-grant":
    case "outage":
    case "bot-refused":
      return callback(e, `code=abc&state=${start.state}`, { cookie: start.cookie });
  }
}

// The retry href exactly as a browser would read it: the anchor carrying
// data-testid="recovery-retry", with &amp; decoded the way getAttribute
// would hand it to navigation.
function retryHref(html: string): string | null {
  const tag = html.match(/<a[^>]*data-testid="recovery-retry"[^>]*>/)?.[0];
  const href = tag?.match(/href="([^"]*)"/)?.[1];
  return href === undefined ? null : href.replace(/&amp;/g, "&");
}

async function expectRecovery(
  res: Response,
  expected: {
    status: number;
    title: string;
    message: string;
    source: string | null;
    next: string | null;
    admitted: boolean;
  },
) {
  expect(res.status).toBe(expected.status);
  const html = await res.text();
  // Copy and invite fallback are byte-identical to today: same title,
  // same message, same invite anchor, same retry label.
  expect(html).toContain(expected.title);
  expect(html).toContain(expected.message);
  expect(html).toContain('href="https://discord.gg/invite" data-testid="recovery-invite"');
  expect(html).toContain("Try again");
  expect(html).not.toContain(DESCRIPTION_SECRET);
  expect(html).not.toContain("fixture-access-token");
  // Admission decides journey cleanup. An admitted callback still clears
  // its own journey cookies (no cookie redesign): the href, not a
  // surviving cookie, carries the attribution. An unadmitted callback
  // must not touch them at all — no deletion and no replacement header
  // for any journey cookie — so the pending journey (e.g. a newer tab's)
  // survives in the browser jar byte-for-byte.
  const setCookies = res.headers.getSetCookie();
  for (const name of ["state", "source", "next"]) {
    if (expected.admitted) {
      expect(setCookies.join("\n")).toContain(`__Host-two_join_${name}=; Max-Age=0`);
    } else {
      expect(
        setCookies.some((c) => c.startsWith(`__Host-two_join_${name}=`)),
        `__Host-two_join_${name} must be untouched`,
      ).toBe(false);
    }
  }
  const href = retryHref(html);
  expect(href).not.toBeNull();
  if (expected.source === null && expected.next === null) {
    expect(href).toBe("/join/discord");
  } else {
    const parsed = new URL(href!, "https://next.example.test");
    expect(parsed.origin).toBe("https://next.example.test");
    expect(parsed.pathname).toBe("/join/discord");
    // Exactly the expected parameters ride along — no dropped attribution,
    // and nothing extra leaks into the retry URL either. Parameter order
    // is deliberately not pinned.
    const keys = [...parsed.searchParams.keys()].sort();
    const want = [
      ...(expected.next === null ? [] : ["next"]),
      ...(expected.source === null ? [] : ["source"]),
    ].sort();
    expect(keys).toEqual(want);
    expect(parsed.searchParams.get("source")).toBe(expected.source);
    expect(parsed.searchParams.get("next")).toBe(expected.next);
  }
  return { html, href: href! };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("join recovery retry preserves a sanitized ?source=", () => {
  it.each(VARIANTS)(
    "$key recovery carries ?source= for a valid source",
    async ({ key, mode, admitted, status, title, message }) => {
      const { env: e } = isolated();
      stubDiscord(mode);
      const start = await startJoin(e, { source: SAFE_SOURCE });
      // Sanity: the start leg accepted and remembered the source, so a
      // bare retry href below can only mean the callback dropped it.
      expect(start.res.headers.getSetCookie().join("\n")).toMatch(/__Host-two_join_source=[^;]/);
      const res = await runVariant(e, key, start);
      await expectRecovery(res, {
        status,
        title,
        message,
        source: SAFE_SOURCE,
        next: null,
        admitted,
      });
    },
  );

  it.each(VARIANTS)(
    "$key recovery carries ?source= alongside a safe ?next=",
    async ({ key, mode, admitted, status, title, message }) => {
      const { env: e } = isolated();
      stubDiscord(mode);
      const start = await startJoin(e, { source: SAFE_SOURCE, next: SAFE_NEXT });
      expect(start.res.headers.getSetCookie().join("\n")).toMatch(/__Host-two_join_source=[^;]/);
      expect(start.res.headers.getSetCookie().join("\n")).toMatch(/__Host-two_join_next=[^;]/);
      const res = await runVariant(e, key, start);
      await expectRecovery(res, {
        status,
        title,
        message,
        source: SAFE_SOURCE,
        next: SAFE_NEXT,
        admitted,
      });
    },
  );

  it.each(["a", "a".repeat(64)])(
    "cancelled recovery carries a boundary-length valid source (%s…)",
    async (source) => {
      const { env: e } = isolated();
      stubDiscord("no-call");
      const start = await startJoin(e, { source });
      expect(start.res.headers.getSetCookie().join("\n")).toMatch(/__Host-two_join_source=[^;]/);
      const res = await runVariant(e, "cancelled", start);
      await expectRecovery(res, {
        status: 200,
        title: "Join cancelled",
        message: "You cancelled the Discord approval",
        source,
        next: null,
        admitted: true,
      });
    },
  );

  it("following the retry href records the source on the retried journey's attempt row", async () => {
    const { fake, env: e } = isolated();
    stubDiscord("success");
    const start = await startJoin(e, { source: SAFE_SOURCE });
    const denied = await callback(e, `error=access_denied&state=${start.state}`, {
      cookie: start.cookie,
    });
    const { href } = await expectRecovery(denied, {
      status: 200,
      title: "Join cancelled",
      message: "You cancelled the Discord approval",
      source: SAFE_SOURCE,
      next: null,
      admitted: true,
    });
    // A fresh browser follows the retry href with no journey cookies left.
    const retry = await app.request(href, {}, e);
    expect(retry.status).toBe(302);
    expect(retry.headers.getSetCookie().join("\n")).toMatch(/__Host-two_join_source=[^;]/);
    const retryState = new URL(retry.headers.get("location")!).searchParams.get("state")!;
    const finish = await callback(e, `code=abc&state=${retryState}`, {
      cookie: cookiesFrom(retry),
    });
    expect(finish.status).toBe(302);
    // No return target was ever in play: the default landing stays.
    expect(finish.headers.get("location")).toBe("/?n=joined");
    // The first (denied) attempt records the source today; the retried
    // (added) attempt must record the same source instead of null.
    expect(
      fake.attempts.map(({ outcome, source, discordId }) => ({ outcome, source, discordId })),
    ).toEqual([
      { outcome: "denied", source: SAFE_SOURCE, discordId: null },
      { outcome: "added", source: SAFE_SOURCE, discordId: "42" },
    ]);
  });

  it("following a combined retry href records the source and lands on the return target", async () => {
    const { fake, env: e } = isolated();
    stubDiscord("success");
    const start = await startJoin(e, { source: SAFE_SOURCE, next: SAFE_NEXT });
    const denied = await callback(e, `error=access_denied&state=${start.state}`, {
      cookie: start.cookie,
    });
    const { href } = await expectRecovery(denied, {
      status: 200,
      title: "Join cancelled",
      message: "You cancelled the Discord approval",
      source: SAFE_SOURCE,
      next: SAFE_NEXT,
      admitted: true,
    });
    const retry = await app.request(href, {}, e);
    expect(retry.status).toBe(302);
    expect(retry.headers.getSetCookie().join("\n")).toMatch(/__Host-two_join_source=[^;]/);
    expect(retry.headers.getSetCookie().join("\n")).toMatch(/__Host-two_join_next=[^;]/);
    const retryState = new URL(retry.headers.get("location")!).searchParams.get("state")!;
    const finish = await callback(e, `code=abc&state=${retryState}`, {
      cookie: cookiesFrom(retry),
    });
    expect(finish.status).toBe(302);
    expect(finish.headers.get("location")).toBe(SAFE_NEXT);
    expect(
      fake.attempts.map(({ outcome, source, discordId }) => ({ outcome, source, discordId })),
    ).toEqual([
      { outcome: "denied", source: SAFE_SOURCE, discordId: null },
      { outcome: "added", source: SAFE_SOURCE, discordId: "42" },
    ]);
  });
});

describe("join recovery retry omits ?source= when there is no valid source", () => {
  it.each(VARIANTS)(
    "$key recovery carries only ?next= when source was absent",
    async ({ key, mode, admitted, status, title, message }) => {
      const { env: e } = isolated();
      stubDiscord(mode);
      const start = await startJoin(e, { next: SAFE_NEXT });
      const res = await runVariant(e, key, start);
      await expectRecovery(res, {
        status,
        title,
        message,
        source: null,
        next: SAFE_NEXT,
        admitted,
      });
    },
  );

  it("cancelled recovery keeps the bare retry href when neither source nor next was carried", async () => {
    const { env: e } = isolated();
    stubDiscord("no-call");
    const start = await startJoin(e);
    const res = await runVariant(e, "cancelled", start);
    await expectRecovery(res, {
      status: 200,
      title: "Join cancelled",
      message: "You cancelled the Discord approval",
      source: null,
      next: null,
      admitted: true,
    });
  });

  it.each(["a/b", "bad source", "-leading-dash", "source&next=/evil", "a".repeat(65)])(
    "cancelled recovery omits hostile start source %s and never echoes it",
    async (hostile) => {
      const { fake, env: e } = isolated();
      stubDiscord("no-call");
      const start = await startJoin(e, { source: hostile });
      // The start leg already refuses to remember it; the retry href must
      // stay bare and the attempt row must keep recording no source.
      expect(start.res.headers.getSetCookie().join("\n")).not.toMatch(
        /__Host-two_join_source=[^;]/,
      );
      const res = await runVariant(e, "cancelled", start);
      const { html } = await expectRecovery(res, {
        status: 200,
        title: "Join cancelled",
        message: "You cancelled the Discord approval",
        source: null,
        next: null,
        admitted: true,
      });
      expect(html).not.toContain(hostile);
      expect(html).not.toContain(encodeURIComponent(hostile));
      expect(
        fake.attempts.map(({ outcome, source, discordId }) => ({ outcome, source, discordId })),
      ).toEqual([{ outcome: "denied", source: null, discordId: null }]);
    },
  );

  it("cancelled recovery omits a hostile start source but keeps a safe ?next=", async () => {
    const { env: e } = isolated();
    stubDiscord("no-call");
    const start = await startJoin(e, { source: "a/b", next: SAFE_NEXT });
    const res = await runVariant(e, "cancelled", start);
    const { html } = await expectRecovery(res, {
      status: 200,
      title: "Join cancelled",
      message: "You cancelled the Discord approval",
      source: null,
      next: SAFE_NEXT,
      admitted: true,
    });
    expect(html).not.toContain("a/b");
  });

  it("cancelled recovery drops a correctly-signed but hostile source cookie value", async () => {
    const hostile = "bad source&injected=1";
    const { env: e } = isolated();
    stubDiscord("no-call");
    const start = await startJoin(e, { source: SAFE_SOURCE, next: SAFE_NEXT });
    const res = await callback(e, `error=access_denied&state=${start.state}`, {
      cookie: await withSignedSource(start.cookie, hostile),
    });
    const { html } = await expectRecovery(res, {
      status: 200,
      title: "Join cancelled",
      message: "You cancelled the Discord approval",
      source: null,
      next: SAFE_NEXT,
      admitted: true,
    });
    expect(html).not.toContain(hostile);
    expect(html).not.toContain(encodeURIComponent(hostile));
    expect(html).not.toContain("injected");
  });

  it.each(VARIANTS.filter((v) => v.key === "expired-grant" || v.key === "outage"))(
    "$key recovery drops a correctly-signed but hostile source cookie value",
    async ({ key, mode, admitted, status, title, message }) => {
      const { env: e } = isolated();
      stubDiscord(mode);
      const start = await startJoin(e, { source: SAFE_SOURCE });
      const hostileStart = {
        state: start.state,
        cookie: await withSignedSource(start.cookie, "https://evil.test/x"),
      };
      const res = await runVariant(e, key, hostileStart);
      const { html } = await expectRecovery(res, {
        status,
        title,
        message,
        source: null,
        next: null,
        admitted,
      });
      expect(html).not.toContain("evil.test");
    },
  );
});
