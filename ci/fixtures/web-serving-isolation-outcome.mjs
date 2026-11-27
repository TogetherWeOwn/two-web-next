import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { addedAfter1033, publicServingRights } from "../web-readiness-scoped-acl.mjs";
import { prepareServingIsolation } from "./web-serving-isolation.mjs";

const firstEnd = "1033_session-roles-checked-at";
const database = "postgres";
const migrationRole = "fixture_executor";
const login = "two_web_app";
const originalMembership = ["pg_read_all_data", "pg_write_all_data"].map((role) => ({
  role,
  grantor: migrationRole,
  admin: false,
  inherit: true,
  set: false,
}));
const acl = Array.from(
  Map.groupBy(
    publicServingRights.filter(({ name }) => !addedAfter1033.has(name)),
    ({ kind, name, column }) => `${kind}/${name}/${column}`,
  ).values(),
  (rights) => {
    const [{ kind, name, column }] = rights;
    return {
      kind,
      name,
      column,
      owner: migrationRole,
      direct: rights.map(({ right }) => [right, migrationRole, false]),
    };
  },
);

export async function prepareServingIsolationOutcome(initial = "before") {
  const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
  const journal = readMigrationFiles({ migrationsFolder })
    .slice(0, 34)
    .map(({ hash, folderMillis }) => ({ hash, created_at: folderMillis }));
  const events = [];
  const faults = {};
  let membership = initial === "before" ? originalMembership : [];

  const { run } = await prepareServingIsolation({
    owner(strings) {
      if (strings[0].startsWith("with objects as")) return acl;
      assert.match(strings[0], /^select role\.rolname/);
      return originalMembership;
    },
    login,
    database,
    migrationRole,
    firstEnd,
    timestamps: journal.map(({ created_at }) => created_at),
    connect(_, { readOnly }) {
      return {
        async begin(mode, callback) {
          assert.equal(
            mode,
            readOnly
              ? "isolation level repeatable read read only"
              : "isolation level read committed",
          );
          events.push(readOnly ? "read only" : "write transaction");
          let pending = [...membership];
          const tx = (strings, role) => {
            if (typeof strings === "string") return strings;
            const sql = strings[0].trim();
            if (/^(set local|reset role)/.test(sql)) return [];
            if (sql.startsWith("select pg_catalog.current_database"))
              return [{ database, authenticated: migrationRole, effective: migrationRole }];
            if (sql.startsWith("select hash, created_at")) return journal;
            if (sql.startsWith("with objects as")) return acl;
            if (sql.startsWith("select role.rolname")) return pending;
            if (sql.startsWith("select bool_and")) return [{ allowed: true }];
            if (sql.startsWith("select rolcanlogin")) return [{ scoped: true }];
            assert.equal(readOnly, false, "readback must avoid mutation queries and locks");
            if (sql.startsWith("select pg_try_advisory")) return [{ acquired: true }];
            if (sql.startsWith("lock table drizzle.")) return [];
            if (sql.startsWith("select array(select c.relname"))
              return [{ names: [...new Set(acl.map(({ name }) => name))] }];
            if (sql.startsWith("select pg_get_viewdef"))
              return [
                {
                  intact: true,
                  definition: "SELECT created_at FROM drizzle.__drizzle_migrations OFFSET 0;",
                },
              ];
            if (sql.startsWith("select array(select p::text")) return [{ exact: true }];
            if (sql.startsWith("select created_at from web_readiness")) return journal;
            assert.match(sql, /^(grant|revoke)$/);
            const edge = originalMembership.find((entry) => entry.role === role);
            assert.ok(edge);
            events.push(`${sql} ${role}`);
            if (role === "pg_write_all_data" && faults.statement) throw faults.statement;
            pending = sql === "grant" ? [...pending, edge] : pending.filter((row) => row !== edge);
            return [];
          };
          tx.unsafe = (sql, args) => {
            if (!args) return sql;
            assert.match(sql.trim(), /^WITH runtimes AS/);
            assert.deepEqual(args, [login]);
            assert.deepEqual(pending, []);
            return [];
          };
          const outcome = await callback(tx);
          events.push("callback completed");
          membership = pending;
          if (faults.acknowledgement) throw faults.acknowledgement;
          events.push("acknowledged");
          return outcome;
        },
        async end(options) {
          assert.deepEqual(options, { timeout: 5 });
          events.push("close");
          if (faults.close) throw faults.close;
        },
      };
    },
  });
  return { run, events, faults };
}
