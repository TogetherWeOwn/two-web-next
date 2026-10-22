// route-inventory: GET /hotzones
// route-inventory: GET /hotzones/:signal
// Acceptance (test files only) for hot-zone heatmap pages.
//
// Contract lock-in (Test Author). The Builder implements against this file;
// nothing here may change to make an implementation pass.
//
// Routes (v1, Hono + SvelteKit strangler shells serving the same reads, per
// the web/src/routes/events/past/ precedent):
// - `/hotzones` — index with hour x weekday grids for joins, voice, games,
//   each linking its signal view. Seasonal via `?season=`.
// - `/hotzones/[signal]` — per-signal drill-down, signal in
//   `joins | voice | games` exactly. Any other segment 404s, never a grid.
// - Builder exposes these paths on the Hono app with the same aggregate
//   reads the Kit `load` functions call, so this Vitest suite (which drives
//   the Hono app) proves the contract; the Kit shells under
//   web/src/routes/hotzones/ carry `csr = false` and the same grammar.
// - The sibling game-leaderboards slice owns `/leaderboards` +
//   `/leaderboards/[game]`; this card never duplicates them.
//
// `?season=` grammar (pure date-window function, no seasons table in v1,
// shared with the sibling `?season=`):
// - absent -> `all` (default, unbounded)
// - `all` -> unbounded
// - `YYYY` (e.g. 2026) -> 1 Jan..31 Dec UTC
// - `YYYY-MM` (e.g. 2026-09) -> month window UTC
// - `YYYY-QN`, N 1..4 (e.g. 2026-Q3) -> quarter window UTC
// - anything else -> 400, never a silent fallback window.
// Joins cells aggregate real web data (`join_attempts.createdAt` in the
// window); voice/games cells are the WhatPulse-seeded prior with the rollup
// semantics, rendered labeled as estimates until bot event-store
// calibration. Season filtering is proven on joins (real data); the seeded
// priors keep their own re-weight schedule.
//
// Visibility: hot-zone grids and voice/games views are aggregates only (7x24
// cells, no per-user rows or timestamps). Index/joins may list published
// gatherings with titles and times outside the grids. Pages are public like
// /events. Member-gating applies to the member leaderboard (sibling file), not here.
//
// How this fails before the Builder lands: unknown-signal guards pass (404
// today), everything else fails — Hono answers 404 where 200/400 is pinned,
// the Kit shells are absent, and the joins season windows cannot differ.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import { joinAttempts } from "../src/db/schema";
import type { Env } from "../src/env";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { createMemorySessionStore } from "../src/sessions";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shell = (path: string) => resolve(root, path);

const SIGNALS = ["joins", "voice", "games"] as const;

// Synthetic probe identities: no real member data, never a live lookup.
const PROBE_PREFIX = "zxq-hotzone-absence";

describe("hot-zone route list + signal vocabulary (no DB)", () => {
  it("serves the index with links to the three signal views", async () => {
    const res = await app.request("/hotzones", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    for (const signal of SIGNALS) expect(html).toContain(`/hotzones/${signal}`);
  });

  it.each([...SIGNALS])("serves the %s drill-down as its own grid", async (signal) => {
    const res = await app.request(`/hotzones/${signal}`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain(signal);
  });

  it.each(["presence", "messages", "activity", "JOINS", "Voice"])(
    "answers /hotzones/%s with 404, never a grid",
    async (unknown) => {
      const res = await app.request(`/hotzones/${unknown}`, {}, env);
      expect(res.status).toBe(404);
    },
  );

  it.each(["all", "2026", "2026-09", "2026-Q3"])(
    "accepts ?season=%s on the index",
    async (season) => {
      const res = await app.request(`/hotzones?season=${season}`, {}, env);
      expect(res.status).toBe(200);
    },
  );

  it.each(["presence", "last-season", "2026-13", "2026-Q5", "Q3-2026", "2026/09", ""])(
    "rejects ?season=%s with 400, never a silent fallback window",
    async (season) => {
      const res = await app.request(`/hotzones?season=${encodeURIComponent(season)}`, {}, env);
      expect(res.status).toBe(400);
    },
  );

  it("rejects a bad season on a signal view before any aggregation", async () => {
    const res = await app.request("/hotzones/joins?season=not-a-season", {}, env);
    expect(res.status).toBe(400);
  });
});

describe("hot-zone SvelteKit shells (no DB)", () => {
  it("ships a server-rendered index shell", () => {
    expect(existsSync(shell("web/src/routes/hotzones/+page.server.ts"))).toBe(true);
    expect(existsSync(shell("web/src/routes/hotzones/+page.svelte"))).toBe(true);
    expect(readFileSync(shell("web/src/routes/hotzones/+page.server.ts"), "utf8")).toContain(
      "csr = false",
    );
  });

  it("ships a server-rendered per-signal shell with the locked vocabulary", () => {
    expect(existsSync(shell("web/src/routes/hotzones/[signal]/+page.server.ts"))).toBe(true);
    expect(existsSync(shell("web/src/routes/hotzones/[signal]/+page.svelte"))).toBe(true);
    const server = readFileSync(shell("web/src/routes/hotzones/[signal]/+page.server.ts"), "utf8");
    expect(server).toContain("csr = false");
    for (const signal of SIGNALS) expect(server).toContain(signal);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("hot-zone grids (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  let live: Env;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
    const store = createMemorySessionStore();
    live = {
      ...env,
      get ADMIN_DB() {
        return db;
      },
      SESSION_STORE: store,
      DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
    } as unknown as Env;
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  const seedJoins = async () => {
    // Eight September attempts in one hour + one January attempt: the two
    // season windows must render differently, proving the window filters.
    await db.insert(joinAttempts).values(
      Array.from({ length: 8 }, (_, n) => ({
        outcome: "added",
        source: `${PROBE_PREFIX}-sept`,
        requestId: `${PROBE_PREFIX}-sept-${n}`,
        discordId: null,
        createdAt: new Date("2026-09-07T20:05:00Z"),
      })),
    );
    await db.insert(joinAttempts).values({
      outcome: "added",
      source: `${PROBE_PREFIX}-jan`,
      requestId: `${PROBE_PREFIX}-jan-0`,
      discordId: null,
      createdAt: new Date("2025-01-06T03:05:00Z"),
    });
    await db.insert(events).values({
      eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      title: `${PROBE_PREFIX} Friday games`,
      status: "published",
      startsAt: new Date("2026-09-07T20:00:00Z"),
      endsAt: new Date("2026-09-07T22:00:00Z"),
    });
  };

  it("renders joins from real web data with no per-user rows", async () => {
    await fixture.reset();
    await seedJoins();
    const res = await app.request("/hotzones/joins?season=2026-09", {}, live);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Monday");
    const outsideGatherings = html.replace(
      /<section\b[^>]*data-testid="hotzone-gatherings"[^>]*>[\s\S]*?<\/section>/g,
      "",
    );
    expect(outsideGatherings).not.toMatch(/20\d\d-\d\d-\d\dT\d\d:/);
    expect(html).not.toContain("discord_id");
    expect(html).not.toContain("created_at");
    expect(html).not.toContain("presence");
    expect(outsideGatherings).not.toContain(PROBE_PREFIX);
  });

  it("filters the joins window by season", async () => {
    await fixture.reset();
    await seedJoins();
    const sept = await (await app.request("/hotzones/joins?season=2026-09", {}, live)).text();
    const jan = await (await app.request("/hotzones/joins?season=2025-01", {}, live)).text();
    expect(sept).not.toBe(jan);
    const all = await (await app.request("/hotzones/joins", {}, live)).text();
    expect(all).not.toBe(jan);
  });

  it.each(["voice", "games"])("labels %s cells as estimates", async (signal) => {
    await fixture.reset();
    await seedJoins();
    const res = await app.request(`/hotzones/${signal}?season=2026-09`, {}, live);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/estimat/i);
  });

  it("keeps voice/games grids aggregate-only too", async () => {
    await fixture.reset();
    await seedJoins();
    for (const signal of ["voice", "games"] as const) {
      const res = await app.request(`/hotzones/${signal}`, {}, live);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toMatch(/20\d\d-\d\d-\d\dT\d\d:/);
      expect(html).not.toContain(PROBE_PREFIX);
    }
  });
});
