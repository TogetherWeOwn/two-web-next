import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addGuildMember, DiscordError, exchangeCode, fetchUser } from "../src/discord";
import { discordFetch, DISCORD_HTTP_BUDGET_MS, DiscordHttpTimeoutError } from "../src/discord-http";
import { fetchMemberRoles, recomputeModerator } from "../src/roles";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, type Sql } from "../src/sessions";

// Inert fixtures only: no real OAuth grants or Discord credentials.
const exchange = () =>
  exchangeCode("fixture-code", "fixture-client", "fixture-secret", "https://example.test/callback");
const identity = () => fetchUser("fixture-access");
const join = () => addGuildMember("fixture-guild", "fixture-user", "fixture-access", "fixture-bot");
const roles = () => fetchMemberRoles("fixture-guild", "fixture-user", "fixture-bot");
const moderator = () =>
  recomputeModerator({
    guildId: "fixture-guild",
    userId: "fixture-user",
    botToken: "fixture-bot",
    moderatorRoleIds: ["fixture-role"],
  });
const BUDGET_MS = DISCORD_HTTP_BUDGET_MS;

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
    DISCORD_GUILD_ID: "fixture-guild",
    DISCORD_BOT_TOKEN: "fixture-bot",
    DISCORD_INVITE_URL: "https://discord.gg/fixture-invite",
    SESSION_SECRET: "fixture signing key ".repeat(3),
    DISCORD_MODERATOR_ROLE_IDS: "1".repeat(18),
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => withThrottleTx(sql) },
  };
  return { store, env: env as Env };
}

const cookieHeader = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function stalledBody(status = 200, cancel = vi.fn()) {
  const body = new ReadableStream<Uint8Array>({ cancel });
  return { body, cancel, response: new Response(body, { status }) };
}

function outcome(promise: Promise<unknown>) {
  let result: { value: unknown } | { error: unknown } | undefined;
  void promise.then(
    (value) => {
      result = { value };
    },
    (error) => {
      result = { error };
    },
  );
  return () => result;
}

describe("Discord auth deadlines", () => {
  it.each([
    ["exchange", exchange],
    ["identity", identity],
    ["join", join],
    ["roles", roles],
  ] as const)(
    "settles %s fetches that ignore cancellation by the operation budget",
    async (name, call) => {
      let signal: AbortSignal | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((_url, init: RequestInit) => {
          signal = init.signal ?? undefined;
          return new Promise<Response>(() => {});
        }),
      );
      const result = outcome(call());
      await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
      expect(result()).toBeUndefined();
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      // Each step keeps its existing taxonomy: exchange/identity wrap the timeout
      // as a transport failure, guild admission degrades to "failed", and the raw
      // role lookup propagates to recomputeModerator's fail-closed catch.
      if (name === "join") expect(result()).toEqual({ value: "failed" });
      else if (name === "roles")
        expect(result()).toEqual({ error: expect.any(DiscordHttpTimeoutError) });
      else {
        expect(result()).toEqual({ error: expect.any(DiscordError) });
        expect((result() as { error: DiscordError }).error.kind).toBe("transport_failure");
      }
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ["exchange JSON", exchange, 200],
    ["identity JSON", identity, 200],
    ["join response", join, 201],
    ["role JSON", roles, 200],
    ["exchange error text", exchange, 400],
    ["identity error text", identity, 503],
  ] as const)("cancels stalled %s consumption after headers", async (name, call, status) => {
    const { body, cancel, response } = stalledBody(status);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const result = outcome(call());
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    if (name.startsWith("join")) expect(result()).toEqual({ value: "failed" });
    else if (name.startsWith("role"))
      expect(result()).toEqual({ error: expect.any(DiscordHttpTimeoutError) });
    else {
      // A timeout alone must never be interpreted as an expired/revoked grant —
      // the unread body's status never reaches the classifier.
      const error = (result() as { error: DiscordError }).error;
      expect(error).toBeInstanceOf(DiscordError);
      expect(error.kind).toBe("transport_failure");
      expect(error.status).toBe(0);
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("denies moderator privileges when the role body stalls", async () => {
    const { body, cancel, response } = stalledBody();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const result = outcome(moderator());
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(result()).toEqual({ value: false });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reset the deadline at headers or after partial body progress", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        streamController = c;
      },
      cancel,
    });
    let deliver!: (res: Response) => void;
    const transport = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          deliver = resolve;
        }),
    );
    const result = outcome(discordFetch("https://example.test", {}, transport));
    await vi.advanceTimersByTimeAsync(BUDGET_MS - 100);
    deliver(new Response(body));
    streamController.enqueue(new TextEncoder().encode("{"));
    await vi.advanceTimersByTimeAsync(99);
    expect(result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result()).toEqual({ error: expect.any(DiscordHttpTimeoutError) });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up headers that arrive after a non-cooperative fetch timed out", async () => {
    let deliver!: (res: Response) => void;
    const transport = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          deliver = resolve;
        }),
    );
    const result = outcome(discordFetch("https://example.test", {}, transport));
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(result()).toEqual({ error: expect.any(DiscordHttpTimeoutError) });
    const { body, cancel, response } = stalledBody();
    deliver(response);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles even if a stream cancellation hook itself never resolves", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const { body, response } = stalledBody(200, cancel);
    const result = outcome(
      discordFetch(
        "https://example.test",
        {},
        vi.fn(async () => response),
      ),
    );
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(result()).toEqual({ error: expect.any(DiscordHttpTimeoutError) });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains a body read error as an empty body with the real status", async () => {
    // Provider-rejection contract (PR #144/#206): once headers arrived, an
    // unreadable body is Discord's failure, not a transport outage. The raw
    // error (which can quote provider text) never escapes the helper.
    const failure = new Error("fixture read failure");
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(failure);
      },
    });
    const res = await discordFetch(
      "https://example.test",
      {},
      vi.fn(async () => new Response(body, { status: 207, statusText: "Multi" })),
    );
    expect(res.status).toBe(207);
    expect(res.statusText).toBe("Multi");
    expect(await res.text()).toBe("");
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("classifies an unreadable token-success body as a provider rejection", async () => {
    const failure = new Error("fixture read failure");
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(failure);
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    await expect(exchange()).rejects.toMatchObject({
      step: "token_exchange",
      status: 200,
      kind: "provider_reject",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns the timeout error when the transport honors abort", async () => {
    const transport = vi.fn(
      (_url, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new Error("fixture abort")), {
            once: true,
          });
        }),
    );
    const result = outcome(discordFetch("https://example.test", {}, transport));
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(result()).toEqual({ error: expect.any(DiscordHttpTimeoutError) });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer after a synchronous transport error", async () => {
    const failure = new Error("fixture transport failure");
    await expect(
      discordFetch(
        "https://example.test",
        {},
        vi.fn(() => {
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves healthy payloads, request admission and status-based failures", async () => {
    const user = { id: "fixture-user", username: "fixture-name", global_name: null, avatar: null };
    const transport = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: "fixture-access" }))
      .mockResolvedValueOnce(Response.json(user))
      .mockResolvedValueOnce(new Response("{}", { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("{}", { status: 403 }))
      .mockResolvedValueOnce(Response.json({ roles: ["fixture-role"], joined_at: null }))
      .mockResolvedValueOnce(new Response("{}", { status: 404 }))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", transport);
    expect(await exchange()).toBe("fixture-access");
    expect(await identity()).toEqual(user);
    expect(await join()).toBe("joined");
    expect(await join()).toBe("already_member");
    expect(await join()).toBe("failed");
    expect(await moderator()).toBe(true);
    expect(await roles()).toBeNull();
    await expect(exchange()).rejects.toMatchObject({
      step: "token_exchange",
      status: 503,
      kind: "provider_outage",
    });
    expect(transport.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      signal: expect.any(AbortSignal),
    });
    expect(transport.mock.calls[0]![1].body.get("grant_type")).toBe("authorization_code");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    for (const [, init] of transport.mock.calls) expect(init.signal.aborted).toBe(false);
  });

  it("leaves no abort listeners, and preserves split UTF-8 text and response metadata", async () => {
    const addListener = vi.spyOn(AbortSignal.prototype, "addEventListener");
    const encoded = new TextEncoder().encode('{"name":"café"}');
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoded.slice(0, 13));
        c.enqueue(encoded.slice(13));
        c.close();
      },
    });
    const response = await discordFetch(
      "https://example.test",
      {},
      vi.fn(
        async () =>
          new Response(body, {
            status: 202,
            statusText: "Accepted",
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    expect(await response.json()).toEqual({ name: "café" });
    expect(response.status).toBe(202);
    expect(response.statusText).toBe("Accepted");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(body.locked).toBe(false);
    expect(addListener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps malformed bodies classified and blank role allowlists fail-closed", async () => {
    const transport = vi.fn(async () => new Response("not JSON"));
    vi.stubGlobal("fetch", transport);
    // PR #144 contract: unreadable/malformed bodies are provider rejections,
    // never raw parser errors escaping to the route.
    await expect(exchange()).rejects.toMatchObject({
      step: "token_exchange",
      kind: "provider_reject",
    });
    await expect(identity()).rejects.toMatchObject({ step: "fetch_user", kind: "provider_reject" });
    expect(await moderator()).toBe(false);
    expect(
      await recomputeModerator({
        guildId: "fixture-guild",
        userId: "fixture-user",
        botToken: "fixture-bot",
        moderatorRoleIds: [],
      }),
    ).toBe(false);
    expect(transport).toHaveBeenCalledTimes(3);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({})),
    );
    await expect(exchange()).rejects.toBeInstanceOf(DiscordError);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("deadline recovery at the existing journey boundaries", () => {
  it.each([
    ["auth", "exchange"],
    ["auth", "identity"],
    ["auth", "join"],
    ["auth", "roles"],
    ["join", "exchange"],
    ["join", "identity"],
    ["join", "join"],
    ["join", "roles"],
  ] as const)("keeps %s recovery/degradation when %s stalls", async (journey, step) => {
    const { store, env } = isolatedJourney();
    const log = [
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
    ];
    const user = { id: "fixture-user", username: "fixture-name", global_name: null, avatar: null };
    const { response, cancel } = stalledBody(step === "join" ? 201 : 200);
    let started!: () => void;
    const reachedStall = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const endpoint = url.endsWith("/oauth2/token")
          ? "exchange"
          : url.endsWith("/users/@me")
            ? "identity"
            : init.method === "PUT"
              ? "join"
              : "roles";
        if (endpoint === step) {
          started();
          return response;
        }
        if (endpoint === "exchange") return Response.json({ access_token: "fixture-access" });
        if (endpoint === "identity") return Response.json(user);
        if (endpoint === "join") return new Response(null, { status: 204 });
        return Response.json({ roles: ["1".repeat(18)] });
      }),
    );
    const startPath = journey === "auth" ? "/auth/discord" : "/join/discord";
    const callbackPath = journey === "auth" ? "/auth/discord/callback" : "/join/callback";
    const start = await app.request(startPath, {}, env);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const pending = app.request(
      `${callbackPath}?code=fixture-code&state=${state}`,
      { headers: { cookie: cookieHeader(start) } },
      env,
    );
    await reachedStall;
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    const result = await pending;
    expect(cancel).toHaveBeenCalledOnce();
    const sessionCookie = result.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-two_session="));
    if (step === "exchange" || step === "identity") {
      expect(sessionCookie).toBeUndefined();
      expect(result.status).toBe(journey === "auth" ? 302 : 503);
      // Transport failure is an outage: retry in a minute, never "you cancelled".
      if (journey === "auth") expect(result.headers.get("location")).toBe("/?n=signin_unavailable");
      else expect(await result.text()).toContain("Discord is unreachable");
    } else if (step === "join" && journey === "join") {
      expect(result.status).toBe(200);
      expect(sessionCookie).toBeUndefined();
    } else {
      expect(result.status).toBe(302);
      expect(sessionCookie).toBeDefined();
      const token = decodeURIComponent(
        sessionCookie!.split(";")[0]!.slice("__Host-two_session=".length),
      ).split(".")[0]!;
      expect(await store.get(await hashToken(token))).toMatchObject({
        member: step !== "join",
        moderator: step === "join",
      });
      if (step === "join") expect(result.headers.get("location")).toBe("/?n=join_failed");
    }
    const logged = JSON.stringify(log.map((spy) => spy.mock.calls));
    expect(logged).not.toMatch(/fixture-(access|bot|secret|code)/);
    expect(vi.getTimerCount()).toBe(0);
  });
});
