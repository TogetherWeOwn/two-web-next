// Acceptance: oversized provider identity fields from Discord
// `/users/@me` fail both OAuth callbacks into their existing generic
// failure outcome BEFORE any session or roster write, and fields at
// exactly the cap still sign in.
// route-inventory: GET /auth/discord/callback
// route-inventory: GET /join/callback
//
// The documented bounds are display-name/username <= 128 characters and
// avatar <= 512 characters. This suite pins one-over as refused and
// at-cap as accepted for each field (ASCII keeps character-vs-byte
// counting out of scope), plus a 100 KiB username — the size a hostile
// or broken provider payload could actually carry under the transport
// body cap. Refusal must be a rejection, never a silent truncation: the
// oversized cases assert no session cookie, no session-store
// create/replace, and no roster (`users`) statement at all, and that
// Discord traffic stops after `/users/@me` (no guild-member read or join
// mutation follows a rejected identity). No provider response bytes,
// tokens or PII may reach the logs or the failure surface: every
// oversized value carries a distinctive marker, and the captured console
// output, response body and redirect target must contain neither the
// marker nor any fixture credential. The generic failure surface is
// each flow's existing provider-reject outcome: login redirects to
// `/?n=signin_failed`; join serves the 503 "Discord is unreachable"
// page. Hermetic: memory session store, in-memory roster double,
// stubbed fetch — no live Discord, database, or secrets.
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, type Sql } from "../src/sessions";

const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "fixture-client",
  DISCORD_CLIENT_SECRET: "fixture-secret",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_BOT_TOKEN: "fixture-bot",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: "",
};

/** A `length`-character value starting with a greppable marker. */
const sized = (marker: string, fill: string, length: number) =>
  marker + fill.repeat(length - marker.length);

const AT_CAP = "u".repeat(128);
const OVER_CAP = sized("oversized-username-marker", "u", 129);
const HUGE = sized("oversized-username-marker", "u", 100 * 1024);
const GLOBAL_AT_CAP = "g".repeat(128);
const GLOBAL_OVER_CAP = sized("oversized-display-name-marker", "g", 129);
const AVATAR_AT_CAP = "a".repeat(512);
const AVATAR_OVER_CAP = sized("oversized-avatar-marker", "a", 513);
const NORMAL = "fixturemember";

const FORBIDDEN_IN_LOGS = [
  "oversized-username-marker",
  "oversized-display-name-marker",
  "oversized-avatar-marker",
  "fixture-access-token",
  "fixture-secret",
  "fixture-bot",
  "test-session-secret-at-least-32-bytes-long",
];

const flows = ["auth", "join"] as const;
type Flow = (typeof flows)[number];
const startPath = (flow: Flow) => (flow === "auth" ? "/auth/discord" : "/join/discord");
const callbackPath = (flow: Flow) =>
  flow === "auth" ? "/auth/discord/callback" : "/join/callback";

const cookieJar = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
const sessionCookie = (res: Response) =>
  res.headers.getSetCookie().find((c) => c.startsWith("__Host-two_session="));

type Profile = { id: string; username: string; global_name: string | null; avatar: string | null };

function mockDiscord(overrides: Partial<Profile>) {
  const profile: Profile = {
    id: "42",
    username: NORMAL,
    global_name: null,
    avatar: "ava-1",
    ...overrides,
  };
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith("/oauth2/token"))
        return Response.json({ access_token: "fixture-access-token" });
      if (url.endsWith("/users/@me")) return Response.json(profile);
      if (url.includes("/members/42") && init?.method === "PUT")
        return new Response(null, { status: 204 });
      if (url.includes("/members/42"))
        return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
      throw new Error("Unexpected network request in identity-length fixture");
    }),
  );
  return calls;
}

// In-memory Sql double for the roster upsert. Understands exactly the
// statement the roster write emits; anything else is a test bug.
function fakeRoster() {
  const rows = new Map<
    string,
    { id: string; username: string; avatar: string | null; member: boolean }
  >();
  const statements: string[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    statements.push(strings.join("?"));
    if (head.includes("INSERT INTO users")) {
      const [id, username, avatar, member] = values as [string, string, string | null, boolean];
      rows.set(id, { id, username, avatar, member });
      return [];
    }
    throw new Error(`fakeRoster: unexpected statement: ${head.slice(0, 80)}`);
  }) as unknown as Sql;
  (sql as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  return { sql, rows, statements };
}

function fixture() {
  const store = createMemorySessionStore(() => Date.now());
  const roster = fakeRoster();
  const fake = (async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("count(*)")) return [{ n: 0, wait: 1 }];
    if (query.includes("INSERT INTO join_attempts")) return [];
    if (query.includes("web_throttle_hits")) return [];
    throw new Error("Unexpected SQL in identity-length fixture");
  }) as unknown as Sql;
  (fake as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  const create = vi.fn(store.create);
  const replace = vi.fn(store.replace);
  const env = {
    ...baseEnv,
    SESSION_STORE: { ...store, create, replace },
    ROSTER_STORE: roster.sql,
    JOIN_DEPS: { store: async () => withThrottleTx(fake) },
  } as Env;
  return { env, store, roster, create, replace };
}

/** Capture every console line the flows emit, serialized for marker scans. */
function captureLogs() {
  const lines: string[] = [];
  const serialize = (args: unknown[]) =>
    args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        if (arg instanceof Error) return `${arg.message} ${arg.stack ?? ""}`;
        try {
          return JSON.stringify(arg) ?? String(arg);
        } catch {
          return String(arg);
        }
      })
      .join(" ");
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(serialize(args));
    });
  }
  return () => lines.join("\n");
}

async function runCallback(flow: Flow, overrides: Partial<Profile>) {
  const logs = captureLogs();
  const f = fixture();
  const startRes = await app.request(startPath(flow), {}, f.env);
  expect(startRes.status).toBe(302);
  const state = new URL(startRes.headers.get("location")!).searchParams.get("state")!;
  const calls = mockDiscord(overrides);
  const res = await app.request(
    `${callbackPath(flow)}?code=fixture-code&state=${state}`,
    { headers: { cookie: cookieJar(startRes) } },
    f.env,
  );
  return { f, calls, res, logs };
}

/** The existing provider-reject surface each flow already uses. */
async function expectGenericFailure(flow: Flow, res: Response) {
  expect(sessionCookie(res)).toBeUndefined();
  const body = await res.text();
  if (flow === "auth") {
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
  } else {
    expect(res.status).toBe(503);
    expect(body).toContain("Discord is unreachable");
  }
  return body;
}

async function sessionRowFor(f: ReturnType<typeof fixture>, res: Response) {
  const cookie = sessionCookie(res);
  expect(cookie).toBeDefined();
  const signed = decodeURIComponent(cookie!.split(";")[0]!.split("=")[1]!);
  return f.store.get(await hashToken(signed.split(".")[0]!));
}

describe("Discord identity field lengths are bounded before session and roster writes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // One oversized field at a time, so a bound missing for any single
  // field fails on its own. The username cases keep `global_name` null
  // and the display-name case keeps a normal `username`, so the
  // effective identity is unambiguous in every row.
  const oversized: { label: string; overrides: Partial<Profile> }[] = [
    { label: "a 129-character provider username", overrides: { username: OVER_CAP } },
    { label: "a 100 KiB provider username", overrides: { username: HUGE } },
    { label: "a 129-character provider display name", overrides: { global_name: GLOBAL_OVER_CAP } },
    { label: "a 513-character provider avatar", overrides: { avatar: AVATAR_OVER_CAP } },
  ];

  for (const flow of flows) {
    it.each(oversized)(`${flow}: $label writes no session or roster row`, async ({ overrides }) => {
      const { f, calls, res, logs } = await runCallback(flow, overrides);
      const body = await expectGenericFailure(flow, res);
      expect(f.create).not.toHaveBeenCalled();
      expect(f.replace).not.toHaveBeenCalled();
      expect(f.roster.rows.size).toBe(0);
      expect(f.roster.statements).toEqual([]);
      // Identity is rejected at the profile read: no guild-member lookup or
      // join mutation may follow it.
      expect(calls.map((url) => new URL(url).pathname)).toEqual([
        "/api/v10/oauth2/token",
        "/api/v10/users/@me",
      ]);
      // No provider bytes, tokens or PII on any observable surface.
      const captured = logs();
      for (const forbidden of FORBIDDEN_IN_LOGS) {
        expect(captured).not.toContain(forbidden);
        expect(body).not.toContain(forbidden);
        expect(res.headers.get("location") ?? "").not.toContain(forbidden);
      }
    });
  }

  it.each(flows)("%s: a username at exactly the 128-character cap signs in", async (flow) => {
    const { f, res } = await runCallback(flow, { username: AT_CAP });
    expect(sessionCookie(res)).toBeDefined();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.roster.rows.get("42")).toEqual({
      id: "42",
      username: AT_CAP,
      avatar: "ava-1",
      member: true,
    });
    const row = await sessionRowFor(f, res);
    expect(row?.username).toBe(AT_CAP);
  });

  it.each(flows)("%s: a display name at exactly the 128-character cap signs in", async (flow) => {
    const { f, res } = await runCallback(flow, { global_name: GLOBAL_AT_CAP });
    expect(sessionCookie(res)).toBeDefined();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.roster.rows.get("42")).toEqual({
      id: "42",
      username: GLOBAL_AT_CAP,
      avatar: "ava-1",
      member: true,
    });
  });

  it.each(flows)("%s: an avatar at exactly the 512-character cap signs in", async (flow) => {
    const { f, res } = await runCallback(flow, { avatar: AVATAR_AT_CAP });
    expect(sessionCookie(res)).toBeDefined();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.roster.rows.get("42")).toEqual({
      id: "42",
      username: NORMAL,
      avatar: AVATAR_AT_CAP,
      member: true,
    });
  });

  it.each(flows)("%s: a normal-length provider username still signs in", async (flow) => {
    const { f, res } = await runCallback(flow, { username: NORMAL });
    expect(sessionCookie(res)).toBeDefined();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.roster.rows.get("42")).toEqual({
      id: "42",
      username: NORMAL,
      avatar: "ava-1",
      member: true,
    });
  });
});
