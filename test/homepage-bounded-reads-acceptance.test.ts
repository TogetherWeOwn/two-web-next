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
// The real-SQL cases register under test/mcp-public.test.ts's existing DB gate.
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
