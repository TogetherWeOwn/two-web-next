// route-inventory: GET /streaming/destinations
// route-inventory: POST /streaming/destinations
// route-inventory: PATCH /streaming/destinations/:id
// route-inventory: DELETE /streaming/destinations/:id
// Independent, immutable acceptance handoff. The Builder builds on this
// history unchanged and never edits this file; corrections belong to the
// test author. No runtime source changes.
//
// Streaming simulcast destinations CRUD + Cloudflare output mirroring
// (streaming design spec, section 9, slice S4): per-member RTMP/SRT outputs
// (youtube/twitch/custom) with tier caps (Basic 2 / Plus 5), a per-destination
// enable toggle, mirroring to Cloudflare live outputs, and a drift-repair job.
// Workers never dial out to destination hosts; validity is observed through
// the Cloudflare mirror. Setup copy carries plain Twitch/YouTube terms links
// (no legal advice).
//
// Contract the Builder implements (read this file as the spec):
// 1. Routes (Hono `:id` param name is pinned by the inventory comments
//    above): GET list, POST create, PATCH update, DELETE remove. JSON is
//    negotiated with `Accept: application/json`; without it GET renders the
//    setup page HTML. Unsafe methods require the request Origin (the global
//    same-origin middleware already enforces this; no new exemption).
// 2. Statuses: create 201 `{ destination }`, list 200 `{ destinations }`,
//    update 200 `{ destination }`, delete 200 `{ deleted: true }`, validation
//    and cap failures 422 `{ errors }` with member-readable strings, unknown
//    or foreign ids 404 (no oracle), guest 302 to /auth/discord, signed-in
//    non-member 403, member without an active subscription 403 with
//    subscribe guidance. Guest and non-member verdicts precede any DB read.
// 3. Tiers come from the subscriptions row (`status = 'active'`,
//    `tier basic|plus`, design section 4). Caps count stored rows: a
//    disabled destination still counts; delete frees a slot; a tier change
//    applies to the next write (no cached tier).
// 4. Storage is the stream_destinations table from design section 4
//    (`id, user_id, cf_output_uid, provider, label, url_enc, key_enc, iv,
//    enabled`). `url_enc`/`key_enc`/`iv` are bytea holding AES-256-GCM
//    ciphertext (never plaintext); the IV is 12 bytes. A duplicate
//    (user_id, label) answers 422, never 500. Stream keys never appear in
//    any response body or page.
// 5. Bindings: STREAM_KEYS_KEY carries base64 of the raw 32-byte data key;
//    CF_STREAM_ACCOUNT_ID and CF_STREAM_API_TOKEN authenticate Cloudflare
//    (`Authorization: Bearer <token>` on every call).
// 6. The Builder calls the Cloudflare v4 Stream API over the global fetch:
//    `POST/GET .../live_inputs/:input/outputs` and
//    `PUT|PATCH|DELETE .../live_inputs/:input/outputs/:uid`, parsing the
//    standard `{ result, success }` envelope. The fake below is lenient on
//    request field casing (`url`, `streamKey|stream_key|key`, `enabled`)
//    and mimics that envelope; production field names follow the Cloudflare
//    API reference.
// 7. No dial-out: the fetch stub throws for any host other than
//    api.cloudflare.com, so a create with an unroutable destination URL
//    must still succeed without touching that host.
// 8. Drift repair runs on the scheduled worker for cron `*/15 * * * *`
//    (Builder: add the constant, the runScheduled branch, the
//    handleScheduled job, and the two-web-jobs cron wiring). TWO is the
//    source of truth: recreate missing outputs with the original key and
//    backfill cf_output_uid, push enabled mismatches, delete extras, and
//    converge within a small bounded number of Cloudflare calls.
// 9. Builder chores outside this file: test/fixtures/route-inventory.json,
//    exact `METHOD /path` entries in docs/parity.md or docs/url-freeze.md,
//    wrangler.jobs.jsonc cron wiring plus the jobs-worker-config pin, and
//    the constants value pin in test/jobs.test.ts. The four inventory
//    comments above already live here, so the inventory guard fails until
//    the routes exist; that failure is RED signal, not breakage.
// 10. Out of scope for this file: HTML form POST variants (the Builder may
//    add `_method` overrides like profiles; these tests use JSON), write
//    throttle values, subscription/setup-page behavior (earlier slices),
//    recording, and quotas.
//
// RED expectations on this branch: every database test fails (404s plus the
// missing-tables fixture failure) and the two hermetic guest tests fail
// (404 instead of 302). The unknown-id 404 guards pass vacuously until the
// routes exist; they pin the no-oracle contract and must stay green after.

import { serializeSigned } from "hono/utils/cookie";
import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, JobsEnv } from "../src/env";
import { handleScheduled } from "../src/jobs/worker";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import app from "./app";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "destinations-test-secret-at-least-32-bytes";
const SESSION_COOKIE = "__Host-two_session";

const BASIC_CAP = 2;
const PLUS_CAP = 5;
const DRIFT_CRON = "*/15 * * * *";

const CF_HOST = "api.cloudflare.com";
const CF_ACCOUNT = "test-stream-account";
const CF_TOKEN = "test-stream-token";
const STREAM_KEYS_VALUE = Buffer.from("0123456789abcdef0123456789abcdef", "utf8").toString(
  "base64",
);

const YOUTUBE_PRESET = "rtmp://a.rtmp.youtube.com/live2";
const TWITCH_PRESET = "rtmp://live.twitch.tv/app/";

type Actor = {
  userId: string;
  username: string;
  member: boolean;
  moderator: boolean;
  tier: "basic" | "plus" | null;
};

const BASIC_ACTOR: Actor = {
  userId: "100000000000003621",
  username: "destinations-basic",
  member: true,
  moderator: false,
  tier: "basic",
};
const PLUS_ACTOR: Actor = {
  userId: "100000000000003622",
  username: "destinations-plus",
  member: true,
  moderator: false,
  tier: "plus",
};
const NOSUB_ACTOR: Actor = {
  userId: "100000000000003623",
  username: "destinations-nosub",
  member: true,
  moderator: false,
  tier: null,
};
const OUTSIDER_ACTOR: Actor = {
  userId: "100000000000003624",
  username: "destinations-outsider",
  member: false,
  moderator: false,
  tier: null,
};
const PEER_ACTOR: Actor = {
  userId: "100000000000003625",
  username: "destinations-peer",
  member: true,
  moderator: false,
  tier: "basic",
};
const BASE_ACTORS = [BASIC_ACTOR, PLUS_ACTOR, NOSUB_ACTOR, OUTSIDER_ACTOR, PEER_ACTOR];

const inputUidFor = (actor: Actor): string => `test-input-${actor.userId}`;

function pickString(body: unknown, names: string[]): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  for (const name of names) {
    const value = (body as Record<string, unknown>)[name];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function pickBoolean(body: unknown, names: string[]): boolean | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  for (const name of names) {
    const value = (body as Record<string, unknown>)[name];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

type CfOutput = { uid: string; url: string; key: string; enabled: boolean };
type CfCall = { method: string; path: string; authed: boolean };

// In-memory Cloudflare Stream fake: live inputs keyed by the fixture input
// uid, each holding outputs by Cloudflare uid. Lenient on request field
// casing (contract item 6); strict on paths, methods, and the Bearer token.
class FakeCloudflare {
  readonly calls: CfCall[] = [];
  authFailures = 0;
  mutations = 0;
  private readonly inputs = new Map<string, Map<string, CfOutput>>();
  private nextUid = 1;

  outputsFor(inputUid: string): Map<string, CfOutput> {
    let outs = this.inputs.get(inputUid);
    if (!outs) {
      outs = new Map();
      this.inputs.set(inputUid, outs);
    }
    return outs;
  }

  private envelope(result: unknown): Response {
    return Response.json({ result, success: true, errors: [], messages: [] });
  }

  private failure(message: string, status: number): Response {
    return Response.json(
      { result: null, success: false, errors: [{ message }], messages: [] },
      { status },
    );
  }

  private outputShape(output: CfOutput): Record<string, unknown> {
    return { uid: output.uid, url: output.url, streamKey: output.key, enabled: output.enabled };
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const authed = req.headers.get("authorization") === `Bearer ${CF_TOKEN}`;
    if (!authed) this.authFailures += 1;
    this.calls.push({ method: req.method, path: url.pathname, authed });
    const match = url.pathname.match(
      /^\/client\/v4\/accounts\/[^/]+\/stream\/live_inputs\/([^/]+)(\/outputs(?:\/([^/]+))?)?$/,
    );
    if (!match) return this.failure("unknown Cloudflare path", 404);
    const inputUid = match[1]!;
    const outputsPath = match[2];
    const outputUid = match[3];
    if (!outputsPath) {
      if (req.method === "GET") return this.envelope({ uid: inputUid });
      return this.failure("unsupported live-input method", 404);
    }
    const outs = this.outputsFor(inputUid);
    if (!outputUid) {
      if (req.method === "GET")
        return this.envelope([...outs.values()].map((output) => this.outputShape(output)));
      if (req.method === "POST") {
        const body: unknown = await req.json().catch(() => null);
        const outUrl = pickString(body, ["url"]);
        if (!outUrl) return this.failure("missing output url", 400);
        this.mutations += 1;
        const uid = `cf-output-${this.nextUid++}`;
        outs.set(uid, {
          uid,
          url: outUrl,
          key: pickString(body, ["streamKey", "stream_key", "key"]) ?? "",
          enabled: pickBoolean(body, ["enabled"]) ?? true,
        });
        return this.envelope(this.outputShape(outs.get(uid)!));
      }
      return this.failure("unsupported outputs method", 404);
    }
    const existing = outs.get(outputUid);
    if (!existing) return this.failure("output not found", 404);
    if (req.method === "PUT" || req.method === "PATCH") {
      const body: unknown = await req.json().catch(() => null);
      const outUrl = pickString(body, ["url"]);
      if (outUrl !== undefined) existing.url = outUrl;
      const key = pickString(body, ["streamKey", "stream_key", "key"]);
      if (key !== undefined) existing.key = key;
      const enabled = pickBoolean(body, ["enabled"]);
      if (enabled !== undefined) existing.enabled = enabled;
      this.mutations += 1;
      return this.envelope(this.outputShape(existing));
    }
    if (req.method === "DELETE") {
      outs.delete(outputUid);
      this.mutations += 1;
      return this.envelope({});
    }
    if (req.method === "GET") return this.envelope(this.outputShape(existing));
    return this.failure("unsupported output method", 404);
  }
}

function installFetchStub(fake: FakeCloudflare): void {
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    if (url.hostname !== CF_HOST)
      throw new Error(
        `unexpected outbound fetch to ${url.hostname}: destinations must never dial out`,
      );
    return fake.handle(req);
  });
}

function testEnv(store: SessionStore): Env {
  return {
    APP_URL,
    DISCORD_CLIENT_ID: "test-client",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/test-invite",
    DISCORD_CLIENT_SECRET: "test-client-secret",
    DISCORD_BOT_TOKEN: "test-bot-token",
    SESSION_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
    CF_STREAM_ACCOUNT_ID: CF_ACCOUNT,
    CF_STREAM_API_TOKEN: CF_TOKEN,
    STREAM_KEYS_KEY: STREAM_KEYS_VALUE,
    SESSION_STORE: store,
  } as unknown as Env;
}

function jobsEnv(): JobsEnv {
  return {
    APP_URL,
    DATABASE_URL: process.env.DATABASE_URL!,
    CF_STREAM_ACCOUNT_ID: CF_ACCOUNT,
    CF_STREAM_API_TOKEN: CF_TOKEN,
    STREAM_KEYS_KEY: STREAM_KEYS_VALUE,
    SYNC_EVENT_QUEUE: { send: async () => {} },
    INTERNAL_ACTION_QUEUE: { send: async () => {} },
  } as unknown as JobsEnv;
}

async function cookieFor(store: SessionStore, actor: Actor): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: actor.userId,
    username: actor.username,
    avatar: null,
    member: actor.member,
    moderator: actor.moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const signed = await serializeSigned(SESSION_COOKIE, token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return signed.split(";")[0]!;
}

describe("streaming destinations guest gate (no database)", () => {
  it("redirects guests to Discord sign-in on GET", async () => {
    const store = createMemorySessionStore();
    const res = await app.request(
      "/streaming/destinations",
      { headers: { accept: "text/html" } },
      testEnv(store),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/auth\/discord/);
  });

  it("redirects guests to Discord sign-in on POST", async () => {
    const store = createMemorySessionStore();
    const res = await app.request(
      "/streaming/destinations",
      {
        method: "POST",
        headers: {
          origin: APP_URL,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "custom", label: "Guest", url: YOUTUBE_PRESET, key: "x" }),
      },
      testEnv(store),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/auth\/discord/);
  });
});

type DestinationItem = {
  id: string;
  provider: string;
  label: string;
  url: string;
  enabled: boolean;
};
type CreateBody = { destination?: Partial<DestinationItem>; errors?: unknown } | null;
type ListBody = { destinations?: Partial<DestinationItem>[]; errors?: unknown } | null;
type DeleteBody = { deleted?: unknown; errors?: unknown } | null;

type DestinationRow = {
  id: string;
  user_id: string;
  cf_output_uid: string | null;
  provider: string;
  label: string;
  url_enc: Buffer;
  key_enc: Buffer;
  iv: Buffer;
  enabled: boolean;
};

// Markers of leaked internals. Member copy names the field and the fix;
// it never names constraints, drivers, files, or stack frames.
const INTERNAL_MARKERS =
  /violates|relation "|null value|duplicate key|ECONNREFUSED|ENOTFOUND|TypeError|ReferenceError|\.ts:\d+|at .*:\d+:\d+/i;

function expectMemberReadable(errors: unknown): string {
  expect(errors !== null && typeof errors === "object", "422 carries an errors object").toBe(true);
  const messages = Object.values(errors as Record<string, unknown>).filter(
    (value): value is string => typeof value === "string",
  );
  expect(messages.length, "at least one readable message").toBeGreaterThan(0);
  const joined = messages.join(" | ");
  expect(joined, "no internals leak into member copy").not.toMatch(INTERNAL_MARKERS);
  return joined;
}

describe.skipIf(!process.env.DATABASE_URL)(
  "streaming destinations acceptance (disposable database)",
  () => {
    let fake = new FakeCloudflare();
    let store = createMemorySessionStore();
    let sharedSql: postgres.Sql | null = null;
    let seedError: unknown = null;
    let actorCounter = 0;
    const createdUserIds = new Set<string>();

    const db = (): postgres.Sql => {
      if (!sharedSql) {
        const target = new URL(process.env.DATABASE_URL!);
        sharedSql = postgres(target.href, { max: 1, password: () => target.password });
      }
      return sharedSql;
    };

    const isUndefinedTable = (err: unknown): boolean =>
      typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42P01";

    const forgetMissingTable = async (promise: Promise<unknown>): Promise<void> => {
      try {
        await promise;
      } catch (err) {
        if (!isUndefinedTable(err)) throw err;
      }
    };

    const cleanupRows = async (): Promise<void> => {
      const ids = [...createdUserIds];
      createdUserIds.clear();
      for (const userId of ids) {
        await forgetMissingTable(db()`DELETE FROM stream_destinations WHERE user_id = ${userId}`);
        await forgetMissingTable(db()`DELETE FROM stream_live_inputs WHERE user_id = ${userId}`);
        await forgetMissingTable(db()`DELETE FROM subscriptions WHERE user_id = ${userId}`);
        await forgetMissingTable(db()`DELETE FROM users WHERE id = ${userId}`);
      }
    };

    const seedActor = async (actor: Actor): Promise<void> => {
      createdUserIds.add(actor.userId);
      await db()`INSERT INTO users (id, username, member)
        VALUES (${actor.userId}, ${actor.username}, ${actor.member})
        ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, member = EXCLUDED.member`;
      if (!actor.tier) return;
      await db()`INSERT INTO subscriptions
        (user_id, stripe_customer_id, stripe_subscription_id, tier, status,
         current_period_start, current_period_end, cancel_at_period_end)
        VALUES (${actor.userId}, ${`test-customer-${actor.userId}`},
          ${`test-subscription-${actor.userId}`}, ${actor.tier}, 'active',
          now(), now() + interval '30 days', false)
        ON CONFLICT (user_id) DO UPDATE SET tier = EXCLUDED.tier, status = 'active',
          current_period_end = EXCLUDED.current_period_end`;
      await db()`INSERT INTO stream_live_inputs
        (user_id, cf_input_uid, ingest_key_enc, ingest_key_iv, enabled, recording_mode)
        VALUES (${actor.userId}, ${inputUidFor(actor)},
          ${Buffer.from(`test-ingest-cipher-${actor.userId}`)}, ${Buffer.from("test-iv-0001")},
          true, 'off')
        ON CONFLICT (user_id) DO UPDATE SET cf_input_uid = EXCLUDED.cf_input_uid`;
    };

    const freshSubscriber = async (tier: "basic" | "plus"): Promise<Actor> => {
      actorCounter += 1;
      const actor: Actor = {
        userId: `100000000000003${700 + actorCounter}`,
        username: `destinations-auto-${actorCounter}`,
        member: true,
        moderator: false,
        tier,
      };
      await seedActor(actor);
      return actor;
    };

    const jsonHeaders = (cookie: string): Record<string, string> => ({
      cookie,
      origin: APP_URL,
      accept: "application/json",
      "content-type": "application/json",
    });

    const postCreate = async (
      cookie: string,
      body: Record<string, unknown>,
    ): Promise<{ status: number; json: CreateBody }> => {
      const res = await app.request(
        "/streaming/destinations",
        { method: "POST", headers: jsonHeaders(cookie), body: JSON.stringify(body) },
        testEnv(store),
      );
      return { status: res.status, json: (await res.json().catch(() => null)) as CreateBody };
    };

    const createOk = async (cookie: string, body: Record<string, unknown>): Promise<string> => {
      const res = await postCreate(cookie, body);
      expect(res.status).toBe(201);
      const id = res.json?.destination?.id;
      expect(typeof id).toBe("string");
      return id!;
    };

    const patchDestination = async (
      cookie: string,
      id: string,
      body: Record<string, unknown>,
    ): Promise<{ status: number; json: CreateBody }> => {
      const res = await app.request(
        `/streaming/destinations/${id}`,
        { method: "PATCH", headers: jsonHeaders(cookie), body: JSON.stringify(body) },
        testEnv(store),
      );
      return { status: res.status, json: (await res.json().catch(() => null)) as CreateBody };
    };

    const deleteDestination = async (
      cookie: string,
      id: string,
    ): Promise<{ status: number; json: DeleteBody }> => {
      const res = await app.request(
        `/streaming/destinations/${id}`,
        { method: "DELETE", headers: jsonHeaders(cookie) },
        testEnv(store),
      );
      return { status: res.status, json: (await res.json().catch(() => null)) as DeleteBody };
    };

    const getListJson = async (cookie: string): Promise<{ status: number; json: ListBody }> => {
      const res = await app.request(
        "/streaming/destinations",
        { headers: { cookie, origin: APP_URL, accept: "application/json" } },
        testEnv(store),
      );
      return { status: res.status, json: (await res.json().catch(() => null)) as ListBody };
    };

    const readRows = async (
      userId: string,
    ): Promise<{ rows: DestinationRow[] } | { error: unknown }> => {
      try {
        const rows = await db()`SELECT id, user_id, cf_output_uid, provider, label,
          url_enc, key_enc, iv, enabled FROM stream_destinations WHERE user_id = ${userId}`;
        return { rows: rows as unknown as DestinationRow[] };
      } catch (error) {
        return { error };
      }
    };

    const mustReadRows = async (userId: string, why: string): Promise<DestinationRow[]> => {
      const outcome = await readRows(userId);
      expect("error" in outcome ? outcome.error : null, why).toBeNull();
      if ("error" in outcome) throw new Error("unreachable: rows unreadable");
      return outcome.rows;
    };

    const cfUidFor = (rows: DestinationRow[], id: string): string => {
      const uid = rows.find((row) => row.id === id)?.cf_output_uid;
      expect(typeof uid).toBe("string");
      return uid!;
    };

    const cfCreates = (): number =>
      fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/outputs")).length;

    const runDriftRepair = async (): Promise<unknown> => {
      try {
        await handleScheduled(
          { cron: DRIFT_CRON, scheduledTime: Date.now(), noRetry() {} },
          jobsEnv(),
        );
        return null;
      } catch (err) {
        return err;
      }
    };

    beforeEach(async () => {
      fake = new FakeCloudflare();
      installFetchStub(fake);
      store = createMemorySessionStore();
      await cleanupRows();
      seedError = null;
      try {
        for (const actor of BASE_ACTORS) await seedActor(actor);
      } catch (err) {
        seedError = err;
      }
    });

    afterEach(async () => {
      vi.unstubAllGlobals();
      await cleanupRows();
    });

    afterAll(async () => {
      await cleanupRows();
      await sharedSql?.end();
      sharedSql = null;
    });

    it("has the subscription and live-input base rows this slice builds on", async () => {
      expect(
        seedError,
        "Builder: subscriptions + stream_live_inputs per design section 4 must exist first",
      ).toBeNull();
      const rows = await db()`SELECT user_id, tier, status FROM subscriptions
        WHERE user_id IN (${BASIC_ACTOR.userId}, ${PLUS_ACTOR.userId}) ORDER BY user_id`;
      expect(rows.map((row) => `${row.user_id}:${row.tier}:${row.status}`)).toEqual([
        `${BASIC_ACTOR.userId}:basic:active`,
        `${PLUS_ACTOR.userId}:plus:active`,
      ]);
      const inputs = await db()`SELECT user_id, cf_input_uid FROM stream_live_inputs
        WHERE user_id IN (${BASIC_ACTOR.userId}, ${PLUS_ACTOR.userId})`;
      expect(inputs).toHaveLength(2);
    });

    it("refuses member reads for signed-in non-members", async () => {
      const cookie = await cookieFor(store, OUTSIDER_ACTOR);
      const res = await app.request(
        "/streaming/destinations",
        { headers: { cookie, origin: APP_URL, accept: "text/html" } },
        testEnv(store),
      );
      expect(res.status).toBe(403);
    });

    it("asks members without a subscription to subscribe instead of listing", async () => {
      const cookie = await cookieFor(store, NOSUB_ACTOR);
      const res = await app.request(
        "/streaming/destinations",
        { headers: { cookie, origin: APP_URL, accept: "text/html" } },
        testEnv(store),
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toMatch(/subscrib/i);
    });

    it("refuses destination writes without a subscription and stores nothing", async () => {
      const cookie = await cookieFor(store, NOSUB_ACTOR);
      const res = await postCreate(cookie, {
        provider: "youtube",
        label: "No sub",
        url: YOUTUBE_PRESET,
        key: "test-destination-key-nosub",
      });
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.json)).toMatch(/subscrib/i);
      const rows = await mustReadRows(
        NOSUB_ACTOR.userId,
        "Builder: stream_destinations per design section 4",
      );
      expect(rows).toHaveLength(0);
      expect(cfCreates()).toBe(0);
    });

    it("renders setup copy with terms links and preset helpers for subscribers", async () => {
      const cookie = await cookieFor(store, BASIC_ACTOR);
      const res = await app.request(
        "/streaming/destinations",
        { headers: { cookie, origin: APP_URL, accept: "text/html" } },
        testEnv(store),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      const hrefs = [...html.matchAll(/href="([^"]*)"/gi)].map((match) => match[1]!);
      expect(
        hrefs.filter((href) => /twitch\.tv/i.test(href) && /term/i.test(href)),
        "plain Twitch terms link on setup copy",
      ).not.toHaveLength(0);
      expect(
        hrefs.filter((href) => /youtube/i.test(href) && /term/i.test(href)),
        "plain YouTube terms link on setup copy",
      ).not.toHaveLength(0);
      expect(
        hrefs.every((href) => !href.startsWith("http:")),
        "terms links are https",
      ).toBe(true);
      expect(html).toMatch(/simulcast/i);
      expect(html).toMatch(/exclusiv/i);
      expect(html).toContain(YOUTUBE_PRESET);
      expect(html).toContain(TWITCH_PRESET);
    });

    it("runs the CRUD roundtrip and never echoes the stream key", async () => {
      const actor = await freshSubscriber("plus");
      const cookie = await cookieFor(store, actor);
      const key = "test-destination-key-roundtrip";
      const created = await postCreate(cookie, {
        provider: "youtube",
        label: "Roundtrip",
        url: `${YOUTUBE_PRESET}/roundtrip`,
        key,
      });
      expect(created.status).toBe(201);
      expect(created.json?.destination).toMatchObject({
        provider: "youtube",
        label: "Roundtrip",
        url: `${YOUTUBE_PRESET}/roundtrip`,
        enabled: true,
      });
      const id = created.json?.destination?.id;
      expect(typeof id).toBe("string");
      expect(JSON.stringify(created.json)).not.toContain(key);
      expect(Object.keys(created.json?.destination ?? {}).filter((k) => /key/i.test(k))).toEqual(
        [],
      );

      const listed = await getListJson(cookie);
      expect(listed.status).toBe(200);
      expect(listed.json?.destinations?.map((item) => item.id)).toContain(id);
      expect(JSON.stringify(listed.json)).not.toContain(key);

      const updated = await patchDestination(cookie, id!, { label: "Roundtrip live" });
      expect(updated.status).toBe(200);
      expect(updated.json?.destination?.label).toBe("Roundtrip live");
      expect(updated.json?.destination?.enabled).toBe(true);
      expect(JSON.stringify(updated.json)).not.toContain(key);

      const removed = await deleteDestination(cookie, id!);
      expect(removed.status).toBe(200);
      expect(removed.json?.deleted).toBe(true);

      const relisted = await getListJson(cookie);
      expect(relisted.status).toBe(200);
      expect(relisted.json?.destinations?.map((item) => item.id)).not.toContain(id);
    });

    it("mirrors creates to Cloudflare and backfills the output uid", async () => {
      const actor = await freshSubscriber("basic");
      const cookie = await cookieFor(store, actor);
      const id = await createOk(cookie, {
        provider: "twitch",
        label: "Mirror create",
        url: `${TWITCH_PRESET}mirror-create`,
        key: "test-destination-key-mirror",
      });
      expect(cfCreates()).toBe(1);
      const rows = await mustReadRows(actor.userId, "Builder: cf_output_uid backfill on create");
      const uid = cfUidFor(rows, id);
      const mirrored = fake.outputsFor(inputUidFor(actor)).get(uid);
      expect(mirrored?.url).toBe(`${TWITCH_PRESET}mirror-create`);
      expect(mirrored?.key).toBe("test-destination-key-mirror");
      expect(mirrored?.enabled).toBe(true);
    });

    it("honors the enable toggle in the Cloudflare mirror", async () => {
      const actor = await freshSubscriber("basic");
      const cookie = await cookieFor(store, actor);
      const id = await createOk(cookie, {
        provider: "twitch",
        label: "Toggle night",
        url: `${TWITCH_PRESET}toggle-night`,
        key: "test-destination-key-toggle",
      });
      const rows = await mustReadRows(actor.userId, "Builder: rows exist after create");
      const uid = cfUidFor(rows, id);
      const outs = fake.outputsFor(inputUidFor(actor));

      const disabled = await patchDestination(cookie, id, { enabled: false });
      expect(disabled.status).toBe(200);
      expect(disabled.json?.destination?.enabled).toBe(false);
      expect(outs.get(uid)?.enabled).toBe(false);

      const listed = await getListJson(cookie);
      expect(listed.json?.destinations?.find((item) => item.id === id)?.enabled).toBe(false);

      const enabled = await patchDestination(cookie, id, { enabled: true });
      expect(enabled.status).toBe(200);
      expect(outs.get(uid)?.enabled).toBe(true);
    });

    it("mirrors url and key updates to Cloudflare", async () => {
      const actor = await freshSubscriber("plus");
      const cookie = await cookieFor(store, actor);
      const id = await createOk(cookie, {
        provider: "custom",
        label: "Mirror update",
        url: "rtmp://ingest.example.test/live",
        key: "test-destination-key-before",
      });
      const rows = await mustReadRows(actor.userId, "Builder: rows exist after create");
      const uid = cfUidFor(rows, id);
      const updated = await patchDestination(cookie, id, {
        url: "srt://ingest.example.test:9000",
        key: "test-destination-key-after",
      });
      expect(updated.status).toBe(200);
      expect(updated.json?.destination?.url).toBe("srt://ingest.example.test:9000");
      const mirrored = fake.outputsFor(inputUidFor(actor)).get(uid);
      expect(mirrored?.url).toBe("srt://ingest.example.test:9000");
      expect(mirrored?.key).toBe("test-destination-key-after");
    });

    it("mirrors deletes to Cloudflare and drops the row", async () => {
      const actor = await freshSubscriber("plus");
      const cookie = await cookieFor(store, actor);
      const id = await createOk(cookie, {
        provider: "custom",
        label: "Mirror delete",
        url: "rtmp://ingest.example.test/gone",
        key: "test-destination-key-gone",
      });
      const rows = await mustReadRows(actor.userId, "Builder: rows exist after create");
      const uid = cfUidFor(rows, id);
      const removed = await deleteDestination(cookie, id);
      expect(removed.status).toBe(200);
      expect(
        fake.calls.some(
          (call) => call.method === "DELETE" && call.path.endsWith(`/outputs/${uid}`),
        ),
        "DELETE reaches the Cloudflare output",
      ).toBe(true);
      expect(fake.outputsFor(inputUidFor(actor)).has(uid)).toBe(false);
      const remaining = await mustReadRows(actor.userId, "Builder: delete drops the row");
      expect(remaining.find((row) => row.id === id)).toBeUndefined();
    });

    it("authenticates every Cloudflare call with the API token", async () => {
      const actor = await freshSubscriber("plus");
      const cookie = await cookieFor(store, actor);
      const id = await createOk(cookie, {
        provider: "youtube",
        label: "Authed",
        url: `${YOUTUBE_PRESET}/authed`,
        key: "test-destination-key-authed",
      });
      expect((await patchDestination(cookie, id, { enabled: false })).status).toBe(200);
      expect((await patchDestination(cookie, id, { label: "Authed live" })).status).toBe(200);
      expect((await deleteDestination(cookie, id)).status).toBe(200);
      expect(fake.calls.length).toBeGreaterThan(0);
      expect(fake.authFailures).toBe(0);
    });

    it("caps Basic members at two destinations without mirroring the excess", async () => {
      const actor = await freshSubscriber("basic");
      const cookie = await cookieFor(store, actor);
      for (let n = 1; n <= BASIC_CAP; n += 1) {
        expect(
          (
            await postCreate(cookie, {
              provider: "custom",
              label: `Basic ${n}`,
              url: `rtmp://ingest.example.test/basic-${n}`,
              key: `test-destination-key-basic-${n}`,
            })
          ).status,
        ).toBe(201);
      }
      expect(cfCreates()).toBe(BASIC_CAP);
      const over = await postCreate(cookie, {
        provider: "custom",
        label: "Basic over",
        url: "rtmp://ingest.example.test/basic-over",
        key: "test-destination-key-basic-over",
      });
      expect(over.status).toBe(422);
      const joined = expectMemberReadable(over.json?.errors);
      expect(joined).toMatch(/Basic/);
      expect(joined).toContain(String(BASIC_CAP));
      expect(joined).toMatch(/destination/i);
      expect(cfCreates()).toBe(BASIC_CAP);
      const rows = await mustReadRows(actor.userId, "Builder: rejected create stores nothing");
      expect(rows).toHaveLength(BASIC_CAP);
    });

    it("caps Plus members at five destinations", async () => {
      const actor = await freshSubscriber("plus");
      const cookie = await cookieFor(store, actor);
      for (let n = 1; n <= PLUS_CAP; n += 1) {
        expect(
          (
            await postCreate(cookie, {
              provider: "custom",
              label: `Plus ${n}`,
              url: `rtmp://ingest.example.test/plus-${n}`,
              key: `test-destination-key-plus-${n}`,
            })
          ).status,
        ).toBe(201);
      }
      const over = await postCreate(cookie, {
        provider: "custom",
        label: "Plus over",
        url: "rtmp://ingest.example.test/plus-over",
        key: "test-destination-key-plus-over",
      });
      expect(over.status).toBe(422);
      const joined = expectMemberReadable(over.json?.errors);
      expect(joined).toMatch(/Plus/);
      expect(joined).toContain(String(PLUS_CAP));
      expect(cfCreates()).toBe(PLUS_CAP);
    });

    it("counts disabled destinations toward the cap", async () => {
      const actor = await freshSubscriber("basic");
      const cookie = await cookieFor(store, actor);
      const first = await createOk(cookie, {
        provider: "youtube",
        label: "Cap one",
        url: `${YOUTUBE_PRESET}/cap-one`,
        key: "test-destination-key-cap-one",
      });
      await createOk(cookie, {
        provider: "twitch",
        label: "Cap two",
        url: `${TWITCH_PRESET}cap-two`,
        key: "test-destination-key-cap-two",
      });
      expect((await patchDestination(cookie, first, { enabled: false })).status).toBe(200);
      const over = await postCreate(cookie, {
        provider: "custom",
        label: "Cap three",
        url: "rtmp://ingest.example.test/cap-three",
        key: "test-destination-key-cap-three",
      });
      expect(over.status).toBe(422);
    });

    it("frees a cap slot on delete", async () => {
      const actor = await freshSubscriber("basic");
      const cookie = await cookieFor(store, actor);
      const first = await createOk(cookie, {
        provider: "youtube",
        label: "Slot one",
        url: `${YOUTUBE_PRESET}/slot-one`,
        key: "test-destination-key-slot-one",
      });
      await createOk(cookie, {
        provider: "twitch",
        label: "Slot two",
        url: `${TWITCH_PRESET}slot-two`,
        key: "test-destination-key-slot-two",
      });
      expect((await deleteDestination(cookie, first)).status).toBe(200);
      await createOk(cookie, {
        provider: "custom",
        label: "Slot three",
        url: "rtmp://ingest.example.test/slot-three",
        key: "test-destination-key-slot-three",
      });
    });

    it("applies tier changes to the next write", async () => {
      const actor = await freshSubscriber("basic");
      const cookie = await cookieFor(store, actor);
      for (let n = 1; n <= BASIC_CAP; n += 1) {
        await createOk(cookie, {
          provider: "custom",
          label: `Upgrade ${n}`,
          url: `rtmp://ingest.example.test/upgrade-${n}`,
          key: `test-destination-key-upgrade-${n}`,
        });
      }
      expect(
        (
          await postCreate(cookie, {
            provider: "custom",
            label: "Upgrade capped",
            url: "rtmp://ingest.example.test/upgrade-capped",
            key: "test-destination-key-upgrade-capped",
          })
        ).status,
      ).toBe(422);
      let upgradeError: unknown = null;
      try {
        await db()`UPDATE subscriptions SET tier = 'plus' WHERE user_id = ${actor.userId}`;
      } catch (err) {
        upgradeError = err;
      }
      expect(upgradeError, "Builder: subscriptions tier update per design section 4").toBeNull();
      for (let n = 3; n <= PLUS_CAP; n += 1) {
        await createOk(cookie, {
          provider: "custom",
          label: `Upgrade ${n}`,
          url: `rtmp://ingest.example.test/upgrade-${n}`,
          key: `test-destination-key-upgrade-${n}`,
        });
      }
      const over = await postCreate(cookie, {
        provider: "custom",
        label: "Upgrade over",
        url: "rtmp://ingest.example.test/upgrade-over",
        key: "test-destination-key-upgrade-over",
      });
      expect(over.status).toBe(422);
      expect(expectMemberReadable(over.json?.errors)).toMatch(/Plus/);
    });

    it("rejects cross-member writes with 404 and keeps the row", async () => {
      const ownerCookie = await cookieFor(store, PEER_ACTOR);
      const id = await createOk(ownerCookie, {
        provider: "youtube",
        label: "Peer private",
        url: `${YOUTUBE_PRESET}/peer-private`,
        key: "test-destination-key-peer",
      });
      const otherCookie = await cookieFor(store, BASIC_ACTOR);
      expect((await patchDestination(otherCookie, id, { label: "Taken" })).status).toBe(404);
      expect((await deleteDestination(otherCookie, id)).status).toBe(404);
      const rows = await mustReadRows(PEER_ACTOR.userId, "Builder: foreign delete changes nothing");
      expect(rows.find((row) => row.id === id)?.label).toBe("Peer private");
    });

    it("excludes other members' destinations from the list", async () => {
      const ownerCookie = await cookieFor(store, PEER_ACTOR);
      await createOk(ownerCookie, {
        provider: "youtube",
        label: "Peer listing marker",
        url: `${YOUTUBE_PRESET}/peer-listing`,
        key: "test-destination-key-peer-listing",
      });
      const otherCookie = await cookieFor(store, BASIC_ACTOR);
      const listed = await getListJson(otherCookie);
      expect(listed.status).toBe(200);
      expect(listed.json?.destinations?.map((item) => item.label)).not.toContain(
        "Peer listing marker",
      );
    });

    it("answers unknown ids with 404, never 500", async () => {
      const cookie = await cookieFor(store, PLUS_ACTOR);
      const missing = "00000000-0000-0000-0000-000000000000";
      expect((await patchDestination(cookie, missing, { label: "Ghost" })).status).toBe(404);
      expect((await deleteDestination(cookie, missing)).status).toBe(404);
    });

    it("answers malformed ids with 404, never 500", async () => {
      const cookie = await cookieFor(store, PLUS_ACTOR);
      expect((await patchDestination(cookie, "not-a-uuid", { label: "Ghost" })).status).toBe(404);
      expect((await deleteDestination(cookie, "not-a-uuid")).status).toBe(404);
    });

    const INVALID_CREATES: { name: string; body: Record<string, unknown>; matches: RegExp }[] = [
      {
        name: "rejects unknown providers",
        body: { provider: "vimeo", label: "Vimeo", url: YOUTUBE_PRESET, key: "k" },
        matches: /provider/i,
      },
      {
        name: "rejects https urls",
        body: {
          provider: "custom",
          label: "Https",
          url: "https://ingest.example.test/live",
          key: "k",
        },
        matches: /rtmp|srt/i,
      },
      {
        name: "rejects malformed urls",
        body: { provider: "custom", label: "Malformed", url: "not a url", key: "k" },
        matches: /url|rtmp|srt/i,
      },
      {
        name: "rejects empty labels",
        body: { provider: "custom", label: "  ", url: YOUTUBE_PRESET, key: "k" },
        matches: /label|name/i,
      },
      {
        name: "rejects empty keys",
        body: { provider: "custom", label: "No key", url: YOUTUBE_PRESET, key: "" },
        matches: /key/i,
      },
      { name: "rejects empty bodies", body: {}, matches: /./ },
    ];

    for (const invalid of INVALID_CREATES) {
      it(`${invalid.name} with member-readable copy`, async () => {
        const actor = await freshSubscriber("plus");
        const cookie = await cookieFor(store, actor);
        const res = await postCreate(cookie, invalid.body);
        expect(res.status).toBe(422);
        expect(expectMemberReadable(res.json?.errors)).toMatch(invalid.matches);
        expect(cfCreates()).toBe(0);
      });
    }

    it("rejects duplicate labels per member with member-readable copy", async () => {
      const actor = await freshSubscriber("plus");
      const cookie = await cookieFor(store, actor);
      await createOk(cookie, {
        provider: "youtube",
        label: "Duplicate",
        url: `${YOUTUBE_PRESET}/duplicate-one`,
        key: "test-destination-key-duplicate-one",
      });
      const dup = await postCreate(cookie, {
        provider: "twitch",
        label: "Duplicate",
        url: `${TWITCH_PRESET}duplicate-two`,
        key: "test-destination-key-duplicate-two",
      });
      expect(dup.status).toBe(422);
      expect(expectMemberReadable(dup.json?.errors)).toMatch(/already|duplicate|called/i);
      expect(cfCreates()).toBe(1);
    });

    it("lets two members reuse the same label", async () => {
      const first = await freshSubscriber("basic");
      const second = await freshSubscriber("basic");
      await createOk(await cookieFor(store, first), {
        provider: "youtube",
        label: "Shared label",
        url: `${YOUTUBE_PRESET}/shared-one`,
        key: "test-destination-key-shared-one",
      });
      await createOk(await cookieFor(store, second), {
        provider: "twitch",
        label: "Shared label",
        url: `${TWITCH_PRESET}shared-two`,
        key: "test-destination-key-shared-two",
      });
    });

    it("accepts srt urls for custom destinations", async () => {
      const actor = await freshSubscriber("basic");
      const cookie = await cookieFor(store, actor);
      const id = await createOk(cookie, {
        provider: "custom",
        label: "SRT ingest",
        url: "srt://ingest.example.test:9000",
        key: "test-destination-key-srt",
      });
      const rows = await mustReadRows(actor.userId, "Builder: srt rows persist");
      expect(rows.find((row) => row.id === id)?.provider).toBe("custom");
    });

    it("creates destinations with unroutable hosts without dialing out", async () => {
      const actor = await freshSubscriber("basic");
      const cookie = await cookieFor(store, actor);
      const id = await createOk(cookie, {
        provider: "custom",
        label: "Unroutable",
        url: "rtmp://unroutable.invalid/live",
        key: "test-destination-key-unroutable",
      });
      expect(typeof id).toBe("string");
    });

    it("encrypts urls and keys at rest with a per-row iv", async () => {
      const actor = await freshSubscriber("plus");
      const cookie = await cookieFor(store, actor);
      const url = "rtmp://ingest.example.test/encrypted";
      const key = "test-destination-key-encrypted";
      const id = await createOk(cookie, { provider: "custom", label: "Encrypted", url, key });
      const rows = await mustReadRows(actor.userId, "Builder: bytea columns per design section 4");
      const row = rows.find((r) => r.id === id);
      expect(row?.provider).toBe("custom");
      expect(row?.label).toBe("Encrypted");
      expect(row?.enabled).toBe(true);
      expect(typeof row?.cf_output_uid).toBe("string");
      for (const [column, cipher, plain] of [
        ["url_enc", row?.url_enc, url],
        ["key_enc", row?.key_enc, key],
      ] as const) {
        expect(Buffer.isBuffer(cipher), `${column} is bytea`).toBe(true);
        expect(cipher!.includes(plain), `${column} never holds plaintext`).toBe(false);
      }
      expect(Buffer.isBuffer(row?.iv)).toBe(true);
      expect(row?.iv.length).toBe(12);
    });

    it("keeps stream keys out of every response and page", async () => {
      const actor = await freshSubscriber("basic");
      const cookie = await cookieFor(store, actor);
      const key = "test-destination-key-never-echoed";
      const created = await postCreate(cookie, {
        provider: "youtube",
        label: "Never echoed",
        url: `${YOUTUBE_PRESET}/never-echoed`,
        key,
      });
      expect(created.status).toBe(201);
      expect(JSON.stringify(created.json)).not.toContain(key);
      const listed = await getListJson(cookie);
      expect(listed.status).toBe(200);
      expect(JSON.stringify(listed.json)).not.toContain(key);
      const page = await app.request(
        "/streaming/destinations",
        { headers: { cookie, origin: APP_URL, accept: "text/html" } },
        testEnv(store),
      );
      expect(page.status).toBe(200);
      expect(await page.text()).not.toContain(key);
    });

    it("escapes destination labels in html but keeps them raw in json", async () => {
      const actor = await freshSubscriber("basic");
      const cookie = await cookieFor(store, actor);
      const label = 'Live & <Late> "Tonight"';
      await createOk(cookie, {
        provider: "youtube",
        label,
        url: `${YOUTUBE_PRESET}/escaped`,
        key: "test-destination-key-escaped",
      });
      const page = await app.request(
        "/streaming/destinations",
        { headers: { cookie, origin: APP_URL, accept: "text/html" } },
        testEnv(store),
      );
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("Live &amp; &lt;Late&gt;");
      expect(html).not.toContain("Live & <Late>");
      const listed = await getListJson(cookie);
      expect(
        listed.json?.destinations?.find((item) => item.url === `${YOUTUBE_PRESET}/escaped`)?.label,
      ).toBe(label);
    });

    type DriftSetup = {
      actor: Actor;
      aId: string;
      bId: string;
      ytUrl: string;
      twUrl: string;
      keyA: string;
      keyB: string;
    };

    const setupDriftedMirror = async (): Promise<DriftSetup> => {
      const actor = await freshSubscriber("plus");
      const cookie = await cookieFor(store, actor);
      const keyA = "test-destination-key-drift-a";
      const keyB = "test-destination-key-drift-b";
      const ytUrl = `${YOUTUBE_PRESET}/drift-alpha`;
      const twUrl = `${TWITCH_PRESET}drift-beta`;
      const aId = await createOk(cookie, {
        provider: "youtube",
        label: "Drift Alpha",
        url: ytUrl,
        key: keyA,
      });
      const bId = await createOk(cookie, {
        provider: "twitch",
        label: "Drift Beta",
        url: twUrl,
        key: keyB,
      });
      expect((await patchDestination(cookie, bId, { enabled: false })).status).toBe(200);
      const rows = await mustReadRows(actor.userId, "Builder: drift setup reads TWO truth");
      const outs = fake.outputsFor(inputUidFor(actor));
      // Drift lives in the mirror only: A vanished, B flipped back on, and a
      // rogue output appeared that TWO never stored.
      outs.delete(cfUidFor(rows, aId));
      outs.get(cfUidFor(rows, bId))!.enabled = true;
      outs.set("cf-output-rogue", {
        uid: "cf-output-rogue",
        url: "rtmp://rogue.example.test/live",
        key: "rogue",
        enabled: true,
      });
      return { actor, aId, bId, ytUrl, twUrl, keyA, keyB };
    };

    it("drift-repair reconciles the Cloudflare mirror to the TWO list", async () => {
      const setup = await setupDriftedMirror();
      const callsBefore = fake.calls.length;
      const driftError = await runDriftRepair();
      expect(
        driftError,
        `Builder: register drift-repair for cron "${DRIFT_CRON}" on the scheduled worker`,
      ).toBeNull();
      const after = fake.outputsFor(inputUidFor(setup.actor));
      expect(after.size).toBe(2);
      const recreated = [...after.values()].find((output) => output.url === setup.ytUrl);
      expect(recreated?.key, "missing outputs return with the original key").toBe(setup.keyA);
      expect(recreated?.enabled).toBe(true);
      expect(
        [...after.values()].find((output) => output.url === setup.twUrl)?.enabled,
        "enabled mismatches follow TWO",
      ).toBe(false);
      const rows = await mustReadRows(setup.actor.userId, "Builder: repair backfills output uids");
      expect(rows.find((row) => row.id === setup.aId)?.cf_output_uid).toBe(recreated?.uid);
      expect(
        fake.calls.length - callsBefore,
        "bounded Cloudflare calls per pass",
      ).toBeLessThanOrEqual(20);
    });

    it("drift-repair is a no-op once the mirror matches", async () => {
      await setupDriftedMirror();
      expect(await runDriftRepair(), "first pass converges").toBeNull();
      const mutations = fake.mutations;
      expect(await runDriftRepair(), "second pass also completes").toBeNull();
      expect(fake.mutations, "no further Cloudflare writes").toBe(mutations);
    });
  },
);
