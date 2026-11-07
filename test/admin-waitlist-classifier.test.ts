import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { listRoster } from "../src/admin/reads";
import { parseRosterQuery } from "../src/admin/table-list";
import type { Db } from "../src/db/index";
import { normalizedStatement, rawMemberOwner } from "../src/db/read-classification";

// Capture the real builder's statement, not a second implementation of its SQL.
async function rosterStatement(raw: Record<string, string> = {}) {
  let statement: { sql: string; params: unknown[] } | undefined;
  const db = {
    select: () => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        leftJoin: () => chain,
        where: async () => [{ n: 0 }],
      };
      return chain;
    },
    execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      statement = new PgDialect().sqlToQuery(query);
      return [];
    },
  } as unknown as Db;
  await listRoster(db, "01J0000000000000000000ABCD", parseRosterQuery(raw));
  if (!statement) throw new Error("roster statement did not execute");
  return { ...statement, sql: normalizedStatement(statement.sql) };
}

describe("ranked roster keyed-read classifier", () => {
  it("admits only the bounded page shape for every allowlisted filter and sort", async () => {
    for (const sort of ["answered", "status", "waitlist"]) {
      for (const order of ["asc", "desc"]) {
        for (const status of ["", "going", "waitlisted", "maybe", "not_going"]) {
          for (const search of ["", "Literal %_\\"]) {
            const statement = await rosterStatement({
              roster_sort: sort,
              roster_order: order,
              roster_status: status,
              roster_q: search,
              roster_page: "2",
            });
            expect(rawMemberOwner(statement.sql)).toBe("user_id");
            expect(statement.sql).toMatch(/ limit 100 offset \$\d+$/);
            expect(statement.sql).not.toContain("Literal");
          }
        }
      }
    }
  });

  it("refuses owner laundering, changed FIFO, extra data and unbounded near-misses", async () => {
    const { sql } = await rosterStatement({ roster_sort: "waitlist" });
    const hostile = [
      sql.replace("select line.user_id,", "select users.id as user_id,"),
      sql.replace("users.id = line.user_id", "true"),
      sql.replace("rsvps.created_at,", "rsvps.updated_at,"),
      sql.replace("coalesce(rsvps.legacy_id, rsvps.id)", "rsvps.legacy_id"),
      sql.replace("partition by rsvps.status", "partition by rsvps.user_id"),
      sql.replace("users.username,", "users.username, users.avatar,"),
      sql.replace("events.event_key = $1", "true"),
      sql.replace("limit 100", "limit $2"),
      sql.replace("limit 100", "limit 101"),
      sql.replace(/ limit 100 offset \$\d+$/, ""),
      `${sql}; select id from users`,
      `${sql} union select user_id, null, status, updated_at, null from rsvps`,
    ];
    for (const query of hostile) {
      expect(query).not.toBe(sql);
      expect(rawMemberOwner(query)).toBeUndefined();
    }
  });
});
