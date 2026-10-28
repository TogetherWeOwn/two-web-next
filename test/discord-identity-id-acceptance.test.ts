// Acceptance: a hostile provider identity id from Discord
// `/users/@me` never reaches a primary key. Oversized (more than 20
// digits) or non-snowflake (not decimal digits only) `id` values fail
// both OAuth callbacks into their existing generic failure outcome
// BEFORE any session, roster, or `discord_id` write can carry the
// value, and an id of at most 20 decimal digits still signs in.
// route-inventory: GET /auth/discord/callback
// route-inventory: GET /join/callback
//
// The hostile set discriminates the two halves of the contract: the
// 21-digit and 130-digit ids are all-digit, so a charset-only check
// would still write them; the remaining ids are at most 20 characters,
// so a length-only check would still write them. Refusal must be a
// rejection, never a truncation or a sanitized rewrite: the hostile
// cases assert no session cookie, no session-store create/replace, no
// roster (`users`) statement at all, and no captured SQL value or
// session-call argument carrying the hostile id, and that Discord
// traffic stops after `/users/@me` (no guild-member read or join
// mutation follows a rejected identity). No provider bytes or tokens
// may reach the logs or the failure surface: every hostile id is
// distinctive, and the captured console output, response body and
// redirect target must contain neither it nor any fixture credential.
// The generic failure surface is each flow's existing provider-reject
// outcome: login redirects to `/?n=signin_failed`; join serves the 503
// "Discord is unreachable" page. Leading-zero ids are deliberately not
// pinned either way. Hermetic: memory session store, in-memory roster
// double, stubbed fetch — no live Discord, database, or secrets.
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

const AT_CAP_ID = "12345678901234567890"; // exactly 20 digits
const TYPICAL_ID = "100000000000000042"; // 18 digits
const SHORT_ID = "42";
const NORMAL = "fixturemember";

const FORBIDDEN_CREDENTIALS = [
  "fixture-access-token",
  "fixture-secret",
  "fixture-bot",
  "test-session-secret-at-least-32-bytes-long",
];

const hostileIds: { label: string; id: string; marker: string }[] = [
  {
    label: "a 21-digit provider id (one over the cap)",
    id: "123456789012345678901",
    marker: "123456789012345678901",
  },
  {
    label: "a 130-digit provider id",
    id: "9876543210".repeat(13),
    marker: "98765432109876543210",
  },
  {
    label: "an 18-character provider id ending in a letter",
    id: "12345678901234567x",
    marker: "12345678901234567x",
  },
  {
    label: "an alphabetic provider id",
    id: "notasnowflakeid",
    marker: "notasnowflakeid",
  },
  {
    label: "a signed provider id",
    id: "-12345678901234567",
    marker: "-12345678901234567",
  },
  {
    label: "a provider id with an embedded space",
    id: "1234567890 1234567",
    marker: "1234567890 1234567",
  },
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

function mockDiscord(id: string) {
  const profile: Profile = { id, username: NORMAL, global_name: null, avatar: "ava-1" };
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith("/oauth2/token"))
        return Response.json({ access_token: "fixture-access-token" });
      if (url.endsWith("/users/@me")) return Response.json(profile);
      // Any guild-member call is served generically, so an implementation
      // that lets a hostile id through completes the sign-in and fails the
      // write assertions below instead of erroring in the fixture.
      if (url.includes("/members/") && init?.method === "PUT")
        return new Response(null, { status: 204 });
      if (url.includes("/members/"))
        return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
      throw new Error("Unexpected network request in identity-id fixture");
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
  const values: unknown[] = [];
  const sql = (async (strings: TemplateStringsArray, ...statementValues: unknown[]) => {
    const head = strings[0] ?? "";
    statements.push(strings.join("?"));
    values.push(...statementValues);
    if (head.includes("INSERT INTO users")) {
      const [id, username, avatar, member] = statementValues as [
        string,
        string,
        string | null,
        boolean,
      ];
      rows.set(id, { id, username, avatar, member });
      return [];
    }
    throw new Error(`fakeRoster: unexpected statement: ${head.slice(0, 80)}`);
  }) as unknown as Sql;
  (sql as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  return { sql, rows, statements, values };
}

function fixture() {
  const store = createMemorySessionStore(() => Date.now());
  const roster = fakeRoster();
  const joinValues: unknown[] = [];
  const fake = (async (strings: TemplateStringsArray, ...statementValues: unknown[]) => {
    const query = strings.join("?");
    joinValues.push(...statementValues);
    if (query.includes("count(*)")) return [{ n: 0, wait: 1 }];
    if (query.includes("INSERT INTO join_attempts")) return [];
    if (query.includes("web_throttle_hits")) return [];
    throw new Error("Unexpected SQL in identity-id fixture");
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
  return { env, store, roster, joinValues, create, replace };
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

async function runCallback(flow: Flow, id: string) {
  const logs = captureLogs();
  const f = fixture();
  const startRes = await app.request(startPath(flow), {}, f.env);
  expect(startRes.status).toBe(302);
  const state = new URL(startRes.headers.get("location")!).searchParams.get("state")!;
  const calls = mockDiscord(id);
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

/** Every write-side value the fixture observed, serialized for one scan. */
function capturedWrites(f: ReturnType<typeof fixture>) {
  return JSON.stringify({
    rosterValues: f.roster.values,
    joinValues: f.joinValues,
    createArgs: f.create.mock.calls,
    replaceArgs: f.replace.mock.calls,
  });
}

describe("Discord provider identity ids are snowflake-bound before any write", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const flow of flows) {
    it.each(hostileIds)(
      `${flow}: $label writes no session, roster, or discord_id value`,
      async ({ id, marker }) => {
        const { f, calls, res, logs } = await runCallback(flow, id);
        const body = await expectGenericFailure(flow, res);
        expect(f.create).not.toHaveBeenCalled();
        expect(f.replace).not.toHaveBeenCalled();
        expect(f.roster.rows.size).toBe(0);
        expect(f.roster.statements).toEqual([]);
        // No captured write of any kind may carry the hostile value.
        expect(capturedWrites(f)).not.toContain(marker);
        // Identity is rejected at the profile read: no guild-member lookup
        // or join mutation may follow it.
        expect(calls).toHaveLength(2);
        expect(calls[0]).toMatch(/\/oauth2\/token$/);
        expect(calls[1]).toMatch(/\/users\/@me$/);
        // No provider bytes or tokens on any observable surface.
        const captured = logs();
        for (const forbidden of [marker, ...FORBIDDEN_CREDENTIALS]) {
          expect(captured).not.toContain(forbidden);
          expect(body).not.toContain(forbidden);
          expect(res.headers.get("location") ?? "").not.toContain(forbidden);
        }
      },
    );
  }

  it.each(flows)("%s: a provider id at exactly the 20-digit cap signs in", async (flow) => {
    const { f, res } = await runCallback(flow, AT_CAP_ID);
    expect(sessionCookie(res)).toBeDefined();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.roster.rows.get(AT_CAP_ID)).toEqual({
      id: AT_CAP_ID,
      username: NORMAL,
      avatar: "ava-1",
      member: true,
    });
    const row = await sessionRowFor(f, res);
    expect(row?.userId).toBe(AT_CAP_ID);
    expect(row?.username).toBe(NORMAL);
  });

  it.each(flows)("%s: a typical 18-digit provider id signs in", async (flow) => {
    const { f, res } = await runCallback(flow, TYPICAL_ID);
    expect(sessionCookie(res)).toBeDefined();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.roster.rows.get(TYPICAL_ID)).toEqual({
      id: TYPICAL_ID,
      username: NORMAL,
      avatar: "ava-1",
      member: true,
    });
    const row = await sessionRowFor(f, res);
    expect(row?.userId).toBe(TYPICAL_ID);
  });

  it.each(flows)("%s: a short all-digit provider id still signs in", async (flow) => {
    const { f, res } = await runCallback(flow, SHORT_ID);
    expect(sessionCookie(res)).toBeDefined();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.roster.rows.get(SHORT_ID)).toEqual({
      id: SHORT_ID,
      username: NORMAL,
      avatar: "ava-1",
      member: true,
    });
  });
});
