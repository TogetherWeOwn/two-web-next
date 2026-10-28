// route-inventory: GET /admin/events/:key
// route-inventory: POST /admin/events/:key
// route-inventory: POST /admin/events/:key/publish
// route-inventory: POST /admin/events/:key/cancel
// route-inventory: POST /admin/events/:key/rsvp-pause
// route-inventory: POST /admin/events/:key/rsvp-reopen
// Acceptance: a malformed event route key is refused with the existing
// private 404 ("Event not found") after moderator authorization and before
// any event-store work — no event lookup, no roster read, no mutation, and
// therefore no write-back dispatch (dispatch only ever follows a successful
// store call). The shared lookup binds the decoded :key straight into a
// Postgres text equality, and Postgres text cannot represent NUL, so a
// forged key that reaches the store turns into a database failure instead
// of the panel's 404.
//
// Contract notes for the implementer:
// - Admission is the existing eventKeyAllowed contract (src/events/keys.ts):
//   ULID keys pass in any letter case; the exact seed-calendar-NN demo keys
//   pass only on the staging/local APP_URLs that contract already names.
//   No wider grammar: an out-of-range or unpadded seed key refuses even on
//   staging, and every seed key refuses on a production APP_URL.
// - The check sits after the moderator guard (guests still bounce to
//   sign-in, non-moderators still 403) and before the first store call on
//   each handler. Whether it runs before or after the handler's database
//   handle is obtained is free — what is pinned is zero statements.
// - Kit: resolveKitEventEdit takes the deployment APP_URL through its deps
//   (`appUrl`); when provided, a refused key answers notFound with zero
//   get/list calls. Callers that pass no appUrl keep today's behaviour (the
//   existing resolver suites use non-ULID fixture keys), so the production
//   load must always pass env.APP_URL — pinned by the source check below.
// - Valid-but-unknown keys keep refusing through the lookup itself: the
//   statement runs, finds nothing, and the same 404 answers.
//
// Hermetic: memory sessions plus a pg-proxy stub that counts every
// statement and returns no rows. No DATABASE_URL, no Discord, no queue.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import {
  resolveKitEventEdit,
  type KitEventEditDeps,
  type KitEventEditRow,
} from "../src/admin/kit-event-edit";
import { adminApp } from "../src/admin/routes";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { STAGING_APP_URL } from "../src/qa";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const PROD_APP_URL = "https://next.example.test";
const VALID_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const baseEnv: Env = {
  APP_URL: PROD_APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

/** pg-proxy stub: counts statements, records params, answers no rows. */
function countingDb() {
  const seen: { sql: string; params: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    seen.push({ sql, params });
    return { rows: [] as unknown[][] };
  });
  const db = drizzle(query) as unknown as Db;
  // pg-proxy cannot run transactions; run the callback against the same
  // stub so statements inside store transactions are counted like any other.
  (db as { transaction: unknown }).transaction = async (cb: (tx: Db) => Promise<unknown>) => cb(db);
  return { db, query, seen };
}

async function cookieFor(
  store: SessionStore,
  row: { userId: string; username: string; moderator: boolean },
): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.username,
    avatar: null,
    member: true,
    moderator: row.moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const serialized = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return serialized.split(";")[0]!;
}

const store = createMemorySessionStore();
let modCookie = "";
let plebCookie = "";

beforeAll(async () => {
  modCookie = await cookieFor(store, {
    userId: "100000000000000111",
    username: "mod",
    moderator: true,
  });
  plebCookie = await cookieFor(store, {
    userId: "100000000000000222",
    username: "pleb",
    moderator: false,
  });
});

function harness(appUrl: string = PROD_APP_URL) {
  const { db, query, seen } = countingDb();
  const app = adminApp({ sessionStore: store, db });
  const env = { ...baseEnv, APP_URL: appUrl, ADMIN_DB: db } as EnvWithAdminDb;
  const get = (path: string, cookie: string | null = modCookie) =>
    app.request(path, { headers: cookie ? { cookie } : {} }, env);
  const head = (path: string) =>
    app.request(path, { method: "HEAD", headers: { cookie: modCookie } }, env);
  const post = (path: string, cookie: string = modCookie) =>
    app.request(
      path,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ title: "Game night" }).toString(),
      },
      env,
    );
  return { app, env, query, seen, get, head, post };
}

// Path segments as they arrive on the wire; Hono decodes the :key param, so
// %00 reaches the handler as a real NUL and %2F as a slash inside the key.
const MALFORMED = [
  { label: "embedded NUL", segment: "AB%00CD" },
  { label: "NUL only", segment: "%00" },
  { label: "Non-Crockford I at ULID length", segment: "01ARZ3NDEKTSV4RRFFQ69G5FAI" },
  { label: "Non-Crockford L at ULID length", segment: "01ARZ3NDEKTSV4RRFFQ69G5FAL" },
  { label: "Non-Crockford O at ULID length", segment: "01ARZ3NDEKTSV4RRFFQ69G5FAO" },
  { label: "Non-Crockford U at ULID length", segment: "01ARZ3NDEKTSV4RRFFQ69G5FAU" },
  { label: "short key", segment: "abc" },
  { label: "25-char ULID prefix", segment: VALID_ULID.slice(0, 25) },
  { label: "27-char ULID plus one", segment: `${VALID_ULID}V` },
  { label: "oversized 300-char key", segment: "A".repeat(300) },
  { label: "encoded slash", segment: "AB%2FCD" },
  { label: "encoded space", segment: "AB%20CD" },
  { label: "encoded question mark", segment: "AB%3FCD" },
  { label: "punctuation", segment: "key!" },
] as const;

const SUBSET = [MALFORMED[0]!, MALFORMED[5]!, MALFORMED[9]!, MALFORMED[10]!];

describe("Hono admin event edit read refuses malformed keys before the store", () => {
  it.each(MALFORMED)("GET $label: private 404 with zero statements", async ({ segment }) => {
    const h = harness();
    const res = await h.get(`/events/${segment}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toContain("private");
    expect(await res.text()).toContain("Event not found");
    expect(h.query).not.toHaveBeenCalled();
  });

  it.each(SUBSET)("HEAD $label: 404 with zero statements", async ({ segment }) => {
    const h = harness();
    const res = await h.head(`/events/${segment}`);
    expect(res.status).toBe(404);
    expect(h.query).not.toHaveBeenCalled();
  });
});

describe("Hono admin event writes refuse malformed keys before the store", () => {
  it.each(SUBSET)("POST edit $label: private 404 with zero statements", async ({ segment }) => {
    const h = harness();
    const res = await h.post(`/events/${segment}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Event not found");
    expect(h.query).not.toHaveBeenCalled();
  });

  for (const action of ["publish", "cancel", "duplicate", "rsvp-pause", "rsvp-reopen"] as const) {
    it.each(SUBSET)(
      `POST ${action} $label: private 404 with zero statements`,
      async ({ segment }) => {
        const h = harness();
        const res = await h.post(`/events/${segment}/${action}`);
        expect(res.status).toBe(404);
        expect(await res.text()).toContain("Event not found");
        expect(h.query).not.toHaveBeenCalled();
      },
    );
  }
});

describe("seed demo keys keep their exact staging/local allowance on Hono reads", () => {
  it("seed key on a production APP_URL refuses with zero statements", async () => {
    const h = harness(PROD_APP_URL);
    const res = await h.get("/events/seed-calendar-01");
    expect(res.status).toBe(404);
    expect(h.query).not.toHaveBeenCalled();
  });

  it.each(["seed-calendar-99", "seed-calendar-1", "seed-calendar-00"])(
    "%s refuses even on staging (exact allowance only)",
    async (key) => {
      const h = harness(STAGING_APP_URL);
      const res = await h.get(`/events/${key}`);
      expect(res.status).toBe(404);
      expect(h.query).not.toHaveBeenCalled();
    },
  );

  it.each([STAGING_APP_URL, "http://localhost:8787", "http://127.0.0.1:8787"])(
    "seed key on %s is admitted to the lookup (unknown here, so lookup 404)",
    async (appUrl) => {
      const h = harness(appUrl);
      const res = await h.get("/events/seed-calendar-01");
      expect(res.status).toBe(404);
      expect(h.query).toHaveBeenCalled();
      expect(h.seen[0]!.params).toEqual(["seed-calendar-01"]);
    },
  );
});

describe("admitted keys and the guard keep today's behaviour (controls)", () => {
  it("valid unknown ULID reaches the lookup with the key unchanged, then 404s", async () => {
    const h = harness();
    const res = await h.get(`/events/${VALID_ULID}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Event not found");
    expect(h.query).toHaveBeenCalled();
    expect(h.seen[0]!.params).toEqual([VALID_ULID]);
  });

  it("lowercase ULID is admitted to the lookup (the contract is case-insensitive)", async () => {
    const h = harness();
    const res = await h.get(`/events/${VALID_ULID.toLowerCase()}`);
    expect(res.status).toBe(404);
    expect(h.query).toHaveBeenCalled();
  });

  it("valid unknown ULID on POST edit reaches the lookup, then 404s", async () => {
    const h = harness();
    const res = await h.post(`/events/${VALID_ULID}`);
    expect(res.status).toBe(404);
    expect(h.query).toHaveBeenCalled();
    expect(h.seen[0]!.params).toEqual([VALID_ULID]);
  });

  it("valid unknown ULID on publish reaches the store, then 404s as not found", async () => {
    const h = harness();
    const res = await h.post(`/events/${VALID_ULID}/publish`);
    expect(res.status).toBe(404);
    expect(h.query).toHaveBeenCalled();
  });

  it("guests still bounce to sign-in on a malformed key, with zero statements", async () => {
    const h = harness();
    const res = await h.get("/events/AB%00CD", null);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth/discord");
    expect(h.query).not.toHaveBeenCalled();
  });

  it("non-moderators still 403 on malformed keys, read and write, zero statements", async () => {
    const h = harness();
    const read = await h.get("/events/AB%00CD", plebCookie);
    expect(read.status).toBe(403);
    const write = await h.post("/events/AB%00CD/publish", plebCookie);
    expect(write.status).toBe(403);
    expect(h.query).not.toHaveBeenCalled();
  });
});

// --- Kit event-edit resolver -------------------------------------------------

type DepsWithAppUrl = KitEventEditDeps & { appUrl?: string };
const kitDb = {} as Db;
const kitRow: KitEventEditRow = {
  eventKey: VALID_ULID,
  title: "Game night",
  game: "Chess",
  description: "Casual play",
  startsAt: new Date("2030-01-01T19:00:00.000Z"),
  endsAt: new Date("2030-01-01T21:00:00.000Z"),
  timezone: "UTC",
  location: "Hall",
  capacity: 8,
  status: "draft",
  rsvpOpen: true,
  recurrenceFrequency: null,
};

function kitDeps(appUrl: string, row: KitEventEditRow | null = kitRow) {
  const get = vi.fn(async (_db: Db, _key: string) => row);
  const list = vi.fn(async () => ({ rows: [], total: 0 }));
  const deps: DepsWithAppUrl = { db: kitDb, get, list, appUrl };
  return { deps, get, list };
}

const KIT_MALFORMED = [
  { label: "embedded NUL", key: "AB\u0000CD" },
  { label: "NUL only", key: "\u0000" },
  { label: "Non-Crockford U at ULID length", key: "01ARZ3NDEKTSV4RRFFQ69G5FAU" },
  { label: "short key", key: "abc" },
  { label: "27-char ULID plus one", key: `${VALID_ULID}V` },
  { label: "oversized 300-char key", key: "A".repeat(300) },
  { label: "slash inside key", key: "AB/CD" },
  { label: "space inside key", key: "AB CD" },
] as const;

describe("Kit event-edit resolver refuses malformed keys before its reads", () => {
  it.each(KIT_MALFORMED)("$label: notFound with zero get/list calls", async ({ key }) => {
    const { deps, get, list } = kitDeps(PROD_APP_URL);
    const outcome = await resolveKitEventEdit(key, {}, deps);
    expect(outcome).toEqual({ kind: "notFound" });
    expect(get).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("seed key refuses on a production appUrl and out-of-range seeds refuse on staging", async () => {
    const prod = kitDeps(PROD_APP_URL);
    expect(await resolveKitEventEdit("seed-calendar-01", {}, prod.deps)).toEqual({
      kind: "notFound",
    });
    expect(prod.get).not.toHaveBeenCalled();
    const staging = kitDeps(STAGING_APP_URL);
    expect(await resolveKitEventEdit("seed-calendar-99", {}, staging.deps)).toEqual({
      kind: "notFound",
    });
    expect(staging.get).not.toHaveBeenCalled();
    expect(staging.list).not.toHaveBeenCalled();
  });

  it("valid ULID still resolves the row and roster (control)", async () => {
    const { deps, get, list } = kitDeps(PROD_APP_URL);
    const outcome = await resolveKitEventEdit(VALID_ULID, {}, deps);
    expect(outcome.kind).toBe("ok");
    expect(get).toHaveBeenCalledWith(kitDb, VALID_ULID);
    expect(list).toHaveBeenCalled();
  });

  it("valid unknown ULID still refuses through the lookup (control)", async () => {
    const { deps, get, list } = kitDeps(PROD_APP_URL, null);
    const outcome = await resolveKitEventEdit(VALID_ULID, {}, deps);
    expect(outcome).toEqual({ kind: "notFound" });
    expect(get).toHaveBeenCalledWith(kitDb, VALID_ULID);
    expect(list).not.toHaveBeenCalled();
  });

  it.each([STAGING_APP_URL, "http://localhost:8787"])(
    "seed key on %s is admitted to the Kit lookup (control)",
    async (appUrl) => {
      const { deps, get } = kitDeps(appUrl, { ...kitRow, eventKey: "seed-calendar-01" });
      const outcome = await resolveKitEventEdit("seed-calendar-01", {}, deps);
      expect(outcome.kind).toBe("ok");
      expect(get).toHaveBeenCalledWith(kitDb, "seed-calendar-01");
    },
  );

  it("lowercase ULID is admitted to the Kit lookup (control)", async () => {
    const lower = VALID_ULID.toLowerCase();
    const { deps, get } = kitDeps(PROD_APP_URL, { ...kitRow, eventKey: lower });
    const outcome = await resolveKitEventEdit(lower, {}, deps);
    expect(outcome.kind).toBe("ok");
    expect(get).toHaveBeenCalled();
  });
});

describe("Kit event-edit load wiring", () => {
  // Source-text by design: the load imports cloudflare:workers and cannot
  // run in the root Vitest process (same reason the page-contract suite
  // pins this file as text). What matters is that production always hands
  // the resolver the deployment APP_URL.
  const load = readFileSync(
    fileURLToPath(
      new URL("../web/src/routes/admin/events/[key]/+page.server.ts", import.meta.url).href,
    ),
    "utf8",
  );

  it("passes env.APP_URL to the resolver as appUrl", () => {
    expect(load).toContain("resolveKitEventEdit");
    expect(load).toMatch(/appUrl\s*:\s*env\.APP_URL/);
  });
});
