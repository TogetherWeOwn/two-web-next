// DB-backed bounded-read and MCP regressions, registered inside the existing
// test/mcp-public.test.ts database gate. No new skip, exclusion or waiver.
import { drizzle } from "drizzle-orm/pg-proxy";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { featuredContents } from "../../src/db/admin-schema";
import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import { listPublishedFeatured, listVisibleFeatured } from "../../src/featured";
import { __resetHomeGuestCacheForTests } from "../../src/home-cache";
import { serializeCommunity } from "../../src/public-data/routes";
import { createMemorySessionStore } from "../../src/sessions";
import app from "../app";
import { createMemberDataFixture, testDatabaseUrl, type MemberDataFixture } from "./member-data-db";
import { createWebV1Fixture, type WebV1Fixture } from "./web-v1-fixture";

import { API_PUBLIC_BOUNDS } from "../../src/public-data/contracts";
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

async function freshCounts() {
  vi.resetModules();
  return import("../../src/counts");
}

const CTRL = "\u0001"; // U+0001: JSON escapes it to six bytes.

// The review's worst case: every key/label exactly at the 64-character SQL
// cap, built from a character JSON escapes to six bytes.
function escapedLadder() {
  return Array.from({ length: 20 }, (_, i) => ({
    key: `${String(i).padStart(2, "0")}${CTRL.repeat(62)}`,
    label: CTRL.repeat(64),
    memberCount: 1,
  }));
}

export function registerHomepageBoundedReadTests() {
  describe("bounded homepage reads (disposable Postgres)", () => {
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
        expect(visible.map((r) => r.id)).toEqual(
          seeded.slice(0, FEATURED_ROW_CAP).map((r) => r.id),
        );
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

        const rawApp = (await import("../../src/index")).default;
        const { __resetApiPublicCacheForTests } = await import("../../src/public-data/cache");
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
}

export function registerMcpCommunityBudgetTests() {
  describe("get_community byte budget (disposable Postgres)", () => {
    let fixture: MemberDataFixture;
    let webV1: WebV1Fixture;
    let warn: ReturnType<typeof vi.spyOn>;
    const APP_URL = "https://next.example.test";
    const MESSAGE = "Community MCP snapshot exceeded the byte budget; serving without ranks.";

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

    const post = async (body: unknown, env = machineEnv()) => {
      const rawApp = (await import("../../src/index")).default;
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
      return { status: res.status, text, messages };
    };

    beforeAll(async () => {
      state.mode = "off";
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });

    afterAll(async () => {
      await fixture?.dispose();
    });

    beforeEach(async () => {
      await fixture.reset();
      state.webV1 = await createWebV1Fixture(process.env.DATABASE_URL!);
      webV1 = state.webV1;
      state.mode = "bridge";
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(async () => {
      state.mode = "off";
      state.webV1 = null;
      await webV1?.dispose();
      vi.restoreAllMocks();
    });

    it("rejects a long echoed ID before dispatch with a near-budget ladder", async () => {
      await webV1.sql`
        INSERT INTO web_v1.live_counts VALUES (84, 12, ${new Date().toISOString()}::text)
      `;
      // Eighteen escaped ranks fit the tool-result allowance, but an unbounded
      // echoed ID can push that otherwise-admitted result above 32 KiB.
      for (const [i, rank] of escapedLadder().slice(0, 18).entries()) {
        await webV1.sql`
          INSERT INTO web_v1.rank_counts VALUES (${rank.key}, ${rank.label}, ${rank.memberCount}, ${i + 1})
        `;
      }
      await freshCounts();
      const acceptedId = "x".repeat(510); // JSON string quotes bring it to 512 bytes.
      const accepted = await post({
        jsonrpc: "2.0",
        id: acceptedId,
        method: "tools/call",
        params: { name: "get_community", arguments: {} },
      });
      expect(accepted.status).toBe(200);
      expect(accepted.messages[0]?.id).toBe(acceptedId);
      const result = accepted.messages[0]?.result as Record<string, unknown>;
      const dto = result.structuredContent as Record<string, unknown>;
      expect(dto.ranks).toHaveLength(18);
      expect(utf8(accepted.text)).toBeGreaterThan(30 * 1024);
      expect(utf8(accepted.text)).toBeLessThanOrEqual(API_PUBLIC_BOUNDS.maxBodyBytes);

      const rejectedEnv = machineEnv();
      const openDb = vi.fn(() => {
        throw new Error("Oversized ID must not reach the database factory");
      });
      Object.defineProperty(rejectedEnv, "ADMIN_DB", { get: openDb });
      const rejected = await post(
        {
          jsonrpc: "2.0",
          id: "x".repeat(2048),
          method: "tools/call",
          params: { name: "get_community", arguments: {} },
        },
        rejectedEnv,
      );
      expect(openDb).not.toHaveBeenCalled();
      expect(rejected.status).toBe(400);
      expect(rejected.messages[0]).toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600 },
      });
      expect(utf8(rejected.text)).toBeLessThanOrEqual(API_PUBLIC_BOUNDS.maxBodyBytes);
      expect(rejected.text).not.toContain("x".repeat(2048));
    });

    it.each([
      ["ASCII", "a".repeat(510), "a".repeat(511)],
      ["JSON escapes", CTRL.repeat(85), CTRL.repeat(86)],
      ["multibyte UTF-8", "😀".repeat(127) + "aa", "😀".repeat(128)],
    ])("bounds serialized %s IDs at 512 bytes", async (_name, acceptedId, rejectedId) => {
      expect(utf8(JSON.stringify(acceptedId))).toBe(512);
      expect(utf8(JSON.stringify(rejectedId))).toBeGreaterThan(512);
      const request = (id: string) => ({
        jsonrpc: "2.0",
        id,
        method: "ping",
      });
      const accepted = await post(request(acceptedId));
      expect(accepted.status).toBe(200);
      expect(accepted.messages[0]).toMatchObject({ id: acceptedId, result: {} });
      const rejected = await post(request(rejectedId));
      expect(rejected.status).toBe(400);
      expect(rejected.messages[0]).toMatchObject({ id: null, error: { code: -32600 } });
    });

    it("degrades an escaped-text ladder to [] and keeps the whole MCP response under 32 KiB", async () => {
      await webV1.sql`
      INSERT INTO web_v1.live_counts VALUES (84, 12, ${new Date().toISOString()}::text)
    `;
      for (const [i, rank] of escapedLadder().entries()) {
        await webV1.sql`
        INSERT INTO web_v1.rank_counts VALUES (${rank.key}, ${rank.label}, ${rank.memberCount}, ${i + 1})
      `;
      }
      // The SQL caps admit the ladder: the read succeeds with all 20 ranks.
      const counts = await freshCounts();
      const read = await counts.readCounts(machineEnv());
      expect(read.ranks).toHaveLength(20);
      expect(read.memberCount).toBe(84);

      const rawApp = (await import("../../src/index")).default;
      const { __resetApiPublicCacheForTests } = await import("../../src/public-data/cache");
      __resetApiPublicCacheForTests();
      const env = machineEnv();

      // REST serves the admitted DTO once: full ladder, still under the promise.
      const rest = await rawApp.request(
        new URL("/api/public/community", APP_URL).href,
        { headers: { "cf-connecting-ip": "192.0.2.73" } },
        env,
      );
      expect(rest.status).toBe(200);
      const restBody = await rest.text();
      expect(JSON.parse(restBody).ranks).toHaveLength(20);
      expect(utf8(restBody)).toBeLessThan(32 * 1024);

      await post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "mcp-community-budget", version: "0" },
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
      // The complete response — envelope, framing and all — fits the promise.
      expect(utf8(called.text)).toBeLessThan(32 * 1024);
      const result = called.messages[0]!["result"] as Record<string, unknown>;
      expect(result["isError"]).toBeUndefined();
      const structured = result["structuredContent"] as Record<string, unknown>;
      expect(structured["member_count"]).toBe(84);
      expect(structured["online_count"]).toBe(12);
      expect(structured["ranks"]).toEqual([]);
      // One counts-only diagnostic, never the stored ladder text.
      const budgetWarns = warn.mock.calls.filter((call: unknown[]) => call[0] === MESSAGE);
      expect(budgetWarns).toHaveLength(1);
      const payload = budgetWarns[0]![1] as { ranks: unknown; bytes: unknown };
      expect(payload).toMatchObject({ ranks: 20 });
      expect(typeof payload.bytes).toBe("number");
      expect(JSON.stringify(warn.mock.calls)).not.toContain(CTRL);
    });
  });
}
