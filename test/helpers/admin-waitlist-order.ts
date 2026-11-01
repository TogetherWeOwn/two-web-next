import { drizzle } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import type { Db } from "../../src/db/index";
import { adminSchema, schema } from "../../src/db/index";
import { events } from "../../src/db/admin-schema";
import { users } from "../../src/db/schema";
import { memberReadDb } from "../../src/db/member-reads";
import { listRoster, type RosterEntry } from "../../src/admin/reads";
import { parseRosterQuery } from "../../src/admin/table-list";
import { bufferedMemberJson, memberReadBoundary } from "../../src/member-reads";
import type { AccessEntry } from "../../src/access-log";
import { createMemberDataFixture } from "./member-data-db";
import { MODERATOR } from "./member-data";
import { key, row } from "./admin-roster-status";

export { key };

export const middleName = "Middle Café %_\\";
export const memberId = (position: number) => String(913410000000001000n - BigInt(position));
export type PositionedEntry = RosterEntry & {
  waitlistPosition?: number | null;
};

// Hand-assigned ranks, not the output of the promotion/position implementation.
// Positions 1/2 differ only below JS Date precision; 3/4 share the coalesced
// key and need the native id; position 5 has a bigint beyond Number precision.
export async function waitlistFixture() {
  const fixture = await createMemberDataFixture(process.env.DATABASE_URL ?? "");
  const statements: { sql: string; params: unknown[] }[] = [];
  const db: Db = drizzle(fixture.client, {
    schema: { ...schema, ...adminSchema },
    logger: { logQuery: (sql, params) => statements.push({ sql, params }) },
  });
  const [event, other] = await db
    .insert(events)
    .values([
      { ...row, id: undefined, icsSequence: undefined },
      {
        ...row,
        id: undefined,
        icsSequence: undefined,
        eventKey: "01J0000000000000000000ABCE",
      },
    ])
    .returning();
  if (!event || !other) throw new Error("fixture events missing");
  await db.insert(users).values(
    Array.from({ length: 110 }, (_, i) => i + 1)
      .filter((position) => position !== 102)
      .map((position) => ({
        id: memberId(position),
        username:
          position === 57
            ? middleName
            : position === 103
              ? "   "
              : `Line ${String(position).padStart(3, "0")}`,
      })),
  );
  const first = [
    [81003102, "2026-01-01 00:00:00.000100+00", "9007199254740999"],
    [81003101, "2026-01-01 00:00:00.000200+00", "1"],
    [81003104, "2026-01-01 00:00:00.001000+00", null],
    [81003105, "2026-01-01 00:00:00.001000+00", "81003104"],
    [81003103, "2026-01-01 00:00:00.001000+00", "9223372036854775806"],
    [81003107, "2026-01-01 00:00:00.002000+00", "9007199254740992"],
    [81003106, "2026-01-01 00:00:00.002000+00", "9007199254740993"],
  ] as const;
  for (let position = 1; position <= 110; position++) {
    const special = first[position - 1];
    await fixture.client`
      insert into rsvps (id, event_id, user_id, status, created_at, updated_at, legacy_id)
      values (${special?.[0] ?? 81003200 + position}, ${event.id}, ${memberId(position)},
        ${position <= 107 ? "waitlisted" : ["going", "maybe", "not_going"][position - 108]!},
        ${special?.[1] ?? `2026-01-02 00:${String(Math.floor(position / 60)).padStart(2, "0")}:${String(position % 60).padStart(2, "0")}+00`}::timestamptz,
        ${new Date(Date.UTC(2026, 2, 1, 0, 0, 111 - position)).toISOString()}::timestamptz, ${special?.[2] ?? null})`;
  }
  await fixture.client`
    insert into rsvps (event_id,user_id,status,created_at,updated_at)
    values (${other.id},${memberId(57)},'waitlisted','2000-01-01','2000-01-01')`;
  statements.length = 0;
  return { ...fixture, db, event, statements };
}
export type WaitlistFixture = Awaited<ReturnType<typeof waitlistFixture>>;

export function queueQuery(extra: Record<string, string> = {}) {
  return parseRosterQuery({
    roster_sort: "waitlist",
    roster_order: "asc",
    ...extra,
  });
}

// Use the actual observation adapter: a query that lost its classification or
// owner provenance must fail before a success response can escape.
export async function capturedRoster(fixture: WaitlistFixture, raw: Record<string, string> = {}) {
  const audits: AccessEntry[] = [];
  const app = new Hono();
  app.get("/", async (c) => {
    await memberReadBoundary(
      c,
      {
        viewer: MODERATOR.userId,
        resource: "events",
        action: "view",
        route: "admin.events.edit",
      },
      async (entry) => {
        audits.push(entry);
        return true;
      },
      async () => {
        const result = await listRoster(memberReadDb(fixture.db), key, queueQuery(raw));
        bufferedMemberJson(c, result);
      },
    );
    return c.res;
  });
  fixture.statements.length = 0;
  const response = await app.request("/");
  if (response.status !== 200) throw new Error(`classified roster refused: ${response.status}`);
  const result = (await response.json()) as {
    rows: PositionedEntry[];
    total: number;
  };
  return { ...result, audits, response };
}
