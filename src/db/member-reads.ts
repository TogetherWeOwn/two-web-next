// Clone Drizzle's execution adapter, not a shared client's request state. This
// observes mapped SELECTs and transaction descendants before results escape.
import { Column, getTableName, is } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PgDialect, PgSession } from "drizzle-orm/pg-core";
import { captureMemberKeys, memberQueryPermit, memberReadActive, refuseMemberRead } from "../member-reads";

import type { Db } from "./index";
import { rawMemberOwner, validateNonSensitiveRead, type SelectedField } from "./read-classification";
const owners: Record<string, string> = {
  users: "id", profiles: "user_id", rsvps: "user_id", join_attempts: "discord_id",
};
// CTEs can mutate even when the final SELECT never references them. Only the
// supported SELECT shapes are reads; do not infer safety from a WITH prefix.
const readStatement = (statement: string) => /^\s*select\b/i.test(statement);
const valueAt = (row: unknown, path: string[]): unknown => {
  let value = row;
  for (const key of path) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
};

function ownerProjection(fields?: SelectedField[]) {
  if (!fields?.length) refuseMemberRead();
  const tables = new Map<string, { key?: SelectedField; fields: SelectedField[] }>();
  for (const selected of fields) {
    // Raw SQL/aliased expressions do not establish owner-column provenance.
    if (!is(selected.field, Column)) refuseMemberRead();
    // Drizzle aliases preserve OriginalName but change Name. Resolve the base
    // owner and group each SQL relation separately; one alias cannot lend its
    // key to another alias (or to an unaliased copy of the same table).
    const table = selected.field.table;
    const original: unknown = Reflect.get(table, Symbol.for("drizzle:OriginalName"));
    if (typeof original !== "string") refuseMemberRead();
    if (!owners[original]) continue;
    const relation = JSON.stringify([Reflect.get(table, Symbol.for("drizzle:Schema")), original, getTableName(table)]);
    const group = tables.get(relation) ?? { fields: [] };
    group.fields.push(selected);
    if (selected.field.name === owners[original]) group.key = selected;
    tables.set(relation, group);
  }
  if (tables.size === 0 || [...tables.values()].some((group) => !group.key)) refuseMemberRead();
  return [...tables.values()];
}

/** Borrow the pool, but retain observation on builders prepared before capture. */
export function memberReadDb(db: Db): Db {
  let observed: Db | undefined;
  return new Proxy(db, {
    get(target, property) {
      const queryMethod = ["select", "selectDistinct", "selectDistinctOn", "insert", "update", "delete", "refreshMaterializedView", "execute", "transaction", "$with", "with", "query", "$count"].includes(String(property));
      // Production postgres-js builders retain observation before capture.
      // Other test adapters stay unchanged outside a sensitive-read boundary.
      const source = queryMethod && (memberReadActive() || is(target, PostgresJsDatabase))
        ? (observed ??= observeMemberReads(target)) : target;
      const value = Reflect.get(source, property);
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
}

/** Preserves the original pool/transaction, schema and mapping; no new lookup. */
export function observeMemberReads(db: Db): Db {
  // Drizzle exposes schema/session metadata on `_`, but protects its dialect in
  // TypeScript. Keep the version-specific adapter access in this one module.
  const internals = db as unknown as { dialect: PgDialect; session: PgSession; _: Db["_"] };
  const session = new Proxy(internals.session, {
    get(target, property, receiver) {
      if (property === "prepareQuery") {
        return (...args: Parameters<PgSession["prepareQuery"]>) => {
          const prepared = target.prepareQuery(...args);
          const statement = args[0].sql;
          const fields = args[1] as SelectedField[] | undefined;
          return new Proxy(prepared, {
            get(query, method, queryReceiver) {
              const original = Reflect.get(query, method, queryReceiver);
              if ((method === "execute" || method === "all") && typeof original === "function") {
                return async (...values: unknown[]) => {
                  // A leading SQL comment or RETURNING mutation must not bypass
                  // observation merely by missing the SELECT prefix. The audit
                  // sink runs outside capture; handlers may only consume reads.
                  const permit = memberReadActive() ? memberQueryPermit() : undefined;
                  if (permit && !readStatement(statement)) refuseMemberRead();
                  if (permit?.classification) validateNonSensitiveRead(permit.classification, statement, fields);
                  const capture = permit && !permit.classification ? permit.capture : undefined;
                  const rawOwner = capture && !fields?.length ? rawMemberOwner(statement) : undefined;
                  const projection = capture && !rawOwner ? ownerProjection(fields) : undefined;
                  const rows: unknown = await Reflect.apply(original, query, values);
                  if (capture) {
                    if (!Array.isArray(rows)) refuseMemberRead();
                    const keys = rawOwner ? rows.map((row) => valueAt(row, [rawOwner]))
                      : rows.flatMap((row) => projection!.flatMap((group) => {
                        // A missing LEFT JOIN contributes no contents/subject.
                        const absent = group.fields.every((field) => valueAt(row, field.path) === null);
                        return absent ? [] : [valueAt(row, group.key!.path)];
                      }));
                    captureMemberKeys(capture, keys);
                  }
                  return rows;
                };
              }
              // setToken() is fluent; returning the underlying prepared query
              // here would discard observation just before execute().
              return typeof original === "function" ? (...values: unknown[]) => {
                const result = Reflect.apply(original, query, values);
                return result === query ? queryReceiver : result;
              } : original;
            },
          });
        };
      }
      if (property === "transaction") {
        return (callback: (tx: Db) => Promise<unknown>, config?: Parameters<PgSession["transaction"]>[1]) =>
          target.transaction((tx) => callback(observeMemberReads(tx as unknown as Db)), config);
      }
      const original = Reflect.get(target, property, receiver);
      // PgSession.count/execute/all call this.prepareQuery. Keep the proxy as
      // receiver so native helpers cannot re-enter the unobserved session.
      return typeof original === "function" ? original.bind(receiver) : original;
    },
  });
  const schema = internals._.schema ? {
    schema: internals._.schema, fullSchema: internals._.fullSchema, tableNamesMap: internals._.tableNamesMap,
  } : undefined;
  const observed = new PostgresJsDatabase(internals.dialect, session, schema) as Db;
  observed.$client = db.$client;
  return observed;
}
