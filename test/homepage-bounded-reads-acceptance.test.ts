// Acceptance: homepage reads bound featured rows and rank counts before
// transfer. One oversized stored featured text or rank label must no longer
// be transferred, cached and serialized whole on the homepage or the machine
// surfaces (docs/machine-interface.md promises every JSON body fits 32 KiB).
//
// Pinned contract (this file is the specification for the paired build):
// - Featured admission is SQL-side, never post-fetch truncation: both readers
//   (listVisibleFeatured, listPublishedFeatured) judge every projected text
//   column against the established write maxima from
//   src/admin/validation-featured-form.ts — title 255, body 1000, url 255,
//   image_url 255, image_alt 255 — counted in characters (code points), the
//   unit the write form counts in, so a multibyte value AT a maximum is
//   admitted byte-identical and one character over is not. Null is admitted.
// - An oversized featured row is skipped whole; healthy siblings keep their
//   order and bytes. A read that skips rows emits exactly one console.warn
//   whose payload carries counts only (the skipped count as a number), never
//   stored text. A clean read warns zero times. Rows the reader's existing
//   visibility filter already excludes (drafts for the visible read) are not
//   "skipped" and do not warn.
// - Featured row cap: 100 rows per read (a generous pathological cap, above
//   the 20-row control in test/event-bounded-reads.test.ts). More rows than
//   the cap returns the first 100 in the existing order plus one saturation
//   diagnostic in the same counts-only shape carrying the cap (the egress
//   precedent warns {limit, returned}); exactly 100 warns zero times.
// - Ranks (src/counts.ts readRanks): SQL LIMIT plus key/label length
//   admission in SQL. Caps: rank_key 64 characters, rank_label 64 characters
//   (8x the longest normal ladder entry), at most 20 rows (4x the five-rung
//   ladder in docs/web-v1-contract.md, matching the machine-interface
//   collection cap). Any oversized, over-cap or misshapen (non-text key or
//   label) rank read degrades the WHOLE rank read to [] through the existing
//   fallback — never a partial ladder, never String()-coerced text. Live
//   counts degrade independently and survive a refused rank read.
// - Healthy data is untouched: readCounts results, the REST community body
//   and the MCP get_community structured content stay byte-identical.
//
// Proof seams: hermetic SQL-shape captures (pg-proxy for featured, a fake
// postgres driver for counts) always run; behavioral proof executes the real
// SELECTs against disposable fixtures (owned member-data schema + a
// transaction-owned web_v1 schema) and records PostgreSQL's actual projected
// rows, so "the oversized bytes never cross" is asserted on the projection
// itself, not only on the mapped result. No production or staging database
// is ever touched: createMemberDataFixture/createWebV1Fixture refuse
// non-test URLs before connecting.
//
// Exact command:
//   DATABASE_URL=postgres://agent_test@agent-testdb:5432/postgres \
//     npx vitest run test/homepage-bounded-reads-acceptance.test.ts \
//       test/featured-policy.test.ts test/home-counts.test.ts test/counts.test.ts

import { drizzle } from "drizzle-orm/pg-proxy";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { featuredContents } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { listPublishedFeatured, listVisibleFeatured } from "../src/featured";
import { __resetHomeGuestCacheForTests } from "../src/home-cache";
import { serializeCommunity } from "../src/public-data/routes";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";
import { createWebV1Fixture, type WebV1Fixture } from "./helpers/web-v1-fixture";

// ---------------------------------------------------------------------------
// Fixture arithmetic: multibyte fills make character-vs-byte counting visible.
// ---------------------------------------------------------------------------

const E_ACUTE = "é"; // 1 code point, 1 UTF-16 unit, 2 UTF-8 bytes.
const ASTRAL = "𐍈"; // 1 code point, 2 UTF-16 units, 4 UTF-8 bytes.
const cp = (s: string) => [...s].length;
const utf8 = (s: string) => new TextEncoder().encode(s).length;
const padTo = (marker: string, total: number, fill = E_ACUTE) =>
  marker + fill.repeat(total - cp(marker));

const FEATURED_MAX = { title: 255, body: 1000, url: 255, imageUrl: 255, imageAlt: 255 } as const;
const FEATURED_ROW_CAP = 100;
const RANK_TEXT_MAX = 64;
const RANK_ROW_CAP = 20;

const NOW = new Date("2026-09-30T12:00:00Z");

describe("acceptance fixture arithmetic (control)", () => {
  it("the multibyte fills really separate characters from bytes", () => {
    expect(cp(E_ACUTE.repeat(255))).toBe(255);
    expect(utf8(E_ACUTE.repeat(255))).toBe(510);
    expect(cp(ASTRAL.repeat(1000))).toBe(1000);
    expect(ASTRAL.repeat(1000).length).toBe(2000);
    expect(utf8(ASTRAL.repeat(1000))).toBe(4000);
    const overTitle = padTo("OVERSIZED-TITLE-MARKER-", FEATURED_MAX.title + 1);
    expect(cp(overTitle)).toBe(256);
    expect(utf8(overTitle)).toBeGreaterThan(256);
  });
});

// ---------------------------------------------------------------------------
// Warn assertions: diagnostics carry counts only, never stored text.
// ---------------------------------------------------------------------------

type WarnSpy = ReturnType<typeof vi.spyOn>;

function warnNumbers(warn: WarnSpy): number[] {
  const out: number[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "number") out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
  };
  warn.mock.calls.forEach(walk);
  return out;
}

function expectCountsOnlyWarn(warn: WarnSpy, expectedCount: number, forbidden: string[]) {
  expect(warn, "exactly one bounded diagnostic per affected read").toHaveBeenCalledTimes(1);
  expect(warnNumbers(warn)).toContain(expectedCount);
  const serialized = JSON.stringify(warn.mock.calls);
  for (const text of forbidden) expect(serialized).not.toContain(text);
}

// ---------------------------------------------------------------------------
// Featured: hermetic SQL shape via pg-proxy (always runs, needs no database).
// The proxy returns no rows; only the SQL the readers generate is asserted.
// A post-fetch filter would emit the legacy unbounded SELECT and fail here.
// ---------------------------------------------------------------------------

describe("featured readers: SQL-side admission shape (hermetic)", () => {
  function shapeDb(captured: { sql: string; params: unknown[] }[]) {
    const db = drizzle(async (sql, params) => {
      captured.push({ sql, params: [...params] });
      return { rows: [] };
    }) as unknown as Db;
    Object.assign(db, {
      transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db),
    });
    return db;
  }

  function expectAdmissionShape(captured: { sql: string; params: unknown[] }[], reader: string) {
    const selects = captured.filter((q) => q.sql.includes("featured_contents"));
    expect(selects.length, `${reader} selects from featured_contents`).toBeGreaterThan(0);
    const combined = selects
      .map((q) => `${q.sql} ${q.params.map((p) => String(p)).join(" ")}`)
      .join("\n");
    for (const column of ["title", "body", "url", "image_url", "image_alt"]) {
      expect(combined, `${reader} judges ${column} by length in SQL`).toMatch(
        new RegExp(`length\\s*\\([^)]*${column}`, "i"),
      );
    }
    expect(combined, `${reader} carries the 255 maxima`).toContain("255");
    expect(combined, `${reader} carries the 1000 body maximum`).toContain("1000");
    expect(combined, `${reader} caps rows in SQL`).toMatch(/limit/i);
    expect(combined, `${reader} limit is the pinned cap or cap+1 probe`).toMatch(/\b10[01]\b/);
    expect(combined, `${reader} keeps the established order`).toMatch(/order by/i);
  }

  it("listVisibleFeatured admits by length and caps rows in its SELECT", async () => {
    const captured: { sql: string; params: unknown[] }[] = [];
    const rows = await listVisibleFeatured(shapeDb(captured), NOW);
    expect(rows).toEqual([]);
    expectAdmissionShape(captured, "listVisibleFeatured");
  });

  it("listPublishedFeatured admits by length and caps rows in its SELECT", async () => {
    const captured: { sql: string; params: unknown[] }[] = [];
    // The published reader rejects on failure by design; the empty proxy may
    // starve a follow-up count read, so shape is asserted on what was sent.
    await listPublishedFeatured(shapeDb(captured)).catch(() => []);
    expectAdmissionShape(captured, "listPublishedFeatured");
  });
});

// ---------------------------------------------------------------------------
// Counts: postgres driver double. Modes:
// - "off": delegate to the real driver (fixture pools are built in this mode)
// - "bridge": execute the real SQL against the transaction-owned web_v1
//   fixture, recording the statements and every text cell that crosses
// - "shape": record statements, return no rows (hermetic SQL-shape proof)
// - "fake": return canned row objects (driver-level misshape proof)
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  mode: "off" as "off" | "bridge" | "shape" | "fake",
  webV1: null as WebV1Fixture | null,
  queries: [] as string[],
  crossedText: [] as string[],
  live: [] as Record<string, unknown>[],
  ranks: [] as Record<string, unknown>[],
}));

vi.mock("postgres", async (importOriginal) => {
  const { default: original } = await importOriginal<{ default: typeof postgres }>();
  return {
    default: (raw: string, options: Record<string, unknown>) => {
      if (state.mode === "shape" || state.mode === "fake") {
        const sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
          const text = parts.reduce(
            (acc, part, i) => acc + (i > 0 ? String(values[i - 1]) : "") + part,
            "",
          );
          state.queries.push(text);
          if (state.mode === "shape") return [];
          return (text.includes("web_v1.live_counts") ? state.live : state.ranks).map((row) => ({
            ...row,
          }));
        };
        sql.end = async () => {};
        return sql;
      }
      const url = testDatabaseUrl(raw); // Even the double refuses non-test URLs.
      if (state.mode !== "bridge" || !state.webV1) {
        return original(url.href, { ...options, password: () => url.password });
      }
      const sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
        state.queries.push(
          parts.reduce((acc, part, i) => acc + (i > 0 ? String(values[i - 1]) : "") + part, ""),
        );
        const rows = await state.webV1!.sql(
          parts,
          ...(values as postgres.ParameterOrFragment<never>[]),
        );
        for (const row of rows) {
          for (const value of Object.values(row)) {
            if (typeof value === "string") state.crossedText.push(value);
          }
        }
        return rows;
      };
      sql.end = async () => {}; // The fixture owns the transaction/socket.
      return sql;
    },
  };
});

const COUNTS_ENV = {
  BOT_DB: { connectionString: "postgres://fixture.test/counts" },
} as unknown as Env;

async function freshCounts() {
  vi.resetModules();
  return import("../src/counts");
}

describe("readRanks: SQL-side admission shape (hermetic)", () => {
  beforeEach(() => {
    state.mode = "shape";
    state.queries = [];
    state.crossedText = [];
  });
  afterEach(() => {
    state.mode = "off";
  });

  it("judges rank_key and rank_label by length and caps rows in the ranks SELECT", async () => {
    const counts = await freshCounts();
    await counts.readCounts(COUNTS_ENV);
    const ranksQuery = state.queries.find((q) => q.includes("web_v1.rank_counts"));
    expect(ranksQuery, "a ranks SELECT was issued").toBeDefined();
    expect(ranksQuery).toMatch(/length\s*\([^)]*rank_key/i);
    expect(ranksQuery).toMatch(/length\s*\([^)]*rank_label/i);
    expect(ranksQuery, "the 64-character key/label cap rides the statement").toContain("64");
    expect(ranksQuery).toMatch(/limit/i);
    expect(ranksQuery, "limit is the pinned cap or cap+1 probe").toMatch(/\b2[01]\b/);
    expect(ranksQuery, "ladder order is preserved").toMatch(/ORDER BY rank_order/i);
  });
});

describe("readRanks: misshapen driver rows degrade the whole rank read (hermetic)", () => {
  const freshLive = () => ({
    human_member_count: "84",
    online_count: "12",
    counts_updated_at: new Date(),
  });

  beforeEach(() => {
    state.mode = "fake";
    state.queries = [];
    state.live = [freshLive()];
    state.ranks = [{ rank_key: "prospect", rank_label: "Prospect", member_count: "24" }];
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    state.mode = "off";
    vi.restoreAllMocks();
  });

  it.each([
    ["a null rank_key", { rank_key: null, rank_label: "Prospect", member_count: "24" }],
    ["a numeric rank_label", { rank_key: "prospect", rank_label: 42, member_count: "24" }],
    ["a missing rank_label", { rank_key: "prospect", member_count: "24" }],
    ["a boolean rank_key", { rank_key: true, rank_label: "Prospect", member_count: "24" }],
  ])("degrades to [] for %s, never coerced text, live counts intact", async (_name, row) => {
    state.ranks = [row as Record<string, unknown>];
    const counts = await freshCounts();
    const result = await counts.readCounts(COUNTS_ENV);
    expect(result.ranks).toEqual([]);
    expect(result.memberCount).toBe(84);
    expect(result.onlineCount).toBe(12);
    expect(JSON.stringify(result)).not.toContain("42");
    expect(JSON.stringify(result)).not.toContain('"null"');
    expect(JSON.stringify(result)).not.toContain('"true"');
  });

  it("degrades to [] when the driver returns more rows than the pinned cap", async () => {
    state.ranks = Array.from({ length: RANK_ROW_CAP + 1 }, (_, i) => ({
      rank_key: `rung-${i}`,
      rank_label: `Rung ${i}`,
      member_count: "1",
    }));
    const counts = await freshCounts();
    const result = await counts.readCounts(COUNTS_ENV);
    expect(result.ranks).toEqual([]);
    expect(result.memberCount).toBe(84);
  });
});

// ---------------------------------------------------------------------------
// Community serializer: byte identity controls shared by REST and MCP
// (src/public-data/routes.ts and src/mcp/server.ts both serialize through
// serializeCommunity), plus the worst-case 32 KiB arithmetic under the caps.
// ---------------------------------------------------------------------------

describe("serializeCommunity under the pinned caps (control)", () => {
  it("keeps the normal snapshot bytes identical", () => {
    const dto = serializeCommunity({
      memberCount: 84,
      onlineCount: 12,
      ranks: [
        { key: "prospect", label: "Prospect", memberCount: 24 },
        { key: "legend", label: "Legend", memberCount: 0 },
      ],
    });
    expect(JSON.stringify(dto)).toBe(
      '{"member_count":84,"online_count":12,"ranks":[' +
        '{"key":"prospect","label":"Prospect","member_count":24},' +
        '{"key":"legend","label":"Legend","member_count":0}]}',
    );
  });

  it("worst case under the caps stays well under the 32 KiB machine promise", () => {
    const dto = serializeCommunity({
      memberCount: 9007199254740991,
      onlineCount: 9007199254740991,
      ranks: Array.from({ length: RANK_ROW_CAP }, () => ({
        key: ASTRAL.repeat(RANK_TEXT_MAX),
        label: ASTRAL.repeat(RANK_TEXT_MAX),
        memberCount: 9007199254740991,
      })),
    });
    const bytes = utf8(JSON.stringify(dto));
    expect(bytes).toBeLessThan(32 * 1024);
    expect(bytes).toBeLessThan(16 * 1024); // "well under", not merely under.
  });
});

// ---------------------------------------------------------------------------
// Real-SQL behavioral proof on disposable fixtures.
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.DATABASE_URL)("bounded homepage reads (disposable Postgres)", () => {
  let fixture: MemberDataFixture;
  let traceDb: Db;
  let warn: WarnSpy;
  const traces: { sql: string; raw: (string | null)[][] }[] = [];
  const featuredTraces = () => traces.filter((t) => t.sql.includes("featured_contents"));
  const crossedFeaturedText = () =>
    featuredTraces()
      .flatMap((t) => t.raw.flat())
      .filter((v): v is string => v !== null)
      .join("\n");

  beforeAll(async () => {
    state.mode = "off";
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    // pg-proxy bridge executing the readers' real SQL on the fixture pool,
    // recording PostgreSQL's actual projected rows before application code
    // maps them (the event-series-context bounds precedent).
    traceDb = drizzle(async (sql, params) => {
      const raw = await fixture.client.unsafe(sql, params as never[]).raw();
      const rows = raw.map((values) =>
        values.map((value, index) => {
          if (value === null) return null;
          const column = raw.columns[index]!;
          const text = value.toString();
          return [1114, 1184].includes(column.type)
            ? text
            : column.parser
              ? column.parser(text)
              : text;
        }),
      );
      traces.push({
        sql,
        raw: raw.map((r) => r.map((v) => (v === null ? null : v.toString()))),
      });
      return { rows };
    }) as unknown as Db;
    Object.assign(traceDb, {
      transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(traceDb),
    });
  });

  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.delete(featuredContents);
    traces.length = 0;
    __resetHomeGuestCacheForTests();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetHomeGuestCacheForTests();
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  type FeaturedInsert = Partial<typeof featuredContents.$inferInsert> & { title: string };
  async function seedFeatured(over: FeaturedInsert) {
    const [row] = await fixture.db
      .insert(featuredContents)
      .values({ isPublished: true, position: 0, ...over })
      .returning();
    return row!;
  }
  const visibleOf = (row: typeof featuredContents.$inferSelect) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    url: row.url,
    imageUrl: row.imageUrl,
    imageAlt: row.imageAlt,
  });

  const healthyFirst = () =>
    seedFeatured({
      title: "Healthy first",
      body: "First sibling body",
      url: "https://example.test/first",
      imageUrl: "/first.jpg",
      imageAlt: "First photo",
      position: 0,
    });
  const healthyLast = () =>
    seedFeatured({
      title: "Healthy last",
      body: null,
      url: null,
      imageUrl: null,
      imageAlt: null,
      position: 2,
    });

  describe("listVisibleFeatured", () => {
    it("admits a row with every field AT its write maximum, multibyte, byte-identical", async () => {
      const row = await seedFeatured({
        title: E_ACUTE.repeat(FEATURED_MAX.title),
        body: ASTRAL.repeat(FEATURED_MAX.body),
        url: `https://example.test/${"a".repeat(FEATURED_MAX.url - "https://example.test/".length)}`,
        imageUrl: `https://cdn.discordapp.com/${"b".repeat(FEATURED_MAX.imageUrl - "https://cdn.discordapp.com/".length)}`,
        imageAlt: E_ACUTE.repeat(FEATURED_MAX.imageAlt),
      });
      expect(cp(row.title)).toBe(FEATURED_MAX.title);
      expect(cp(row.body!)).toBe(FEATURED_MAX.body);
      const visible = await listVisibleFeatured(traceDb, NOW);
      expect(visible).toEqual([visibleOf(row)]);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([
      [
        "title",
        { title: padTo("OVERSIZED-TITLE-MARKER-", FEATURED_MAX.title + 1) },
        "OVERSIZED-TITLE-MARKER-",
      ],
      [
        "body",
        {
          title: "Oversized body slot",
          body: padTo("OVERSIZED-BODY-MARKER-", FEATURED_MAX.body + 1, ASTRAL),
        },
        "OVERSIZED-BODY-MARKER-",
      ],
      [
        "url",
        {
          title: "Oversized url slot",
          url: padTo("https://example.test/OVERSIZEDURLMARKER-", FEATURED_MAX.url + 1, "a"),
        },
        "OVERSIZEDURLMARKER-",
      ],
      [
        "imageUrl",
        {
          title: "Oversized image slot",
          imageUrl: padTo(
            "https://cdn.discordapp.com/OVERSIZEDIMAGEMARKER-",
            FEATURED_MAX.imageUrl + 1,
            "b",
          ),
          imageAlt: "A photo",
        },
        "OVERSIZEDIMAGEMARKER-",
      ],
      [
        "imageAlt",
        {
          title: "Oversized alt slot",
          imageUrl: "/slot.jpg",
          imageAlt: padTo("OVERSIZED-ALT-MARKER-", FEATURED_MAX.imageAlt + 1),
        },
        "OVERSIZED-ALT-MARKER-",
      ],
    ])(
      "skips a row one character over the %s maximum; siblings, order and bytes intact",
      async (_field, over, marker) => {
        const first = await healthyFirst();
        await seedFeatured({ position: 1, ...over } as FeaturedInsert);
        const last = await healthyLast();
        const visible = await listVisibleFeatured(traceDb, NOW);
        expect(visible).toEqual([visibleOf(first), visibleOf(last)]);
        // The oversized bytes never cross the projection itself.
        expect(crossedFeaturedText()).not.toContain(marker);
        expectCountsOnlyWarn(warn, 1, [marker, "Healthy first", "Healthy last"]);
      },
    );

    it("aggregates multiple skipped rows into one counts-only diagnostic", async () => {
      const first = await healthyFirst();
      await seedFeatured({
        title: padTo("OVERSIZED-TITLE-MARKER-", FEATURED_MAX.title + 1),
        position: 1,
      });
      await seedFeatured({
        title: "Oversized body slot",
        body: padTo("OVERSIZED-BODY-MARKER-", FEATURED_MAX.body + 1),
        position: 3,
      });
      const last = await healthyLast();
      const visible = await listVisibleFeatured(traceDb, NOW);
      expect(visible).toEqual([visibleOf(first), visibleOf(last)]);
      expect(crossedFeaturedText()).not.toContain("OVERSIZED-TITLE-MARKER-");
      expect(crossedFeaturedText()).not.toContain("OVERSIZED-BODY-MARKER-");
      expectCountsOnlyWarn(warn, 2, [
        "OVERSIZED-TITLE-MARKER-",
        "OVERSIZED-BODY-MARKER-",
        "Healthy first",
      ]);
    });

    it("does not warn for an oversized draft the visibility filter already excludes", async () => {
      const first = await healthyFirst();
      await fixture.db.insert(featuredContents).values({
        title: padTo("OVERSIZED-TITLE-MARKER-", FEATURED_MAX.title + 1),
        isPublished: false,
        position: 1,
      });
      const visible = await listVisibleFeatured(traceDb, NOW);
      expect(visible).toEqual([visibleOf(first)]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("returns the 20-row control whole, in order, with no diagnostic", async () => {
      const seeded = [];
      for (let i = 0; i < 20; i++)
        seeded.push(await seedFeatured({ title: `Slot ${i}`, position: i }));
      const visible = await listVisibleFeatured(traceDb, NOW);
      expect(visible.map((r) => r.id)).toEqual(seeded.map((r) => r.id));
      expect(warn).not.toHaveBeenCalled();
    });

    it(`returns exactly ${FEATURED_ROW_CAP} rows whole with no saturation diagnostic`, async () => {
      await fixture.db.insert(featuredContents).values(
        Array.from({ length: FEATURED_ROW_CAP }, (_, i) => ({
          title: `Slot ${i}`,
          isPublished: true,
          position: i,
        })),
      );
      const visible = await listVisibleFeatured(traceDb, NOW);
      expect(visible).toHaveLength(FEATURED_ROW_CAP);
      expect(warn).not.toHaveBeenCalled();
    });

    it(`saturates above ${FEATURED_ROW_CAP} rows: first ${FEATURED_ROW_CAP} in order, one counts-only diagnostic`, async () => {
      const seeded = await fixture.db
        .insert(featuredContents)
        .values(
          Array.from({ length: FEATURED_ROW_CAP + 1 }, (_, i) => ({
            title: `Slot ${String(i).padStart(3, "0")}`,
            isPublished: true,
            position: i,
          })),
        )
        .returning();
      const visible = await listVisibleFeatured(traceDb, NOW);
      expect(visible.map((r) => r.id)).toEqual(seeded.slice(0, FEATURED_ROW_CAP).map((r) => r.id));
      expectCountsOnlyWarn(warn, FEATURED_ROW_CAP, ["Slot "]);
    });
  });

  describe("listPublishedFeatured (homepage guest-cache base)", () => {
    it("skips an oversized future-window row and keeps siblings with windows intact", async () => {
      const first = await healthyFirst();
      const future = await seedFeatured({
        title: "Future sibling",
        position: 1,
        startsAt: new Date(NOW.getTime() + 3600_000),
        endsAt: new Date(NOW.getTime() + 7200_000),
      });
      await seedFeatured({
        title: "Oversized body slot",
        body: padTo("OVERSIZED-BODY-MARKER-", FEATURED_MAX.body + 1),
        position: 2,
        startsAt: new Date(NOW.getTime() + 3600_000),
      });
      const published = await listPublishedFeatured(traceDb);
      expect(published.map((r) => r.id)).toEqual([first.id, future.id]);
      expect(published[1]!.startsAt).toEqual(future.startsAt);
      expect(published[1]!.endsAt).toEqual(future.endsAt);
      expect(crossedFeaturedText()).not.toContain("OVERSIZED-BODY-MARKER-");
      expectCountsOnlyWarn(warn, 1, ["OVERSIZED-BODY-MARKER-", "Healthy first"]);
    });

    it(`caps the published base at ${FEATURED_ROW_CAP} with one counts-only diagnostic`, async () => {
      await fixture.db.insert(featuredContents).values(
        Array.from({ length: FEATURED_ROW_CAP + 1 }, (_, i) => ({
          title: `Slot ${String(i).padStart(3, "0")}`,
          isPublished: true,
          position: i,
        })),
      );
      const published = await listPublishedFeatured(traceDb);
      expect(published).toHaveLength(FEATURED_ROW_CAP);
      expectCountsOnlyWarn(warn, FEATURED_ROW_CAP, ["Slot "]);
    });
  });

  describe("homepage surface", () => {
    it("renders healthy siblings and never the oversized row's text", async () => {
      // Title-only siblings render as bare <h3> (a linked title wraps in <a>).
      await seedFeatured({ title: "Healthy first", position: 0 });
      await seedFeatured({
        title: padTo("OVERSIZED-TITLE-MARKER-", FEATURED_MAX.title + 1),
        position: 1,
      });
      await healthyLast();
      const res = await app.request("/", {}, {
        APP_URL: "https://next.example.test",
        DISCORD_CLIENT_ID: "client-id",
        DISCORD_CLIENT_SECRET: "client-secret",
        DISCORD_GUILD_ID: "guild-id",
        DISCORD_INVITE_URL: "https://discord.gg/invite",
        DISCORD_BOT_TOKEN: "bot-token",
        SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
        ADMIN_DB: fixture.db,
        SESSION_STORE: createMemorySessionStore(),
        // Hermetic Discord seam (test/home-counts.test.ts pattern): no live
        // fetch and no failure-warn noise in this suite's diagnostics.
        DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
      } as unknown as Env);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("<h3>Healthy first</h3>");
      expect(html).toContain("<h3>Healthy last</h3>");
      expect(html).not.toContain("OVERSIZED-TITLE-MARKER-");
      expect(html.match(/data-testid="featured-item"/g)).toHaveLength(2);
    });
  });

  describe("rank counts through the real web_v1 SQL", () => {
    let webV1: WebV1Fixture;
    const APP_URL = "https://next.example.test";
    const normalRanks: [string, string, number | null][] = [
      ["prospect", "Prospect", 24],
      ["member", "Member", 40],
      ["soldier", "Soldier", 20],
      ["veteran", "Veteran", null],
      ["legend", "Legend", 0],
    ];
    const expectedNormal = {
      memberCount: 84,
      onlineCount: 12,
      ranks: normalRanks.map(([key, label, memberCount]) => ({ key, label, memberCount })),
    };

    async function seedLive() {
      await webV1.sql`
        INSERT INTO web_v1.live_counts VALUES (84, 12, ${new Date().toISOString()}::text)
      `;
    }
    async function seedRanks(ranks: [string, string, number | null][]) {
      for (const [i, [key, label, count]] of ranks.entries()) {
        await webV1.sql`
          INSERT INTO web_v1.rank_counts VALUES (${key}, ${label}, ${count}, ${i + 1})
        `;
      }
    }
    function machineEnv() {
      return {
        APP_URL,
        DATABASE_URL: process.env.DATABASE_URL!,
        BOT_DB: { connectionString: testDatabaseUrl(process.env.DATABASE_URL!).href },
        ADMIN_DB: fixture.db,
        SESSION_STORE: createMemorySessionStore(),
        SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
        DISCORD_INVITE_URL: "https://discord.gg/test-invite-handoff",
        DISCORD_BOT_TOKEN: "bot-token",
        THROTTLE_STORE: async () => null,
      } as unknown as Env;
    }

    beforeEach(async () => {
      state.mode = "off";
      webV1 = await createWebV1Fixture(process.env.DATABASE_URL!);
      state.webV1 = webV1;
      state.mode = "bridge";
      state.queries = [];
      state.crossedText = [];
    });
    afterEach(async () => {
      state.mode = "off";
      state.webV1 = null;
      await webV1?.dispose();
    });

    it("returns the normal ladder unchanged, and REST/MCP bytes stay identical", async () => {
      await seedLive();
      await seedRanks(normalRanks);
      const counts = await freshCounts();
      expect(await counts.readCounts(machineEnv())).toEqual(expectedNormal);
      expect(warn).not.toHaveBeenCalled();

      const rawApp = (await import("../src/index")).default;
      const { __resetApiPublicCacheForTests } = await import("../src/public-data/cache");
      __resetApiPublicCacheForTests();
      const env = machineEnv();
      const rest = await rawApp.request(
        new URL("/api/public/community", APP_URL).href,
        { headers: { "cf-connecting-ip": "192.0.2.73" } },
        env,
      );
      expect(rest.status).toBe(200);
      const restBody = await rest.text();
      const expectedBody = JSON.stringify({
        member_count: 84,
        online_count: 12,
        ranks: normalRanks.map(([key, label, count]) => ({
          key,
          label,
          member_count: count,
        })),
      });
      expect(restBody).toBe(expectedBody);
      expect(utf8(restBody)).toBeLessThan(32 * 1024);

      const post = async (body: unknown) => {
        const res = await rawApp.request(
          new URL("/mcp", APP_URL).href,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "cf-connecting-ip": "192.0.2.71",
            },
            body: JSON.stringify(body),
          },
          env,
        );
        const text = await res.text();
        const contentType = res.headers.get("content-type") ?? "";
        const messages = contentType.includes("text/event-stream")
          ? text
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => JSON.parse(line.slice("data:".length).trim()))
          : text.length > 0
            ? [JSON.parse(text)]
            : [];
        return { status: res.status, messages };
      };
      await post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "bounded-reads-acceptance", version: "0" },
        },
      });
      await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      const called = await post({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_community", arguments: {} },
      });
      expect(called.status).toBe(200);
      const result = called.messages[0]!["result"] as Record<string, unknown>;
      expect(result["isError"]).toBeUndefined();
      expect(result["structuredContent"]).toEqual(JSON.parse(restBody));
      const textContent = (result["content"] as { text: string }[])[0]!.text;
      expect(textContent).toBe(restBody);
    });

    it("admits key and label AT the 64-character cap, multibyte, byte-identical", async () => {
      const keyAt = E_ACUTE.repeat(RANK_TEXT_MAX);
      const labelAt = ASTRAL.repeat(RANK_TEXT_MAX);
      await seedLive();
      await seedRanks([...normalRanks.slice(0, 4), [keyAt, labelAt, 3]]);
      const counts = await freshCounts();
      const result = await counts.readCounts(machineEnv());
      expect(result.ranks).toHaveLength(5);
      expect(result.ranks[4]).toEqual({ key: keyAt, label: labelAt, memberCount: 3 });
      expect(result.memberCount).toBe(84);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([
      [
        "label",
        (ranks: [string, string, number | null][]) =>
          ranks.map((r, i) =>
            i === 1
              ? ([r[0], padTo("OVERSIZED-LABEL-MARKER-", RANK_TEXT_MAX + 1), r[2]] as const)
              : r,
          ),
        "OVERSIZED-LABEL-MARKER-",
      ],
      [
        "key",
        (ranks: [string, string, number | null][]) =>
          ranks.map((r, i) =>
            i === 1
              ? ([padTo("OVERSIZEDKEYMARKER-", RANK_TEXT_MAX + 1, "k"), r[1], r[2]] as const)
              : r,
          ),
        "OVERSIZEDKEYMARKER-",
      ],
    ])(
      "degrades the whole rank read to [] for one %s over the cap; live counts survive, bytes never cross",
      async (_field, mutate, marker) => {
        await seedLive();
        await seedRanks(mutate(normalRanks) as [string, string, number | null][]);
        const counts = await freshCounts();
        const result = await counts.readCounts(machineEnv());
        expect(result).toEqual({ memberCount: 84, onlineCount: 12, ranks: [] });
        // No partial ladder, and the oversized text never crossed the driver.
        expect(state.crossedText.join("\n")).not.toContain(marker);
        expect(JSON.stringify(result)).not.toContain(marker);
        // Any diagnostic is counts/reasons only: at most one warn, no text.
        expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
        expect(JSON.stringify(warn.mock.calls)).not.toContain(marker);
      },
    );

    it(`returns exactly ${RANK_ROW_CAP} healthy ranks in SQL order`, async () => {
      await seedLive();
      await seedRanks(
        Array.from({ length: RANK_ROW_CAP }, (_, i) => [
          `rung-${String(i).padStart(2, "0")}`,
          `Rung ${i}`,
          i,
        ]) as [string, string, number][],
      );
      const counts = await freshCounts();
      const result = await counts.readCounts(machineEnv());
      expect(result.ranks.map((r) => r.key)).toEqual(
        Array.from({ length: RANK_ROW_CAP }, (_, i) => `rung-${String(i).padStart(2, "0")}`),
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it(`degrades the whole rank read to [] at ${RANK_ROW_CAP + 1} rows, never a truncated ladder`, async () => {
      await seedLive();
      await seedRanks(
        Array.from({ length: RANK_ROW_CAP + 1 }, (_, i) => [
          `rung-${String(i).padStart(2, "0")}`,
          `Rung ${i}`,
          i,
        ]) as [string, string, number][],
      );
      const counts = await freshCounts();
      const result = await counts.readCounts(machineEnv());
      expect(result).toEqual({ memberCount: 84, onlineCount: 12, ranks: [] });
      // The ranks SELECT itself carried the LIMIT: at most cap+1 rank rows
      // could cross, regardless of how many the view holds.
      const ranksQuery = state.queries.find((q) => q.includes("web_v1.rank_counts"));
      expect(ranksQuery).toMatch(/limit/i);
    });
  });
});
