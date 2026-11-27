// Both serving logins deliberately have the same ACLs in the same database.
export function servingIsolationFixture({ owners, ledger, executor }) {
  const tx = async ([query]) => {
    if (query.startsWith("set local ")) return [];
    if (query.includes("pg_catalog.current_database()")) {
      return [{ database: "postgres", authenticated: executor, effective: executor }];
    }
    if (query.includes("select hash, created_at from drizzle.")) return ledger;
    if (query.startsWith("with objects as")) return owners;
    if (query.includes("from pg_auth_members m")) {
      return ["pg_read_all_data", "pg_write_all_data"].map((role) => ({
        role,
        grantor: executor,
        admin: false,
        inherit: true,
        set: false,
      }));
    }
    throw new Error("Unexpected serving isolation fixture query");
  };
  return { tx, begin: async (_, work) => work(tx), end: async () => {} };
}

// The CLI subprocess supplies only synthetic rows. Never open a socket.
export default function fixturePostgres() {
  return servingIsolationFixture(JSON.parse(process.env.FIXTURE_SERVING_ISOLATION_CATALOG));
}
