import assert from "node:assert/strict";
import { webMigrationLockKey } from "../../db-migrate.mjs";
import { withClient } from "./cluster.mjs";

const advisoryStatement = "select pg_try_advisory_xact_lock($1) as acquired";
const relationStatement = "lock table drizzle.__drizzle_migrations in share mode nowait";

export async function assertServingLedgerRelationLock({
  admin,
  isolate,
  isolationQueries,
  fingerprint,
}) {
  const before = await fingerprint();
  assert.match(before.ledger.digest, /^[a-f0-9]{64}$/);
  await withClient(admin(), (holder) =>
    holder.begin(async (tx) => {
      // A writer's lock conflicts with SHARE but permits the readback below.
      await tx`lock table drizzle.__drizzle_migrations in row exclusive mode nowait`;
      const [{ advisory }] = await tx`select exists (
        select from pg_locks where pid = pg_backend_pid() and locktype = 'advisory'
      ) as advisory`;
      assert.equal(advisory, false, "The competing transaction must leave advisory locks free");

      await assert.rejects(isolate("forward"), {
        code: "55P03",
        message: 'could not obtain lock on relation "drizzle.__drizzle_migrations"',
      });
      // The recipe reaches the relation lock only after the advisory try-lock succeeds.
      const advisoryIndex = isolationQueries.findIndex(
        ({ statement, advisoryKey }) =>
          statement === advisoryStatement && advisoryKey === webMigrationLockKey,
      );
      assert.ok(advisoryIndex >= 0, "Isolation must try the Web migration lock");
      assert.equal(isolationQueries[advisoryIndex + 1]?.statement, relationStatement);
      assert.ok(
        isolationQueries.every(({ statement }) => !/^\s*(?:grant|revoke)\b/i.test(statement)),
        "Isolation must refuse before issuing scoped ACL changes",
      );

      await withClient(admin(), (observer) =>
        observer.begin(async (probe) => {
          const [{ acquired }] =
            await probe`select pg_try_advisory_xact_lock(${webMigrationLockKey}) as acquired`;
          assert.equal(acquired, true, "Isolation must release the Web migration lock on refusal");
        }),
      );
      assert.equal(await isolate("readback"), "before");
      assert.deepEqual(await fingerprint(), before);
    }),
  );

  await withClient(admin(), (observer) =>
    observer.begin((tx) => tx`lock table drizzle.__drizzle_migrations in share mode nowait`),
  );
}
