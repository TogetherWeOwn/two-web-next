// Optional direct-agent-testdb control. Never Hyperdrive or Neon evidence.
import { expect, it, vi } from "vitest";
import postgres from "postgres";
import { runFixedStagingChecks } from "../spike/hyperdrive-semantics/staging-checks";

// Pin ALL options; no connection URL/environment override is accepted.
const open = () => postgres({
  host: "agent-testdb", port: 5432, username: "agent_test", password: () => "",
  database: "agent_test", ssl: false, max: 1, fetch_types: false, prepare: true,
  connect_timeout: 5,
  connection: { application_name: "w1-staging-offline-control", statement_timeout: 5000, lock_timeout: 2000 },
});
const enabled = process.env.W1_AGENT_TESTDB === "1";
async function expectDropped(schema: string) {
  const verify = open();
  try {
    const [row] = await verify`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = ${schema}`;
    expect(row?.n).toBe(0);
  } finally {
    await verify.end({ timeout: 2 });
  }
}

it.skipIf(!enabled)("fixed prepared checks clean their agent-testdb schema", async () => {
  const result = await runFixedStagingChecks(open);
  expect(result).toMatchObject({ ok: true, passed: 3, total: 3, cleanup: true });
  expect(result).not.toHaveProperty("path");
  await expectDropped(result.schema);
}, 30_000);

it.skipIf(!enabled)("setup failure drops only the owned agent-testdb schema", async () => {
  let ownedSchema = "";
  await expect(runFixedStagingChecks(() => {
    const sql = open();
    const unsafe = sql.unsafe.bind(sql);
    vi.spyOn(sql, "unsafe").mockImplementation((...args) => {
      const created = /^CREATE SCHEMA (w1_staging_[a-f0-9]{32})$/.exec(args[0]);
      if (created) ownedSchema = created[1]!;
      if (args[0].includes("CREATE TABLE") && args[0].includes("spike_rsvps")) throw new Error("forced_offline_setup_failure");
      return unsafe(...args);
    });
    return sql;
  })).rejects.toThrow("forced_offline_setup_failure");
  expect(ownedSchema).toMatch(/^w1_staging_[a-f0-9]{32}$/);
  await expectDropped(ownedSchema);
}, 30_000);
