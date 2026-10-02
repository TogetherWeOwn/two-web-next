// Bot-owned web_v1 views are not part of the owned web fixture schema.
// Keep these read models synthetic; never create or read shared bot tables.
import type { PgDialect, PgSession } from "drizzle-orm/pg-core";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Counts } from "../src/counts";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";

export type AuditFixtureState = "populated" | "unavailable";
export function auditFixtureState(value: string | null): AuditFixtureState {
  if (value === null || value === "populated") return "populated";
  if (value === "unavailable") return value;
  throw new Error("Unknown accessibility read-model fixture state");
}

// Only the temporary audit bundle substitutes this export for src/counts.ts.
export async function readCounts(
  env: Env & { A11Y_READ_STATE?: AuditFixtureState },
): Promise<Counts> {
  if (env.A11Y_READ_STATE === "unavailable")
    return { memberCount: null, onlineCount: null, ranks: [] };
  return {
    memberCount: 84,
    onlineCount: 12,
    ranks: [
      { key: "prospect", label: "Prospect", memberCount: 4 },
      { key: "member", label: "Member", memberCount: 50 },
      { key: "soldier", label: "Soldier", memberCount: 20 },
      { key: "veteran", label: "Veteran", memberCount: 10 },
      { key: "legend", label: "Legend", memberCount: 0 },
    ],
  };
}

const members: Record<string, Record<string, unknown>> = {
  "100000000000000101": {
    joined_at: "2025-01-01T00:00:00Z",
    tenure_days: 637,
    rank_key: "veteran",
    is_current_member: true,
  },
  "100000000000000102": {
    joined_at: "2026-09-30T00:00:00Z",
    tenure_days: 1,
    rank_key: "prospect",
    is_current_member: false,
  },
};
const milestones = [
  {
    milestone: "first_event",
    occurred_at: "2026-09-29T19:00:00Z",
    detail: "Synthetic chess night — مرحباً",
  },
  { milestone: "joined", occurred_at: "2025-01-01T00:00:00Z", detail: null },
];
export function auditReadDatabase(db: Db, state: AuditFixtureState): Db {
  // Substitute at the execution seam: a member boundary clones the session,
  // so a top-level execute override alone would expose the borrowed bot views.
  const internals = db as unknown as { dialect: PgDialect; session: PgSession; _: Db["_"] };
  const session = new Proxy(internals.session, {
    get(target, property, receiver) {
      if (property === "prepareQuery") {
        return (...args: Parameters<PgSession["prepareQuery"]>) => {
          const parsed = args[0];
          const statement = parsed.sql
            .replaceAll('"', "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
          if (!/\bweb_v1\b/.test(statement)) return target.prepareQuery(...args);
          // Strictly intercept BOTH qualified queries, including their bound ID.
          // Unknown bot-view reads fail before even preparing on the real client.
          const memberQuery =
            "select member_id, joined_at, tenure_days, rank_key, is_current_member from web_v1.members where member_id = $1 limit 1";
          const milestoneQuery =
            "select member_id, milestone, occurred_at, detail from web_v1.member_milestones where member_id = $1 order by occurred_at desc";
          if (
            ![memberQuery, milestoneQuery].includes(statement) ||
            parsed.params.length !== 1 ||
            typeof parsed.params[0] !== "string"
          ) {
            throw new Error("Accessibility bot-view query has no isolated fixture");
          }
          const id = parsed.params[0];
          return {
            execute: async () =>
              state === "unavailable" || !Object.hasOwn(members, id)
                ? []
                : statement === memberQuery
                  ? [{ member_id: id, ...members[id] }]
                  : id === "100000000000000101"
                    ? milestones.map((row) => ({ member_id: id, ...row }))
                    : [],
          };
        };
      }
      if (property === "transaction") {
        return (
          callback: (tx: Db) => Promise<unknown>,
          config?: Parameters<PgSession["transaction"]>[1],
        ) =>
          target.transaction(
            (tx) => callback(auditReadDatabase(tx as unknown as Db, state)),
            config,
          );
      }
      const original = Reflect.get(target, property, receiver);
      return typeof original === "function" ? original.bind(target) : original;
    },
  });
  const schema = internals._.schema
    ? {
        schema: internals._.schema,
        fullSchema: internals._.fullSchema,
        tableNamesMap: internals._.tableNamesMap,
      }
    : undefined;
  const isolated = new PostgresJsDatabase(internals.dialect, session, schema) as Db;
  isolated.$client = db.$client;
  return isolated;
}
