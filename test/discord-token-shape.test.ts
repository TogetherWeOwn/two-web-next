import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { DiscordError, exchangeCode, failureMeta } from "../src/discord";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import type { Env } from "../src/env";
import type { EnvWithJoin } from "../src/join/route";

const TOKEN = "***synthetic-token-shape***";
const SECRET = "***synthetic-secret-shape***";
const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: SECRET,
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: "508654771276873729",
};
const exchange = () => exchangeCode("code", "client-id", SECRET, `${env.APP_URL}/auth/discord/callback`);
const rejectedMeta = { exception: "DiscordError", kind: "provider_reject", status: 200 };

// Fresh bodies for every exchange: parsing consumes the response stream.
const malformedAnswers: [string, () => Response][] = [
  ["null envelope", () => Response.json(null)],
  ["array envelope", () => Response.json([{ access_token: TOKEN }])],
  ["empty array envelope", () => Response.json([])],
  ["string envelope", () => Response.json(TOKEN)],
  ["numeric envelope", () => Response.json(123)],
  ["boolean envelope", () => Response.json(true)],
  ["missing token", () => Response.json({ diagnostic: SECRET })],
  ["empty token", () => Response.json({ access_token: "" })],
  ["null token", () => Response.json({ access_token: null })],
  ["numeric token", () => Response.json({ access_token: 123 })],
  ["zero token", () => Response.json({ access_token: 0 })],
  ["true token", () => Response.json({ access_token: true })],
  ["false token", () => Response.json({ access_token: false })],
  ["object token", () => Response.json({ access_token: { diagnostic: TOKEN } })],
  ["array token", () => Response.json({ access_token: [TOKEN] })],
  ["invalid JSON", () => new Response(`not JSON ${TOKEN} ${SECRET}`)],
  ["body-read failure", () => new Response(new ReadableStream({
    start(controller) {
      controller.error(new Error(`read failed ${TOKEN}`, { cause: new Error(SECRET) }));
    },
  }))],
];

function leakFree(...surfaces: unknown[]) {
  const text = surfaces.map((s) => JSON.stringify(s) ?? String(s)).join("\n");
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(SECRET);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("successful Discord token response admission", () => {
  it.each(malformedAnswers)("rejects %s through bounded token-exchange recovery", async (_name, answer) => {
    vi.stubGlobal("fetch", vi.fn(async () => answer()));
    const err = await exchange().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordError);
    const discordError = err as DiscordError;
    expect(failureMeta(discordError)).toEqual(rejectedMeta);
    expect(discordError.step).toBe("token_exchange");
    expect(discordError.message).toBe("discord token_exchange failed with HTTP 200");
    expect(discordError.providerCode).toBeNull();
    expect(discordError.cause).toBeUndefined();
    leakFree(discordError, discordError.message);
  });

  it.each([TOKEN, ` ${TOKEN} `, " "])("returns a nonempty string exactly, without coercion or trimming", async (token) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: token, token_type: "Bearer" })));
    expect(await exchange()).toBe(token);
  });

  it.each([
    [400, "expired_grant", "invalid_grant"],
    [401, "provider_reject", "invalid_grant"],
    [403, "provider_reject", "invalid_grant"],
    [429, "rate_limited", null],
    [503, "provider_outage", null],
  ] as const)("preserves HTTP %i classification before shape validation", async (status, kind, providerCode) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: "invalid_grant", access_token: TOKEN, error_description: SECRET,
    }, { status })));
    const err = await exchange().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordError);
    expect(err).toMatchObject({ step: "token_exchange", status, kind, providerCode });
    leakFree(err, (err as DiscordError).message);
  });

  it("preserves transport failure without retaining its message or cause", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError(`fetch failed ${TOKEN}`, { cause: new Error(SECRET) });
    }));
    const err = await exchange().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordError);
    expect(err).toMatchObject({ step: "token_exchange", status: 0, kind: "transport_failure", providerCode: null });
    expect((err as DiscordError).cause).toBeUndefined();
    leakFree(err, (err as DiscordError).message);
  });
});

function isolatedJourney() {
  const attempts: unknown[][] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head.includes("count(*)")) return [{ n: 0, wait: 1 }];
    if (head.includes("web_throttle_hits")) return [];
    if (head.includes("INSERT INTO join_attempts")) {
      attempts.push(values);
      return [];
    }
    throw new Error("Unexpected journey SQL");
  }) as unknown as Sql;
  sql.unsafe = async () => [];
  const store = createMemorySessionStore();
  const create = vi.spyOn(store, "create");
  const rotate = vi.spyOn(store, "rotate");
  const roster = vi.fn(async () => []);
  const e = {
    ...env,
    SESSION_STORE: store,
    ROSTER_STORE: roster as unknown as Sql,
    JOIN_DEPS: { store: async () => sql },
  } as unknown as EnvWithJoin;
  return { env: e, create, rotate, roster, attempts };
}

const journeys = [
  { name: "login", start: "/auth/discord", callback: "/auth/discord/callback" },
  { name: "join", start: "/join/discord", callback: "/join/callback" },
] as const;

for (const journey of journeys) {
  describe(`${journey.name} callback stops after a malformed token success`, () => {
    it.each(malformedAnswers)("contains %s without identity lookup or persistence", async (_name, answer) => {
      const isolated = isolatedJourney();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const calls: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
        calls.push(new URL(url).pathname);
        if (url.endsWith("/oauth2/token")) return answer();
        throw new Error("No Discord request is allowed after a malformed token response");
      }));
      const start = await app.request(journey.start, {}, isolated.env);
      expect(start.status).toBe(302);
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const cookie = start.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      const res = await app.request(`${journey.callback}?code=abc&state=${state}`, {
        headers: { cookie },
      }, isolated.env);
      const html = await res.text();

      expect(calls).toEqual(["/api/v10/oauth2/token"]);
      expect(isolated.create).not.toHaveBeenCalled();
      expect(isolated.rotate).not.toHaveBeenCalled();
      expect(isolated.roster).not.toHaveBeenCalled();
      expect(res.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");
      expect(error).not.toHaveBeenCalled();
      if (journey.name === "login") {
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/?n=signin_failed");
        expect(warn.mock.calls).toEqual([["discord sign-in failed", rejectedMeta]]);
        expect(isolated.attempts).toEqual([]);
      } else {
        expect(res.status).toBe(503);
        expect(html).toContain("Discord is unreachable");
        expect(html).not.toContain("approval expired");
        expect(warn.mock.calls).toEqual([["discord token exchange failed on the join journey", {
          ...rejectedMeta, source: null, outcome: "error",
        }]]);
        expect(isolated.attempts).toEqual([["error", null, null, null]]);
      }
      leakFree(html, [...res.headers], res.headers.getSetCookie(), warn.mock.calls, error.mock.calls, isolated.attempts);
    });
  });
}
