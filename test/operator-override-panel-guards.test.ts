// Builder-owned guards for the operator override panel. They pin the fail-closed
// branches, the producer-contract limits, record fidelity, the staleness wording and the
// pre-authentication attempt cap that the Test Author acceptance suites do not reach.
// Each case is written so that removing the guard it names turns it red.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";

const ORIGIN = "https://next.example.test";
const TOKEN = "operator-override-guards-".padEnd(32, "x");
const MAX_BODY = 256 * 1024;

type Map = Record<string, string>;
const record = (patch: Record<string, unknown> = {}) => ({
  epoch: 7,
  overrides: { TWO_AUTOMOD_MENTION_LIMIT: "3" } as Map,
  baseline: { TWO_AUTOMOD_MENTION_LIMIT: "5" } as Map,
  enforcement: "pending",
  ...patch,
});

const bindings = (patch: Record<string, unknown> = {}): Env =>
  ({
    APP_URL: ORIGIN,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    SESSION_STORE: createMemorySessionStore(),
    BOT_ENDPOINT_URL: "https://bot.example.test/internal-action",
    OPS_CONTROL_TOKEN: TOKEN,
    ...patch,
  }) as Env;

// The attempt cap is per client and per isolate, so every case reads as its own client.
let nextClient = 1;
const freshClient = () => {
  const n = nextClient++;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
};

function installFetch(body: () => unknown = () => record()) {
  const stub = vi.fn<typeof fetch>(async () => Response.json(body()));
  vi.stubGlobal("fetch", stub);
  return stub;
}

const read = (
  client: string,
  authorization: string | null = `Bearer ${TOKEN}`,
  patch: Record<string, unknown> = {},
  path = "/admin/ops-overrides",
) =>
  app.request(
    path,
    {
      headers: {
        origin: ORIGIN,
        "cf-connecting-ip": client,
        ...(authorization === null ? {} : { authorization }),
      },
    },
    bindings(patch),
  );

const withRecord = async (payload: unknown, client = freshClient()) => {
  installFetch(() => payload);
  const res = await read(client);
  return { res, html: await res.text() };
};

beforeEach(() => {
  for (const method of ["log", "warn", "info", "error"] as const)
    vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("record schema limits", () => {
  const entries = (count: number): Map =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`K${i}`, "v"]));

  it.each(["overrides", "baseline"])("accepts 256 %s entries and refuses 257", async (field) => {
    const ok = await withRecord(record({ [field]: entries(256) }));
    expect(ok.res.status).toBe(200);
    const over = await withRecord(record({ [field]: entries(257) }));
    expect(over.res.status).toBe(503);
    expect(over.html).not.toContain("K0");
  });

  it.each(["overrides", "baseline"])("bounds %s keys to 1..128 characters", async (field) => {
    const edge = await withRecord(record({ [field]: { ["K".repeat(128)]: "v" } }));
    expect(edge.res.status).toBe(200);
    for (const key of ["", "K".repeat(129)]) {
      const refused = await withRecord(record({ [field]: { [key]: "v" } }));
      expect(refused.res.status).toBe(503);
    }
  });

  it("caps an override value at the 4096 characters the bot stores", async () => {
    expect((await withRecord(record({ overrides: { K: "v".repeat(4096) } }))).res.status).toBe(200);
    expect((await withRecord(record({ overrides: { K: "v".repeat(4097) } }))).res.status).toBe(503);
  });

  it("accepts a boot baseline above 4096 characters, up to the 5 KB platform limit", async () => {
    const spaced = `[${" ".repeat(4095)}]`;
    expect(spaced).toHaveLength(4097);
    const ok = await withRecord(record({ baseline: { TWO_SELF_ROLE_PANELS: spaced } }));
    expect(ok.res.status).toBe(200);
    expect(ok.html).toContain("TWO_SELF_ROLE_PANELS");
    expect((await withRecord(record({ baseline: { K: "v".repeat(5120) } }))).res.status).toBe(200);
    expect((await withRecord(record({ baseline: { K: "v".repeat(5121) } }))).res.status).toBe(503);
  });

  it("bounds enforcement to 1..128 characters", async () => {
    expect((await withRecord(record({ enforcement: "e".repeat(128) }))).res.status).toBe(200);
    for (const enforcement of ["", "e".repeat(129)])
      expect((await withRecord(record({ enforcement }))).res.status).toBe(503);
  });

  it("keeps the whole record inside the shared byte cap", () => {
    // 256 baseline entries at the value limit exceed the reader cap, so the cap, not
    // the per-entry limits, is what bounds the aggregate.
    expect(256 * 5120).toBeGreaterThan(MAX_BODY);
  });
});

describe("record fidelity", () => {
  const row = (html: string, key: string) =>
    html.match(new RegExp(`<tr><th scope="row"><code>${key}</code></th>.*?</tr>`))?.[0] ?? "";

  it("tells a leading-space value from its trimmed twin", async () => {
    const spaced = await withRecord(record({ overrides: { TWO_AUTOMOD_ENFORCE: " 1" } }));
    const exact = await withRecord(record({ overrides: { TWO_AUTOMOD_ENFORCE: "1" } }));
    expect(row(spaced.html, "TWO_AUTOMOD_ENFORCE")).toContain("<code>&quot; 1&quot;</code>");
    expect(row(exact.html, "TWO_AUTOMOD_ENFORCE")).toContain("<code>&quot;1&quot;</code>");
    expect(row(spaced.html, "TWO_AUTOMOD_ENFORCE")).not.toBe(
      row(exact.html, "TWO_AUTOMOD_ENFORCE"),
    );
  });

  it("keeps an absent key distinct from the literal 'Not set' and from an empty value", async () => {
    const baseline = { TWO_AUTOMOD_BAD_WORDS: "w", TWO_AUTOMOD_MENTION_LIMIT: "5" };
    const absent = await withRecord(
      record({ overrides: { TWO_AUTOMOD_MENTION_LIMIT: "3" }, baseline }),
    );
    const literal = await withRecord(
      record({
        overrides: { TWO_AUTOMOD_MENTION_LIMIT: "3", TWO_AUTOMOD_BAD_WORDS: "Not set" },
        baseline,
      }),
    );
    const empty = await withRecord(
      record({
        overrides: { TWO_AUTOMOD_MENTION_LIMIT: "3", TWO_AUTOMOD_BAD_WORDS: "" },
        baseline,
      }),
    );
    const cells = [absent, literal, empty].map((r) => row(r.html, "TWO_AUTOMOD_BAD_WORDS"));
    expect(cells[0]).toContain("<em>not set</em>");
    expect(cells[1]).toContain("<code>&quot;Not set&quot;</code>");
    expect(cells[2]).toContain("<code>&quot;&quot;</code>");
    expect(new Set(cells).size).toBe(3);
    expect(absent.html).not.toBe(literal.html);
  });

  it("marks a baseline key the bot did not report, the same way for both columns", async () => {
    const { html } = await withRecord(
      record({ overrides: { ONLY_OVERRIDE: "1" }, baseline: { ONLY_BASELINE: "2" } }),
    );
    expect(row(html, "ONLY_OVERRIDE")).toContain("<em>not reported</em>");
    expect(row(html, "ONLY_BASELINE")).toContain("<em>not set</em>");
  });

  it("spells out controls and invisible characters instead of rendering them", async () => {
    const { html } = await withRecord(
      record({ baseline: { K: "a\tb\u200bc\u202ed\u0085e\\f", L: "x\u007fy" } }),
    );
    expect(html).toContain("&quot;a\\tb\\u200bc\\u202ed\\u0085e\\\\f&quot;");
    expect(html).toContain("&quot;x\\u007fy&quot;");
    expect(html).not.toMatch(/[\u200b\u202e\u0085\u007f]/);
  });

  it("loads a stylesheet that preserves whitespace inside stored values", () => {
    const css = readFileSync("public/operator-overrides-theme.css", "utf8");
    expect(css).toMatch(/\.ops-overrides td code\s*\{[^}]*white-space:\s*pre-wrap/);
  });
});

describe("staleness wording", () => {
  it("does not promise polling or a hard 300-second fallback", async () => {
    const { html } = await withRecord(record());
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toMatch(/polling is configured separately/i);
    expect(text).toMatch(/cannot show whether it is on/i);
    expect(text).toMatch(
      /last-good limit of 300 seconds is checked only when a later poll completes/i,
    );
    expect(text).toMatch(/can stay in effect longer/i);
    expect(text).not.toMatch(/at most 300|Runtime polls every 15 seconds/i);
  });

  it("states the same limits in the operator guide", () => {
    const guide = readFileSync("docs/operator-overrides.md", "utf8").replace(/\s+/g, " ");
    expect(guide).toMatch(/checked only when a later poll completes/i);
    expect(guide).toMatch(/polling is (?:separately )?configured/i);
    expect(guide).not.toMatch(/at most 300 seconds/i);
  });
});

describe("fail-closed configuration and URL guards", () => {
  it("keeps the route dark for a configured token with surrounding whitespace", async () => {
    const spaced = ` ${TOKEN.slice(1)}`;
    expect(spaced).toHaveLength(32);
    const fetched = installFetch();
    const res = await read(freshClient(), `Bearer ${spaced}`, { OPS_CONTROL_TOKEN: spaced });
    expect(res.status).toBe(404);
    expect(fetched).not.toHaveBeenCalled();
    expect(await res.text()).not.toContain("TWO_AUTOMOD");
  });

  it("refuses a bare trailing question mark even with the right bearer", async () => {
    const fetched = installFetch();
    const res = await read(freshClient(), `Bearer ${TOKEN}`, {}, "/admin/ops-overrides?");
    expect(res.status).toBe(400);
    expect(fetched).not.toHaveBeenCalled();
    expect(await res.text()).not.toContain("TWO_AUTOMOD");
  });
});

describe("pre-authentication attempt cap", () => {
  const WRONG = `Bearer ${TOKEN.slice(0, -1)}z`;

  it("refuses the eleventh rejected guess before comparing, without upstream contact", async () => {
    const fetched = installFetch();
    const client = freshClient();
    for (let i = 0; i < 10; i++) expect((await read(client, WRONG)).status).toBe(401);
    const limited = await read(client, WRONG);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get("cache-control")).toBe("private, no-store");
    expect(await limited.text()).not.toContain("TWO_AUTOMOD");
    // The cap is pre-authentication: even the right bearer waits for a token.
    expect((await read(client)).status).toBe(429);
    expect(fetched).not.toHaveBeenCalled();
  });

  it("returns tokens over time and scopes the cap to one client", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T12:00:00.000Z"));
    const fetched = installFetch();
    const client = freshClient();
    for (let i = 0; i < 10; i++) await read(client, WRONG);
    expect((await read(client, WRONG)).status).toBe(429);
    expect((await read(freshClient())).status).toBe(200);
    vi.setSystemTime(new Date("2026-10-28T12:00:02.000Z"));
    expect((await read(client)).status).toBe(200);
    expect(fetched).toHaveBeenCalledTimes(2);
  });

  it("does not charge accepted reads or requests that present no bearer value", async () => {
    installFetch();
    const client = freshClient();
    for (let i = 0; i < 25; i++) expect((await read(client)).status).toBe(200);
    for (const authorization of [null, "", "Bearer ", `Basic ${TOKEN}`, `bearer ${TOKEN}`]) {
      for (let i = 0; i < 4; i++) expect((await read(client, authorization)).status).toBe(401);
    }
    expect((await read(client)).status).toBe(200);
  });

  it("keeps its per-client state bounded", async () => {
    installFetch();
    const first = freshClient();
    for (let i = 0; i < 10; i++) await read(first, WRONG);
    expect((await read(first, WRONG)).status).toBe(429);
    // 1024 other clients evict the oldest state; the first client starts fresh.
    for (let i = 0; i < 1030; i++) await read(freshClient(), WRONG);
    expect((await read(first, WRONG)).status).toBe(401);
  });
});
