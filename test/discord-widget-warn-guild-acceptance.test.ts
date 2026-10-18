// Acceptance: when the Discord widget probe finds the widget unavailable,
// the operator-facing warning must say WHICH guild was probed. A bare status
// or exception with no guild cannot be attributed when more than one guild is
// in play, and the verdict already stores the guild, so both unavailability
// warnings carry it as `guild_id` alongside the existing field. The warning
// stays a bare posture line: no member data, token, probe URL, or response
// body is ever added to either line. Local stub transports only: no request
// leaves the test process.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscordWidgetHealth } from "../src/discord-widget";

const GUILD = "326474832151838730";
const OTHER_GUILD = "999999999999999999";
const BODY_SENTINEL = "upstream-private-body-sentinel";

type Transport = (url: string, init?: RequestInit) => Promise<Response>;

function harness(transport: Transport) {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    return transport(String(input), init);
  });
  const widget = createDiscordWidgetHealth({
    fetch: fetch as typeof globalThis.fetch,
    now: () => 0,
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return {
    calls,
    warn,
    // One verdict read with a background carrier, then settle the probe it
    // scheduled, exactly as the /join page drives the health instance.
    async probe(guildId: string) {
      const pending: Promise<unknown>[] = [];
      const url = widget.url(guildId, (p) => pending.push(p));
      await Promise.all(pending);
      return url;
    },
    // A later read with no carrier: answers from the stored verdict alone.
    verdict(guildId: string) {
      return widget.url(guildId);
    },
  };
}

// The structured payload of one warning call: the object argument, wherever
// it sits among the call arguments. Fails the test if a warning carries no
// structured payload at all.
function warnPayload(warn: ReturnType<typeof vi.spyOn>, index = 0): Record<string, unknown> {
  const call = warn.mock.calls[index] ?? [];
  const payload = call.find(
    (arg: unknown): arg is Record<string, unknown> =>
      typeof arg === "object" && arg !== null && !Array.isArray(arg),
  );
  expect(payload, "warning carries a structured payload object").toBeDefined();
  return payload as Record<string, unknown>;
}

// Neither warning may gain anything beyond the guild: the serialized calls
// must contain no response body, no probe URL, and no credential-shaped text,
// and the payload must hold no URL/body/token/member field.
function expectNoLeaks(warn: ReturnType<typeof vi.spyOn>) {
  const serialized = JSON.stringify(warn.mock.calls);
  expect(serialized).not.toContain(BODY_SENTINEL);
  expect(serialized).not.toContain("discord.com/api");
  expect(serialized).not.toContain("widget.json");
  const payload = warnPayload(warn);
  for (const key of Object.keys(payload)) {
    expect(key).not.toMatch(/url|body|token|secret|member|username|header/i);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Discord widget unavailability warnings carry the guild under test", () => {
  it("non-2xx probe: the warning payload carries guild_id alongside status", async () => {
    const h = harness(async () => new Response(BODY_SENTINEL, { status: 503 }));

    await h.probe(GUILD);

    // Positive control: the real probe ran once, against this guild's widget.
    expect(h.calls).toEqual([`https://discord.com/api/v10/guilds/${GUILD}/widget.json`]);
    expect(h.warn).toHaveBeenCalledOnce();
    expect(warnPayload(h.warn)).toMatchObject({ guild_id: GUILD, status: 503 });
    expectNoLeaks(h.warn);
    // The verdict still degrades exactly as before: no widget URL afterwards.
    expect(h.verdict(GUILD)).toBeNull();
  });

  it("throwing probe: the warning payload carries guild_id alongside exception", async () => {
    const h = harness(async () => {
      throw new TypeError(`fetch failed ${BODY_SENTINEL}`);
    });

    await h.probe(GUILD);

    expect(h.calls).toEqual([`https://discord.com/api/v10/guilds/${GUILD}/widget.json`]);
    expect(h.warn).toHaveBeenCalledOnce();
    const payload = warnPayload(h.warn);
    expect(payload).toMatchObject({ guild_id: GUILD });
    expect(payload).toHaveProperty("exception");
    expectNoLeaks(h.warn);
    expect(h.verdict(GUILD)).toBeNull();
  });

  it("the guild in the warning is the guild actually probed, not a fixed value", async () => {
    const h = harness(async () => new Response(BODY_SENTINEL, { status: 500 }));

    await h.probe(OTHER_GUILD);

    expect(h.calls).toEqual([`https://discord.com/api/v10/guilds/${OTHER_GUILD}/widget.json`]);
    expect(h.warn).toHaveBeenCalledOnce();
    expect(warnPayload(h.warn)).toMatchObject({ guild_id: OTHER_GUILD, status: 500 });
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain(GUILD);
  });

  it("healthy probe: no warning at all, and the widget URL stands (positive control)", async () => {
    const h = harness(async () => Response.json({ id: GUILD, presence_count: 3 }));

    await h.probe(GUILD);

    expect(h.calls).toHaveLength(1);
    expect(h.warn).not.toHaveBeenCalled();
    expect(h.verdict(GUILD)).toContain(GUILD);
  });
});
