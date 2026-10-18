// route-inventory: GET /join/discord
// route-inventory: GET /join/callback
// Acceptance: a failed join callback renders the recovery page, and its
// "Try again" retry link must keep the sanitized ?next= return target the
// journey started with. The callback clears the journey cookies, so the
// retry href is the only place the return target can survive: it must be
// "/join/discord?next=<safe value>" when the journey carried a safe next,
// and the bare "/join/discord" when next was hostile or absent. The
// recovery title, message and invite fallback stay byte-identical.
//
// Hermetic: mounted app with in-memory stores and a stubbed Discord
// fetch only. No database, no network, no live Discord contact.
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

// A safe return target with a query string and a second parameter: a retry
// href built by raw concatenation would truncate it at the '&', so the
// parsed-value assertions below only pass when the value is carried as a
// single encoded ?next= parameter.
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

async function startJoin(e: Env, next?: string) {
  const query = next === undefined ? "" : `?next=${encodeURIComponent(next)}`;
  const res = await app.request(`/join/discord${query}`, {}, e);
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  return { res, state, cookie: cookiesFrom(res) };
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

const VARIANTS: {
  key: VariantKey;
  mode: DiscordMode;
  status: number;
  title: string;
  message: string;
}[] = [
  {
    key: "cancelled",
    mode: "no-call",
    status: 200,
    title: "Join cancelled",
    message: "You cancelled the Discord approval",
  },
  {
    key: "discord-error",
    mode: "no-call",
    status: 200,
    title: "Join didn&#39;t complete",
    message: "complete the approval. Try again",
  },
  {
    key: "expired-state",
    mode: "no-call",
    status: 200,
    title: "Join link expired",
    message: "That join link expired",
  },
  {
    key: "expired-grant",
    mode: "expired-grant",
    status: 200,
    title: "Join approval expired",
    message: "That Discord approval expired",
  },
  {
    key: "outage",
    mode: "exchange-outage",
    status: 503,
    title: "Discord is unreachable",
    message: "reach Discord to complete the join",
  },
  {
    key: "bot-refused",
    mode: "bot-refuses",
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
  expected: { status: number; title: string; message: string; next: string | null },
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
  // The journey cookies are still cleared by the callback (no cookie
  // redesign): the href, not a surviving cookie, carries the target.
  for (const name of ["state", "source", "next"]) {
    expect(res.headers.getSetCookie().join("\n")).toContain(`__Host-two_join_${name}=; Max-Age=0`);
  }
  const href = retryHref(html);
  expect(href).not.toBeNull();
  if (expected.next === null) {
    expect(href).toBe("/join/discord");
  } else {
    const parsed = new URL(href!, "https://next.example.test");
    expect(parsed.origin).toBe("https://next.example.test");
    expect(parsed.pathname).toBe("/join/discord");
    expect(parsed.searchParams.get("next")).toBe(expected.next);
    expect(href!.startsWith("/join/discord?next=")).toBe(true);
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

describe("join recovery retry keeps a safe ?next= return target", () => {
  it.each(VARIANTS)(
    "$key recovery carries ?next= for a safe return target",
    async ({ key, mode, status, title, message }) => {
      const { env: e } = isolated();
      stubDiscord(mode);
      const start = await startJoin(e, SAFE_NEXT);
      // Sanity: the start leg accepted and remembered the safe target, so a
      // bare retry href below can only mean the callback dropped it.
      expect(start.res.headers.getSetCookie().join("\n")).toMatch(/__Host-two_join_next=[^;]/);
      const res = await runVariant(e, key, start);
      await expectRecovery(res, { status, title, message, next: SAFE_NEXT });
    },
  );

  it("following the retry href re-establishes the target and the retry journey lands on it", async () => {
    const { env: e } = isolated();
    stubDiscord("success");
    const start = await startJoin(e, SAFE_NEXT);
    const denied = await callback(e, `error=access_denied&state=${start.state}`, {
      cookie: start.cookie,
    });
    const { href } = await expectRecovery(denied, {
      status: 200,
      title: "Join cancelled",
      message: "You cancelled the Discord approval",
      next: SAFE_NEXT,
    });
    // A fresh browser follows the retry href with no journey cookies left.
    const retry = await app.request(href, {}, e);
    expect(retry.status).toBe(302);
    expect(retry.headers.getSetCookie().join("\n")).toMatch(/__Host-two_join_next=[^;]/);
    const retryState = new URL(retry.headers.get("location")!).searchParams.get("state")!;
    const finish = await callback(e, `code=abc&state=${retryState}`, {
      cookie: cookiesFrom(retry),
    });
    expect(finish.status).toBe(302);
    expect(finish.headers.get("location")).toBe(SAFE_NEXT);
  });
});

describe("join recovery retry omits ?next= when there is no safe target", () => {
  it.each(VARIANTS)(
    "$key recovery keeps the bare retry href when next was absent",
    async ({ key, mode, status, title, message }) => {
      const { env: e } = isolated();
      stubDiscord(mode);
      const start = await startJoin(e);
      const res = await runVariant(e, key, start);
      await expectRecovery(res, { status, title, message, next: null });
    },
  );

  it.each(["https://evil.test/", "//evil.test/", "/\\evil.test", "javascript:alert(1)"])(
    "cancelled recovery omits hostile next %s and never echoes it",
    async (hostile) => {
      const { env: e } = isolated();
      stubDiscord("no-call");
      const start = await startJoin(e, hostile);
      expect(start.res.headers.getSetCookie().join("\n")).not.toMatch(/__Host-two_join_next=[^;]/);
      const res = await runVariant(e, "cancelled", start);
      const { html } = await expectRecovery(res, {
        status: 200,
        title: "Join cancelled",
        message: "You cancelled the Discord approval",
        next: null,
      });
      expect(html).not.toContain(hostile);
      expect(html).not.toContain(encodeURIComponent(hostile));
      expect(html).not.toContain("evil.test");
    },
  );

  it.each(VARIANTS.filter((v) => v.key === "expired-grant" || v.key === "outage"))(
    "$key recovery omits a hostile next and keeps the bare retry href",
    async ({ key, mode, status, title, message }) => {
      const { env: e } = isolated();
      stubDiscord(mode);
      const start = await startJoin(e, "https://evil.test/");
      const res = await runVariant(e, key, start);
      const { html } = await expectRecovery(res, { status, title, message, next: null });
      expect(html).not.toContain("evil.test");
    },
  );
});
