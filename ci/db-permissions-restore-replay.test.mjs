import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { build } from "esbuild";
import {
  assertMigrationPrefix,
  PLANETSCALE_PRODUCTION_BRANCH_ID,
  PLANETSCALE_PRODUCTION_HOST,
  webMigrationLockKey,
} from "./db-migrate.mjs";
import { runRepair } from "./db-permissions-repair.mjs";
import { runReadinessProjection } from "./db-readiness-projection.mjs";
import { runExecutorAuthority } from "./db-repair-executor.mjs";
import { planServingIsolation, runServingIsolation } from "./db-serving-ledger-isolation.mjs";
import {
  bootstrap,
  fixtureCluster,
  newPassword,
  withClient,
} from "./fixtures/db-restore-replay/cluster.mjs";
import {
  app,
  backup,
  bot,
  botReader,
  botTables,
  customer,
  executor,
  grantAdmin,
  inventory,
  migrator,
  owners,
  provisioner,
  roleCatalog,
  seed,
  setPassword,
  webRoles,
} from "./fixtures/db-restore-replay/seed.mjs";
import { servingIsolationFixture } from "./fixtures/db-restore-replay/serving-isolation-connector.mjs";
import { assertServingPostcheckRollback } from "./fixtures/db-restore-replay/serving-postcheck-case.mjs";
import { assertServingLedgerRelationLock } from "./fixtures/db-restore-replay/serving-relation-lock-case.mjs";
import {
  prepareServingIsolation,
  probeServingLedger,
  readServingLedger,
} from "./fixtures/web-serving-isolation.mjs";
import { assertRuntimeDefaultAcl } from "./migration-runtime-rights.mjs";
import { readLedgerState } from "./production-deploy-gate.mjs";
import { addedAfter1033, publicServingRights } from "./web-readiness-scoped-acl.mjs";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const hash = (input) => createHash("sha256").update(input).digest("hex");
const snapshotSql = read("db-permissions-repair-state.sql");
const MISSING_EDGE = [true, false, false];

async function denies(query, code = "42501") {
  await assert.rejects(query, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function changes(before, after, removed, added) {
  const encoded = (rows) => rows.map((row) => JSON.stringify(row)).sort();
  const difference = (left, right) => {
    const other = new Set(encoded(right));
    return encoded(left).filter((row) => !other.has(row));
  };
  assert.deepEqual(difference(before, after), encoded(removed));
  assert.deepEqual(difference(after, before), encoded(added));
}

async function assertLogin(sql, role, database) {
  const [identity] = await sql`select session_user::text as login, current_user::text as effective,
      current_database()::text as database`;
  assert.deepEqual(identity, { login: role, effective: role, database });
}

async function readAs(connect, role, database, readRows) {
  return withClient(connect(role, database), (sql) =>
    sql.begin("read only", async (tx) => {
      await assertLogin(tx, role, database);
      return readRows(tx);
    }),
  );
}

async function botReads(connect) {
  await readAs(connect, bot, "two_bot", async (tx) => {
    for (const table of botTables) {
      const rows = await tx`select id from ${tx(`public.${table}`)} order by id`;
      assert.deepEqual(
        rows.map(({ id }) => id),
        [1, 2],
      );
    }
  });
  await readAs(connect, botReader, "two_bot", async (tx) => {
    const [row] = await tx`select
      (select count from web_v1.live_counts) as live,
      (select count from web_v1.rank_counts) as ranks,
      exists (select from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','p')
        and has_table_privilege(current_user, c.oid, 'SELECT')) as base_read`;
    assert.deepEqual(row, { live: 2, ranks: 2, base_read: false });
    await denies(tx.savepoint((sp) => sp`select id from public.events`));
  });
}

async function webReads(connect, repaired, ledgerRows = 34) {
  await readAs(connect, app, "postgres", async (tx) => {
    const [counts] = await tx`select (select count(*)::int from public.events) as events,
      (select count(*)::int from public.rsvps) as rsvps, (select count(*)::int from public.queue_jobs) as jobs,
      (select count(*)::int from drizzle.__drizzle_migrations) as ledger`;
    assert.deepEqual(counts, { events: 2, rsvps: 1, jobs: 1, ledger: ledgerRows });
  });
  await readAs(connect, backup, "postgres", async (tx) => {
    const rows = await tx`select id from public.events order by id`;
    assert.deepEqual(
      rows.map(({ id }) => id),
      [1, 2],
    );
    const [row] = await tx`select
      has_table_privilege(current_user, 'public.events', 'INSERT') as writes,
      has_column_privilege(current_user, 'public.web_session_grace', 'id', 'SELECT') as grace_column,
      has_table_privilege(current_user, 'public.web_session_grace', 'SELECT') as grace_table`;
    assert.deepEqual(row, { writes: false, grace_column: true, grace_table: false });
  });
  await readAs(connect, migrator, "postgres", async (tx) => {
    if (repaired) {
      const [{ count }] = await tx`select count(*)::int as count from drizzle.__drizzle_migrations`;
      assert.equal(count, ledgerRows);
    } else {
      await denies(tx.savepoint((sp) => sp`select id from drizzle.__drizzle_migrations`));
    }
  });
}

async function observeRepair(tx) {
  const [{ digest, state }] = await tx.unsafe(snapshotSql);
  return { digest, state: JSON.parse(state) };
}

const inspect = (connect) =>
  readAs(connect, executor, "postgres", async (tx) => {
    await tx`set local search_path = pg_catalog`;
    return observeRepair(tx);
  });

const readRelationGrants = (connect, names) =>
  readAs(connect, executor, "postgres", async (tx) => {
    // GRANT can materialize a NULL relation ACL as explicit owner defaults.
    // Compare both representations as the same grants.
    const rows = await tx`select n.nspname || '.' || c.relname as name,
      array(select item::text from unnest(coalesce(c.relacl, acldefault(
        case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end,
        c.relowner
      ))) as items(item) order by item::text) as grants
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where (n.nspname || '.' || c.relname) = any(${names}::text[]) order by name`;
    return [...rows];
  });

function namedRepairScope({ state }) {
  const {
    inventory,
    schema_db_acl,
    object_acl,
    defaults,
    app,
    ledger,
    drizzle_access,
    migrator_ready,
  } = state;
  return {
    inventory,
    schema_db_acl,
    object_acl,
    defaults,
    app,
    ledger,
    drizzle_access,
    migrator_ready,
  };
}

async function expectedForward(sql) {
  const rollback = new Error("discard expected catalog");
  let observed;
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`set local search_path = pg_catalog`;
      await tx`grant usage, create on schema drizzle to two_web_migrate`;
      for (const [name, type, parent] of inventory) {
        if (!parent) await tx`alter ${tx.unsafe(type)} ${tx(name)} owner to two_web_migrate`;
      }
      await tx
        .unsafe(`
      alter default privileges for role two_web_migrate in schema public
        revoke select, insert, update, delete on tables from two_web_app;
      alter default privileges for role two_web_migrate in schema public
        revoke select on tables from two_web_backup;
      alter default privileges for role two_web_migrate in schema public
        revoke select, usage on sequences from two_web_backup;
    `)
        .simple();
      observed = await observeRepair(tx);
      throw rollback;
    }),
    (error) => error === rollback,
  );
  return observed;
}

// The real runner validates its normal plan/identity. Only the injected
// connector redirects it to a fresh, authenticated session on the Unix socket.
const planUrl = `postgresql://fixture.${PLANETSCALE_PRODUCTION_BRANCH_ID}:synthetic@${PLANETSCALE_PRODUCTION_HOST}/postgres?sslmode=verify-full`;
const identity = (role) => hash(`postgres\0${role}`);
const runAuthority = (connect, operation) => {
  const plan = JSON.stringify({ operation, executor, identity: identity(provisioner) });
  return runExecutorAuthority(
    operation,
    {
      PRODUCTION_DB_EXECUTOR_PLAN: plan,
      PRODUCTION_DB_EXECUTOR_PLAN_SHA256: hash(plan),
      PRODUCTION_DB_EXECUTOR_DATABASE_URL: planUrl,
    },
    () => connect(provisioner),
  );
};
const run = (connect, direction, before, after) => {
  const plan = JSON.stringify({ before, after, owners, identity: identity(executor) });
  return runRepair(
    direction,
    {
      PRODUCTION_DB_REPAIR_PLAN: plan,
      PRODUCTION_DB_REPAIR_PLAN_SHA256: hash(plan),
      PRODUCTION_DB_REPAIR_DATABASE_URL: planUrl,
    },
    () => connect(executor),
  );
};

async function rehearseSnapshotWriterRefusal(connect, repair, pre) {
  const rollback = new Error("discard synthetic snapshot write");
  await withClient(connect(app), async (writer) => {
    // The completed INSERT holds its row-write lock until begin() rolls back.
    // Keep the checks inside the callback so the writer cannot finish early.
    await assert.rejects(
      writer.begin(async (tx) => {
        await assertLogin(tx, app, "postgres");
        const inserted = await tx`insert into public.discord_event_snapshots (id) values (1)`;
        assert.equal(inserted.count, 1);
        await assert.rejects(repair("forward"), (error) => {
          assert.equal(error.code, "55P03");
          assert.ok(
            error.message === "canceling statement due to lock timeout",
            "Expected PostgreSQL to time out waiting for the snapshot lock",
          );
          return true;
        });
        const refused = await inspect(connect);
        assert.deepEqual(refused.state.ledger, pre.state.ledger);
        assert.equal(refused.digest, pre.digest);
        throw rollback;
      }),
      (error) => error === rollback,
    );
  });
  await withClient(connect(executor), async (sql) => {
    const rows = await sql`select id from public.discord_event_snapshots`;
    assert.equal(rows.length, 0);
  });
}

const originalEnd = "1033_session-roles-checked-at";
const expansion = [
  "1034_event-echoes",
  "1035_bot-reconciliation-intents",
  "1036_event-sync-claim-started",
  "1037_waitlist-offers",
];
const expandedEnd = expansion.at(-1);

test("recovered serving isolation proof is bound to its serving principal", async () => {
  const otherLogin = "fixture_other_serving";
  const version = "97ff7cb6-896b-4a53-9130-ee4f3f31d278";
  const artifact = { sourceSha: "b".repeat(40), digest: "c".repeat(64) };
  const objects = publicServingRights
    .filter(({ name }) => !addedAfter1033.has(name))
    .map(({ kind, name, column }) => ({ kind, name, column, owner: migrator, direct: [] }));
  const owners = [...new Map(objects.map((row) => [JSON.stringify(row), row])).values()];
  const { entries } = JSON.parse(read("../drizzle/meta/_journal.json"));
  const prefixLength = entries.findIndex(({ tag }) => tag === originalEnd) + 1;
  assert.ok(prefixLength > 0);
  const ledger = readMigrationFiles({
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  })
    .slice(0, prefixLength)
    .map(({ hash, folderMillis }) => ({ hash, created_at: folderMillis }));
  const catalog = { owners, ledger, executor: migrator };
  const fixture = servingIsolationFixture(catalog);
  const capture = (login) =>
    planServingIsolation(fixture.tx, identity(migrator), version, artifact, login);
  const original = await capture(app);
  const recovered = await capture(otherLogin);
  assert.equal(recovered.before, original.before);
  assert.equal(recovered.after, original.after);
  assert.equal(recovered.version, original.version);

  const environment = (plan) => {
    const raw = JSON.stringify(plan);
    return {
      PRODUCTION_DB_ISOLATION_PLAN: raw,
      PRODUCTION_DB_ISOLATION_PLAN_SHA256: hash(raw),
      PRODUCTION_DB_ISOLATION_DATABASE_URL: planUrl,
    };
  };
  const preload = fileURLToPath(
    new URL("./fixtures/db-restore-replay/serving-isolation-preload.mjs", import.meta.url),
  );
  const cli = (plan, expectedStatus) => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        preload,
        fileURLToPath(new URL("./db-serving-ledger-isolation-cli.mjs", import.meta.url)),
        "readback",
        originalEnd,
      ],
      {
        env: {
          ...environment(plan),
          FIXTURE_SERVING_ISOLATION_CATALOG: JSON.stringify(catalog),
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, expectedStatus);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  };
  cli(original, 10);
  cli(recovered, 1);
  const legacy = { ...original };
  delete legacy.servingRole;
  cli(legacy, 1);

  const connect = () => fixture;
  const fetchImpl = () => assert.fail("Traffic must stay offline");
  assert.equal(
    await runServingIsolation("readback", originalEnd, environment(recovered), {
      login: otherLogin,
      connect,
      fetchImpl,
    }),
    "before",
  );
  for (const operation of ["readback", "forward", "undo"]) {
    await assert.rejects(
      runServingIsolation(operation, originalEnd, environment(original), {
        login: otherLogin,
        connect: () => assert.fail("Cross-principal reuse reached the database connector"),
        fetchImpl,
      }),
      { message: "Serving isolation plan belongs to a different serving role" },
    );
  }
});

function writeWebSlice(directory, originalLength) {
  const journal = JSON.parse(read("../drizzle/meta/_journal.json"));
  const entries = journal.entries.slice(0, originalLength + expansion.length);
  assert.deepEqual(
    entries.slice(originalLength).map(({ tag }) => tag),
    expansion,
  );
  const migrationsFolder = join(directory, "web-slice");
  mkdirSync(join(migrationsFolder, "meta"), { recursive: true });
  writeFileSync(
    join(migrationsFolder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  for (const { tag } of entries) {
    copyFileSync(
      new URL(`../drizzle/${tag}.sql`, import.meta.url),
      join(migrationsFolder, `${tag}.sql`),
    );
  }
  return migrationsFolder;
}

async function rehearseRepairedServing(restore, fresh, directory, t) {
  const jobs = "fixture_jobs";
  const grantor = "fixture_serving_grantor";
  const jobsPassword = newPassword();
  await withClient(restore.admin(), async (sql) => {
    await sql`create role ${sql(jobs)} login`;
    await setPassword(sql, jobs, jobsPassword);
    await sql`grant ${sql(app)} to ${sql(jobs)} with inherit true, set false`;
    await sql`create role ${sql(grantor)} nologin`;
    await sql`grant pg_read_all_data, pg_write_all_data to ${sql(grantor)}
      with admin true, inherit false, set false`;
    await sql.begin(async (tx) => {
      await tx`set local role ${tx(grantor)}`;
      await tx`grant pg_read_all_data, pg_write_all_data to ${tx(app)} granted by current_user`;
    });
    // The migrator needs SET on the original grantors for the inverse.
    // The repair executor's temporary membership in the migrator was revoked.
    await sql`grant ${sql(executor)} to ${sql(migrator)} with inherit false, set true`;
    await sql`grant ${sql(grantor)} to ${sql(migrator)} with inherit false, set true`;
  });
  const connectMigrator = () => fresh(migrator);
  const getLedger = (end) =>
    withClient(connectMigrator(), async (sql) => {
      const timestamps = await assertMigrationPrefix(sql, end);
      const [row] = await sql`select to_regclass('public.announcement_send_claims') as deferred`;
      assert.equal(row.deferred, null);
      return { timestamps, rows: await readServingLedger(sql) };
    });
  const base = await getLedger(originalEnd);
  const plan = JSON.stringify({
    operation: "forward",
    ledger: originalEnd,
    servingRole: app,
    identity: identity(migrator),
    webVersion: null,
  });
  await runReadinessProjection(
    "forward",
    {
      PRODUCTION_DB_READINESS_PLAN: plan,
      PRODUCTION_DB_READINESS_PLAN_SHA256: hash(plan),
      PRODUCTION_DB_READINESS_DATABASE_URL: planUrl,
    },
    { connect: connectMigrator },
  );

  const migrationsFolder = writeWebSlice(directory, base.rows.length);
  const outfile = join(directory, "database-readiness.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/up-database.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    define: { __TWO_WEB_1033_COMPAT__: "true" },
    plugins: [
      {
        name: "historical-web-journal",
        setup(bundle) {
          // Use the same canonical prefix for the historical readiness build
          // and the expansion. Later required migrations belong to newer builds.
          bundle.onResolve({ filter: /^\.\.\/drizzle\/meta\/_journal\.json$/ }, () => ({
            path: join(migrationsFolder, "meta/_journal.json"),
          }));
        },
      },
    ],
  });
  const { databaseReadiness } = await import(pathToFileURL(outfile).href);
  const isolationQueries = [];
  const {
    run: isolate,
    version,
    assertDuplicateRefused,
  } = await withClient(restore.admin(), (owner) =>
    prepareServingIsolation({
      owner,
      login: app,
      database: "postgres",
      migrationRole: migrator,
      connect() {
        const client = connectMigrator();
        isolationQueries.length = 0;
        client.options.debug = (_id, statement, parameters) => {
          isolationQueries.push({
            statement,
            advisoryKey: statement.startsWith("select pg_try_advisory_xact_lock(")
              ? Number(parameters[0])
              : undefined,
          });
        };
        return client;
      },
      firstEnd: originalEnd,
      timestamps: base.timestamps,
    }),
  );

  const probe = (ledger, isolated) =>
    withClient(restore.admin(), async (owner) => {
      let webReadiness;
      for (const [role, open] of [
        [app, () => fresh(app)],
        [jobs, () => restore.connect(jobs, jobsPassword)],
      ]) {
        await withClient(open(), async (sql) => {
          await assertLogin(sql, role, "postgres");
          await probeServingLedger(owner, role, sql, ledger.rows, isolated);
          if (!isolated) {
            const rows = await sql`select last_value from drizzle.__drizzle_migrations_id_seq`;
            assert.equal(rows.length, 1);
          }
          const [workload] = await sql`select
          (select count(*)::int from public.events) as events,
          (select count(*)::int from public.queue_jobs) as jobs`;
          assert.deepEqual(workload, { events: 2, jobs: 1 });
          if (role === app) await sql`update public.events set id = id where false`;
          else await sql`update public.queue_jobs set id = id where false`;
          const readiness = await databaseReadiness(sql);
          assert.deepEqual(readLedgerState(readiness), ledger.timestamps);
          if (role === app) webReadiness = readiness;
        });
      }
      await botReads(fresh);
      return webReadiness;
    });

  await t.test("competing ledger relation lock refuses isolation before ACL changes", () =>
    assertServingLedgerRelationLock({
      admin: restore.admin,
      isolate,
      isolationQueries,
      async fingerprint() {
        const { digest, state } = await inspect(fresh);
        return { catalog: digest, ledger: state.ledger };
      },
    }),
  );

  const { state: baseline } = await inspect(fresh);
  assert.equal(baseline.migrator_ready, true);
  const originalObjects = Object.keys(baseline.inventory);
  const originalGrants = await readRelationGrants(fresh, originalObjects);
  assert.equal(originalGrants.length, originalObjects.length);
  const roles = () => withClient(restore.admin(), roleCatalog);
  const baselineRoles = await roles();
  // Keep the row count and hashes intact while changing the restored history.
  await withClient(restore.admin(), async (owner) => {
    const last = base.rows.at(-1);
    const changedTimestamp = String(BigInt(last.created_at) + 1n);
    await owner`update drizzle.__drizzle_migrations set created_at = ${changedTimestamp}
      where created_at = ${last.created_at}`;
    const divergent = [...base.rows.slice(0, -1), { ...last, created_at: changedTimestamp }];
    assert.deepEqual(await readServingLedger(owner), divergent);
    await assert.rejects(isolate("readback"), /Migration history is not an exact prefix/);
    assert.deepEqual(await readServingLedger(owner), divergent);
    await owner`update drizzle.__drizzle_migrations set created_at = ${last.created_at}
      where created_at = ${changedTimestamp}`;
    assert.deepEqual(await readServingLedger(owner), base.rows);
    assert.equal(await isolate("readback"), "before");
  });
  t.diagnostic("Readback refused the same-count timestamp mismatch and accepted the exact ledger.");
  const readiness = await probe(base, false);
  t.diagnostic("Web, Jobs and both Bot logins passed on the repaired 1033 baseline.");
  const assertMigrationLockRefused = async (operation, options, expectedState) => {
    const { digest } = await inspect(fresh);
    const statements = [];
    const client = fresh(migrator, "postgres", (_id, statement) => statements.push(statement));
    await withClient(client, () =>
      withClient(restore.admin(), (holder) =>
        holder.begin(async (tx) => {
          const [{ acquired }] =
            await tx`select pg_try_advisory_xact_lock(${webMigrationLockKey}) as acquired`;
          assert.equal(acquired, true, "Fixture must hold the Web migration lock");
          await assert.rejects(isolate(operation, { ...options, connect: () => client }), {
            code: "ERR_ASSERTION",
            message: "Web migration lock held",
          });
          const trace = statements.join("\n");
          assert.match(trace, /^select pg_try_advisory_xact_lock\b/im);
          assert.doesNotMatch(trace, /^\s*(?:grant|revoke)\b/im);
          await assert.rejects(client`select 1`, { code: "CONNECTION_ENDED" });
          assert.equal(await isolate("readback", options), expectedState);
          assert.equal((await inspect(fresh)).digest, digest);
        }),
      ),
    );
  };
  const forward = { readiness: { ...readiness, revision: { version_id: version } } };
  await t.test("failed serving postcheck rolls back ACLs and allows a clean retry", () =>
    assertServingPostcheckRollback({
      admin: restore.admin,
      login: app,
      isolate,
      forward,
      readAclState: async () => ({
        repair: await inspect(fresh),
        grants: await readRelationGrants(fresh, originalObjects),
        roles: await roles(),
      }),
      probeBefore: () => probe(base, false),
      retryForward: async () => {
        await assertMigrationLockRefused("forward", forward, "before");
        assert.equal(await isolate("forward", forward), "committed");
        t.diagnostic(
          "Held Web migration lock refused forward before ACL changes. Retry committed.",
        );
      },
    }),
  );
  const { digest: isolatedDigest } = await inspect(fresh);
  await assertDuplicateRefused("forward", forward);
  assert.equal(
    (await inspect(fresh)).digest,
    isolatedDigest,
    "Duplicate forward changed the catalog",
  );
  t.diagnostic("Duplicate isolation forward refused. Readback stayed after and grants matched.");
  await probe(base, true);
  t.diagnostic("Isolated 1033 preserved workload access and projected readiness.");
  await withClient(connectMigrator(), async (sql) => {
    await assertRuntimeDefaultAcl(sql);
    await migrate(drizzle(sql), { migrationsFolder });
  });
  const expanded = await getLedger(expandedEnd);
  assert.equal(await isolate("readback", { end: expandedEnd }), "after");
  await probe(expanded, true);
  t.diagnostic("Isolated 1037 preserved workload access and projected readiness.");

  const undo = { end: expandedEnd };
  await assertMigrationLockRefused("undo", undo, "after");
  assert.equal(await isolate("undo", undo), "committed");
  t.diagnostic("Held Web migration lock refused undo before ACL changes. Retry committed.");
  assert.equal(await isolate("readback", undo), "before");
  const { digest: restoredDigest } = await inspect(fresh);
  await assertDuplicateRefused("undo", undo);
  const { digest: replayedUndoDigest, state: afterUndo } = await inspect(fresh);
  assert.equal(replayedUndoDigest, restoredDigest, "Duplicate undo changed the catalog");
  t.diagnostic("Duplicate isolation undo refused. Readback stayed before and grants matched.");
  assert.deepEqual(await getLedger(expandedEnd), expanded);
  await probe(expanded, false);
  await webReads(fresh, true, expanded.rows.length);
  assert.deepEqual(await roles(), baselineRoles);
  assert.deepEqual(
    Object.fromEntries(originalObjects.map((name) => [name, afterUndo.inventory[name]])),
    baseline.inventory,
  );
  assert.deepEqual(await readRelationGrants(fresh, originalObjects), originalGrants);
  assert.deepEqual(
    afterUndo.object_acl.filter(
      ({ name, column_number }) => column_number > 0 && Object.hasOwn(baseline.inventory, name),
    ),
    baseline.object_acl.filter(({ column_number }) => column_number > 0),
  );
  for (const key of ["defaults", "schema_db_acl", "drizzle_access", "migrator_ready"]) {
    assert.deepEqual(afterUndo[key], baseline[key], key);
  }
  t.diagnostic(
    "Repaired 1033 → isolated 1033 → isolated 1037 → inverse: Web/Jobs readiness and Bot reads passed. The inverse restored repaired rights and retained the 1037 ledger. 1038 stayed absent.",
  );
}

test("serving isolation rejects the wrong database before write locks or ACL work", async () => {
  const objects = new Map();
  for (const { kind, name, column } of publicServingRights) {
    if (addedAfter1033.has(name)) continue;
    objects.set(`${kind}/${name}/${column}`, { kind, name, column, owner: migrator, direct: [] });
  }
  const membership = ["pg_read_all_data", "pg_write_all_data"].map((role) => ({
    role,
    grantor: migrator,
    admin: false,
    inherit: true,
    set: false,
  }));
  const plan = JSON.stringify(
    await planServingIsolation(
      async ([sql]) => {
        if (sql.startsWith("with objects as")) return [...objects.values()];
        if (sql.includes("from pg_auth_members m")) return membership;
        assert.fail(`Unexpected plan query: ${sql}`);
      },
      identity(migrator),
      "97ff7cb6-896b-4a53-9130-ee4f3f31d278",
      { sourceSha: "b".repeat(40), digest: "c".repeat(64) },
      app,
    ),
  );
  const env = {
    PRODUCTION_DB_ISOLATION_PLAN: plan,
    PRODUCTION_DB_ISOLATION_PLAN_SHA256: hash(plan),
    PRODUCTION_DB_ISOLATION_DATABASE_URL: planUrl,
  };
  const settings = [
    "set local search_path = pg_catalog, pg_temp",
    "set local lock_timeout = '500ms'",
    "set local statement_timeout = '5s'",
    "set local transaction_timeout = '25s'",
  ];
  const identityQuery =
    "select pg_catalog.current_database()::text as database, session_user::text as authenticated, current_user::text as effective";
  const advisoryLockQuery = "select pg_try_advisory_xact_lock(?) as acquired";
  const ledgerLockQuery = "lock table drizzle.__drizzle_migrations in share mode nowait";
  const ledgerLock = new Error("Fixture stops at the ledger lock");
  async function runWithDatabase(database, rejectsWith) {
    const trace = [];
    const tx = async (strings, ...values) => {
      const sql = strings.join("?").replace(/\s+/g, " ").trim();
      trace.push(sql);
      if (settings.includes(sql)) return [];
      if (sql === identityQuery)
        return [{ database, authenticated: migrator, effective: migrator }];
      if (sql === advisoryLockQuery) {
        assert.deepEqual(values, [webMigrationLockKey]);
        return [{ acquired: true }];
      }
      if (sql === ledgerLockQuery) throw ledgerLock;
      assert.fail(`Unexpected serving isolation query: ${sql}`);
    };
    await assert.rejects(
      runServingIsolation("forward", originalEnd, env, {
        login: app,
        fetchImpl: () => assert.fail("Unexpected serving isolation traffic check"),
        connect(_config, options) {
          assert.deepEqual(options, { readOnly: false });
          trace.push("connect");
          return {
            async begin(mode, work) {
              assert.equal(mode, "isolation level read committed");
              trace.push("begin");
              try {
                return await work(tx);
              } finally {
                trace.push("leave transaction");
              }
            },
            async end(options) {
              assert.deepEqual(options, { timeout: 5 });
              trace.push("close");
            },
          };
        },
      }),
      rejectsWith,
    );
    return trace;
  }

  const throughIdentity = ["connect", "begin", ...settings, identityQuery];
  const cleanup = ["leave transaction", "close"];
  assert.deepEqual(
    await runWithDatabase("fixture_wrong_database", {
      message: "Production migration database or role identity did not match; values withheld.",
    }),
    [...throughIdentity, ...cleanup],
  );
  assert.deepEqual(await runWithDatabase("postgres", (error) => error === ledgerLock), [
    ...throughIdentity,
    advisoryLockQuery,
    ledgerLockQuery,
    ...cleanup,
  ]);
});

test("PostgreSQL 18 branch replay preserves repair and Bot scope with alternate ADMIN authority", async (t) => {
  const directory = mkdtempSync("/tmp/two-web-replay-");
  const clusters = [];
  t.after(() => {
    for (const cluster of clusters.reverse()) cluster.stop();
    rmSync(directory, { recursive: true, force: true });
    assert.equal(existsSync(directory), false);
    t.diagnostic("Disposable source and restore clusters stopped and fixture directory removed.");
  });
  let phase = "synthetic source and restore setup";
  try {
    const source = fixtureCluster(join(directory, "source"));
    clusters.push(source);
    const restore = fixtureCluster(join(directory, "restore"));
    clusters.push(restore);
    const sourcePasswords = Object.fromEntries(webRoles.map((role) => [role, newPassword()]));
    const sourceConnect = await seed(source, sourcePasswords, true);
    const connect = await seed(restore, sourcePasswords, false);
    const readSource = () => withClient(source.admin(), roleCatalog);
    const readRestore = () => withClient(restore.admin(), roleCatalog);
    const original = await readSource();
    const originalRepairState = await inspect(sourceConnect);
    const incoming = webRoles.map((role) => [role, provisioner, bootstrap, ...MISSING_EDGE]);
    await webReads(sourceConnect, false);
    await botReads(sourceConnect);

    phase = "deny without ADMIN on retained Web roles";
    const missing = await readRestore();
    assert.deepEqual(missing.roles, original.roles);
    changes(original.edges, missing.edges, incoming, []);
    changes(
      original.authority,
      missing.authority,
      webRoles.map((role) => [provisioner, role, true, false, false, true]),
      webRoles.map((role) => [provisioner, role, false, false, false, false]),
    );
    assert.ok(!missing.edges.some(([role]) => webRoles.includes(role)));
    await botReads(connect);
    await withClient(connect(customer), (sql) => denies(grantAdmin(sql, provisioner, customer)));
    await withClient(connect(provisioner), async (sql) => {
      for (const role of webRoles) await denies(setPassword(sql, role, newPassword()));
    });
    await assert.rejects(runAuthority(connect, "provision"), /approved scope/);
    for (const role of webRoles) {
      await withClient(connect(role), (sql) => denies(sql`select current_user`, "28P01"));
    }
    assert.deepEqual(await readRestore(), missing);
    assert.deepEqual(
      namedRepairScope(await inspect(connect)),
      namedRepairScope(originalRepairState),
    );
    t.diagnostic(
      "Three incoming edges missing. Customer replay, password rotation and provisioning denied.",
    );

    phase = "alternate replay and fresh Web credentials";
    // Fixture premise: the bootstrap user seeds three ADMIN-only edges on the
    // customer in this cluster. PlanetScale documents CREATEROLE and built-in
    // role privileges but no way to acquire these edges on retained custom roles.
    await withClient(restore.admin(), (sql) => grantAdmin(sql, customer, bootstrap));
    await withClient(connect(customer), async (sql) => {
      await denies(sql`grant two_web_app to fixture_provisioner
        with admin true, inherit false, set false granted by fixture_bootstrap`);
      await grantAdmin(sql, provisioner, customer);
    });
    // The re-authorized provisioner assigns the random passwords that the
    // fresh connections will present to the SCRAM listener.
    const webPasswords = Object.fromEntries(webRoles.map((role) => [role, newPassword()]));
    await withClient(connect(provisioner), async (sql) => {
      for (const role of webRoles) await setPassword(sql, role, webPasswords[role]);
    });
    const fresh = (role, database, debug) =>
      webPasswords[role]
        ? restore.connect(role, webPasswords[role], database, debug)
        : connect(role, database);
    for (const role of webRoles) {
      await withClient(connect(role), (sql) => denies(sql`select current_user`, "28P01"));
    }
    const replayed = await readRestore();
    assert.deepEqual(replayed.roles, original.roles);
    changes(
      original.edges,
      replayed.edges,
      incoming,
      webRoles.flatMap((role) => [
        [role, customer, bootstrap, ...MISSING_EDGE],
        [role, provisioner, customer, ...MISSING_EDGE],
      ]),
    );
    changes(
      original.authority,
      replayed.authority,
      webRoles.map((role) => [customer, role, false, false, false, false]),
      webRoles.map((role) => [customer, role, true, false, false, true]),
    );
    assert.deepEqual(await readSource(), original);
    await webReads(fresh, false);
    t.diagnostic(
      "Seeded ADMIN permits alternate replay and fresh SCRAM logins. The original grantor is still denied.",
    );

    phase = "refuse repair during a snapshot write";
    const unprovisioned = await inspect(connect);
    assert.deepEqual(namedRepairScope(unprovisioned), namedRepairScope(originalRepairState));
    await runAuthority(connect, "provision");
    const pre = await inspect(connect);
    const before = pre.digest;
    const expected = await withClient(connect(executor), expectedForward);
    const repair = (direction) => run(connect, direction, before, expected.digest);
    await rehearseSnapshotWriterRefusal(fresh, repair, pre);
    t.diagnostic("Snapshot writer held through the repair lock timeout. PRE and ledger matched.");

    phase = "forward, exact undo and revoke";
    const provisionedRoles = await readRestore();
    // The repair snapshot excludes this unrelated customer membership.
    assert.deepEqual(
      provisionedRoles.edges.filter(
        ([role, member]) => role === "pg_monitor" && member === customer,
      ),
      [["pg_monitor", customer, bootstrap, true, true, true]],
    );
    assert.equal(await repair("readback"), "before");
    assert.equal(await repair("forward"), "committed");
    assert.equal(await repair("readback"), "after");
    assert.deepEqual(await readRestore(), provisionedRoles);
    await webReads(fresh, true);
    await botReads(connect);
    assert.equal(await repair("undo"), "committed");
    assert.equal(await repair("readback"), "before");
    assert.deepEqual(await readRestore(), provisionedRoles);
    await runAuthority(connect, "revoke");
    assert.deepEqual(await inspect(connect), unprovisioned);
    assert.deepEqual(await readRestore(), replayed);
    await webReads(fresh, false);
    await botReads(connect);
    t.diagnostic(
      "Exact undo restored the original digest and the first revoke removed temporary authority.",
    );

    phase = "forward and revoke while retaining repaired state";
    await runAuthority(connect, "provision");
    // The second provision creates a new pg_auth_members OID, which the
    // unchanged repair includes in its digest. Pin this attempt separately.
    const reprovisioned = await inspect(connect);
    assert.notEqual(reprovisioned.digest, before);
    const retained = await withClient(connect(executor), expectedForward);
    assert.equal(await run(connect, "forward", reprovisioned.digest, retained.digest), "committed");
    await runAuthority(connect, "revoke");
    const { state: repaired } = await inspect(connect);
    assert.deepEqual(repaired, { ...retained.state, memberships: unprovisioned.state.memberships });
    assert.deepEqual(await readRestore(), replayed);
    await webReads(fresh, true);
    await botReads(connect);
    assert.deepEqual(await readSource(), original);
    assert.deepEqual(await inspect(sourceConnect), originalRepairState);
    await botReads(sourceConnect);
    t.diagnostic(
      "Forward, exact undo, both revocations, scoped catalog and Bot read parity passed.",
    );
    phase = "isolation and inverse on the repaired restore";
    await rehearseRepairedServing(restore, fresh, directory, t);
  } catch (error) {
    // PostgreSQL errors can include the failed statement, including ALTER ROLE.
    if (error.code === "ERR_ASSERTION") throw error;
    throw new Error(`${phase} failed${error.code ? ` (SQLSTATE ${error.code})` : ""}`);
  }
});
