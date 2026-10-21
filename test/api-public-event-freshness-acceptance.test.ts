// route-inventory: GET /api/public/events
// route-inventory: GET /api/public/events/:key
// route-inventory: GET /api/public/community
// route-inventory: GET /api/public/join
// route-inventory: GET /openapi.json
// route-inventory: POST /events
// route-inventory: PATCH /events/:key
// route-inventory: POST /events/:key/publish
// route-inventory: POST /events/:key/cancel
// route-inventory: POST /api/agent-events
// Acceptance (failing-first, Test Author owned): public API preserves event
// freshness across cache hits and mutations (J2). At source pin c84bbef9,
// src/public-data/cache.ts grants a 60s isolate TTL with no mutation fence,
// src/public-data/routes.ts replays a full max-age=60 on cached 200/304 and
// publishes reads without a generation check, and event mutations retire
// HTML/home caches only — so a near-expiry hit extends downstream freshness
// and pre-retirement reads refill after mutation. These tests pin the fix:
// remaining-TTL hits, retire on committed moderator/agent mutations (never on
// refusal/rollback), a generation fence for deferred readers, and preserved
// bounds/ETags/session-free/community/join behavior plus machine-checkable
// docs. Real app + agent-testdb/CI Postgres only for the DB slice; the docs
// slice is offline. Fake clock plus explicit deferred-reader gates, no sleeps.
// The builder implements on this branch and never edits this file; corrections
// return to the Test Author.
import { readFileSync, readdirSync } from "node:fs";
import { URL } from "node:url";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events, rsvps } from "../src/db/admin-schema";
import { users } from "../src/db/schema";
import type { Env } from "../src/env";
import { API_PUBLIC_BOUNDS } from "../src/public-data/contracts";
import type { PublicApiEventCollectionDto, PublicApiEventDto } from "../src/public-data/contracts";
import {
  API_PUBLIC_CACHE_TTL_MS,
  __resetApiPublicCacheForTests,
  readApiPublicCache,
  writeApiPublicCache,
} from "../src/public-data/cache";
import { getOpenApiDocument } from "../src/public-data/openapi";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import { sha256Hex } from "../src/bot/signer";
import {
  DEFAULT_CONFIG as AGENT_DEFAULT_CONFIG,
  handleAgentEvent,
  type IngressConfig,
} from "../src/agent-events/service";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { validatePublicSchema } from "./helpers/public-api-schema";

// Deferred-reader gates: the mocked reads resolve their rows first (so the
// in-flight request has already seen pre-retirement bytes), then pause on the
// test's promise before returning to the route. One-shot per test so a
// concurrent moderator write can never deadlock on the same seam.
const gates = vi.hoisted(() => ({
  collection: null as null | { used: boolean; arrived: () => void; gate: Promise<void> },
  detail: null as null | { used: boolean; arrived: () => void; gate: Promise<void> },
}));
vi.mock("../src/events/reads", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/events/reads")>();
  return {
    ...original,
    listPublicApiEvents: async (...args: Parameters<typeof original.listPublicApiEvents>) => {
      const result = await original.listPublicApiEvents(...args);
      const gate = gates.collection;
      if (gate && !gate.used) {
        gate.used = true;
        gate.arrived();
        await gate.gate;
      }
      return result;
    },
    getPublicApiEvent: async (...args: Parameters<typeof original.getPublicApiEvent>) => {
      const result = await original.getPublicApiEvent(...args);
      const gate = gates.detail;
      if (gate && !gate.used) {
        gate.used = true;
        gate.arrived();
        await gate.gate;
      }
      return result;
    },
  };
});

// The Discord write-back carrier stays out of this suite (covered by the
// write-back suites): stub the transport edge and keep the store transactions
// real. Without this the routes warn on the missing queue binding.
vi.mock("../src/jobs/worker", () => ({
  enqueueSyncEvent: async () => true,
}));

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

// All-digit 26-char keys, same shape as the api-public-events pins, so no
// secret scanner trips and every key parses as a public event id.
const key = (n: number) => String(n).padStart(26, "0");

const maxAgeOf = (res: Response): number | null => {
  const header = res.headers.get("cache-control");
  const match = header ? header.match(/max-age=(\d+)/) : null;
  return match ? Number(match[1]) : null;
};

// ---------------------------------------------------------------------------
// Offline docs slice: canonical API docs explain freshness. No DB needed.
// ---------------------------------------------------------------------------

describe("public API freshness docs (offline)", () => {
  const root = new URL("../", import.meta.url);

  const readDocs = (): string => {
    // Canonical human docs: any markdown under docs/ plus the README. The
    // builder may put the freshness section wherever it fits; the test pins
    // the explanation, not the filename.
    const files: string[] = [];
    try {
      for (const entry of readdirSync(new URL("docs/", root), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(readFileSync(new URL(`docs/${entry.name}`, root), "utf8"));
        }
      }
    } catch {
      // No docs directory in a minimal checkout: fall through to README only.
    }
    try {
      files.push(readFileSync(new URL("README.md", root), "utf8"));
    } catch {
      // Ignore: the assertions below fail with a clear message.
    }
    return files.join("\n");
  };

  it("documents remaining freshness and the 60s bound in the served OpenAPI description", async () => {
    // Machine docs: GET /openapi.json is the canonical machine-readable
    // contract. It must tell an agent that hits carry only what is left of
    // the original 60s window — a hit at t0+59s answers max-age=1, never a
    // fresh full window — and that a fresh miss re-arms the bound.
    const spec = getOpenApiDocument(APP_URL);
    const description = String(spec.info.description ?? "");
    expect(description.toLowerCase()).toContain("fresh");
    expect(description).toContain("60");
    expect(description.toLowerCase()).toMatch(/remain|left|original/);
  });

  it("states same-isolate retirement is not a global edge purge, with TTL as the cross-isolate bound", async () => {
    // The retire is isolate-local (the mutating isolate retires at once);
    // every other isolate converges on TTL expiry. Both the served OpenAPI
    // description and one human doc must say so for the PUBLIC API —
    // anonymous-HTML docs do not satisfy this: the test requires /api/public
    // (or "public api") in the same text as the isolate/TTL explanation.
    const spec = getOpenApiDocument(APP_URL);
    const specText = String(spec.info.description ?? "").toLowerCase();
    expect(specText).toContain("isolate");
    expect(specText).toMatch(/ttl|60/);
    expect(specText).toMatch(/retire|fresh|remain/);
    expect(specText).toMatch(/not.*(global|edge)|isolate-local|same-isolate/);

    const root = new URL("../", import.meta.url);
    const candidates: string[] = [];
    try {
      for (const entry of readdirSync(new URL("docs/", root), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          candidates.push(readFileSync(new URL(`docs/${entry.name}`, root), "utf8"));
        }
      }
    } catch {
      // Ignore: assertion below fails clearly.
    }
    const hasPublicFreshnessDoc = candidates.some((text) => {
      const lower = text.toLowerCase();
      const namesPublicApi = text.includes("/api/public") || lower.includes("public api");
      return (
        namesPublicApi &&
        lower.includes("isolate") &&
        /ttl|max-age|60/.test(lower) &&
        /retire|fresh|remain/.test(lower) &&
        /not.*(global|edge)|isolate-local|same-isolate/.test(lower)
      );
    });
    expect(hasPublicFreshnessDoc).toBe(true);
  });

  it("gives an agent-runnable fixture command for the public API freshness proof", async () => {
    // An agent must be able to reproduce the freshness proof locally: docs
    // name a command that runs the public-API suites against a disposable
    // test database (DATABASE_URL plus a vitest target covering api-public).
    const docs = readDocs();
    expect(docs).toContain("DATABASE_URL");
    expect(docs.toLowerCase()).toContain("vitest");
    expect(docs).toMatch(/api-public/);
  });
});

// ---------------------------------------------------------------------------
// DB slice: remaining TTL, retirement, generation fence, preserved bounds.
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.DATABASE_URL)("public API event freshness acceptance", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  let store: SessionStore;
  let env: Env;

  // Agent ingress identity (one grant per suite; events reset per test, grants
  // persist because the fixture reset keeps grant tables).
  const CALLER = "freshness-agent-under-test";
  const agentCfg: IngressConfig = {
    ...AGENT_DEFAULT_CONFIG,
    enabled: true,
    callerAgentId: CALLER,
    lockWaitMs: 1500,
  };
  const agentToken = `tok-freshness-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let idemCounter = 0;
  const idemKey = () => `freshness-${Date.now()}-${++idemCounter}`;

  const agentCall = (body: unknown, token: string | null = agentToken) =>
    handleAgentEvent(fixture.client, agentCfg, body, token);

  const AGENT_FIELDS = {
    title: "Agent freshness proof",
    game: "Helldivers 2",
    description: "Uniquely labelled freshness proof.",
    starts_at: "2099-10-01 20:00",
    ends_at: "2099-10-01 22:00",
    timezone: "Europe/London",
    location: "Voice: General",
    capacity: 4,
  };

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 5 });
    db = fixture.db;
    store = createMemorySessionStore();
    env = {
      APP_URL,
      SESSION_SECRET,
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_GUILD_ID: "326474832151838730",
      DISCORD_INVITE_URL: "https://discord.gg/invite",
      DISCORD_BOT_TOKEN: "bot-token",
      SESSION_STORE: store,
      // Human-route throttle degrades to allow with no store: this suite
      // never measures the throttle, only cache freshness and retirement.
      THROTTLE_STORE: async () => null,
      SYNC_EVENT_QUEUE: {},
      get ADMIN_DB() {
        return db;
      },
    } as unknown as Env;
    await fixture.client.unsafe(
      `INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash) VALUES ($1,'co',$2,$3)`,
      [CALLER, agentCfg.stagingGuildId, await sha256Hex(agentToken)],
    );
  });

  beforeEach(async () => {
    await fixture.reset();
    __resetApiPublicCacheForTests();
    gates.collection = null;
    gates.detail = null;
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  const get = async (path: string, init: RequestInit = {}, ip = "192.0.2.81") =>
    app.request(path, { ...init, headers: { "cf-connecting-ip": ip, ...init.headers } }, env);

  const seed = (n: number, extra: Record<string, unknown> = {}) =>
    db.insert(events).values({
      eventKey: key(n),
      title: `Game ${n}`,
      status: "published",
      startsAt: new Date(Date.UTC(2099, 0, n, 20)),
      endsAt: new Date(Date.UTC(2099, 0, n, 22)),
      ...extra,
    });

  const smuggleTitle = (eventKey: string, title: string) =>
    fixture.client`update events set title = ${title} where event_key = ${eventKey}`;

  const moderatorCookie = async () => {
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId: "100000000000000171",
      username: "100000000000000171",
      avatar: null,
      member: true,
      moderator: true,
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
  };

  const modWrite = async (method: string, path: string, body?: unknown): Promise<Response> =>
    app.request(
      path,
      {
        method,
        headers: {
          cookie: await moderatorCookie(),
          origin: APP_URL,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );

  const CREATE_FORM = {
    title: "Moderator freshness draft",
    game: "Chess",
    starts_at: "2099-11-04 20:00",
    ends_at: "2099-11-04 22:00",
    timezone: "Europe/London",
    location: "Voice",
    capacity: 8,
  };

  // -- Remaining freshness: hits carry only what is left --------------------

  it("serves a collection 200 hit at t0+59s with max-age=1, not a fresh window", async () => {
    await seed(81);
    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      const first = await get("/api/public/events");
      expect(first.status).toBe(200);
      expect(maxAgeOf(first)).toBe(60);
      const firstBody = await first.text();
      // A hit one second before expiry must not re-arm downstream freshness
      // past the original t0+60s deadline.
      nowSpy.mockReturnValue(t0 + 59_000);
      const hit = await get("/api/public/events");
      expect(hit.status).toBe(200);
      expect(await hit.text()).toBe(firstBody);
      expect(maxAgeOf(hit)).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("serves a detail 200 hit at t0+59s with max-age=1, not a fresh window", async () => {
    await seed(82);
    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      const first = await get(`/api/public/events/${key(82)}`);
      expect(first.status).toBe(200);
      expect(maxAgeOf(first)).toBe(60);
      const firstBody = await first.text();
      nowSpy.mockReturnValue(t0 + 59_000);
      const hit = await get(`/api/public/events/${key(82)}`);
      expect(hit.status).toBe(200);
      expect(await hit.text()).toBe(firstBody);
      expect(maxAgeOf(hit)).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("serves a collection 304 hit at t0+59s with max-age=1", async () => {
    await seed(83);
    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      const first = await get("/api/public/events");
      const etag = first.headers.get("etag");
      expect(etag).not.toBeNull();
      await first.text();
      nowSpy.mockReturnValue(t0 + 59_000);
      const hit = await get("/api/public/events", {
        headers: { "if-none-match": etag! },
      });
      expect(hit.status).toBe(304);
      expect(hit.headers.get("etag")).toBe(etag);
      expect(maxAgeOf(hit)).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("serves a detail 304 hit at t0+59s with max-age=1", async () => {
    await seed(84);
    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      const first = await get(`/api/public/events/${key(84)}`);
      const etag = first.headers.get("etag");
      expect(etag).not.toBeNull();
      await first.text();
      nowSpy.mockReturnValue(t0 + 59_000);
      const hit = await get(`/api/public/events/${key(84)}`, {
        headers: { "if-none-match": etag! },
      });
      expect(hit.status).toBe(304);
      expect(hit.headers.get("etag")).toBe(etag);
      expect(maxAgeOf(hit)).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("retains max-age=60 on fresh misses after expiry", async () => {
    // Control: the documented bound still arms on a miss. A hit at t0+59s
    // carries 1s (above); a miss at t0+60s re-arms the full window.
    await seed(85);
    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      const first = await get("/api/public/events");
      expect(first.status).toBe(200);
      expect(maxAgeOf(first)).toBe(60);
      await first.text();
      nowSpy.mockReturnValue(t0 + API_PUBLIC_CACHE_TTL_MS);
      const miss = await get("/api/public/events");
      expect(miss.status).toBe(200);
      expect(maxAgeOf(miss)).toBe(60);
      const detail = await get(`/api/public/events/${key(85)}`);
      expect(detail.status).toBe(200);
      expect(maxAgeOf(detail)).toBe(60);
    } finally {
      nowSpy.mockRestore();
    }
  });

  // -- Moderator retirement: committed writes retire, refusals do not --------

  it("retires collection and detail on a committed moderator PATCH", async () => {
    // Published rows need a location: the store refuses a published edit
    // that would leave one blank, so the fixture carries Voice.
    await seed(91, { title: "Old title", location: "Voice" });
    const before = await get("/api/public/events");
    expect(await before.text()).toContain("Old title");
    const detailBefore = await get(`/api/public/events/${key(91)}`);
    expect(detailBefore.status).toBe(200);

    // Bypass the store: proves the next fetch would come from cache if the
    // mutation did not retire.
    await smuggleTitle(key(91), "Smuggled title");
    expect(await (await get("/api/public/events")).text()).toContain("Old title");

    const edited = await modWrite("PATCH", `/events/${key(91)}`, { title: "Renamed night" });
    expect(edited.status).toBe(200);

    const after = await get("/api/public/events");
    const html = await after.text();
    expect(html).toContain("Renamed night");
    expect(html).not.toContain("Smuggled title");
    expect(maxAgeOf(after)).toBe(60);
    const detailAfter = await get(`/api/public/events/${key(91)}`);
    expect(detailAfter.status).toBe(200);
    expect(await detailAfter.text()).toContain("Renamed night");
  });

  it("retires the collection on moderator publish so the new event appears", async () => {
    // Publishing requires a non-blank location, so the draft carries one.
    await seed(92, { title: "Debut night", status: "draft", location: "Voice" });
    const before = await get("/api/public/events");
    expect(await before.text()).not.toContain("Debut night");

    const published = await modWrite("POST", `/events/${key(92)}/publish`);
    expect(published.status).toBe(200);

    const after = await get("/api/public/events");
    expect(await after.text()).toContain("Debut night");
    const detail = await get(`/api/public/events/${key(92)}`);
    expect(detail.status).toBe(200);
  });

  it("retires collection and detail on moderator cancel with published-only detail semantics", async () => {
    await seed(93, { title: "Doomed night", location: "Voice" });
    expect(await (await get("/api/public/events")).text()).toContain("Doomed night");
    expect((await get(`/api/public/events/${key(93)}`)).status).toBe(200);

    const cancelled = await modWrite("POST", `/events/${key(93)}/cancel`);
    expect(cancelled.status).toBe(200);

    const after = await get("/api/public/events");
    expect(await after.text()).not.toContain("Doomed night");
    const detail = await get(`/api/public/events/${key(93)}`);
    expect(detail.status).toBe(404);
    expect(await detail.json()).toEqual({
      error: { code: "not_found", message: "No published event with that key." },
    });
  });

  it("retires the collection on moderator create-as-draft (proven via a smuggled row)", async () => {
    // A draft is invisible to the published-only collection, so the retire is
    // proven by re-reading a smuggled published row: without a retire the
    // next fetch still serves the pre-create bytes.
    await seed(94, { title: "Old title" });
    expect(await (await get("/api/public/events")).text()).toContain("Old title");
    await smuggleTitle(key(94), "Smuggled title");
    expect(await (await get("/api/public/events")).text()).toContain("Old title");

    const created = await modWrite("POST", "/events", CREATE_FORM);
    expect(created.status).toBe(201);

    const after = await get("/api/public/events");
    const body = await after.text();
    expect(body).toContain("Smuggled title");
    expect(body).not.toContain("Old title");
  });

  it("keeps entries on moderator refusals (unauthenticated, forbidden, not-found, invalid)", async () => {
    // Control: refusals never reach a commit, so they must never retire.
    // Passes now (nothing retires) and must keep passing after the fix.
    // Both collection and detail warm before the smuggle, so both prove a
    // cache hit (an unwarm detail would miss and read the smuggled row).
    await seed(95, { title: "Old title", location: "Voice" });
    expect(await (await get("/api/public/events")).text()).toContain("Old title");
    expect(await (await get(`/api/public/events/${key(95)}`)).text()).toContain("Old title");
    await smuggleTitle(key(95), "Smuggled title");
    expect(await (await get("/api/public/events")).text()).toContain("Old title");
    expect(await (await get(`/api/public/events/${key(95)}`)).text()).toContain("Old title");

    // Unauthenticated: no cookie.
    const anon = await app.request(
      `/events/${key(95)}`,
      {
        method: "PATCH",
        headers: { origin: APP_URL, "content-type": "application/json" },
        body: JSON.stringify({ title: "Hacker" }),
      },
      env,
    );
    expect(anon.status).toBe(401);

    // Invalid: empty title is refused before any write.
    const invalid = await modWrite("PATCH", `/events/${key(95)}`, { title: "" });
    expect(invalid.status).toBe(422);

    // Not found: unknown key.
    const missing = await modWrite("PATCH", `/events/${key(96)}`, { title: "Ghost" });
    expect(missing.status).toBe(404);

    // Still stale: none of the refusals retired.
    expect(await (await get("/api/public/events")).text()).toContain("Old title");
    const detail = await get(`/api/public/events/${key(95)}`);
    expect(await detail.text()).toContain("Old title");
  });

  it("keeps entries on a rolled-back moderator write (capacity below occupied seats)", async () => {
    // The store opens a transaction, judges capacity under the row lock, and
    // rolls back: the 422 must leave the cache untouched.
    const [ev] = await db
      .insert(events)
      .values({
        eventKey: key(97),
        title: "Old title",
        status: "published",
        startsAt: new Date(Date.UTC(2099, 0, 15, 20)),
        endsAt: new Date(Date.UTC(2099, 0, 15, 22)),
        location: "Voice",
        capacity: 2,
      })
      .returning();
    await db
      .insert(users)
      .values([
        { id: "fresh-named-1", username: "fresh-named-1" },
        { id: "fresh-named-2", username: "fresh-named-2" },
      ])
      .onConflictDoNothing();
    await db.insert(rsvps).values([
      { eventId: ev!.id, userId: "fresh-named-1", status: "going" },
      { eventId: ev!.id, userId: "fresh-named-2", status: "going" },
    ]);
    expect(await (await get("/api/public/events")).text()).toContain("Old title");
    await smuggleTitle(key(97), "Smuggled title");
    expect(await (await get("/api/public/events")).text()).toContain("Old title");

    const rolledBack = await modWrite("PATCH", `/events/${key(97)}`, { capacity: 1 });
    expect(rolledBack.status).toBe(422);

    expect(await (await get("/api/public/events")).text()).toContain("Old title");
  });

  // -- Agent retirement: committed ingress retires, denials do not -----------

  it("retires on committed agent publish and update", async () => {
    await seed(98, { title: "Old title" });
    expect(await (await get("/api/public/events")).text()).toContain("Old title");
    await smuggleTitle(key(98), "Smuggled title");
    expect(await (await get("/api/public/events")).text()).toContain("Old title");

    const created = await agentCall({
      op: "create",
      idempotency_key: idemKey(),
      fields: AGENT_FIELDS,
    });
    expect(created.status).toBe(201);
    const eventKey = (created.body as { event_key: string }).event_key;
    expect(typeof eventKey).toBe("string");

    // Agent create retires too (same seam as the moderator store): the next
    // fetch re-reads past the smuggled row.
    const afterCreate = await get("/api/public/events");
    expect(await afterCreate.text()).toContain("Smuggled title");

    const published = await agentCall({
      op: "publish",
      idempotency_key: idemKey(),
      event_key: eventKey,
    });
    expect(published.status).toBe(200);
    const afterPublish = await get("/api/public/events");
    expect(await afterPublish.text()).toContain("Agent freshness proof");

    const read = await agentCall({
      op: "read",
      idempotency_key: idemKey(),
      event_key: eventKey,
    });
    expect(read.status).toBe(200);
    const version = (read.body as { event: { agent_version: number } }).event.agent_version;
    const updated = await agentCall({
      op: "update",
      idempotency_key: idemKey(),
      event_key: eventKey,
      version,
      fields: { ...AGENT_FIELDS, title: "Agent renamed proof" },
    });
    expect(updated.status).toBe(200);
    const afterUpdate = await get("/api/public/events");
    const body = await afterUpdate.text();
    expect(body).toContain("Agent renamed proof");
    const detail = await get(`/api/public/events/${eventKey}`);
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain("Agent renamed proof");
  });

  it("retires on agent cancel with published-only detail semantics", async () => {
    const created = await agentCall({
      op: "create",
      idempotency_key: idemKey(),
      fields: { ...AGENT_FIELDS, title: "Agent doomed proof" },
    });
    expect(created.status).toBe(201);
    const eventKey = (created.body as { event_key: string }).event_key;
    const published = await agentCall({
      op: "publish",
      idempotency_key: idemKey(),
      event_key: eventKey,
    });
    expect(published.status).toBe(200);
    expect(await (await get("/api/public/events")).text()).toContain("Agent doomed proof");
    expect((await get(`/api/public/events/${eventKey}`)).status).toBe(200);

    const cancelled = await agentCall({
      op: "cancel",
      idempotency_key: idemKey(),
      event_key: eventKey,
    });
    expect(cancelled.status).toBe(200);

    expect(await (await get("/api/public/events")).text()).not.toContain("Agent doomed proof");
    const detail = await get(`/api/public/events/${eventKey}`);
    expect(detail.status).toBe(404);
  });

  it("keeps entries on agent denials (stale version, validation, quota, wrong caller)", async () => {
    // Failing-first on the create retire, control on the denials: the
    // committed create retires (fails now, passes after the fix), while each
    // denial after it retires nothing (must hold both now and after).
    await seed(99, { title: "Old title", location: "Voice" });
    expect(await (await get("/api/public/events")).text()).toContain("Old title");
    await smuggleTitle(key(99), "Smuggled title");
    expect(await (await get("/api/public/events")).text()).toContain("Old title");

    const created = await agentCall({
      op: "create",
      idempotency_key: idemKey(),
      fields: { ...AGENT_FIELDS, title: "Agent denial fixture" },
    });
    expect(created.status).toBe(201);
    const eventKey = (created.body as { event_key: string }).event_key;

    // Stale version: the row moved on (moderator edit bumps agent_version).
    const read = await agentCall({
      op: "read",
      idempotency_key: idemKey(),
      event_key: eventKey,
    });
    expect(read.status).toBe(200);
    const stale = await agentCall({
      op: "update",
      idempotency_key: idemKey(),
      event_key: eventKey,
      version: 999001,
      fields: AGENT_FIELDS,
    });
    expect(stale.status).toBe(409);

    // Validation: empty title is refused.
    const invalid = await agentCall({
      op: "update",
      idempotency_key: idemKey(),
      event_key: eventKey,
      version: (read.body as { event: { agent_version: number } }).event.agent_version,
      fields: { ...AGENT_FIELDS, title: "" },
    });
    expect(invalid.status).toBe(422);

    // Quota: the grant already owns its one proof event.
    const quota = await agentCall({
      op: "create",
      idempotency_key: idemKey(),
      fields: AGENT_FIELDS,
    });
    expect(quota.status).toBe(409);

    // Wrong caller: an unknown credential never reaches the store.
    const wrongCaller = await agentCall(
      { op: "read", idempotency_key: idemKey(), event_key: eventKey },
      "tok-unknown-freshness",
    );
    expect(wrongCaller.status).toBe(401);

    // The create above retired once (proving the seam works); every denial
    // after it retired nothing, so the smuggled bytes stay served.
    expect(await (await get("/api/public/events")).text()).toContain("Smuggled title");
  });

  it("documents that event deletion has no moderator or agent path", async () => {
    // There is deliberately no deleteEvent (src/admin/store-event-reads.ts:
    // "no delete anywhere on this resource") and no agent delete op
    // (OPS is create/read/update/publish/cancel). Cancellation is the
    // terminal record. Retirement therefore covers create/update/publish/
    // cancel only; this test pins the boundary so a future delete cannot
    // slip in without its own retirement.
    const store = await import("../src/admin/store");
    expect("deleteEvent" in store).toBe(false);
    const types = await import("../src/agent-events/types");
    expect([...types.OPS]).toEqual(["create", "read", "update", "publish", "cancel"]);
    // No HTTP delete route for events either (RSVP delete is a different
    // resource and out of scope here).
    const res = await modWrite("DELETE", `/events/${key(91)}`);
    expect([404, 405]).toContain(res.status);
  });

  // -- Generation fence: deferred readers never refill after a retire --------

  it("never settles a pre-retirement collection read after its deferred completion", async () => {
    await seed(101, { title: "Old title", location: "Voice" });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let arrived!: () => void;
    const arrivedAtGate = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    gates.collection = { used: false, arrived, gate };
    try {
      // The in-flight read resolves Old rows, then pauses before returning.
      const inflight = get("/api/public/events");
      await arrivedAtGate;
      // The moderator write commits and retires while the read is parked.
      const edited = await modWrite("PATCH", `/events/${key(101)}`, { title: "New title" });
      expect(edited.status).toBe(200);
      releaseGate();
      // The overtaken response still answers its own pre-retire bytes,
      // proving the race was exercised — but it settles nothing shared.
      const overtaken = await inflight;
      expect(overtaken.status).toBe(200);
      expect(await overtaken.text()).toContain("Old title");
      // The next fetch is fresh: the deferred completion did not refill.
      const fresh = await get("/api/public/events");
      const body = await fresh.text();
      expect(body).toContain("New title");
      expect(body).not.toContain("Old title");
    } finally {
      releaseGate();
      gates.collection = null;
    }
  });

  it("never resurrects a cancelled event via a deferred detail read", async () => {
    await seed(102, { title: "Doomed detail", location: "Voice" });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let arrived!: () => void;
    const arrivedAtGate = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    gates.detail = { used: false, arrived, gate };
    try {
      const inflight = get(`/api/public/events/${key(102)}`);
      await arrivedAtGate;
      const cancelled = await modWrite("POST", `/events/${key(102)}/cancel`);
      expect(cancelled.status).toBe(200);
      releaseGate();
      const overtaken = await inflight;
      expect(overtaken.status).toBe(200);
      expect(await overtaken.text()).toContain("Doomed detail");
      // Published-only semantics win: the deferred 200 must not refill the
      // detail entry the cancel retired.
      const fresh = await get(`/api/public/events/${key(102)}`);
      expect(fresh.status).toBe(404);
      // And the collection stays cancelled-free too.
      expect(await (await get("/api/public/events")).text()).not.toContain("Doomed detail");
    } finally {
      releaseGate();
      gates.detail = null;
    }
  });

  // -- Preserved bounds: 64 entries, byte cap, ETags, session-free ----------

  it("keeps the 64-entry bound with FIFO eviction", async () => {
    // Control: the bound is unchanged. 65 distinct writes evict the oldest;
    // the test uses the module clock seam for determinism.
    const t0 = 1_000_000;
    for (let n = 0; n < 65; n++) {
      writeApiPublicCache(
        `GET /api/public/events?probe=bound-${n}`,
        {
          status: 200,
          headers: { etag: `"bound-${n}"`, "cache-control": "public, max-age=60" },
          body: `{"probe":${n}}`,
        },
        t0,
      );
    }
    expect(readApiPublicCache("GET /api/public/events?probe=bound-0", t0 + 1)).toBeNull();
    expect(readApiPublicCache("GET /api/public/events?probe=bound-64", t0 + 1)).not.toBeNull();
  });

  it("keeps every collection body within 32 KiB by trimming descriptions", async () => {
    // Control: the byte cap still trims instead of dropping rows.
    await seed(111, { description: "x".repeat(100_000), title: "Long read" });
    await seed(112, { description: "y".repeat(100_000), title: "Long read two" });
    const res = await get("/api/public/events");
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(
      API_PUBLIC_BOUNDS.maxBodyBytes,
    );
    const body = JSON.parse(raw) as PublicApiEventCollectionDto;
    expect(body.data).toHaveLength(2);
    for (const row of body.data) expect(row.description!.endsWith("…")).toBe(true);
    expect(validatePublicSchema(body, "PublicApiEventCollection")).toEqual([]);
  });

  it("keeps ETags stable and session-free representations identical", async () => {
    // Control: conditional GET still 304s on an unchanged ETag, a changed row
    // still mints a new ETag, and cookies/moderator sessions buy no extra
    // bytes — the representation is published-only for every viewer.
    await seed(113, { title: "Shared night" });
    const anon = await get("/api/public/events");
    const etag = anon.headers.get("etag");
    expect(etag).not.toBeNull();
    const anonBody = await anon.text();
    const mod = await get("/api/public/events", {
      headers: { cookie: await moderatorCookie() },
    });
    expect(await mod.text()).toBe(anonBody);
    const stray = await get("/api/public/events", {
      headers: { cookie: "stray=crumb" },
    });
    expect(await stray.text()).toBe(anonBody);
    const revalidated = await get("/api/public/events", {
      headers: { "if-none-match": etag! },
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("etag")).toBe(etag);
  });

  it("keeps community and join payloads intact with fresh-miss bounds", async () => {
    // Control: unrelated payloads are untouched by the event-freshness fix.
    // Fresh misses still arm the documented bound; event mutations must not
    // change community/join bytes (their cache entries may rebuild, but the
    // payloads stay identical).
    const community = await get("/api/public/community");
    expect(community.status).toBe(200);
    expect(maxAgeOf(community)).toBe(60);
    expect(validatePublicSchema(await community.json(), "CommunitySnapshot")).toEqual([]);
    const join = await get("/api/public/join");
    expect(join.status).toBe(200);
    expect(maxAgeOf(join)).toBe(60);
    const joinBody = (await (await get("/api/public/join")).json()) as { invite_url: string };
    expect(joinBody.invite_url).toBe("https://discord.gg/invite");

    await seed(114, { title: "Unrelated event", location: "Voice" });
    await get("/api/public/events");
    const edited = await modWrite("PATCH", `/events/${key(114)}`, { title: "Renamed event" });
    expect(edited.status).toBe(200);

    const communityAfter = await get("/api/public/community");
    expect(communityAfter.status).toBe(200);
    expect(validatePublicSchema(await communityAfter.json(), "CommunitySnapshot")).toEqual([]);
    const joinAfter = (await (await get("/api/public/join")).json()) as { invite_url: string };
    expect(joinAfter.invite_url).toBe("https://discord.gg/invite");
  });

  it("keeps conditional GET idempotent and headers machine-checkable", async () => {
    // Control: the same If-None-Match 304s twice with the same ETag, and
    // both 200 and 304 carry parseable cache-control + etag. Frozen clock
    // keeps the remaining-TTL header identical across the two 304s.
    await seed(115);
    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      const first = await get("/api/public/events");
      expect(first.status).toBe(200);
      const etag = first.headers.get("etag")!;
      expect(etag).toMatch(/^".+"$/);
      expect(maxAgeOf(first)).not.toBeNull();
      await first.text();
      const one = await get("/api/public/events", {
        headers: { "if-none-match": etag },
      });
      const two = await get("/api/public/events", {
        headers: { "if-none-match": etag },
      });
      expect(one.status).toBe(304);
      expect(two.status).toBe(304);
      expect(one.headers.get("etag")).toBe(etag);
      expect(two.headers.get("etag")).toBe(etag);
      expect(one.headers.get("cache-control")).toBe(two.headers.get("cache-control"));
      expect(maxAgeOf(one)).not.toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("exposes no privileged data and offers no live invalidation tool", async () => {
    // Control: the fix adds no privileged bytes (no Discord ids, no member
    // data) and no privileged purge endpoint. Unknown invalidation paths
    // stay 404 (an event-key-shaped path keeps its 422 malformed-key refusal,
    // never a purge) and the spec keeps exactly its four public paths.
    await seed(116, { discordEventId: "mirror-fresh-116" });
    const raw = await (await get("/api/public/events")).text();
    expect(raw).not.toContain("mirror-fresh-116");
    const detailRaw = await (await get(`/api/public/events/${key(116)}`)).text();
    expect(detailRaw).not.toContain("mirror-fresh-116");
    for (const path of ["/api/public/cache", "/api/public/invalidate"]) {
      expect((await get(path)).status).toBe(404);
      expect([404, 405]).toContain((await modWrite("POST", path, {})).status);
    }
    // Event-key-shaped: "cache" is not a ULID, so the detail route refuses
    // it as invalid_request — never a purge, never a 200.
    expect((await get("/api/public/events/cache")).status).toBe(422);
    const spec = getOpenApiDocument(APP_URL);
    expect(Object.keys(spec.paths).sort()).toEqual(
      [
        "/api/public/community",
        "/api/public/events",
        "/api/public/events/{key}",
        "/api/public/join",
      ].sort(),
    );
  });
});
