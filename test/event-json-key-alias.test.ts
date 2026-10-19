// route-inventory: GET /events.json
// Events JSON key alias: an admitted ULID event_key in another letter case
// resolves to the canonical stored key before lookup, so upper, lower,
// mixed-case and percent-encoded aliases read identical data, totals and
// ETags. Hermetic: mounted app with a memory session and a case-sensitive
// drizzle double (strict `===` on the bound key, emulating Postgres
// `text = text`). Removing the route normalization empties every alias case.
import { serializeSigned } from "hono/utils/cookie";
import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

// Allowlisted synthetic fixture ULIDs only (see .gitleaks.toml).
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DRAFT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAB";
const UNKNOWN_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAC";
const SEED_KEY = "seed-calendar-01";

const APP_URL = "https://next.example.test";
const STAGING_URL = "https://next.togetherweown.com";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

type FakeRow = {
  id: number;
  eventKey: string;
  title: string;
  game: string | null;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  location: string | null;
  capacity: number | null;
  status: string;
  rsvpOpen: boolean;
  discordEventId: string | null;
};

// Bound query values: walk drizzle SQL nesting to the Param leaves. listJson
// only ever binds the "published" status and at most one event key, so the
// first non-status value is the key filter.
function boundStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node !== "object" || node === null) return out;
  const chunks = (node as { queryChunks?: unknown }).queryChunks;
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) boundStrings(chunk, out);
    return out;
  }
  const record = node as { constructor?: { name?: string }; value?: unknown };
  if (record.constructor?.name === "Param" && typeof record.value === "string")
    out.push(record.value);
  return out;
}

function makeCaseSensitiveDb(rows: FakeRow[]) {
  let selects = 0;
  const db = {
    select(projection?: unknown) {
      selects += 1;
      const chain = {
        table: "",
        predicate: undefined as unknown,
        from(table: unknown) {
          chain.table = getTableName(table as Parameters<typeof getTableName>[0]);
          return chain;
        },
        where(predicate: unknown) {
          chain.predicate = predicate;
          return chain;
        },
        orderBy(..._args: unknown[]) {
          return chain;
        },
        limit(..._args: unknown[]) {
          return chain;
        },
        offset(..._args: unknown[]) {
          return chain;
        },
        groupBy(..._args: unknown[]) {
          return chain;
        },
        execute(): unknown {
          // RSVP aggregates are out of scope here: no going rows, zero counts.
          if (chain.table !== "events") return [];
          const bound = boundStrings(chain.predicate).filter((s) => s !== "published");
          const matched = rows.filter(
            (row) =>
              row.status === "published" && (bound.length === 0 || row.eventKey === bound[0]),
          );
          if (typeof projection === "object" && projection !== null && "n" in projection)
            return [{ n: matched.length }];
          return matched;
        },
        then<TResult1 = unknown, TResult2 = never>(
          onFulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null | undefined,
          onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
        ): Promise<TResult1 | TResult2> {
          return Promise.resolve(chain.execute()).then(onFulfilled, onRejected);
        },
      };
      return chain;
    },
  };
  return { db, selects: () => selects };
}

function row(id: number, eventKey: string, status: string, title: string): FakeRow {
  return {
    id,
    eventKey,
    title,
    game: null,
    description: null,
    startsAt: new Date("2099-11-04T20:00:00Z"),
    endsAt: new Date("2099-11-04T22:00:00Z"),
    timezone: "UTC",
    location: null,
    capacity: null,
    status,
    rsvpOpen: true,
    discordEventId: null,
  };
}

describe("events.json event-key alias (hermetic)", () => {
  const store = createMemorySessionStore();
  const fake = makeCaseSensitiveDb([
    row(1, KEY, "published", "Friday night Helldivers"),
    row(2, DRAFT_KEY, "draft", "Unannounced raid"),
    row(3, SEED_KEY, "published", "Seed showcase"),
  ]);
  const env = {
    APP_URL,
    SESSION_SECRET,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_STORE: store,
    ADMIN_DB: fake.db,
  } as unknown as Env;

  async function cookieFor(userId: string, moderator: boolean): Promise<string> {
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId,
      username: userId,
      avatar: null,
      member: true,
      moderator,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return (
      await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
  }

  const asMember = async (path: string, init: RequestInit = {}) =>
    app.request(
      path,
      {
        ...init,
        headers: { cookie: await cookieFor("100000000000000131", false), ...init.headers },
      },
      env,
    );
  const asModerator = async (path: string, init: RequestInit = {}) =>
    app.request(
      path,
      {
        ...init,
        headers: { cookie: await cookieFor("100000000000000132", true), ...init.headers },
      },
      env,
    );

  const lower = KEY.toLowerCase();
  const mixed = `${KEY.slice(0, 13).toLowerCase()}${KEY.slice(13)}`;
  // Hand-built %XX sequences (encodeURIComponent is the identity on this
  // alphabet), so the request line carries real percent-escapes that the
  // framework must decode before admission and canonicalization.
  const encoded = lower.replace(/a/g, "%61").replace(/f/g, "%66");

  it("upper, lower and mixed-case aliases read identical data, totals and ETags", async () => {
    const upper = await asMember(`/events.json?event_key=${KEY}`);
    expect(upper.status).toBe(200);
    const upperBody = await upper.text();
    const upperEtag = upper.headers.get("etag");
    expect(upperEtag).not.toBeNull();
    expect(JSON.parse(upperBody).data.map((r: { event_key: string }) => r.event_key)).toEqual([
      KEY,
    ]);
    expect(JSON.parse(upperBody).meta.total).toBe(1);
    for (const alias of [lower, mixed]) {
      const res = await asMember(`/events.json?event_key=${alias}`);
      expect(res.status, alias).toBe(200);
      expect(await res.text(), alias).toBe(upperBody);
      expect(res.headers.get("etag"), alias).toBe(upperEtag);
    }
  });

  it("a percent-encoded lowercase alias reads the canonical row", async () => {
    expect(encoded).not.toBe(lower);
    expect(encoded).toContain("%");
    const plain = await asMember(`/events.json?event_key=${lower}`);
    const res = await asMember(`/events.json?event_key=${encoded}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(await plain.text());
    expect(res.headers.get("etag")).toBe(plain.headers.get("etag"));
  });

  it("a cross-case conditional request settles to 304", async () => {
    const first = await asMember(`/events.json?event_key=${KEY}`);
    const etag = first.headers.get("etag")!;
    await first.text();
    const replay = await asMember(`/events.json?event_key=${lower}`, {
      headers: { "if-none-match": etag },
    });
    expect(replay.status).toBe(304);
    expect(await replay.text()).toBe("");
    expect(replay.headers.get("etag")).toBe(etag);
  });

  it("invalid keys stay 422 without touching the database", async () => {
    const before = fake.selects();
    expect((await asMember("/events.json?event_key=nope")).status).toBe(422);
    expect((await asMember(`/events.json?event_key=${SEED_KEY}`)).status).toBe(422);
    expect(fake.selects()).toBe(before);
  });

  it("unknown valid keys stay empty, in any letter case", async () => {
    for (const key of [UNKNOWN_KEY, UNKNOWN_KEY.toLowerCase()]) {
      const res = await asMember(`/events.json?event_key=${key}`);
      expect(res.status, key).toBe(200);
      const body = (await res.json()) as { data: unknown[]; meta: { total: number } };
      expect(body.data).toEqual([]);
      expect(body.meta.total).toBe(0);
    }
  });

  it("drafts stay excluded for members and moderators, in any letter case", async () => {
    for (const key of [DRAFT_KEY, DRAFT_KEY.toLowerCase()]) {
      for (const get of [asMember, asModerator]) {
        const res = await get(`/events.json?event_key=${key}`);
        expect(res.status, `${key}`).toBe(200);
        const body = (await res.json()) as { data: unknown[]; meta: { total: number } };
        expect(body.data, `${key}`).toEqual([]);
        expect(body.meta.total, `${key}`).toBe(0);
      }
    }
  });

  it("guests stay refused without touching the database", async () => {
    const before = fake.selects();
    const res = await app.request(`/events.json?event_key=${lower}`, {}, env);
    expect(res.status).toBe(401);
    expect(fake.selects()).toBe(before);
  });

  it("seed keys stay addressable on staging bindings", async () => {
    const stagingEnv = { ...env, APP_URL: STAGING_URL } as unknown as Env;
    const memberCookie = await cookieFor("100000000000000131", false);
    const res = await app.request(
      `/events.json?event_key=${SEED_KEY}`,
      { headers: { cookie: memberCookie } },
      stagingEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { event_key: string }[] };
    expect(body.data.map((r) => r.event_key)).toEqual([SEED_KEY]);
  });
});
