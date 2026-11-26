export function repairClientWithCloseFailure({ states, acknowledge }, events, transactionError) {
  const tx = ([sql]) => {
    if (sql.startsWith("select pg_catalog.current_database()")) {
      return [{ database: "postgres", authenticated: "repair_owner", effective: "repair_owner" }];
    }
    return [{ acquired: true, clear: true, authorized: true }];
  };
  tx.unsafe = (sql) => {
    if (/^(GRANT|REVOKE|ALTER) /.test(sql)) {
      events.push("mutation");
      return [];
    }
    return [states.shift()];
  };
  return {
    async begin(_, execute) {
      events.push("begin");
      const outcome = await execute(tx);
      events.push(outcome);
      if (!acknowledge) throw transactionError;
      return outcome;
    },
    async end({ timeout }) {
      events.push(`end:${timeout}`);
      throw new Error("fixture close driver detail");
    },
  };
}

export default function syntheticPostgres() {
  return repairClientWithCloseFailure(
    JSON.parse(process.env.REPAIR_CLOSE_FIXTURE),
    [],
    new Error("fixture transaction driver detail"),
  );
}
