// Acceptance-owned local SQL fixtures. Never replace the predicate with a URL-aware fake.
import { drizzle } from "drizzle-orm/postgres-js";
import { events } from "../../src/db/admin-schema";
import { adminSchema, schema } from "../../src/db/index";
import type { PublicEvent } from "../../src/events/reads";
import { createMemberDataFixture } from "./member-data-db";
import { archiveEnv, archiveRow } from "./past-archive-search-acceptance";

export const GAME = "Go";
export const TEXT = "Table night";
export const SPECIAL_GAME = "Échecs & <club> %_\\🎲";
export const archiveGamePath = (game = GAME, page = 1, q = "") =>
  `/events/past?${new URLSearchParams({ game, page: String(page), ...(q ? { q } : {}) })}`;
export const gameKey = (n: number) => `01ARZ3NDEKTSV4RRFF${String(n).padStart(8, "0")}`;
export const gameRow = (n: number, overrides: Partial<PublicEvent> = {}) =>
  archiveRow(n, {
    eventKey: gameKey(n),
    title: `${TEXT} ${n}`,
    game: GAME,
    ...overrides,
  });
export const gameFirstKeys = Array.from({ length: 20 }, (_, i) => gameKey((25 - i) * 2));
export const gameLastKeys = [gameKey(10), gameKey(8), gameKey(6), gameKey(4), gameKey(2)];

// All starts tie; nonmatches interleave across the 20/5 boundary. Neither title
// nor description contains "Go", so treating game as text cannot pass.
export function gameRows(): PublicEvent[] {
  return [
    ...Array.from({ length: 25 }, (_, index) => {
      const n = index + 1;
      return [
        gameRow(n * 2, {
          status: n % 2 ? "past" : "published",
          title: n === 3 ? "A different heading" : `${TEXT} ${n}`,
          description: n === 3 ? `About ${TEXT}` : null,
        }),
        gameRow(n * 2 + 1, { game: "Chess" }),
      ];
    }).flat(),
    gameRow(101, { status: "draft", game: "Draft only" }),
    gameRow(102, { status: "cancelled", game: "Cancelled only" }),
    gameRow(103, {
      status: "published",
      game: "Future only",
      startsAt: new Date("2031-01-01T20:00:00Z"),
      endsAt: new Date("2031-01-01T22:00:00Z"),
    }),
    gameRow(104, { status: "past", game: SPECIAL_GAME, title: "Special table" }),
    gameRow(105, {
      status: "past",
      game: "Explicit past only",
      title: "Closed early",
      endsAt: new Date("2031-01-01T22:00:00Z"),
    }),
    gameRow(106, { status: "draft" }),
    gameRow(107, { status: "cancelled" }),
  ];
}

export async function createArchiveGameFixture() {
  // Deliberately no skip or credential fallback. The shared guard refuses unsafe
  // targets before connecting; both CI jobs supply their disposable service URL.
  const fixture = await createMemberDataFixture(process.env.DATABASE_URL ?? "");
  const statements: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(fixture.client, {
    schema: { ...schema, ...adminSchema },
    logger: { logQuery: (sql, params) => statements.push({ sql, params }) },
  });
  return {
    ...fixture,
    db,
    env: archiveEnv(db),
    statements,
    async seed(rows = gameRows()) {
      await fixture.reset();
      await fixture.db.insert(events).values(rows);
      statements.length = 0;
    },
  };
}
