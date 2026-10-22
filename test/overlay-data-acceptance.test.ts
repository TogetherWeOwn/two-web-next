// route-inventory: GET /o/:token/data
// Acceptance: overlay live-data endpoint (spec slice 3).
//
// Contract under test (the Builder implements to this file):
// - GET /o/:token/data answers 200 JSON {identity, live_line, event, config}
//   with `cache-control: private, no-store`, a quoted ETag, and no Set-Cookie.
// - identity = {display_name (users.username verbatim), avatar_url
//   (Discord CDN URL, null when the member has no avatar hash or the config
//   hides it)}. live_line = {source: "event"|"custom"|"none", text}: event
//   auto-text contains the current/next published event title, custom text is
//   the stored custom_text verbatim, and text is "" when neither applies.
//   event = {title, starts_at} of that event, or null. config echoes the
//   stored {elements, theme} verbatim (custom_text lives there, not duplicated
//   at the top level). Those four top-level keys are the whole allowlist: no
//   email/session/bio/games/timezone/token bytes, and the member snowflake
//   appears only inside avatar_url.
// - Matching If-None-Match (exact, weak, list, *) answers 304 with an empty
//   body and the ETag echoed. A config or event change flips the ETag and
//   the next poll carries the new bytes.
// - Unknown/revoked tokens answer 404 JSON {error: {code: "not_found"}},
//   mirroring the public-data apiError envelope, with the same no-store
//   headers, no member bytes, and no Set-Cookie. The overlay path never
//   reads the session store and never writes member_data_access_logs.
// - The per-token throttle runs before the token lookup: an exhausted budget
//   answers 429 (JSON envelope for JSON callers) with Retry-After even for
//   unknown tokens and without any database. Flooding one token never limits
//   another token from the same IP, and the limit follows the token across IPs.
// - One poll costs at most 2 data SELECTs (token+config+identity join plus
//   the event read): the token lookup filters on token_hash equality (the
//   UNIQUE index), and nothing reads profiles/sessions/access logs.
//
// Seeding contract (spec DDL, slice 1): overlay_configs(member_id, elements,
// theme) with elements {show_identity, show_avatar, show_live_line,
// live_line_mode: "event"|"custom", custom_text|null, layout:
// "compact"|"banner"} and theme {preset, accent}; overlay_tokens(member_id,
// token_hash sha256 hex, status 'live').
//
// Live against the guarded test database in a throwaway schema. Skipped when
// DATABASE_URL is unset. Never point this at production or staging. The
// hermetic 429-shape suite at the bottom runs without any database.
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "./app";
import { events, memberDataAccessLogs } from "../src/db/admin-schema";
import { adminSchema, schema } from "../src/db/index";
import type { Env } from "../src/env";
import { profiles, users } from "../src/db/schema";
import { createMemorySessionStore, type SessionStore, type Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const QUOTED_ETAG_RE = /^".+"$/;
const FLOOD_IP = "192.0.2.44";
const FLOOD_IP_OTHER = "192.0.2.45";

// Both directive orders ship in the repo (global "no-store, private",
// jsonSession "private, no-store"): pin the directives, never the order.
const expectNoStore = (res: Response) => {
  const cacheControl = res.headers.get("cache-control") ?? "";
  expect(cacheControl).toContain("no-store");
  expect(cacheControl).toContain("private");
};

const mintToken = () => `two_ov_${randomBytes(32).toString("base64url")}`;
const sha256hex = (token: string) => createHash("sha256").update(token).digest("hex");

let memberSeq = 0;
const nextMemberId = () => `910000000000000${String(++memberSeq).padStart(3, "0")}`;
let eventSeq = 0;
const nextEventKey = () => `overlay-data-evt-${Date.now()}-${++eventSeq}`;

type ElementMap = Record<string, string | boolean | null>;
type ThemeMap = { preset: string; accent: string };
const defaultElements = (overrides: ElementMap = {}): ElementMap => ({
  show_identity: true,
  show_avatar: true,
  show_live_line: true,
  live_line_mode: "event",
  custom_text: null,
  layout: "compact",
  ...overrides,
});
const defaultTheme = (): ThemeMap => ({ preset: "dark-translucent", accent: "gold" });

// Feed-shape throttle double (test/feed-throttle-429.test.ts): fixed verdict,
// no database. checkJoinThrottle only needs the advisory-lock no-op, the
// count row, and the insert/delete sinks.
function memoryThrottleSql(limited: boolean, wait = 42) {
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const statement = strings.join("?");
      if (statement.includes("pg_advisory_xact_lock")) return [];
      if (statement.includes("SELECT count(*)")) {
        return [{ n: limited ? 999 : 0, wait }];
      }
      if (statement.includes("INSERT INTO web_throttle_hits")) return [];
      if (statement.includes("DELETE FROM web_throttle_hits")) return [];
      throw new Error("Unexpected throttle statement");
    },
    {
      begin: (run: (tx: Sql) => Promise<unknown>) => run(sql as unknown as Sql),
      unsafe: async () => [],
    },
  );
  return sql as unknown as Sql;
}

describe.skipIf(!process.env.DATABASE_URL)("overlay live-data endpoint (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let env: Env;
  const sessionCalls: string[] = [];

  const countingStore = (inner: SessionStore): SessionStore =>
    new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          sessionCalls.push(String(prop));
          return (value as (...call: unknown[]) => unknown).apply(target, args);
        };
      },
    });

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 4 });
    const store = createMemorySessionStore();
    // No DATABASE_URL on the app env: the DB comes from the injected
    // ADMIN_DB, like test/event-json-etag-invalidation.test.ts. The session
    // store counts every call so the overlay path can prove it never reads it.
    env = {
      APP_URL,
      SESSION_SECRET,
      SESSION_STORE: countingStore(store),
      ADMIN_DB: fixture.db,
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_GUILD_ID: "326474832151838730",
      DISCORD_INVITE_URL: "https://discord.gg/invite",
      DISCORD_BOT_TOKEN: "bot-token",
      SYNC_EVENT_QUEUE: { send: async () => {} },
    } as unknown as Env;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  const dataGet = (token: string, init: { etag?: string; ip?: string } = {}, useEnv?: Env) =>
    app.request(
      `/o/${token}/data`,
      {
        headers: {
          accept: "application/json",
          "cf-connecting-ip": init.ip ?? FLOOD_IP,
          ...(init.etag ? { "if-none-match": init.etag } : {}),
        },
      },
      useEnv ?? env,
    );

  const requireOverlaySchema = async () => {
    let schemaError: unknown = null;
    try {
      await fixture.client`SELECT 1 FROM overlay_tokens LIMIT 0`;
      await fixture.client`SELECT 1 FROM overlay_configs LIMIT 0`;
    } catch (error) {
      schemaError = error;
    }
    expect(
      schemaError,
      "overlay schema (slice 1: overlay_tokens + overlay_configs) must be applied before slice-3 acceptance can run",
    ).toBeNull();
  };

  const seedMember = async (
    overrides: {
      username?: string;
      avatar?: string | null;
      bio?: string;
      games?: string[];
      timezone?: string;
      elements?: ElementMap;
      theme?: ThemeMap;
    } = {},
  ) => {
    await requireOverlaySchema();
    await fixture.client`DELETE FROM overlay_tokens`;
    await fixture.client`DELETE FROM overlay_configs`;
    await fixture.reset();
    const memberId = nextMemberId();
    const username = overrides.username ?? `Overlay Streamer ${memberId.slice(-3)}`;
    const avatar =
      overrides.avatar === undefined ? `avatarhash${memberId.slice(-3)}` : overrides.avatar;
    await fixture.db.insert(users).values({ id: memberId, username, avatar, member: true });
    if (
      overrides.bio !== undefined ||
      overrides.games !== undefined ||
      overrides.timezone !== undefined
    ) {
      await fixture.db.insert(profiles).values({
        userId: memberId,
        bio: overrides.bio ?? null,
        games: overrides.games ?? [],
        timezone: overrides.timezone ?? null,
      });
    }
    const elements = defaultElements(overrides.elements);
    const theme = overrides.theme ?? defaultTheme();
    const token = mintToken();
    await fixture.client`INSERT INTO overlay_configs (member_id, elements, theme) VALUES (${memberId}, ${JSON.stringify(elements)}::text::jsonb, ${JSON.stringify(theme)}::text::jsonb)`;
    await fixture.client`INSERT INTO overlay_tokens (member_id, token_hash, status) VALUES (${memberId}, ${sha256hex(token)}, 'live')`;
    return { memberId, username, avatar, token, elements, theme };
  };

  const seedEvent = (key: string, title: string) =>
    fixture.db.insert(events).values({
      eventKey: key,
      title,
      status: "published",
      startsAt: new Date("2099-03-10T20:00:00Z"),
      endsAt: new Date("2099-03-10T22:00:00Z"),
      timezone: "UTC",
      location: "Voice",
    });

  const readAccessLogCount = async () => {
    const rows = await fixture.db.select().from(memberDataAccessLogs);
    return rows.length;
  };

  it("serves the harness control without a database-backed overlay", async () => {
    // Positive control: the app harness answers an existing static route, so
    // the overlay failures below prove a missing route, not a broken harness.
    const res = await app.request("/.well-known/security.txt", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
  });

  it("answers unknown tokens as a JSON 404 with no-store headers and no member bytes", async () => {
    const res = await dataGet(`two_ov_${"0".repeat(43)}`);
    expect(res.status).toBe(404);
    // The JSON envelope proves the overlay route (not Hono's default text
    // fallback) refused the token, mirroring the public-data apiError shape.
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const cacheControl = res.headers.get("cache-control") ?? "";
    expect(cacheControl).toContain("no-store");
    expect(cacheControl).toContain("private");
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not_found");
    expect(typeof body.error.message).toBe("string");
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("identity");
    expect(raw).not.toContain("display_name");
  });

  it("serves the allowlisted payload with identity, event auto-text and config", async () => {
    const seed = await seedMember();
    const eventKey = nextEventKey();
    const title = `Overlay Auto Event ${eventKey.slice(-6)}`;
    await seedEvent(eventKey, title);

    const res = await dataGet(seed.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expectNoStore(res);
    expect(res.headers.get("set-cookie")).toBeNull();
    const etag = res.headers.get("etag");
    expect(etag).toMatch(QUOTED_ETAG_RE);

    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["config", "event", "identity", "live_line"]);
    expect(body.identity).toEqual({
      display_name: seed.username,
      avatar_url: `https://cdn.discordapp.com/avatars/${seed.memberId}/${seed.avatar}.png`,
    });
    const liveLine = body.live_line as { source: string; text: string };
    expect(liveLine.source).toBe("event");
    expect(liveLine.text).toContain(title);
    expect(body.event).toMatchObject({ title });
    expect(body.config).toEqual({ elements: seed.elements, theme: seed.theme });
  });

  it("serves custom text verbatim in custom mode", async () => {
    const custom = "Live now: community game night! <3";
    const seed = await seedMember({
      elements: { live_line_mode: "custom", custom_text: custom },
    });
    await seedEvent(nextEventKey(), "An event the custom line ignores");

    const res = await dataGet(seed.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.live_line).toEqual({ source: "custom", text: custom });
    expect((body.config as { elements: { custom_text: unknown } }).elements.custom_text).toBe(
      custom,
    );
  });

  it("answers an empty live line when no event and no custom text apply", async () => {
    const seed = await seedMember();
    // No events seeded: the text pin is the contract, not the source label.
    const res = await dataGet(seed.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.live_line as { text: string }).text).toBe("");
    expect(body.event).toBeNull();
  });

  it("nulls the avatar URL when the member has no avatar hash", async () => {
    const seed = await seedMember({ avatar: null });
    const res = await dataGet(seed.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.identity as { avatar_url: unknown }).avatar_url).toBeNull();
  });

  it("settles unchanged polls to an empty 304 carrying the ETag", async () => {
    const seed = await seedMember();
    await seedEvent(nextEventKey(), "Overlay 304 fixture");

    const first = await dataGet(seed.token);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(QUOTED_ETAG_RE);

    const replay = await dataGet(seed.token, { etag: etag! });
    expect(replay.status).toBe(304);
    expect(await replay.text()).toBe("");
    expect(replay.headers.get("etag")).toBe(etag);
    expectNoStore(replay);
    expect(replay.headers.get("set-cookie")).toBeNull();
  });

  it("matches weak, listed and star validators, and misses junk", async () => {
    const seed = await seedMember();
    await seedEvent(nextEventKey(), "Overlay validator fixture");

    const first = await dataGet(seed.token);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag")!;
    const junk = etag.replace(/^"(.)/, (_m, ch: string) => `"${ch === "0" ? "1" : "0"}`);

    const weak = await dataGet(seed.token, { etag: `W/${etag}` });
    expect(weak.status).toBe(304);
    expect(await weak.text()).toBe("");
    expect(weak.headers.get("etag")).toBe(etag);

    const listed = await dataGet(seed.token, { etag: `"junk", ${etag}` });
    expect(listed.status).toBe(304);
    expect(await listed.text()).toBe("");

    const star = await dataGet(seed.token, { etag: "*" });
    expect(star.status).toBe(304);
    expect(await star.text()).toBe("");

    const miss = await dataGet(seed.token, { etag: junk });
    expect(miss.status).toBe(200);
    expect(miss.headers.get("etag")).toBe(etag);
  });

  it("flips the ETag and body after a config change, then settles again", async () => {
    const seed = await seedMember({
      elements: { live_line_mode: "custom", custom_text: "before the change" },
    });

    const first = await dataGet(seed.token);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag")!;
    expect(((await first.json()) as { live_line: { text: string } }).live_line.text).toBe(
      "before the change",
    );

    const elements = { ...seed.elements, custom_text: "after the change" };
    await fixture.client`UPDATE overlay_configs SET elements = ${JSON.stringify(elements)}::text::jsonb, updated_at = now() WHERE member_id = ${seed.memberId}`;

    const stale = await dataGet(seed.token, { etag });
    expect(stale.status).toBe(200);
    const next = stale.headers.get("etag");
    expect(next).toMatch(QUOTED_ETAG_RE);
    expect(next).not.toBe(etag);
    expect(((await stale.json()) as { live_line: { text: string } }).live_line.text).toBe(
      "after the change",
    );

    const settled = await dataGet(seed.token, { etag: next! });
    expect(settled.status).toBe(304);
    expect(await settled.text()).toBe("");
  });

  it("flips the ETag and auto-text after an event change", async () => {
    const seed = await seedMember();
    const eventKey = nextEventKey();
    await seedEvent(eventKey, "Overlay title before");

    const first = await dataGet(seed.token);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag")!;

    await fixture.db
      .update(events)
      .set({ title: "Overlay title after" })
      .where(eq(events.eventKey, eventKey));

    const stale = await dataGet(seed.token, { etag });
    expect(stale.status).toBe(200);
    expect(stale.headers.get("etag")).not.toBe(etag);
    const body = (await stale.json()) as {
      live_line: { source: string; text: string };
      event: { title: string };
    };
    expect(body.live_line.source).toBe("event");
    expect(body.live_line.text).toContain("Overlay title after");
    expect(body.event.title).toBe("Overlay title after");
  });

  it("leaks no denylisted member fields even when every one is set", async () => {
    const bio = `overlay-bio-poison-${randomBytes(8).toString("hex")}`;
    const game = `overlay-game-poison-${randomBytes(8).toString("hex")}`;
    const timezone = `Overlay/Poison_${randomBytes(4).toString("hex")}`;
    const seed = await seedMember({ bio, games: [game], timezone });
    await seedEvent(nextEventKey(), "Overlay poison fixture");

    const res = await dataGet(seed.token);
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).toContain(seed.username);
    expect(raw).toContain(String(seed.avatar));
    expect(raw).not.toContain(bio);
    expect(raw).not.toContain(game);
    expect(raw).not.toContain(timezone);
    expect(raw).not.toContain("token_hash");
    expect(raw).not.toContain("two_ov_");
    // The snowflake is identifying data: it may appear only inside the
    // avatar URL, never as its own field.
    const avatarUrl = `https://cdn.discordapp.com/avatars/${seed.memberId}/${seed.avatar}.png`;
    expect(raw).toContain(avatarUrl);
    expect(raw.split(avatarUrl).join("")).not.toContain(seed.memberId);
  });

  it("never reads the session store on the overlay path", async () => {
    const seed = await seedMember();
    await seedEvent(nextEventKey(), "Overlay session fixture");
    sessionCalls.length = 0;

    const hit = await dataGet(seed.token);
    expect(hit.status).toBe(200);
    const miss = await dataGet(`two_ov_${"1".repeat(43)}`);
    expect(miss.status).toBe(404);
    expect(sessionCalls).toEqual([]);
  });

  it("writes no member-data access-log rows for overlay reads", async () => {
    const seed = await seedMember();
    await seedEvent(nextEventKey(), "Overlay access-log fixture");
    expect(await readAccessLogCount()).toBe(0);

    const hit = await dataGet(seed.token);
    expect(hit.status).toBe(200);
    expect(await readAccessLogCount()).toBe(0);
  });

  it("serves one poll with at most 2 indexed data reads and no stray reads", async () => {
    const seed = await seedMember();
    await seedEvent(nextEventKey(), "Overlay read-count fixture");
    // Recording client on the same owned schema: the postgres debug hook
    // sees every statement the route issues through the injected ADMIN_DB.
    // Seeding above ran through the fixture pool, so the window below holds
    // only the measured poll. The allowing throttle double keeps budget
    // bookkeeping out of the recorded statements.
    const statements: string[] = [];
    let recording = false;
    const raw = postgres(process.env.DATABASE_URL!, {
      max: 1,
      connect_timeout: 5,
      password: () => "",
      connection: { search_path: fixture.schemaName },
      onnotice: () => {},
      debug: (_connection, query) => {
        if (recording) statements.push(query);
      },
    });
    try {
      const countingEnv = {
        ...env,
        ADMIN_DB: drizzle(raw, { schema: { ...schema, ...adminSchema } }),
        THROTTLE_STORE: async () => memoryThrottleSql(false),
      } as unknown as EnvWithThrottle;
      recording = true;
      const res = await dataGet(seed.token, {}, countingEnv);
      recording = false;
      expect(res.status).toBe(200);
      expect(
        ((await res.json()) as { identity: { display_name: string } }).identity.display_name,
      ).toBe(seed.username);

      const selects = statements.filter((query) => /^\s*select/i.test(query));
      const dataSelects = selects.filter((query) =>
        /overlay_tokens|overlay_configs|users|events/i.test(query),
      );
      expect(
        dataSelects.length,
        `one poll must cost <=2 data SELECTs, saw:\n${dataSelects.join("\n")}`,
      ).toBeLessThanOrEqual(2);
      expect(
        dataSelects.length,
        "the poll must actually read the overlay tables (no canned-body pass)",
      ).toBeGreaterThanOrEqual(1);
      expect(
        dataSelects.some((query) => /token_hash"?\s*=/i.test(query)),
        `the token lookup must filter on token_hash equality (the UNIQUE index), saw:\n${dataSelects.join("\n")}`,
      ).toBe(true);
      expect(
        selects.some((query) => /profiles|sessions|member_data_access_logs/i.test(query)),
        `no poll may read profiles, sessions or access logs, saw:\n${selects.join("\n")}`,
      ).toBe(false);
    } finally {
      await raw.end();
    }
  });

  it("throttles per token: one flooded token never limits another, on any IP", async () => {
    const first = await seedMember({ username: "Overlay flood A" });
    // Second member without wiping the first: reset() clears shared tables,
    // so seed it directly after the helper's wipe.
    const memberB = nextMemberId();
    await fixture.db.insert(users).values({
      id: memberB,
      username: "Overlay flood B",
      avatar: "floodbavatar",
      member: true,
    });
    const elementsB = defaultElements();
    const tokenB = mintToken();
    await fixture.client`INSERT INTO overlay_configs (member_id, elements, theme) VALUES (${memberB}, ${JSON.stringify(elementsB)}::text::jsonb, ${JSON.stringify(defaultTheme())}::text::jsonb)`;
    await fixture.client`INSERT INTO overlay_tokens (member_id, token_hash, status) VALUES (${memberB}, ${sha256hex(tokenB)}, 'live')`;
    await seedEvent(nextEventKey(), "Overlay flood fixture");
    const throttleEnv = {
      ...env,
      THROTTLE_STORE: async () => fixture.client as unknown as Sql,
    } as unknown as EnvWithThrottle;

    // Flood token A from one IP: the cap (spec e.g. 30/min) must trip well
    // inside 61 rapid polls, but never inside the first 10 — one OBS
    // instance polls 3/min and must never see a 429.
    let first429 = -1;
    for (let i = 0; i < 61; i++) {
      const res = await dataGet(first.token, { ip: FLOOD_IP }, throttleEnv);
      if (res.status === 429) {
        first429 = i;
        expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(first429, "per-token cap must trip inside 61 rapid polls").toBeGreaterThanOrEqual(0);
    expect(
      first429,
      "one OBS instance at 20s polls must never trip the cap",
    ).toBeGreaterThanOrEqual(10);

    // Same IP, other token: still admitted, proving the bucket is per token.
    const sibling = await dataGet(tokenB, { ip: FLOOD_IP }, throttleEnv);
    expect(sibling.status).toBe(200);

    // Same token, other IP: still limited, proving the bucket follows the
    // token instead of the client address.
    const roaming = await dataGet(first.token, { ip: FLOOD_IP_OTHER }, throttleEnv);
    expect(roaming.status).toBe(429);
    expect(Number(roaming.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });
});

describe("overlay live-data 429 shape (hermetic)", () => {
  const jsonEnv = (limited: boolean) =>
    ({
      APP_URL,
      THROTTLE_STORE: async () => memoryThrottleSql(limited),
    }) as unknown as EnvWithThrottle;

  it("answers an exhausted per-token budget as 429 JSON before any lookup", async () => {
    // Unknown token and no database anywhere in the env: the 429 proves the
    // throttle guard runs before the token lookup and needs no DB or session.
    const res = await app.request(
      `/o/two_ov_${"2".repeat(43)}/data`,
      { headers: { accept: "application/json", "cf-connecting-ip": FLOOD_IP } },
      jsonEnv(true),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({
      reason: "rate_limited",
      message: "Too many requests. Try again in 42 seconds.",
      retry_after: 42,
    });
  });

  it("positive control: an unexhausted budget never answers 429 without a database", async () => {
    // No ADMIN_DB and no DATABASE_URL here, so a request that clears the
    // guard must reach the no-DB path instead. This proves the 429 above
    // comes from the exhausted budget, not from another refusal.
    const res = await app.request(
      `/o/two_ov_${"3".repeat(43)}/data`,
      { headers: { accept: "application/json", "cf-connecting-ip": FLOOD_IP } },
      jsonEnv(false),
    );
    expect(res.status).not.toBe(429);
    expect(res.headers.get("retry-after")).toBeNull();
  });
});
