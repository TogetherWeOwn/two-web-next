// Per-app profile store, stats and access-log sink resolvers. Split out of
// src/profiles/routes.tsx: each prefers the injected dep and otherwise
// builds from the request env.
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { AccessSink } from "../access-log";
import { dbFor, type EnvWithAdminDb } from "../admin/db";
import { recordAccess } from "../admin/store";
import { botDatabaseUrl, databaseOptions } from "../db/connection";
import type { Env } from "../env";
import type { Ctx, ProfileDeps } from "./routes-shared";
import { readAttendedHistory, type AttendedHistory } from "./history";
import {
  MEMBER_STATS_BUDGET_MS,
  memberStatsWithBudget,
  readMemberStats,
  readOwnedMemberStats,
} from "./stats";
import { createDbProfileStore, type ProfileStore } from "./store";

export function profileStores(deps: ProfileDeps) {
  const storeFor = async (c: { env: Env }): Promise<ProfileStore | null> => {
    if (deps.store) return deps.store;
    const db = await dbFor(c);
    return db ? createDbProfileStore(db) : null;
  };
  const statsFor = (c: Ctx, id: string) =>
    memberStatsWithBudget(
      deps.stats ??
        (async (memberId, signal) => {
          // Injected fixtures/clients are borrowed, never shut down by this request.
          const injected = (c.env as EnvWithAdminDb).ADMIN_DB;
          if (injected) return readMemberStats(injected, memberId, signal, c.get("requestId"));
          // Bot-owned `web_v1` views live in the bot database, never the
          // web DB (same source rule as homepage counts): explicit
          // BOT_DATABASE_URL wins, else the BOT_DB Hyperdrive binding.
          const url = botDatabaseUrl(c.env);
          if (!url) return null;
          signal.throwIfAborted();
          // Also bound server-side execution if the connection disappears mid-query.
          const client = postgres(url, {
            ...databaseOptions,
            connection: { statement_timeout: MEMBER_STATS_BUDGET_MS },
          });
          return readOwnedMemberStats(drizzle(client), memberId, signal, c.get("requestId"));
        }),
      id,
      c.get("requestId"),
    );
  const sinkFor = async (c: { env: Env }): Promise<AccessSink | null> => {
    if (deps.accessLog) return deps.accessLog;
    const db = await dbFor(c);
    return db ? (entry) => recordAccess(db, entry) : null;
  };
  // Own attended history for the self-view only; the read route decides
  // selfness, so other-member renders never reach this read. No database
  // reads as absent (no section), like a missing stats block.
  const historyFor = async (c: Ctx, id: string): Promise<AttendedHistory | null> => {
    if (deps.history) return deps.history(id);
    const db = await dbFor(c);
    return db ? readAttendedHistory(db, id) : null;
  };
  return { storeFor, statsFor, sinkFor, historyFor };
}

export type ProfileStores = ReturnType<typeof profileStores>;
