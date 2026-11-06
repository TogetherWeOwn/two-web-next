import { drizzle } from "drizzle-orm/postgres-js";
import { expect, vi } from "vitest";
import type { Db } from "../../src/db/index";
import { adminSchema, schema } from "../../src/db/index";
import { events, memberDataAccessLogs } from "../../src/db/admin-schema";
import { users } from "../../src/db/schema";
import * as reads from "../../src/admin/reads";
import { parseRosterQuery } from "../../src/admin/table-list";
import { createMemberDataFixture } from "./member-data-db";
import { clearAuditRows } from "./audit-rows";
import {
  compileRosterKit,
  key,
  readRoster,
  rosterHtml,
  row,
  text,
  type Renderer,
} from "./admin-roster-status";

export { key };

export const middleName = "Middle Café %_\\";
export const memberId = (position: number) => String(913410000000001000n - BigInt(position));

// Hand-assigned ranks, not the output of the promotion/position implementation.
// Positions 1/2 differ only below JS Date precision; 3/4 share the coalesced
// key and need the native id; position 5 has a bigint beyond Number precision.
export async function waitlistFixture(create = createMemberDataFixture) {
  const fixture = await create(process.env.DATABASE_URL ?? "");
  try {
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
                : `${[1, 3, 105].includes(position) ? "Gap" : "Line"} ${String(position).padStart(3, "0")}`,
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
    const kit = await compileRosterKit();
    statements.length = 0;
    return { ...fixture, db, event, statements, kit };
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}
export type WaitlistFixture = Awaited<ReturnType<typeof waitlistFixture>>;

export function queueQuery(extra: Record<string, string> = {}) {
  return parseRosterQuery({
    roster_sort: "waitlist",
    roster_order: "asc",
    ...extra,
  });
}

// Call-through spy captures the exact data handed to the real route renderer.
// SQL, observation, admission and persisted auditing all remain real.
export async function capturedRoster(
  fixture: WaitlistFixture,
  raw: Record<string, string> = {},
  renderer: Renderer = "Hono",
) {
  await clearAuditRows(fixture.db, ["member_data_access_logs"]);
  const spy = vi.spyOn(reads, "listRoster");
  fixture.kit.configure({ listRoster: spy });
  try {
    fixture.statements.length = 0;
    const response = await readRoster(
      renderer,
      fixture,
      new URLSearchParams({
        roster_sort: "waitlist",
        roster_order: "asc",
        ...raw,
      }).toString(),
      fixture.kit,
    );
    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalledOnce();
    const result: Awaited<ReturnType<typeof reads.listRoster>> = await spy.mock.results[0]!.value;
    const html = rosterHtml(await response.text());
    const names = [...html.matchAll(/<tr\b[^>]*>\s*<td\b[^>]*>([\s\S]*?)<\/td>/g)]
      .filter((m) => !m[0].includes('data-testid="roster-empty"'))
      .map((m) => text(m[1]!));
    expect(names).toEqual(result.rows.map((r) => r.username?.trim() || "Unknown member"));
    // Keep query-count evidence independent of the fixture's own audit inspection.
    const statements = [...fixture.statements];
    const audits = await fixture.db.select().from(memberDataAccessLogs);
    fixture.statements.splice(0, fixture.statements.length, ...statements);
    return { ...result, audits, response };
  } finally {
    spy.mockRestore();
    fixture.kit.configure({ listRoster: reads.listRoster });
  }
}
