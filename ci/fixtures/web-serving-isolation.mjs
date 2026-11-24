import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PLANETSCALE_PRODUCTION_BRANCH_ID, PLANETSCALE_PRODUCTION_HOST } from "../db-migrate.mjs";
import { planServingIsolation, runServingIsolation } from "../db-serving-ledger-isolation.mjs";

const ledger = "drizzle.__drizzle_migrations";
const projection = "web_readiness.migration_timestamps";

// The existing bridge rehearsal owns the database, roles and both Worker builds.
export async function rehearseServingIsolation({
  owner,
  reader,
  login,
  database,
  ownerRole,
  databasePath,
  oldHistory,
  newHistory,
  cutoverUp,
  probeEventSync,
}) {
  await owner`GRANT USAGE ON SCHEMA drizzle TO ${owner(login)}`;
  await owner`GRANT SELECT (created_at) ON drizzle.__drizzle_migrations TO ${owner(login)}`;
  const version = randomUUID();
  const sha = (data) => createHash("sha256").update(data).digest("hex");
  const identityHash = sha(`${database}\0${ownerRole}`);
  const plan = JSON.stringify(await planServingIsolation(owner, identityHash, version, login));
  const firstEnd = oldHistory.at(-1).tag;
  const lastEnd = newHistory.at(-1).tag;
  const run = (operation, end = firstEnd, liveVersion = version) =>
    runServingIsolation(
      operation,
      end,
      {
        PRODUCTION_DB_ISOLATION_PLAN: plan,
        PRODUCTION_DB_ISOLATION_PLAN_SHA256: sha(plan),
        PRODUCTION_DB_ISOLATION_DATABASE_URL: `postgresql://fixture.${PLANETSCALE_PRODUCTION_BRANCH_ID}:fixture-password@${PLANETSCALE_PRODUCTION_HOST}:5432/postgres?sslmode=verify-full`,
        PRODUCTION_DB_ISOLATION_CF_ACCOUNT_ID: "a".repeat(32),
        PRODUCTION_DB_ISOLATION_CF_READ_TOKEN: "fixture",
      },
      {
        login,
        owner: ownerRole,
        connect(config) {
          config.url.pathname = databasePath;
          return { begin: owner.begin, end: async () => {} };
        },
        fetchImpl(target) {
          assert.equal(operation, "forward");
          if (new URL(target).hostname === "api.cloudflare.com") {
            return Response.json({
              success: true,
              result: {
                deployments: [
                  {
                    created_on: "2026-01-01T00:00:00Z",
                    versions: [{ percentage: 100, version_id: liveVersion }],
                  },
                ],
              },
            });
          }
          assert.equal(String(target), "https://togetherweown.com/up");
          return Response.json({
            revision: { version_id: version },
            db: "ok",
            pending_migrations: 0,
            migration_ledger: oldHistory.map(({ created_at }) => Number(created_at)),
          });
        },
      },
    );
  assert.equal(await run("readback"), "before");
  await assert.rejects(run("forward", firstEnd, randomUUID()), /Approved Worker must serve all/);
  assert.equal(await run("readback"), "before");
  assert.equal(await run("forward"), "committed");
  assert.equal(await run("readback"), "after");
  await assert.rejects(reader.unsafe(`SELECT created_at FROM ${ledger}`), { code: "42501" });
  await cutoverUp(oldHistory, projection);
  await probeEventSync();
  assert.equal(await run("undo"), "committed");
  assert.equal(await run("readback"), "before");
  assert.equal(await run("forward"), "committed");

  return async () => {
    assert.equal(await run("readback", lastEnd), "after");
    await cutoverUp(newHistory, projection);
    assert.equal(await run("undo", lastEnd), "committed");
    assert.equal(await run("readback", lastEnd), "before");
    await owner`REVOKE USAGE ON SCHEMA drizzle FROM ${owner(login)}`;
    await owner`REVOKE SELECT (created_at) ON drizzle.__drizzle_migrations FROM ${owner(login)}`;
  };
}
