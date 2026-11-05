// Documented per-field boundary regressions; the independent envelope acceptance
// suite stays unchanged. Registered inside the existing review-p1 DATABASE_URL gate:
//   npx vitest run test/review-p1-verify.test.ts --reporter=json
// EGRESS-BOUNDARY-* names are stable IDs in the Vitest JSON receipt.
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../../src/db/admin-schema";
import type { Db } from "../../src/db/index";
import { listFeed, sitemapEvents } from "../../src/events/reads";
import {
  captureDiagnosticStream,
  scanDiagnosticStream,
  type DiagnosticRecord,
} from "./diagnostic-stream";
import { calendarRow } from "./ics-wire-fixture";
import { createMemberDataFixture, type MemberDataFixture } from "./member-data-db";

const NOW = new Date("2026-07-10T12:00:00Z");
const key = (id: number) => String(id).padStart(26, "0");
const row = (id: number) =>
  calendarRow({ id, eventKey: key(id), game: "Fixture game", organizer_name: "Fixture host" });

// Independent literals from docs/runbook-logs.md, not implementation constants:
// a changed limit must fail both over-admission and accidental data-loss checks.
const BUDGETS = [
  { field: "eventKey", bytes: 256 },
  { field: "title", bytes: 400 },
  { field: "game", bytes: 400 },
  { field: "description", bytes: 4000 },
  { field: "timezone", bytes: 256 },
  { field: "location", bytes: 1020 },
  { field: "organizer_name", bytes: 2000 },
] as const;
const SURFACES = [
  ...BUDGETS.map((budget) => ({ surface: "feed" as const, ...budget })),
  { surface: "sitemap" as const, field: "eventKey" as const, bytes: 256 },
];
const CASES = SURFACES.flatMap(({ surface, field, bytes }) =>
  (["ascii", "multibyte"] as const).flatMap((encoding) =>
    ([-1, 0, 1] as const).map((delta) => ({
      surface,
      field,
      encoding,
      delta,
      size: bytes + delta,
    })),
  ),
);

export function registerEventEgressTextBoundaries(databaseUrl: string): void {
  let fixture: MemberDataFixture;
  let db: Db;
  const transfers: (string | null)[][][] = [];
  let diagnostics: DiagnosticRecord[] = [];

  describe("documented stored-text byte boundaries through PostgreSQL", () => {
    beforeAll(async () => {
      // The host supplies DATABASE_URL; the helper owns the disposable schema.
      fixture = await createMemberDataFixture(databaseUrl);
      db = drizzle(async (sql, params) => {
        const raw = await fixture.client.unsafe(sql, params as never[]).raw();
        // Observe the actual selected field payload BEFORE Drizzle maps it or
        // the application filters rows. Do not simulate the SQL admission in JS.
        transfers.push(raw.map((values) => values.map((v) => (v === null ? null : v.toString()))));
        return {
          rows: raw.map((values) =>
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
          ),
        };
      }) as unknown as Db;
    });
    afterAll(async () => {
      await fixture?.dispose();
    });
    beforeEach(async () => {
      await fixture.reset();
      transfers.length = 0;
      diagnostics = captureDiagnosticStream();
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each(CASES)(
      "EGRESS-BOUNDARY-$surface-$field-$encoding-$delta ($size bytes)",
      async ({ surface, field, encoding, delta, size }) => {
        // Four-byte code points plus ASCII padding hit every adjacent BYTE value,
        // not just adjacent Unicode character counts (including budget +/- 1).
        const text =
          encoding === "ascii"
            ? "a".repeat(size)
            : "😀".repeat(Math.floor(size / 4)) + "a".repeat(size % 4);
        expect(Buffer.byteLength(text, "utf8")).toBe(size);
        if (encoding === "multibyte") expect(text.length).toBeLessThan(size);
        const sibling = row(2);
        await fixture.db.insert(events).values([{ ...row(1), [field]: text }, sibling]);

        const admitted = delta <= 0;
        if (surface === "feed") {
          const result = await listFeed(db, ["published", "cancelled"], NOW);
          expect(result.map((r) => r.id)).toEqual(admitted ? [1, 2] : [2]);
          expect(result.at(-1)).toMatchObject({
            id: sibling.id,
            eventKey: sibling.eventKey,
            title: sibling.title,
            game: sibling.game,
            description: sibling.description,
            timezone: sibling.timezone,
            location: sibling.location,
            organizer_name: sibling.organizer_name,
          });
          if (admitted) expect(result[0]![field]).toBe(text);
        } else {
          const result = await sitemapEvents(db);
          expect(result.map((r) => r.key)).toEqual(
            admitted ? [text, sibling.eventKey] : [sibling.eventKey],
          );
          expect(result.at(-1)).toEqual({
            key: sibling.eventKey,
            status: "published",
            updatedAt: sibling.updatedAt.toISOString(),
          });
        }

        expect(transfers, "one SELECT, no fallback or refill read").toHaveLength(1);
        const raw = transfers[0]!;
        expect(raw, "refused rows still occupy their SQL slots").toHaveLength(2);
        if (admitted) {
          expect(raw[0], "whole original value crosses SQL, never shortened").toContain(text);
          expect(raw[0]!.filter((v) => v === null)).toHaveLength(0);
          expect(diagnostics).toEqual([]);
        } else {
          // Every projected input in these fixtures is non-null. The one over-
          // budget field must arrive as SQL NULL, not as full or truncated text.
          expect(raw[0]!.filter((v) => v === null)).toHaveLength(1);
          expect(raw.flat()).not.toContain(text);
          expect(diagnostics.map(({ channel, args }) => ({ channel, args }))).toEqual([
            {
              channel: "warn",
              args: [
                "Event egress read refused oversized stored text.",
                { surface, skipped: 1, code: "stored-text-oversized" },
              ],
            },
          ]);
          expect(
            scanDiagnosticStream(diagnostics, [text, key(1), key(2), "postgres://", "SELECT "]),
          ).toEqual({
            hits: [],
            incomplete: [],
          });
          expect(Buffer.byteLength(JSON.stringify(diagnostics.map((r) => r.args)))).toBeLessThan(
            512,
          );
        }
        // Bound the raw SQL field payload too, independently of JS row refusal.
        for (const values of raw) {
          const bytes = values.reduce((n, v) => n + Buffer.byteLength(v ?? ""), 0);
          expect(bytes).toBeLessThanOrEqual((surface === "feed" ? 8332 : 256) + 1024);
        }
      },
    );
  });
}
