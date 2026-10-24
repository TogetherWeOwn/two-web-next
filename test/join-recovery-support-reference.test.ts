// route-inventory: GET /join/discord
// route-inventory: GET /join/callback
// Acceptance: every join recovery render shows the Support reference a
// member can quote to support, carrying the same validated request ID as
// the response's x-request-id header (admitted Ray ID, or a generated
// ULID; client-supplied IDs are ignored). This is the contract the 500
// and 503 pages already meet; the join recovery page must meet it too.
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

const RAY = "0123456789abcdef-LHR";
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
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

type DiscordMode = "no-call" | "expired-grant" | "exchange-outage" | "bot-refuses";

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

async function startJoin(e: Env) {
  const res = await app.request("/join/discord", {}, e);
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  return { state, cookie: cookiesFrom(res) };
}

const callback = (e: Env, query: string, headers: Record<string, string>) =>
  app.request(`/join/callback?${query}`, { headers }, e);

// The visible Support reference, however the page marks it up: the error
// pages render `Support reference: <code data-testid="...">id</code>`.
// Accept that shape or any element immediately following the label, but
// never a bare ID elsewhere on the page.
function supportReference(html: string): string | null {
  return (
    html.match(/data-testid="[^"]*support-reference[^"]*"[^>]*>([^<]*)</)?.[1]?.trim() ??
    html.match(/Support reference:\s*(?:<[^>]+>\s*)+([0-9A-Za-z][0-9A-Za-z-]*)/)?.[1] ??
    html.match(/Support reference:\s*([0-9A-Za-z][0-9A-Za-z-]*)/)?.[1] ??
    null
  );
}

async function expectRecoveryWithReference(
  res: Response,
  expected: { status: number; title: string },
) {
  expect(res.status).toBe(expected.status);
  const html = await res.text();
  expect(html).toContain(expected.title);
  // Recovery affordances and no-JS readability are unchanged: the title,
  // retry and invite are in the server-rendered HTML itself.
  expect(html).toContain('data-testid="recovery-retry"');
  expect(html).toContain('data-testid="recovery-invite"');
  expect(html).toContain("https://discord.gg/invite");
  expect(html).not.toContain(DESCRIPTION_SECRET);
  expect(html).not.toContain("fixture-access-token");
  const headerId = res.headers.get("x-request-id");
  expect(headerId).toBeTruthy();
  expect(html).toContain("Support reference");
  expect(supportReference(html)).toBe(headerId);
  return { html, headerId: headerId! };
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

describe("join recovery shows the support reference on every recovery path", () => {
  it("cancelled consent (access_denied) shows the admitted Ray ID, matching x-request-id", async () => {
    const { env: e } = isolated();
    const calls = stubDiscord("no-call");
    const start = await startJoin(e);
    const res = await callback(
      e,
      `error=access_denied&error_description=${DESCRIPTION_SECRET}&state=${start.state}`,
      { cookie: start.cookie, "cf-ray": RAY },
    );
    const { headerId } = await expectRecoveryWithReference(res, {
      status: 200,
      title: "Join cancelled",
    });
    expect(headerId).toBe(RAY);
    expect(calls).toHaveLength(0);
  });

  it("a non-denied Discord error shows the admitted Ray ID, matching x-request-id", async () => {
    const { env: e } = isolated();
    const calls = stubDiscord("no-call");
    const start = await startJoin(e);
    const res = await callback(
      e,
      `error=server_error&error_description=${DESCRIPTION_SECRET}&state=${start.state}`,
      { cookie: start.cookie, "cf-ray": RAY },
    );
    const { headerId } = await expectRecoveryWithReference(res, {
      status: 200,
      title: "Join didn&#39;t complete",
    });
    expect(headerId).toBe(RAY);
    expect(calls).toHaveLength(0);
  });

  it("expired or forged state shows the admitted Ray ID, matching x-request-id", async () => {
    const { env: e } = isolated();
    const calls = stubDiscord("no-call");
    const start = await startJoin(e);
    const res = await callback(e, "code=abc&state=forged", {
      cookie: start.cookie,
      "cf-ray": RAY,
    });
    const { headerId } = await expectRecoveryWithReference(res, {
      status: 200,
      title: "Join link expired",
    });
    expect(headerId).toBe(RAY);
    expect(calls).toHaveLength(0);
  });

  it("an expired approval grant shows the admitted Ray ID, matching x-request-id", async () => {
    const { env: e } = isolated();
    stubDiscord("expired-grant");
    const start = await startJoin(e);
    const res = await callback(e, `code=abc&state=${start.state}`, {
      cookie: start.cookie,
      "cf-ray": RAY,
    });
    const { headerId } = await expectRecoveryWithReference(res, {
      status: 200,
      title: "Join approval expired",
    });
    expect(headerId).toBe(RAY);
  });

  it("Discord unreachable (exchange outage, 503) shows the admitted Ray ID, matching x-request-id", async () => {
    const { env: e } = isolated();
    stubDiscord("exchange-outage");
    const start = await startJoin(e);
    const res = await callback(e, `code=abc&state=${start.state}`, {
      cookie: start.cookie,
      "cf-ray": RAY,
    });
    const { headerId } = await expectRecoveryWithReference(res, {
      status: 503,
      title: "Discord is unreachable",
    });
    expect(headerId).toBe(RAY);
  });

  it("bot-refused recovery shows the admitted Ray ID, matching x-request-id", async () => {
    const { env: e } = isolated();
    stubDiscord("bot-refuses");
    const start = await startJoin(e);
    const res = await callback(e, `code=abc&state=${start.state}`, {
      cookie: start.cookie,
      "cf-ray": RAY,
    });
    const { headerId } = await expectRecoveryWithReference(res, {
      status: 200,
      title: "We couldn&#39;t add you automatically",
    });
    expect(headerId).toBe(RAY);
  });
});

describe("join recovery support reference follows the x-request-id contract", () => {
  it("shows a generated ULID matching x-request-id when no Ray ID is sent", async () => {
    const { env: e } = isolated();
    stubDiscord("no-call");
    const start = await startJoin(e);
    const res = await callback(e, `error=access_denied&state=${start.state}`, {
      cookie: start.cookie,
    });
    const { headerId } = await expectRecoveryWithReference(res, {
      status: 200,
      title: "Join cancelled",
    });
    expect(headerId).toMatch(ULID);
  });

  it("ignores a client-supplied x-request-id instead of showing it as the reference", async () => {
    const { env: e } = isolated();
    stubDiscord("no-call");
    const start = await startJoin(e);
    const forged = "client-forged-reference";
    const res = await callback(e, `error=access_denied&state=${start.state}`, {
      cookie: start.cookie,
      "x-request-id": forged,
    });
    const { html, headerId } = await expectRecoveryWithReference(res, {
      status: 200,
      title: "Join cancelled",
    });
    expect(headerId).not.toBe(forged);
    expect(headerId).toMatch(ULID);
    expect(html).not.toContain(forged);
  });

  it("replaces a hostile cf-ray with the generated reference and never echoes it", async () => {
    const { env: e } = isolated();
    stubDiscord("no-call");
    const start = await startJoin(e);
    const hostile = '0123456789abcdef-LHR"><b>leak-marker</b>';
    const res = await callback(e, `error=access_denied&state=${start.state}`, {
      cookie: start.cookie,
      "cf-ray": hostile,
    });
    const { html, headerId } = await expectRecoveryWithReference(res, {
      status: 200,
      title: "Join cancelled",
    });
    expect(headerId).not.toBe(hostile);
    expect(headerId).toMatch(ULID);
    expect(html).not.toContain("leak-marker");
  });
});
