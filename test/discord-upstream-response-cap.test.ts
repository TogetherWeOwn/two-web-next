// Upstream JSON response buffering: the four Discord/bot `res.json()` sites
// (token exchange, user fetch, role lookup, widget snapshot) all read through
// the shared bounded buffer in `src/discord-http.ts` (256 KiB,
// DISCORD_HTTP_MAX_RESPONSE_BYTES). Overflow cancels the stream and hands back
// an empty body with the real status, so each caller keeps its existing
// fail-closed/fallback path. Hermetic oversized-body fixtures per site pin that
// mapping; under-cap fixtures pin unchanged recovery behavior. No live Discord
// calls; synthetic markers only, asserted absent from every log surface.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordError, exchangeCode, fetchUser } from "../src/discord";
import { DISCORD_HTTP_MAX_RESPONSE_BYTES } from "../src/discord-http";
import { fetchMemberRoles } from "../src/roles";
import { createDiscordWidgetHealth } from "../src/discord-widget";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import type { Env } from "../src/env";

// 256 KiB provider-buffer convention, pinned as a literal like the sibling bot
// suites (bot-client-response-cap, bot-event-read-budget) so a cap-value drift
// turns this suite red instead of silently resizing every fixture.
const CAP = 262_144;
const TOKEN = "***synthetic-token-shape***";
const SECRET = "***synthetic-secret-shape***";
const MEMBER = "***synthetic-member-shape***";

const GUILD = "222222222222222222";
const USER = "333333333333333333";
const FACADE = `https://discord.com/widget?id=${GUILD}&theme=dark`;

function leakFree(...surfaces: unknown[]) {
  const text = surfaces.map((s) => JSON.stringify(s) ?? String(s)).join("\n");
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(MEMBER);
}

// A pull-driven stream of `totalBytes` in `chunkBytes` pieces. `pulls()`
// counts how many pieces the reader actually pulled: an overflow must stop
// the download after cap + one chunk (cancel called), never read the whole
// hostile body. The marker rides in the first chunk so a log/body leak would
// carry it.
function oversizedBody(totalBytes: number, chunkBytes: number, marker: string) {
  const fullChunks = Math.ceil(totalBytes / chunkBytes);
  let produced = 0;
  let pulls = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (produced >= totalBytes) {
        controller.close();
        return;
      }
      const n = Math.min(chunkBytes, totalBytes - produced);
      const chunk = new Uint8Array(n);
      chunk.fill(0x61);
      if (produced === 0) {
        const bytes = new TextEncoder().encode(`{"marker":"${marker}","pad":"`);
        chunk.set(bytes.subarray(0, Math.min(bytes.length, n)));
      }
      produced += n;
      controller.enqueue(chunk);
    },
    cancel,
  });
  return {
    response: () => new Response(body, { status: 200 }),
    cancel,
    pulls: () => pulls,
    fullChunks,
  };
}

const exchange = () =>
  exchangeCode("fixture-code", "fixture-client", "fixture-secret", "https://example.test/callback");
const identity = () => fetchUser("fixture-access");
const roles = () => fetchMemberRoles(GUILD, USER, "fixture-bot");

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("shared response cap value", () => {
  it("pins the 256 KiB provider-buffer bound", () => {
    expect(DISCORD_HTTP_MAX_RESPONSE_BYTES).toBe(262_144);
    expect(CAP).toBe(DISCORD_HTTP_MAX_RESPONSE_BYTES);
  });
});

describe("oversized upstream bodies refuse cheaply without buffering", () => {
  it("token exchange classifies an over-cap body as a provider rejection", async () => {
    const big = oversizedBody(CAP * 2, 65536, `${TOKEN} ${SECRET}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => big.response()),
    );
    const err = await exchange().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordError);
    expect(err).toMatchObject({ step: "token_exchange", status: 200, kind: "provider_reject" });
    expect((err as DiscordError).providerCode).toBeNull();
    expect(big.cancel).toHaveBeenCalledOnce();
    expect(big.pulls()).toBeLessThan(big.fullChunks);
    expect(vi.getTimerCount()).toBe(0);
    leakFree(err, (err as DiscordError).message);
  });

  it("user fetch classifies an over-cap body as a provider rejection", async () => {
    const big = oversizedBody(CAP * 2, 65536, MEMBER);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => big.response()),
    );
    const err = await identity().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordError);
    expect(err).toMatchObject({ step: "fetch_user", status: 200, kind: "provider_reject" });
    expect(big.cancel).toHaveBeenCalledOnce();
    expect(big.pulls()).toBeLessThan(big.fullChunks);
    expect(vi.getTimerCount()).toBe(0);
    leakFree(err, (err as DiscordError).message);
  });

  it("role lookup fails closed on an over-cap body and logs no body bytes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const big = oversizedBody(CAP * 2, 65536, MEMBER);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => big.response()),
    );
    expect(await roles()).toBeNull();
    expect(big.cancel).toHaveBeenCalledOnce();
    expect(big.pulls()).toBeLessThan(big.fullChunks);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls).toEqual([
      ["moderator recompute lookup returned non-JSON", { guild_id: GUILD }],
    ]);
    expect(vi.getTimerCount()).toBe(0);
    leakFree(warn.mock.calls);
  });

  it("widget probe keeps the facade with a null snapshot on an over-cap body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const big = oversizedBody(CAP * 2, 65536, MEMBER);
    const transport = vi.fn(async () => big.response());
    const widget = createDiscordWidgetHealth({
      fetch: transport as unknown as typeof fetch,
      now: () => 0,
    });
    const pending: Promise<unknown>[] = [];
    // Optimistic verdict: the facade URL answers before the probe settles.
    expect(widget.url(GUILD, (p) => pending.push(p))).toBe(FACADE);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    // 2xx keeps the facade up; the unparseable over-cap payload leaves no snapshot.
    expect(widget.url(GUILD)).toBe(FACADE);
    expect(widget.snapshot(GUILD)).toBeNull();
    expect(big.cancel).toHaveBeenCalledOnce();
    expect(big.pulls()).toBeLessThan(big.fullChunks);
    expect(warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    leakFree(warn.mock.calls, widget.snapshot(GUILD));
  });
});

describe("under-cap upstream bodies keep existing recovery behavior", () => {
  it("token exchange still returns the access token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ access_token: "fixture-access" })),
    );
    expect(await exchange()).toBe("fixture-access");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("user fetch still returns the identity", async () => {
    const user = { id: USER, username: "fixture-name", global_name: null, avatar: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(user)),
    );
    expect(await identity()).toEqual(user);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("role lookup still returns roles without warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ roles: ["1".repeat(18)], joined_at: null })),
    );
    expect(await roles()).toEqual({ roles: ["1".repeat(18)], joinedAt: null });
    expect(warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("widget probe still parses a small presence snapshot", async () => {
    const transport = vi.fn(async () =>
      Response.json({
        name: "TWO",
        presence_count: 3,
        channels: [{ id: "1", name: "voice", position: 0 }],
        members: [{ username: "ada", status: "online" }],
        instant_invite: "https://discord.gg/fixture",
      }),
    );
    const widget = createDiscordWidgetHealth({
      fetch: transport as unknown as typeof fetch,
      now: () => 0,
    });
    const pending: Promise<unknown>[] = [];
    expect(widget.url(GUILD, (p) => pending.push(p))).toBe(FACADE);
    await Promise.all(pending);
    expect(widget.url(GUILD)).toBe(FACADE);
    expect(widget.snapshot(GUILD)).toMatchObject({
      guildId: GUILD,
      name: "TWO",
      presenceCount: 3,
      inviteUrl: "https://discord.gg/fixture",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

function isolatedJourney() {
  const store = createMemorySessionStore(() => Date.now());
  const sql = (async (strings: TemplateStringsArray) => {
    if ((strings[0] ?? "").includes("count(*)")) return [{ n: 0, wait: 1 }];
    return [];
  }) as unknown as Sql;
  const env = {
    APP_URL: "https://example.test",
    DISCORD_CLIENT_ID: "fixture-client",
    DISCORD_CLIENT_SECRET: "fixture-secret",
    DISCORD_GUILD_ID: GUILD,
    DISCORD_BOT_TOKEN: "fixture-bot",
    DISCORD_INVITE_URL: "https://discord.gg/fixture-invite",
    SESSION_SECRET: "fixture signing key ".repeat(3),
    DISCORD_MODERATOR_ROLE_IDS: "1".repeat(18),
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => withThrottleTx(sql) },
  };
  return { env: env as Env };
}

const cookieHeader = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

describe("oversized token body at the journey boundary", () => {
  it.each([
    ["login", "/auth/discord", "/auth/discord/callback", 302, "/?n=signin_failed"],
    ["join", "/join/discord", "/join/callback", 503, null],
  ] as const)(
    "%s keeps its recovery page when the token body is over cap",
    async (_journey, startPath, callbackPath, status, location) => {
      // Route assertions run on real timers: the capped read settles immediately.
      vi.useRealTimers();
      const { env } = isolatedJourney();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const url =
            typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
          calls.push(new URL(url).pathname);
          if (url.endsWith("/oauth2/token")) return oversizedBody(CAP * 2, 65536, TOKEN).response();
          throw new Error("No Discord request is allowed after an over-cap token response");
        }),
      );
      const start = await app.request(startPath, {}, env);
      expect(start.status).toBe(302);
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const res = await app.request(
        `${callbackPath}?code=fixture-code&state=${state}`,
        { headers: { cookie: cookieHeader(start) } },
        env,
      );
      const html = await res.text();
      // The oversized token body stops the journey before any identity lookup.
      expect(calls).toEqual(["/api/v10/oauth2/token"]);
      expect(res.status).toBe(status);
      expect(res.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");
      if (location !== null) expect(res.headers.get("location")).toBe(location);
      else expect(html).toContain("Discord is unreachable");
      expect(error).not.toHaveBeenCalled();
      leakFree(html, [...res.headers], res.headers.getSetCookie(), warn.mock.calls);
    },
  );
});
