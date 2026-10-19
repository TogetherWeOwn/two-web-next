// route-inventory: POST /e/:key/rsvp
// Acceptance: event-key aliases on the no-JS POST HTML adapter.
//
// PUT/DELETE /events/:key/rsvp already 308 a valid key in another letter
// case to the canonical RSVP URL (see src/events/routes-rsvp.tsx), and the
// read routes canonicalize before lookup. The POST /e/:key/rsvp adapter
// deliberately kept its exact session, decoy and refusal paths instead of
// the redirect — so it must normalize the key itself: a lowercase or
// mixed-case ULID alias must reach the same stored event row as the
// canonical (uppercase) key, and every return path the adapter emits
// (success redirect, login `next`, refusal return link) must land on the
// canonical event page, never back on the alias.
//
// Hermetic by design: the real app with a memory session store over a
// case-sensitive store double. The double runs the real writeRsvp /
// withdrawRsvp transactions but resolves the event row with strict `===`
// on the bound key (emulating Postgres `text = text`), so an alias only
// reaches the row if the key is normalized before the lookup. It records
// every bound event key, the RSVP rows it holds and the throttle hits it
// charged, so "reached the same row" is observed in store state, not
// inferred from the redirect alone — the withdraw already-withdrawn
// convergence answers 303 either way, and only the row (and the charged
// hit, which an unknown event never spends) tells the two apart.
// No live DB, Discord, deploys or credential use.
import { serializeSigned } from "hono/utils/cookie";
import { getTableName } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { RSVP_COPY, throttleWaitCopy } from "../src/islands/contracts-rsvp-button";
import type { QueueMessage } from "../src/jobs/types";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

// RSVP route tests isolate dispatch; other suites prove the real producer.
vi.mock("../src/jobs/worker", () => ({
  enqueueSyncEvent: async (env: Env, message: QueueMessage) => {
    await env.SYNC_EVENT_QUEUE!.send(message, { delaySeconds: 10 });
    return true;
  },
}));

// Allowlisted synthetic fixture ULIDs only (see .gitleaks.toml).
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DRAFT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAB";
const PAUSED_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAD";
const UNKNOWN_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
// Member-read boundaries require Discord-snowflake viewer ids.
const MEMBER = "420000000000000042";
// The one post-lock instant the double's clock read answers; before every
// fixture event ends, so published events judge open on the database clock.
const DB_NOW = new Date("2029-06-01T12:00:00Z");

const lower = (key: string) => key.toLowerCase();
const mixed = (key: string) => `${key.slice(0, 13).toLowerCase()}${key.slice(13)}`;
// Hand-built %XX sequences (encodeURIComponent is the identity on this
// alphabet), so the request line carries real percent-escapes the
// framework must decode before admission and canonicalization.
const encodedLower = (key: string) => lower(key).replace(/a/g, "%61").replace(/f/g, "%66");

type FakeEvent = typeof events.$inferSelect;
type FakeRsvp = {
  id: number;
  eventId: number;
  userId: string;
  status: string;
  syncedToDiscordAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  legacyId: number | null;
};

function fakeEvent(over: Partial<FakeEvent>): FakeEvent {
  const startsAt = new Date("2030-01-01T20:00:00Z");
  return {
    id: 42,
    eventKey: KEY,
    title: "Alias night",
    game: null,
    description: null,
    startsAt,
    endsAt: new Date("2030-01-01T22:00:00Z"),
    timezone: "UTC",
    location: null,
    capacity: null,
    status: "published",
    rsvpOpen: true,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: startsAt,
    updatedAt: startsAt,
    icsSequence: 0n,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    ...over,
  };
}

// Bound query values in order: walk drizzle SQL nesting to the Param leaves.
function boundValues(node: unknown, out: unknown[] = []): unknown[] {
  if (typeof node !== "object" || node === null) return out;
  // inArray binds its list as a bare chunk array of Params.
  if (Array.isArray(node)) {
    for (const item of node) boundValues(item, out);
    return out;
  }
  const chunks = (node as { queryChunks?: unknown }).queryChunks;
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) boundValues(chunk, out);
    return out;
  }
  const record = node as { constructor?: { name?: string }; value?: unknown };
  if (record.constructor?.name === "Param") {
    // inArray binds its list as one array-valued Param in this drizzle
    // version; flatten so id lists read like scalar bindings.
    if (Array.isArray(record.value)) out.push(...record.value);
    else out.push(record.value);
  }
  return out;
}

// SQL text of a `tx.execute(sql`...`)` argument: the literal chunks only
// (StringChunk values, never the bound parameters).
function executeText(arg: unknown): string {
  const chunks = (arg as { queryChunks?: unknown })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  const parts: string[] = [];
  for (const chunk of chunks) {
    if (typeof chunk === "string") parts.push(chunk);
    else if (typeof chunk === "object" && chunk !== null) {
      const value = (chunk as { value?: unknown }).value;
      if (typeof value === "string") parts.push(value);
      else if (Array.isArray(value))
        for (const item of value) if (typeof item === "string") parts.push(item);
    }
  }
  return parts.join(" ").toLowerCase();
}

const RSVP_STATUSES = new Set(["going", "waitlisted", "maybe", "not_going"]);

function makeCaseSensitiveStore(presetThrottleHits: number) {
  const eventsByKey = new Map<string, FakeEvent>(
    [
      fakeEvent({ id: 42, eventKey: KEY }),
      fakeEvent({ id: 43, eventKey: DRAFT_KEY, status: "draft", title: "Unannounced raid" }),
      fakeEvent({ id: 44, eventKey: PAUSED_KEY, rsvpOpen: false, title: "Paused night" }),
    ].map((row) => [row.eventKey, row]),
  );
  const rsvpRows: FakeRsvp[] = [];
  const boundEventKeys: string[] = [];
  let nextRsvpId = 1;
  let throttleHits = presetThrottleHits;
  let transactions = 0;

  const matches = (predicate: unknown) => {
    const values = boundValues(predicate);
    const numbers = values.filter((v): v is number => typeof v === "number");
    const strings = values.filter((v): v is string => typeof v === "string");
    return {
      eventId: numbers[0],
      userId: strings.find((s) => /^\d+$/.test(s)),
      status: strings.find((s) => RSVP_STATUSES.has(s)),
      numbers,
      strings,
    };
  };
  const filterRsvps = (predicate: unknown) => {
    const { eventId, userId, status } = matches(predicate);
    return rsvpRows.filter(
      (row) =>
        (eventId === undefined || row.eventId === eventId) &&
        (userId === undefined || row.userId === userId) &&
        (status === undefined || row.status === status),
    );
  };

  type Chain = PromiseLike<unknown[]> & {
    [method: string]: (...args: unknown[]) => Chain;
  };
  const selectChain = (projection: unknown): Chain => {
    let table = "";
    let predicate: unknown;
    let cap: number | undefined;
    const keys =
      typeof projection === "object" && projection !== null ? Object.keys(projection) : [];
    const execute = (): unknown[] => {
      if (table === "events") {
        if (keys.includes("now")) return [{ now: DB_NOW }];
        // The write path's one event lookup: strictly case-sensitive, like
        // Postgres `text = text` against the stored uppercase key.
        const wanted = boundValues(predicate).find((v): v is string => typeof v === "string");
        if (wanted !== undefined) boundEventKeys.push(wanted);
        const row = wanted === undefined ? undefined : eventsByKey.get(wanted);
        return row ? [row] : [];
      }
      if (table === "rsvps") {
        const matched = filterRsvps(predicate);
        if (keys.includes("n")) return [{ n: matched.length }];
        if (keys.includes("id")) return matched.slice(0, cap).map((row) => ({ id: row.id }));
        return matched;
      }
      return [];
    };
    const chain = {
      then<TResult1 = unknown[], TResult2 = never>(
        onFulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null | undefined,
        onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
      ): Promise<TResult1 | TResult2> {
        return Promise.resolve(execute()).then(onFulfilled, onRejected);
      },
    } as unknown as Chain;
    for (const method of [
      "from",
      "where",
      "orderBy",
      "limit",
      "offset",
      "groupBy",
      "for",
      "$dynamic",
    ]) {
      chain[method] = (...args: unknown[]) => {
        if (method === "from") table = getTableName(args[0] as Parameters<typeof getTableName>[0]);
        if (method === "where") predicate = args[0];
        if (method === "limit" && typeof args[0] === "number") cap = args[0];
        return chain;
      };
    }
    return chain;
  };

  const runDelete = (predicate: unknown): { id: number }[] => {
    const { eventId, userId, numbers, strings } = matches(predicate);
    // writeRsvp deletes a superseded row by its own id; withdrawRsvp
    // deletes by (event, caller). The bound shape tells them apart.
    const byId = userId === undefined && strings.length === 0 && numbers.length === 1;
    const removed: { id: number }[] = [];
    for (let i = rsvpRows.length - 1; i >= 0; i--) {
      const row = rsvpRows[i]!;
      const hit = byId ? row.id === numbers[0] : row.eventId === eventId && row.userId === userId;
      if (hit) {
        removed.push({ id: row.id });
        rsvpRows.splice(i, 1);
      }
    }
    return removed;
  };

  const tx = {
    execute: async (arg: unknown) => {
      const text = executeText(arg);
      if (text.includes("web_throttle_hits") && text.includes("count"))
        return [{ n: throttleHits, wait: 7 }];
      if (text.includes("insert into web_throttle_hits")) throttleHits += 1;
      return [];
    },
    select: (projection?: unknown) => selectChain(projection),
    insert: (..._args: unknown[]) => ({
      values: (v: { eventId: number; userId: string; status: string; updatedAt: Date }) => ({
        onConflictDoUpdate: (cfg: { set: Partial<FakeRsvp> }) => {
          const existing = rsvpRows.find(
            (row) => row.eventId === v.eventId && row.userId === v.userId,
          );
          if (existing) Object.assign(existing, cfg.set);
          else
            rsvpRows.push({
              id: nextRsvpId++,
              eventId: v.eventId,
              userId: v.userId,
              status: v.status,
              syncedToDiscordAt: null,
              createdAt: DB_NOW,
              updatedAt: v.updatedAt,
              legacyId: null,
            });
          return Promise.resolve([]);
        },
      }),
    }),
    delete: (..._args: unknown[]) => {
      let predicate: unknown;
      const chain = {
        where(p: unknown) {
          predicate = p;
          return chain;
        },
        returning: (..._a: unknown[]) => Promise.resolve(runDelete(predicate)),
        then(
          onFulfilled?: ((value: unknown[]) => unknown) | null,
          onRejected?: ((reason: unknown) => unknown) | null,
        ) {
          return Promise.resolve(runDelete(predicate)).then(onFulfilled, onRejected);
        },
      };
      return chain;
    },
    update: (..._args: unknown[]) => ({
      set: (values: Partial<FakeRsvp>) => ({
        where: (predicate: unknown) => {
          const ids = new Set(matches(predicate).numbers);
          for (const row of rsvpRows) if (ids.has(row.id)) Object.assign(row, values);
          return Promise.resolve([]);
        },
      }),
    }),
  };

  const db = {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      transactions += 1;
      return fn(tx);
    },
  } as unknown as Db;

  return {
    db,
    boundEventKeys,
    transactions: () => transactions,
    throttleHits: () => throttleHits,
    rowsFor: (eventId: number) => rsvpRows.filter((row) => row.eventId === eventId),
    seedRsvp: (eventId: number, userId: string, status = "going") =>
      rsvpRows.push({
        id: nextRsvpId++,
        eventId,
        userId,
        status,
        syncedToDiscordAt: null,
        createdAt: DB_NOW,
        updatedAt: DB_NOW,
        legacyId: null,
      }),
  };
}

function fixture(opts: { throttleHits?: number } = {}) {
  const store: SessionStore = createMemorySessionStore();
  const fake = makeCaseSensitiveStore(opts.throttleHits ?? 0);
  const sent: QueueMessage[] = [];
  const env = {
    APP_URL,
    SESSION_SECRET,
    SESSION_STORE: store,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    ADMIN_DB: fake.db,
    SYNC_EVENT_QUEUE: { send: async (m: QueueMessage) => void sent.push(m) },
  } as unknown as Env;

  // Sessions rotate on authenticated views, so every request mints a fresh
  // cookie, as in the other mounted RSVP suites.
  async function cookieFor(userId: string, member = true): Promise<string> {
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId,
      username: userId,
      avatar: null,
      member,
      moderator: false,
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

  const post = async (
    key: string,
    status: string,
    as: string | null,
    extra: Record<string, string> = {},
    member = true,
  ) =>
    app.request(
      `/e/${key}/rsvp`,
      {
        method: "POST",
        headers: {
          ...(as ? { cookie: await cookieFor(as, member) } : {}),
          origin: APP_URL,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ status, ...extra }),
      },
      env,
    );

  return { fake, sent, post };
}

describe("POST /e/:key/rsvp event-key aliases (acceptance, hermetic)", () => {
  it("the canonical key answers in one write and returns to the event page (positive control)", async () => {
    const f = fixture();
    const res = await f.post(KEY, "going", MEMBER);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/e/${KEY}`);
    expect(f.fake.boundEventKeys).toEqual([KEY]);
    expect(f.fake.rowsFor(42)).toEqual([
      expect.objectContaining({ eventId: 42, userId: MEMBER, status: "going" }),
    ]);
    expect(f.sent.map((m) => ("eventKey" in m ? m.eventKey : null))).toEqual([KEY]);
  });

  it.each([
    ["lowercase", (k: string) => lower(k)],
    ["mixed-case", (k: string) => mixed(k)],
    ["percent-encoded lowercase", (k: string) => encodedLower(k)],
  ])(
    "a %s alias answer reaches the canonical event row in the same POST",
    async (_label, alias) => {
      const f = fixture();
      const res = await f.post(alias(KEY), "going", MEMBER);
      // Not a canonical-redirect dance: the write lands in THIS request
      // (one transaction), then the adapter 303s to the canonical page.
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/e/${KEY}`);
      expect(f.fake.transactions()).toBe(1);
      // The store is case-sensitive and only holds the uppercase key, so a
      // stored row proves the bound lookup key was the canonical form.
      expect(f.fake.boundEventKeys).toEqual([KEY]);
      expect(f.fake.rowsFor(42)).toEqual([
        expect.objectContaining({ eventId: 42, userId: MEMBER, status: "going" }),
      ]);
      expect(f.sent.map((m) => ("eventKey" in m ? m.eventKey : null))).toEqual([KEY]);
    },
  );

  it("a canonical withdraw deletes the caller's row (positive control)", async () => {
    const f = fixture();
    f.fake.seedRsvp(42, MEMBER);
    const res = await f.post(KEY, "withdraw", MEMBER);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/e/${KEY}`);
    expect(f.fake.boundEventKeys).toEqual([KEY]);
    expect(f.fake.rowsFor(42)).toHaveLength(0);
  });

  it.each([
    ["lowercase", (k: string) => lower(k)],
    ["mixed-case", (k: string) => mixed(k)],
  ])(
    "a %s alias withdraw deletes the caller's row on the canonical event",
    async (_label, alias) => {
      const f = fixture();
      f.fake.seedRsvp(42, MEMBER);
      const res = await f.post(alias(KEY), "withdraw", MEMBER);
      // The already-withdrawn convergence answers this same 303 when the
      // lookup misses, so the redirect alone proves nothing: the seeded
      // row must actually be gone, under the canonical lookup.
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/e/${KEY}`);
      expect(f.fake.boundEventKeys).toEqual([KEY]);
      expect(f.fake.rowsFor(42)).toHaveLength(0);
    },
  );

  it("an alias withdraw with no caller row still converges to the canonical page, having found the event", async () => {
    const f = fixture();
    const res = await f.post(lower(KEY), "withdraw", MEMBER);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/e/${KEY}`);
    expect(f.fake.boundEventKeys).toEqual([KEY]);
    // The event row was found, so the accepted withdraw spent one budget
    // hit even though it deleted nothing — an alias that missed the event
    // would have returned before the charge (see the unknown-key case).
    expect(f.fake.throttleHits()).toBe(1);
    expect(f.fake.rowsFor(42)).toHaveLength(0);
  });

  it("unknown valid keys keep the 404 refusal on answer and the already-withdrawn 303 on withdraw, under their canonical form", async () => {
    const f = fixture();
    const answer = await f.post(lower(UNKNOWN_KEY), "going", MEMBER);
    expect(answer.status).toBe(404);
    const html = await answer.text();
    expect(html).toContain(`<h1>${RSVP_COPY.failedTitle.replaceAll("'", "&#39;")}</h1>`);
    expect(html).toContain('role="alert"');
    expect(html).toContain(`href="/e/${UNKNOWN_KEY}"`);
    expect(html).not.toContain(MEMBER);

    const withdraw = await f.post(mixed(UNKNOWN_KEY), "withdraw", MEMBER);
    expect(withdraw.status).toBe(303);
    expect(withdraw.headers.get("location")).toBe(`/e/${UNKNOWN_KEY}`);

    // Both lookups bound the canonical form and found nothing; an
    // unknown-event write spends no throttle budget and stores no row.
    expect(f.fake.boundEventKeys).toEqual([UNKNOWN_KEY, UNKNOWN_KEY]);
    expect(f.fake.throttleHits()).toBe(0);
    expect(f.fake.rowsFor(42)).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
  });

  it("drafts stay excluded under an alias: the closed refusal, not a write and not a miss", async () => {
    const f = fixture();
    const aliasRes = await f.post(lower(DRAFT_KEY), "going", MEMBER);
    expect(aliasRes.status).toBe(403);
    expect(await aliasRes.text()).toContain(`href="/e/${DRAFT_KEY}"`);
    const canonicalRes = await f.post(DRAFT_KEY, "going", MEMBER);
    expect(canonicalRes.status).toBe(403);
    expect(await canonicalRes.text()).toContain(`href="/e/${DRAFT_KEY}"`);
    // The draft row was found (and closed) under both spellings: no RSVP
    // row, and a policy-refused write spends no budget.
    expect(f.fake.boundEventKeys).toEqual([DRAFT_KEY, DRAFT_KEY]);
    expect(f.fake.rowsFor(43)).toHaveLength(0);
    expect(f.fake.throttleHits()).toBe(0);
  });

  it("a paused event's refusal under an alias keeps 403 and returns to the canonical page", async () => {
    const f = fixture();
    const res = await f.post(mixed(PAUSED_KEY), "going", MEMBER);
    expect(res.status).toBe(403);
    expect(res.headers.get("retry-after")).toBeNull();
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain(`href="/e/${PAUSED_KEY}"`);
    expect(f.fake.boundEventKeys).toEqual([PAUSED_KEY]);
    expect(f.fake.rowsFor(44)).toHaveLength(0);
  });

  it("a throttled alias answer keeps the 429 refusal, Retry-After and announced wait", async () => {
    const f = fixture({ throttleHits: 12 });
    const res = await f.post(lower(KEY), "going", MEMBER);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    const html = await res.text();
    expect(html).toContain(throttleWaitCopy(7));
    expect(html).toContain(`href="/e/${KEY}"`);
    expect(f.fake.boundEventKeys).toEqual([KEY]);
    expect(f.fake.rowsFor(42)).toHaveLength(0);
  });

  it("guests are refused to login with the canonical return path, before any store read", async () => {
    const f = fixture();
    for (const status of ["going", "withdraw"]) {
      const res = await f.post(lower(KEY), status, null);
      expect(res.status, status).toBe(303);
      expect(res.headers.get("location"), status).toBe(
        `/join/discord?next=${encodeURIComponent(`/e/${KEY}`)}`,
      );
    }
    expect(f.fake.transactions()).toBe(0);
    expect(f.fake.boundEventKeys).toEqual([]);
    expect(f.fake.rowsFor(42)).toHaveLength(0);
  });

  it("a signed-in non-member keeps the 403 refusal under an alias, before any store read", async () => {
    const f = fixture();
    const res = await f.post(mixed(KEY), "going", MEMBER, {}, false);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(`href="/e/${KEY}"`);
    expect(f.fake.transactions()).toBe(0);
    expect(f.fake.rowsFor(42)).toHaveLength(0);
  });

  it("filled decoys under an alias still touch no auth, store or service, and return to the canonical page", async () => {
    const f = fixture();
    f.fake.seedRsvp(42, MEMBER);
    for (const status of ["going", "withdraw"]) {
      // No cookie at all: the decoy answers before the session check.
      const res = await f.post(lower(KEY), status, null, { website: "filled" });
      expect(res.status, status).toBe(303);
      expect(res.headers.get("location"), status).toBe(`/e/${KEY}`);
    }
    expect(f.fake.transactions()).toBe(0);
    expect(f.fake.boundEventKeys).toEqual([]);
    // The seeded row survives the decoy "withdraw" untouched.
    expect(f.fake.rowsFor(42)).toHaveLength(1);
    expect(f.sent).toHaveLength(0);
  });

  it("invalid keys stay refused verbatim: refusal on answer, convergence on withdraw, no canonical rewrite", async () => {
    const f = fixture();
    f.fake.seedRsvp(42, MEMBER);
    // `I` is outside the Crockford alphabet, so this 26-char near-miss is
    // not a ULID in any letter case and must never be canonicalized.
    for (const bad of ["not-a-key", `${KEY.slice(0, 25)}I`, KEY.slice(0, 25)]) {
      const answer = await f.post(bad, "going", MEMBER);
      expect(answer.status, bad).toBe(404);
      expect(await answer.text(), bad).toContain(`href="/e/${bad}"`);
      const withdraw = await f.post(bad, "withdraw", MEMBER);
      expect(withdraw.status, bad).toBe(303);
      expect(withdraw.headers.get("location"), bad).toBe(`/e/${bad}`);
    }
    // Nothing was written or withdrawn, and no invalid spelling was ever
    // rewritten into the canonical event's key at the store boundary.
    expect(f.fake.boundEventKeys).not.toContain(KEY);
    expect(f.fake.rowsFor(42)).toHaveLength(1);
    expect(f.sent).toHaveLength(0);
  });
});
