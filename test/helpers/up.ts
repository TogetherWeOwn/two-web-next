import type { Sql } from "postgres";
import { WEB_MIGRATIONS } from "../../src/up";

type Result = Record<string, unknown>[] | Error | (() => Promise<Record<string, unknown>[]>);

// Query-aware double: a healthy queue cannot stand in for a DB ping or ledger.
export function healthSql(
  options: {
    ping?: Result;
    migrations?: Result;
    absence?: Result;
    legacy?: Result;
    queue?: Result;
  } = {},
): Sql {
  const fn = async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("set_config")) return [];
    const result = query.includes("to_regclass")
      ? (options.absence ?? [{ absent: false }])
      : query.includes("web_readiness.migration_timestamps")
        ? (options.migrations ??
          WEB_MIGRATIONS.map((entry) => ({ created_at: String(entry.when) })))
        : query.includes("__drizzle_migrations")
          ? (options.legacy ?? new Error("Unexpected legacy read"))
          : query.includes("queue_jobs")
            ? (options.queue ?? [])
            : (options.ping ?? [{ checked_at: new Date() }]);
    if (result instanceof Error) throw result;
    return typeof result === "function" ? result() : result;
  };
  const sql = fn as unknown as Sql;
  return Object.assign(sql, {
    begin: async (_options: string, read: (tx: Sql) => Promise<unknown>) => read(sql),
  });
}
