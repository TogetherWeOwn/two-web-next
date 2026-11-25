import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { assertMigrationPrefix } from "./db-migrate.mjs";
import {
  bootstrap,
  fixtureCluster,
  newPassword,
  withClient,
} from "./fixtures/db-restore-replay/cluster.mjs";
import { app, setPassword } from "./fixtures/db-restore-replay/seed.mjs";
import {
  prepareServingIsolation,
  probeServingLedger,
  readServingLedger,
} from "./fixtures/web-serving-isolation.mjs";
import { addedAfter1033, publicServingRights } from "./web-readiness-scoped-acl.mjs";

const firstEnd = "1033_session-roles-checked-at";

async function seedServingAcl(sql, password) {
  const folder = new URL("../drizzle/", import.meta.url);
  const { entries } = JSON.parse(readFileSync(new URL("meta/_journal.json", folder), "utf8"));
  const end = entries.findIndex(({ tag }) => tag === firstEnd);
  assert.ok(end >= 0);
  const ledger = readMigrationFiles({ migrationsFolder: fileURLToPath(folder) })
    .slice(0, end + 1)
    .map(({ folderMillis, hash }) => ({ created_at: folderMillis, hash }));

  await sql`create role ${sql(app)} login`;
  await setPassword(sql, app, password);
  await sql`grant pg_read_all_data, pg_write_all_data to ${sql(app)} with inherit true, set false`;
  await sql`create schema drizzle`;
  await sql`create table drizzle.__drizzle_migrations (id serial primary key, hash text, created_at bigint)`;
  await sql`insert into drizzle.__drizzle_migrations ${sql(ledger, "hash", "created_at")}`;
  await sql`grant usage on schema drizzle to ${sql(app)}`;
  await sql`grant select (created_at) on drizzle.__drizzle_migrations to ${sql(app)}`;
  await sql`grant select on sequence drizzle.__drizzle_migrations_id_seq to ${sql(app)}`;

  const objects = new Map(
    publicServingRights
      .filter(({ name }) => !addedAfter1033.has(name))
      .map(({ kind, name }) => [name, kind]),
  );
  for (const [name, kind] of objects) {
    const object = sql(`public.${name}`);
    if (kind === "sequence") await sql`create sequence ${object}`;
    else await sql`create table ${object} (id int)`;
  }
  await sql`alter table public.agent_event_grants add column updated_at timestamptz`;

  const projection = readFileSync(
    new URL("../docs/web-readiness-projection.sql", import.meta.url),
    "utf8",
  );
  await sql.unsafe(projection).simple();
  await sql`comment on view web_readiness.migration_timestamps is 'two-web readiness projection installation v1'`;
  await sql`grant usage on schema web_readiness to ${sql(app)}`;
  await sql`grant select on web_readiness.migration_timestamps to ${sql(app)}`;
}

test("failed serving undo postcheck rolls back restored grants and allows retry", async (t) => {
  const directory = mkdtempSync("/tmp/two-web-undo-postcheck-");
  let cluster;
  t.after(() => {
    cluster?.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  cluster = fixtureCluster(join(directory, "postgres"));
  const password = newPassword();
  const { run, plan, ledger } = await withClient(cluster.admin(), async (owner) => {
    await seedServingAcl(owner, password);
    return {
      ...(await prepareServingIsolation({
        owner,
        login: app,
        database: "postgres",
        migrationRole: bootstrap,
        connect: () => cluster.admin(),
        firstEnd,
        timestamps: await assertMigrationPrefix(owner, firstEnd),
      })),
      ledger: await readServingLedger(owner),
    };
  });
  const probe = (isolated) =>
    withClient(cluster.admin(), (owner) =>
      withClient(cluster.connect(app, password), async (serving) => {
        await probeServingLedger(owner, app, serving, ledger, isolated);
        if (!isolated) {
          assert.equal(
            (await serving`select last_value from drizzle.__drizzle_migrations_id_seq`).length,
            1,
          );
        }
      }),
    );

  assert.equal(await run("forward"), "committed");
  assert.equal(await run("readback"), "after");

  const reviewed = JSON.parse(plan);
  const wrongBefore = "0".repeat(64);
  // The fixture hashes this plan as supplied. Its isolated endpoint still
  // matches, so undo reaches the final digest check after applying the inverse.
  await assert.rejects(run("undo", { raw: JSON.stringify({ ...reviewed, before: wrongBefore }) }), {
    code: "ERR_ASSERTION",
    operator: "strictEqual",
    actual: reviewed.before,
    expected: wrongBefore,
  });
  assert.equal(await run("readback"), "after");
  await probe(true);

  assert.equal(await run("undo"), "committed");
  assert.equal(await run("readback"), "before");
  await probe(false);
});
