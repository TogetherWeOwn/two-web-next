// Acceptance-owned: collection feed/sitemap stored-text admission.
// Run on an approved disposable DB, never staging/production:
//   npx vitest run test/event-egress-text-acceptance.test.ts test/review-p1-verify.test.ts --reporter=json
// EGRESS-TEXT-* names are stable receipt IDs; Vitest JSON is the structured receipt.
// The Builder must not edit this file. It exercises emitted SQL on PostgreSQL,
// recording field payload bytes BEFORE Drizzle/application mapping. This is not
// a claim about TCP framing, query cost, wall time, or memory usage.
//
// Independent envelope, not a required private implementation constant:
// - <=16 KiB of selected text per feed row, <=256 B per sitemap row; dates and
//   scalar/diagnostic fields get a separate conservative 1 KiB/row allowance.
// - Every existing write-valid maximum (including four-byte Unicode) fits.
// - SQL admission may use per-field or combined budgets inside that envelope.
// - Refuse a row, never shorten it. A refusal reports surface + skipped count
//   and a stable code/reason token, with no stored identity/text/error detail.
// Breaks caught: SELECT-all, JS-only/character-count guards, truncated success,
// silent filtering, swallowed query faults, changed scopes/order/validators,
// post-filter saturation accounting, and duplicated/leaky row diagnostics.
// Registered inside the existing review-p1-verify.test.ts DATABASE_URL gate;
// no runner exclusions, new conditional skips, or fallback DB connections.
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAiFriendlyRoutes } from "../../src/ai-friendly/routes";
import { events } from "../../src/db/admin-schema";
import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import { eventsIcsCollection } from "../../src/events/feeds";
import { listFeed, sitemapEvents } from "../../src/events/reads";
import { registerEventRoutes } from "../../src/events/routes";
import { buildSitemapUrls, crawlableEvents, renderSitemap } from "../../src/seo";
import { registerSeoLeaves } from "../../src/seo-leaves";
import {
  captureDiagnosticStream,
  scanDiagnosticStream,
  type DiagnosticRecord,
} from "./diagnostic-stream";
import { APP_URL, calendarBytes, calendarRow, healthyVevent } from "./ics-wire-fixture";
import { createMemberDataFixture, type MemberDataFixture } from "./member-data-db";

const NOW = new Date("2026-07-10T12:00:00Z");
const CAP = 1000;
const FEED_TEXT_BYTES = 16_384;
const SITEMAP_TEXT_BYTES = 256;
const SCALAR_ALLOWANCE = 1024;
// RSS XML escaping expands by at most 6x; ICS escaping/folding and Markdown
// are smaller. Fixed row/response allowances include URLs at this fixed origin,
// timestamps, status notes, calendar properties and diagnostic scalar columns.
const FEED_RESPONSE_BOUND = 8192 + CAP * (8 * FEED_TEXT_BYTES + 4096);
const SITEMAP_RESPONSE_BOUND = 8192 + CAP * (8 * SITEMAP_TEXT_BYTES + 4096);
const MARKER = "egress-stored-payload-sentinel";
const huge = `${MARKER}:😀`.repeat(2048);
const key = (id: number) => String(id).padStart(26, "0");
type EventRow = typeof events.$inferSelect;
const row = (id: number, over: Partial<EventRow> = {}) =>
  calendarRow({ id, eventKey: key(id), ...over });
const feedIds = (rows: Awaited<ReturnType<typeof listFeed>>) => rows.map((r) => r.id);
const token = (v: unknown): v is string =>
  typeof v === "string" && /^[a-z][a-z0-9_.:-]{2,63}$/i.test(v);

function assertLimit(query: { sql: string; params: unknown[] }) {
  const match = /\blimit\s+(?:\$(\d+)|(\d+))/i.exec(query.sql);
  expect(match, "SQL keeps the existing 1000-row ceiling").not.toBeNull();
  const value = match?.[2] ? Number(match[2]) : query.params[Number(match?.[1]) - 1];
  expect(value).toBe(CAP);
}

export function registerEventEgressTextPostgresAcceptance(databaseUrl: string): void {
  type Trace = {
    sql: string;
    params: unknown[];
    raw: (string | null)[][];
    columns: string[];
    bytes: number;
  };
  let fixture: MemberDataFixture;
  let db: Db;
  const traces: Trace[] = [];
  let diagnostics: DiagnosticRecord[] = [];
  const warnings: unknown[][] = [];
  const errors: unknown[][] = [];
  const app = new Hono<{ Bindings: Env }>();
  const noSession = async () => null;
  registerEventRoutes(app, noSession, noSession);
  registerAiFriendlyRoutes(app);
  registerSeoLeaves(app);
  const env = () =>
    ({ APP_URL, ADMIN_DB: db, THROTTLE_STORE: async () => fixture.client }) as unknown as Env;
  const request = (path: string, headers?: Record<string, string>) =>
    app.request(path, { headers }, env());

  function resetObservations() {
    traces.length = 0;
    diagnostics.length = 0;
    warnings.length = 0;
    errors.length = 0;
  }

  function assertTransfer(textBudget: number, maxRows: number) {
    expect(traces, "no second read or unbounded fallback").toHaveLength(1);
    const trace = traces[0]!;
    assertLimit(trace);
    expect(trace.raw.length).toBeLessThanOrEqual(maxRows);
    expect(trace.bytes, "actual PostgreSQL field payload, before JS filtering").toBeLessThanOrEqual(
      maxRows * (textBudget + SCALAR_ALLOWANCE),
    );
    for (const values of trace.raw) {
      const bytes = values.reduce((sum, v) => sum + Buffer.byteLength(v ?? ""), 0);
      expect
        .soft(bytes, "per-record bound, not only collection average")
        .toBeLessThanOrEqual(textBudget + SCALAR_ALLOWANCE);
      for (const value of values)
        expect.soft(value ?? "", "oversized/unused text never crosses SQL").not.toContain(MARKER);
    }
    return trace;
  }

  function assertRefusal(surface: "feed" | "sitemap", skipped: number) {
    // Do not pin new English wording or the Builder's chosen token spelling.
    // Require a structured, recognizable and bounded refusal, not a generic date
    // warning or a quiet empty collection. The repeatability check below binds it.
    expect(warnings).toHaveLength(1);
    const [message, detail] = warnings[0]!;
    expect(typeof message).toBe("string");
    expect(String(message).length).toBeLessThanOrEqual(160);
    expect(detail).toMatchObject({ surface, skipped });
    const fields = detail as Record<string, unknown>;
    expect(token(fields.code) || token(fields.reason), "stable refusal code/reason token").toBe(
      true,
    );
    expect(Object.keys(fields).length).toBeLessThanOrEqual(8);
    // Bounded reason-count dictionaries are allowed. Arbitrary arrays, row keys,
    // error objects, SQL and driver metadata are not.
    for (const [name, value] of Object.entries(fields)) {
      if (value !== null && typeof value === "object") {
        expect(name).toMatch(/reason|count/i);
        expect(Array.isArray(value)).toBe(false);
        const reasons = Object.entries(value);
        expect(reasons.length).toBeLessThanOrEqual(8);
        for (const [reason, count] of reasons) {
          expect(token(reason)).toBe(true);
          expect(Number.isSafeInteger(count) && Number(count) >= 0 && Number(count) <= CAP).toBe(
            true,
          );
        }
      } else if (typeof value === "string") {
        expect(value.length).toBeLessThanOrEqual(80);
      } else {
        expect(typeof value === "number" || typeof value === "boolean" || value === null).toBe(
          true,
        );
      }
    }
    const serialized = JSON.stringify(diagnostics.map((record) => record.args));
    expect(
      scanDiagnosticStream(diagnostics, [
        MARKER,
        key(1),
        key(2),
        "postgres://",
        "SELECT ",
        APP_URL,
      ]),
    ).toEqual({ hits: [], incomplete: [] });
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(2048);
    expect(errors).toEqual([]);
    return JSON.stringify(warnings);
  }

  async function seed(...rows: EventRow[]) {
    await fixture.db.insert(events).values(rows);
  }

  async function responses() {
    const result: Record<string, { body: string; etag: string | null; modified: string | null }> =
      {};
    for (const path of ["/events.ics", "/events.rss", "/events.md"]) {
      const response = await request(path);
      expect(response.status).toBe(200);
      result[path] = {
        body: await response.text(),
        etag: response.headers.get("etag"),
        modified: response.headers.get("last-modified"),
      };
    }
    return result;
  }

  describe("stored-text admission through real PostgreSQL", () => {
    beforeAll(async () => {
      // The host supplies DATABASE_URL; the shared helper refuses unauthorized targets.
      fixture = await createMemberDataFixture(databaseUrl);
      db = drizzle(async (sql, params) => {
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
          params: [...params],
          raw: raw.map((r) => r.map((v) => (v === null ? null : v.toString()))),
          columns: raw.columns.map((c) => c.name),
          bytes: raw.reduce((sum, r) => sum + r.reduce((n, v) => n + (v?.byteLength ?? 0), 0), 0),
        });
        return { rows };
      }) as unknown as Db;
    });
    afterAll(async () => {
      await fixture?.dispose();
    });
    beforeEach(async () => {
      await fixture.reset();
      await fixture.client`delete from web_throttle_hits`;
      resetObservations();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      diagnostics = captureDiagnosticStream();
      const captureWarning = vi.mocked(console.warn).getMockImplementation()!;
      const captureError = vi.mocked(console.error).getMockImplementation()!;
      vi.mocked(console.warn).mockImplementation((...args) => {
        captureWarning(...args);
        warnings.push(args);
      });
      vi.mocked(console.error).mockImplementation((...args) => {
        captureError(...args);
        errors.push(args);
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it("EGRESS-TEXT-04 enormous unused feed fields change neither SQL bytes nor response bytes/validators", async () => {
      await seed(row(1));
      await listFeed(db, ["published"], NOW);
      const normalBytes = traces[0]!.bytes;
      const normal = await responses();
      await fixture.reset();
      await seed(
        row(1, {
          accessibilityNotes: huge,
          join_url: huge,
          join_instructions: huge,
          discordEventId: huge,
          discordSyncFailureCode: huge,
          proofMarker: huge,
          createdBy: huge,
          recurrenceFrequency: huge,
        }),
      );
      resetObservations();
      expect(feedIds(await listFeed(db, ["published"], NOW))).toEqual([1]);
      expect(assertTransfer(FEED_TEXT_BYTES, 1).bytes).toBe(normalBytes);
      expect(await responses()).toEqual(normal);
      expect(warnings).toEqual([]);
    });

    it("EGRESS-TEXT-05 enormous unused sitemap text is never transferred or refused", async () => {
      await seed(row(1));
      const normal = await sitemapEvents(db);
      const normalBytes = traces[0]!.bytes;
      await fixture.reset();
      await seed(
        row(1, {
          title: huge,
          game: huge,
          description: huge,
          timezone: huge,
          location: huge,
          organizer_name: huge,
          accessibilityNotes: huge,
          join_url: huge,
          join_instructions: huge,
          createdBy: huge,
        }),
      );
      resetObservations();
      expect(await sitemapEvents(db)).toEqual(normal);
      expect(assertTransfer(SITEMAP_TEXT_BYTES, 1).bytes).toBe(normalBytes);
      expect(warnings).toEqual([]);
    });

    it.each([
      "eventKey",
      "title",
      "game",
      "description",
      "timezone",
      "location",
      "organizer_name",
    ] as const)(
      "EGRESS-TEXT-06 oversized feed %s is refused before transfer, not truncated or hidden in JS",
      async (field) => {
        await seed(row(1, { [field]: huge }), row(2));
        expect(feedIds(await listFeed(db, ["published", "cancelled"], NOW))).toEqual([2]);
        assertTransfer(FEED_TEXT_BYTES, 2);
        const first = assertRefusal("feed", 1);
        resetObservations();
        expect(feedIds(await listFeed(db, ["published", "cancelled"], NOW))).toEqual([2]);
        expect(assertRefusal("feed", 1)).toBe(first);
      },
    );

    it("EGRESS-TEXT-07 oversized sitemap identity is refused without transferring/logging it", async () => {
      await seed(row(1, { eventKey: huge }), row(2));
      expect(await sitemapEvents(db)).toEqual([
        { key: key(2), status: "published", updatedAt: "2026-07-01T12:00:00.000Z" },
      ]);
      assertTransfer(SITEMAP_TEXT_BYTES, 2);
      assertRefusal("sitemap", 1);
    });

    it("EGRESS-TEXT-08 every four-byte write-valid maximum survives whole, never shortened", async () => {
      // 4 UTF-8 bytes/code point: established human write maxima, not an ASCII
      // fixture that accidentally permits a code-unit/byte confusion.
      const fields = {
        title: "😀".repeat(100),
        game: "😀".repeat(100),
        description: "😀".repeat(1000),
        location: "😀".repeat(255),
        organizer_name: "😀".repeat(500),
      };
      await seed(row(1, fields));
      const rows = await listFeed(db, ["published"], NOW);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject(fields);
      const trace = assertTransfer(FEED_TEXT_BYTES, 1);
      for (const text of Object.values(fields)) expect(trace.raw[0]).toContain(text);
      const result = await responses();
      const unfolded = result["/events.ics"]!.body.replace(/\r\n /g, "");
      expect(unfolded).toContain(`SUMMARY:${fields.title}\r\n`);
      expect(unfolded).toContain(`DESCRIPTION:${fields.description}\r\n`);
      expect(unfolded).toContain(`LOCATION:${fields.location}\r\n`);
      expect(result["/events.rss"]!.body).toContain(
        `<description>${fields.description}</description>`,
      );
      expect(result["/events.md"]!.body).toContain(fields.game);
      expect(result["/events.md"]!.body).toContain(fields.organizer_name);
      expect(warnings).toEqual([]);
    });

    it("EGRESS-TEXT-09 multibyte text below the envelope's character count is still byte-bounded", async () => {
      // 8192 characters but 32768 bytes: a 16 KiB length()/JS string-length
      // check cannot establish the transport bound. Smaller per-field limits
      // or a combined SQL byte budget are both legitimate implementations.
      await seed(row(1, { description: "😀".repeat(8192) }), row(2));
      expect(feedIds(await listFeed(db, ["published"], NOW))).toEqual([2]);
      assertTransfer(FEED_TEXT_BYTES, 2);
      assertRefusal("feed", 1);
    });

    it("EGRESS-TEXT-10 null optional text remains healthy; SQL NULL arithmetic cannot drop it", async () => {
      await seed(
        row(1, { game: null, description: null, location: null, organizer_name: null }),
        row(2, { status: "cancelled" }),
      );
      expect(feedIds(await listFeed(db, ["published", "cancelled"], NOW))).toEqual([1, 2]);
      expect((await sitemapEvents(db)).map((r) => r.key)).toEqual([key(1)]);
      expect(warnings).toEqual([]);
    });

    it("EGRESS-TEXT-11 ordinary ICS bytes, identity, sequence and conditional validators stay exact", async () => {
      await seed(row(1));
      const response = await request("/events.ics");
      const expected = calendarBytes(healthyVevent(key(1)));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(expected);
      const etag = `"${createHash("sha256").update(expected).digest("hex")}"`;
      expect(response.headers.get("etag")).toBe(etag);
      // Established collection contract uses an ETag, not Last-Modified.
      expect(response.headers.get("last-modified")).toBeNull();
      const cached = await request("/events.ics", { "if-none-match": etag });
      expect(cached.status).toBe(304);
      expect(await cached.text()).toBe("");
      expect(cached.headers.get("etag")).toBe(etag);
      expect(warnings).toEqual([]);
    });

    it("EGRESS-TEXT-12 healthy scopes and equal-start ID ordering survive refusal", async () => {
      await seed(
        row(3, { game: "Other" }),
        row(2, { game: " Helldivers ", status: "cancelled" }),
        row(1, { game: "HELLDIVERS" }),
        row(4, { game: "Helldivers", description: huge }),
        row(5, { status: "draft" }),
        row(6, { status: "past" }),
        row(7, { startsAt: new Date("2026-07-01"), endsAt: new Date("2026-07-02") }),
      );
      expect(feedIds(await listFeed(db, ["published", "cancelled"], NOW, "helldivers"))).toEqual([
        1, 2,
      ]);
      resetObservations();
      expect(feedIds(await listFeed(db, ["published"], NOW))).toEqual([1, 3]);
      resetObservations();
      expect(await listFeed(db, ["published", "cancelled"], NOW, "unknown game")).toEqual([]);
      expect(warnings).toEqual([]);
      resetObservations();
      // Description is unused by sitemap: the same row is NOT refused there.
      expect((await sitemapEvents(db)).map((r) => r.key)).toEqual([key(7), key(1), key(3), key(4)]);
      expect(warnings).toEqual([]);
    });

    it("EGRESS-TEXT-13 1000-row saturation is measured before text refusal, without refill reads", async () => {
      await fixture.client`
        insert into events (id, event_key, title, description, starts_at, ends_at, updated_at, status)
        select n, lpad(n::text, 26, '0'), 'Normal', case when n = 1 then ${huge} else null end,
          '2026-07-15 18:00:00Z'::timestamptz, '2026-07-15 20:00:00Z'::timestamptz,
          '2026-07-01 12:00:00Z'::timestamptz, 'published'
        from generate_series(1, 1001) n
      `;
      const rows = await listFeed(db, ["published"], NOW);
      expect(feedIds(rows)).toEqual(Array.from({ length: 999 }, (_, i) => i + 2));
      expect(assertTransfer(FEED_TEXT_BYTES, CAP).raw).toHaveLength(CAP);
      const capacity = warnings.filter(
        ([message]) => message === "Event egress read reached capacity.",
      );
      expect(capacity).toEqual([
        ["Event egress read reached capacity.", { surface: "feed", limit: CAP, returned: CAP }],
      ]);
      const refusal = warnings.filter(
        ([message]) => message !== "Event egress read reached capacity.",
      );
      expect(refusal).toHaveLength(1);
      expect(refusal[0]![1]).toMatchObject({ surface: "feed", skipped: 1 });
      // Conservative deterministic response bound, not a timing/heap benchmark.
      const response = await request("/events.ics");
      expect(response.status).toBe(200);
      const body = await response.text();
      expect([...body.matchAll(/BEGIN:VEVENT/g)]).toHaveLength(999);
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(FEED_RESPONSE_BOUND);
      const entries = await sitemapEvents(db);
      expect(entries).toHaveLength(CAP);
      const xml = renderSitemap(buildSitemapUrls(APP_URL, crawlableEvents(entries)));
      expect([...xml.matchAll(/<loc>[^<]+\/e\//g)]).toHaveLength(CAP);
      expect(Buffer.byteLength(xml)).toBeLessThanOrEqual(SITEMAP_RESPONSE_BOUND);
    });

    it.each(["feed", "sitemap"] as const)(
      "EGRESS-TEXT-14 %s preserves the malformed-window guard and counts each bad row once",
      async (surface) => {
        await seed(row(1), row(2), row(3));
        await fixture.client`
          update events set starts_at = '280000-01-01 18:00:00Z'::timestamptz,
            ends_at = '280000-01-01 20:00:00Z'::timestamptz where id in (1, 3)
        `;
        // Row 3 is both byte-poisoned and date-poisoned: classify/refuse once.
        await fixture.client`update events set event_key = ${huge} where id = 3`;
        resetObservations();
        if (surface === "feed") {
          expect(feedIds(await listFeed(db, ["published"], NOW))).toEqual([2]);
        } else {
          expect((await sitemapEvents(db)).map((r) => r.key)).toEqual([key(2)]);
        }
        assertTransfer(surface === "feed" ? FEED_TEXT_BYTES : SITEMAP_TEXT_BYTES, 3);
        const counts = warnings.map(([, detail]) => (detail as { skipped?: number }).skipped);
        expect(counts.every((n) => Number.isSafeInteger(n) && Number(n) > 0)).toBe(true);
        expect(counts.reduce<number>((sum, n) => sum + Number(n), 0)).toBe(2);
        expect(warnings.length).toBeLessThanOrEqual(2);
        expect(warnings.some(([message]) => String(message).includes("unrenderable"))).toBe(true);
        expect(JSON.stringify([warnings, errors])).not.toContain(MARKER);
      },
    );

    it("EGRESS-TEXT-15 text admission does not catch unexpected serializer faults as row refusals", async () => {
      await seed(row(1));
      const rows = await listFeed(db, ["published"], NOW);
      expect(() => eventsIcsCollection(rows, "not an absolute URL")).toThrow();
      expect(warnings).toEqual([]);
    });

    it.each([
      ["ASCII", "a".repeat(FEED_TEXT_BYTES + 1)],
      ["four-byte boundary plus one byte", `${"😀".repeat(FEED_TEXT_BYTES / 4)}a`],
    ])(
      "EGRESS-TEXT-16 one byte beyond the conservative text envelope refuses: %s",
      async (_name, text) => {
        expect(Buffer.byteLength(text!)).toBe(FEED_TEXT_BYTES + 1);
        await seed(row(1, { description: text }), row(2));
        expect(feedIds(await listFeed(db, ["published"], NOW))).toEqual([2]);
        assertTransfer(FEED_TEXT_BYTES, 2);
        assertRefusal("feed", 1);
      },
    );

    it.each(["feed", "sitemap"] as const)(
      "EGRESS-TEXT-17 %s bulk refusal aggregates a count, never a row/key list",
      async (surface) => {
        const bad = Array.from({ length: 103 }, (_, i) =>
          row(i + 1, surface === "feed" ? { description: huge } : { eventKey: `${huge}${i}` }),
        );
        await seed(...bad, row(104), row(105));
        if (surface === "feed") {
          expect(feedIds(await listFeed(db, ["published"], NOW))).toEqual([104, 105]);
        } else {
          expect((await sitemapEvents(db)).map((r) => r.key)).toEqual([key(104), key(105)]);
        }
        assertTransfer(surface === "feed" ? FEED_TEXT_BYTES : SITEMAP_TEXT_BYTES, 105);
        assertRefusal(surface, 103);
      },
    );

    it.each(["/events.ics", "/events.rss", "/events.md", "/sitemap_index.xml"])(
      "EGRESS-TEXT-18 %s serves healthy sibling bytes/validators with one bounded refusal read",
      async (path) => {
        await seed(row(2));
        const normal = await request(path);
        expect(normal.status).toBe(200);
        const normalBody = await normal.text();
        const normalTag = normal.headers.get("etag");
        const normalCache = normal.headers.get("cache-control");
        await fixture.reset();
        await seed(row(1, { eventKey: huge }), row(2));
        resetObservations();
        const response = await request(path);
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).toBe(normalBody);
        expect(body).toContain(key(2));
        expect(response.headers.get("etag")).toBe(normalTag);
        expect(response.headers.get("cache-control")).toBe(normalCache);
        const surface = path === "/sitemap_index.xml" ? "sitemap" : "feed";
        assertTransfer(surface === "feed" ? FEED_TEXT_BYTES : SITEMAP_TEXT_BYTES, 2);
        assertRefusal(surface, 1);
        expect(Buffer.byteLength(body)).toBeLessThanOrEqual(
          surface === "feed" ? FEED_RESPONSE_BOUND : SITEMAP_RESPONSE_BOUND,
        );
      },
    );

    it("EGRESS-TEXT-19 sitemap saturation counts raw slots before stored-key refusal, without refill", async () => {
      const refusedKey = MARKER.padEnd(257, "x");
      expect(Buffer.byteLength(refusedKey)).toBe(257);
      await fixture.client`
        insert into events (id, event_key, title, starts_at, ends_at, updated_at, status)
        select n, case when n = 1 then ${refusedKey} else lpad(n::text, 26, '0') end,
          'Normal', '2026-07-15 18:00:00Z'::timestamptz, '2026-07-15 20:00:00Z'::timestamptz,
          '2026-07-01 12:00:00Z'::timestamptz, 'published'
        from generate_series(1, 1001) n
      `;
      const entries = await sitemapEvents(db);
      expect(entries).toEqual(
        Array.from({ length: 999 }, (_, i) => ({
          key: key(i + 2),
          status: "published",
          updatedAt: "2026-07-01T12:00:00.000Z",
        })),
      );
      expect(entries.some((entry) => entry.key === key(1001))).toBe(false);
      const trace = assertTransfer(SITEMAP_TEXT_BYTES, 1000);
      expect(trace.sql.trimStart()).toMatch(/^select\b/i);
      expect(trace.raw).toHaveLength(1000);
      expect(trace.raw.some((values) => values.includes(key(1000)))).toBe(true);
      expect(trace.raw.some((values) => values.includes(key(1001)))).toBe(false);
      const capacity = warnings.filter(
        ([message]) => message === "Event egress read reached capacity.",
      );
      expect(capacity).toEqual([
        [
          "Event egress read reached capacity.",
          { surface: "sitemap", limit: 1000, returned: 1000 },
        ],
      ]);
      const refusal = warnings.filter(
        ([message]) => message !== "Event egress read reached capacity.",
      );
      expect(refusal).toHaveLength(1);
      const [message, detail] = refusal[0]!;
      expect(typeof message).toBe("string");
      expect(String(message).length).toBeLessThanOrEqual(160);
      expect(detail).toMatchObject({ surface: "sitemap", skipped: 1 });
      const fields = detail as Record<string, unknown>;
      expect(token(fields.code) || token(fields.reason), "stable refusal code/reason token").toBe(
        true,
      );
      expect(Object.keys(fields).length).toBeLessThanOrEqual(8);
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics.every((record) => record.channel === "warn")).toBe(true);
      expect(
        scanDiagnosticStream(diagnostics, [
          MARKER,
          refusedKey,
          ...Array.from({ length: 1001 }, (_, i) => key(i + 1)),
          "postgres://",
          "SELECT ",
          APP_URL,
        ]),
      ).toEqual({ hits: [], incomplete: [] });
      expect(
        Buffer.byteLength(JSON.stringify(diagnostics.map((record) => record.args))),
      ).toBeLessThanOrEqual(2048);
      expect(errors).toEqual([]);
    });
  });
}
