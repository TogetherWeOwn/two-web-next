// TOG-18976: anonymous event-card cache decision (ledger A5,
// docs/w15-events-acceptance-ledger.md:90).
//
// Decision: PARTIAL/ADAPTED. Drop the home-page (`/`) shared cache with
// measurement; keep timed expiry on `/events` + `/events/past` with retire
// on publish/edit/RSVP-settle (N6 closes the R12 invalidation divergence
// from legacy: Feature/Events/AnonymousEventCardCacheTest.php, TOG-9277).
// Anonymous `/events` cards are `public, max-age=60` with `Vary: Cookie` and
// proven anonymous (test/guest-calendar-anon.test.ts); anonymous
// `/events/past` cards are `public, max-age=300` with no RSVP controls
// (test/islands-past-events.test.ts:107-122). Every committed request-path
// event or RSVP mutation retires the shared entries, so the next guest fetch
// shows the new title and going count; only the scheduled reconcile close
// still relies on timed expiry (stale placement for up to 60 s on `/events`
// or 300 s on `/events/past`). Home stays `private, no-store` because:
// - no measured p95 problem: staging anonymous `/`, n=20, median 175 ms /
//   p95 261 ms TTFB, inside the 600 ms server-response tripwire;
// - home is viewer-specific funnel top (guest/member header, hero CTA,
//   one-shot join flash, ?n= notices, outage fallbacks) — a shared entry
//   risks leaking member state or pinning empty/unavailable states;
// - cost is already bounded: 3 capped rows + batched going counts,
//   isolate-local 60 s counts cache, 400 ms statement timeouts + 1000 ms
//   deadline with graceful fallback.
//
// This suite pins the disposition: the ledger row says Partial/adapted with
// timed expiry, anonymous home bodies stay private with no session data,
// and viewer-specific variants (flash, notice) stay private too. The retire
// itself is pinned by test/anonymous-event-card-cache-retire.test.ts.
// Hermetic pg-proxy fixtures only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { JOIN_RESULT_COOKIE } from "../src/return-journey";
import app from "./app";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const NOW = new Date("2030-07-04T18:00:00Z");

const baseEnv: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

function row(id: number): typeof events.$inferSelect {
  const startsAt = new Date(NOW.getTime() + id * 3600_000);
  return {
    id,
    icsSequence: 1n,
    eventKey: `event-${id}`,
    title: `Game night ${id}`,
    game: null,
    description: "Private host notes",
    startsAt,
    endsAt: new Date(startsAt.getTime() + 7200_000),
    timezone: "Europe/London",
    location: "Voice lobby",
    capacity: null,
    status: "published",
    discordEventId: "discord-event-id",
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: "private-creator-id",
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fixture(rows: (typeof events.$inferSelect)[] = []) {
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const db = drizzle(async (sql: string, params: unknown[]) => {
    if (sql.includes('from "featured_contents"')) return { rows: [] };
    if (sql.includes("set_config")) return { rows: [] };
    if (sql.includes('from "rsvps"'))
      return { rows: [[1, 2]].filter(([id]) => params.includes(id)) };
    let selected = [...rows];
    if (sql.includes('"status" =')) selected = selected.filter((r) => r.status === params[0]);
    if (sql.includes("limit")) selected = selected.slice(0, Number(params.at(-1)));
    return {
      rows: selected.map((r) =>
        columns.map((k) => (r[k] instanceof Date ? r[k].toISOString() : r[k])),
      ),
    };
  }) as unknown as Db;
  Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
  const env = { ...baseEnv, ADMIN_DB: db } as Env;
  return { env, request: (path: string, init?: RequestInit) => app.request(path, init, env) };
}

async function flashCookie(): Promise<string> {
  return (
    (await serializeSigned(JOIN_RESULT_COOKIE, "added", SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })) as string
  ).split(";")[0]!;
}

describe("anonymous event-card cache decision (TOG-18976, ledger A5)", () => {
  it("records the Partial/adapted disposition with the timed-expiry divergence", () => {
    const ledger = readFileSync(
      join(__dirname, "..", "docs", "w15-events-acceptance-ledger.md"),
      "utf8",
    );
    const row = ledger.split("\n").find((line) => line.startsWith("| A5 "));
    expect(row, "ledger keeps an A5 row").toBeDefined();
    expect(row!).toMatch(/Partial\/adapted/i);
    expect(row!).toMatch(/TOG-18976/);
    expect(row!).toMatch(/timed expiry/i);
    expect(row!).toMatch(/guest-calendar-anon/);
    expect(row!).toMatch(/islands-past-events/);
    expect(row!).not.toMatch(/Dropped for home/);
  });

  it("serves anonymous home cards private with no session data", async () => {
    const { request } = fixture([row(1), row(2), row(3)]);
    const res = await request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const html = await res.text();
    expect(html).toContain('data-testid="home-events-list"');
    expect(html).toContain("Game night 1");
    for (const secret of [
      "private-creator-id",
      "discord-event-id",
      "Private host notes",
      "user_id",
    ]) {
      expect(html).not.toContain(secret);
    }
  });

  it("keeps the anonymous empty state private", async () => {
    const { request } = fixture([]);
    const res = await request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toContain('data-testid="home-events-empty"');
  });

  it("keeps viewer-specific variants (flash, notice) private", async () => {
    const { request } = fixture([row(1)]);
    const flashed = await request("/", { headers: { cookie: await flashCookie() } });
    expect(flashed.status).toBe(200);
    expect(flashed.headers.get("cache-control")).toBe("private, no-store");
    const noticed = await fixture([row(1)]).request("/?n=joined");
    expect(noticed.status).toBe(200);
    expect(noticed.headers.get("cache-control")).toBe("private, no-store");
  });
});
