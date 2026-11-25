import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { build } from "esbuild";
import postgres from "postgres";
import { rehearseServingIsolation } from "./fixtures/web-serving-isolation.mjs";
import { assertServingLedgerIsolation } from "./migration-runtime-rights.mjs";
import { readLedgerState } from "./production-deploy-gate.mjs";
import { buildCutoverApps, probeCutoverEventSync } from "./web-readiness-cutover.mjs";
import { assertScopedAcl, grantScopedAcl, probeWorkloads } from "./web-readiness-scoped-acl.mjs";

const legacy = "57f1abbc25d0b39a77d83b46eb8b803b0249bb66";
const bridge = "ac9024ed0150df44dfcde1bdce64e3fa9699924e";
const successor = "88e73791dd84b4e81a8d89687032185fa694cb3b";
const bridges = [bridge, successor];
const git = (...args) => execFileSync("git", args, { maxBuffer: 32 * 1024 * 1024 });
const fixture = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const projection = "web_readiness.migration_timestamps";
const ledger = "drizzle.__drizzle_migrations";
const webTags = JSON.parse(fixture("../drizzle/meta/_journal.json"))
  .entries.map(({ tag }) => tag)
  .filter((tag) => /^1\d{3}_/.test(tag));

async function pinnedApp(root, sha) {
  git("merge-base", "--is-ancestor", sha, "origin/main");
  const dir = join(root, sha);
  mkdirSync(dir);
  const paths = [
    "src",
    "lib",
    "vendor/design-kit",
    "drizzle",
    "migrations.lock",
    "tsconfig.json",
    "ci/build-leaf-css.mjs",
    "public/styles.css",
    "public/theme-tokens.css",
    "public/theme.css",
  ];
  if (sha !== legacy) paths.push("ci/css-dictionary.mjs", "web/src/lib/site-header.css");
  execFileSync("tar", ["-x", "-C", dir], { input: git("archive", sha, ...paths) });
  const { entries } = JSON.parse(readFileSync(join(dir, "drizzle/meta/_journal.json"), "utf8"));
  const { migrations: lock } = JSON.parse(readFileSync(join(dir, "migrations.lock"), "utf8"));
  const history = entries.map(({ tag, when }, i) => {
    assert.ok(Number.isSafeInteger(when) && (i === 0 || when > entries[i - 1].when));
    const path = `drizzle/${tag}.sql`;
    const sql = readFileSync(join(dir, path));
    const hash = createHash("sha256").update(sql).digest("hex");
    assert.deepEqual(lock[i], { path, sha256: hash });
    return { tag, created_at: String(when), hash };
  });
  assert.equal(history.length, lock.length);
  assert.deepEqual(
    readdirSync(join(dir, "drizzle"))
      .filter((f) => f.endsWith(".sql"))
      .sort(),
    history.map(({ tag }) => `${tag}.sql`).sort(),
  );
  execFileSync(process.execPath, [join(dir, "ci/build-leaf-css.mjs")]);
  const outfile = join(dir, "app.mjs");
  await build({
    absWorkingDir: dir,
    entryPoints: ["src/index.tsx"],
    outfile,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node24",
  });
  const { default: app } = await import(pathToFileURL(outfile).href);
  return { sha, app, history, migrationsFolder: join(dir, "drizzle") };
}

async function checkUp(
  build,
  reader,
  expected,
  status,
  pending,
  queries,
  relation,
  appUrl = "https://next.example.test",
) {
  queries.length = 0;
  const env = {
    APP_URL: appUrl,
    SESSION_SECRET: randomUUID(),
    DISCORD_CLIENT_SECRET: "fixture",
    DISCORD_BOT_TOKEN: "fixture",
    QUEUE_DEPTH_STORE: reader,
  };
  const response = await build.app.request(`${appUrl}/up`, {}, env);
  assert.equal(response.status, status, `${build.sha} /up status`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.has("set-cookie"), false);
  const body = await response.json();
  const { db, pending_migrations, migration_ledger, queue } = body;
  const timestamps = expected?.map(({ created_at }) => Number(created_at)) ?? null;
  assert.equal(db, "ok");
  assert.equal(pending_migrations, pending);
  assert.deepEqual(migration_ledger, timestamps);
  if (status === 200) {
    assert.equal(queue?.status, "healthy", `${build.sha} /up empty queue`);
    assert.deepEqual(readLedgerState(body), timestamps);
  } else {
    assert.throws(() => readLedgerState(body), /production ledger is not provably current/);
  }
  const read = (name) => queries.some((query) => query.includes(`FROM ${name}`));
  assert.ok(read(relation), `${build.sha} read ${relation}`);
  if (relation === projection) assert.ok(!read(ledger), `${build.sha} must not fall back`);
  const rows = migration_ledger?.length ?? "unreadable";
  console.info(`${build.sha} /up: HTTP ${status}, pending=${pending}, rows=${rows}`);
}

// The migration selftest owns both disposable databases and validates the
// target before connecting. Every fixture login changes only the identity.
export async function rehearseWebReadiness(owner, url, botOwner, botUrl) {
  const login = `runtime_${randomUUID().replaceAll("-", "")}`;
  const queries = [];
  const root = mkdtempSync(join(tmpdir(), "web-readiness-"));
  const roles = [];
  let reader;
  try {
    symlinkSync(resolve("node_modules"), join(root, "node_modules"));
    assert.equal(new Set([legacy, ...bridges]).size, bridges.length + 1);
    const old = await pinnedApp(root, legacy);
    const candidates = [];
    for (const sha of bridges) candidates.push(await pinnedApp(root, sha));
    const cutover = await buildCutoverApps(root);
    const [first] = candidates;
    const bridgeUp = async (expected, status, pending) => {
      for (const candidate of candidates) {
        await checkUp(candidate, reader, expected, status, pending, queries, projection);
      }
    };
    const cutoverUp = async (expected, relation, serving = reader) => {
      // A future web migration outside the reviewed window requires the full
      // current journal, even when this historical fixture is a valid prefix.
      const hasNewRequirement = webTags.some((tag) => tag.slice(0, 4) > "1038");
      const applied = new Set(expected?.map(({ tag }) => tag));
      const pending = expected
        ? hasNewRequirement
          ? webTags.filter((tag) => !applied.has(tag)).length
          : Number(!applied.has(old.history.at(-1).tag))
        : null;
      for (const app of cutover.apps) {
        await checkUp(
          app,
          serving,
          expected,
          pending === 0 ? 200 : 503,
          pending,
          queries,
          relation,
          "https://togetherweown.com",
        );
      }
    };
    assert.equal(old.history.length, 34);
    assert.match(old.history.at(-1).tag, /^1033_/);
    assert.deepEqual(first.history.slice(0, 34), old.history);
    assert.deepEqual(
      first.history.slice(34).map(({ tag }) => tag.slice(0, 4)),
      ["1034", "1035", "1036", "1037"],
    );
    for (const candidate of candidates.slice(1)) assert.deepEqual(candidate.history, first.history);
    console.info(`Pinned sources: legacy=${legacy}; bridges=${bridges.join(", ")}.`);

    const identity = async (sql) => {
      const [row] = await sql`SELECT current_database() AS db, oid, current_user AS role,
        session_user AS login, pg_get_userbyid(datdba) AS owner
        FROM pg_database WHERE datname = current_database()`;
      return row;
    };
    const catalog = await identity(owner);
    assert.equal(catalog.db, url.pathname.slice(1));
    assert.equal(catalog.role, catalog.owner);
    const openLogin = async (admin, target, role) => {
      const password = randomUUID();
      await admin`CREATE ROLE ${admin(role)} LOGIN PASSWORD ${admin.unsafe(`'${password}'`)}`;
      const entry = { admin, role };
      roles.push(entry);
      const loginUrl = new URL(target);
      loginUrl.username = role;
      loginUrl.password = "";
      const sql = postgres(loginUrl.href, {
        // Keep SELECT * safe across the 1036 column addition on the same connection.
        ...cutover.databaseOptions,
        port: 5432,
        max: 2,
        connect_timeout: 5,
        password: () => password,
        debug: (_connection, query) => queries.push(query),
      });
      entry.sql = sql;
      assert.deepEqual(await identity(sql), { ...(await identity(admin)), role, login: role });
      return sql;
    };
    const suffix = login.slice("runtime_".length);
    const webRole = `web_${suffix}`;
    const jobsRole = `jobs_${suffix}`;
    const migrationRole = `migrator_${suffix}`;
    const auditRole = `audit_${suffix}`;
    const botRole = `bot_reader_${suffix}`;
    const botViews = `bot_views_${suffix}`;
    const grantor = `serving_grantor_${suffix}`;
    await owner`CREATE ROLE ${owner(grantor)} NOLOGIN`;
    roles.push({ admin: owner, role: grantor });
    await botOwner`CREATE ROLE ${botOwner(botViews)} NOLOGIN`;
    roles.push({ admin: botOwner, role: botViews });
    reader = await openLogin(owner, url, login);
    const web = await openLogin(owner, url, webRole);
    const jobs = await openLogin(owner, url, jobsRole);
    const migrator = await openLogin(owner, url, migrationRole);
    const audit = await openLogin(owner, url, auditRole);
    const bot = await openLogin(botOwner, botUrl, botRole);
    await owner`GRANT pg_read_all_data, pg_write_all_data TO ${owner(grantor)} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`;
    await owner`GRANT ${owner(grantor)} TO ${owner(migrationRole)} WITH INHERIT FALSE, SET TRUE`;
    await owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE ${tx(grantor)}`;
      await tx`GRANT pg_read_all_data, pg_write_all_data TO ${tx(login)} GRANTED BY ${tx(grantor)}`;
    });
    await owner`GRANT ${owner(login)} TO ${owner(webRole)}, ${owner(jobsRole)} WITH INHERIT TRUE, SET FALSE`;
    await owner`REVOKE CREATE ON SCHEMA public FROM PUBLIC`;
    await owner`GRANT CREATE ON DATABASE ${owner(catalog.db)} TO ${owner(migrationRole)}`;
    await owner`GRANT USAGE, CREATE ON SCHEMA public TO ${owner(migrationRole)}`;

    await botOwner`GRANT ${botOwner(botViews)} TO ${botOwner(botRole)} WITH INHERIT TRUE, SET FALSE`;
    await botOwner`CREATE TABLE public.events (id int PRIMARY KEY)`;
    await botOwner`INSERT INTO public.events VALUES (1), (2)`;
    await botOwner`CREATE SCHEMA web_v1`;
    await botOwner`CREATE VIEW web_v1.live_counts AS SELECT count(*)::int AS count FROM public.events`;
    await botOwner`GRANT USAGE ON SCHEMA web_v1 TO ${botOwner(botViews)}`;
    await botOwner`GRANT SELECT ON web_v1.live_counts TO ${botOwner(botViews)}`;

    const readLedger = async (sql = migrator) => [
      ...(await sql`SELECT created_at::text, hash
        FROM drizzle.__drizzle_migrations ORDER BY created_at, id`),
    ];
    const pairs = (history) => history.map(({ created_at, hash }) => ({ created_at, hash }));
    await migrate(drizzle(migrator), old);
    assert.deepEqual(await readLedger(), pairs(old.history));
    await migrator`GRANT SELECT ON public.activity_log TO ${migrator(auditRole)}`;
    await cutoverUp(old.history, ledger);
    await probeCutoverEventSync(cutover.pgEventStore, reader);
    await migrator.unsafe(fixture("../docs/web-readiness-projection.sql"));
    await migrator`COMMENT ON VIEW web_readiness.migration_timestamps IS 'two-web readiness projection installation v1'`;
    await owner`GRANT USAGE ON SCHEMA public, web_readiness TO ${owner(login)}`;
    await owner`GRANT SELECT ON web_readiness.migration_timestamps TO ${owner(login)}`;
    await bridgeUp(old.history, 503, 4);
    await cutoverUp(old.history, projection);

    const denied = { code: "42501" };
    const probePrincipals = async (history, isolated) => {
      assert.deepEqual(await readLedger(), pairs(history));
      for (const [role, sql] of [
        [webRole, web],
        [jobsRole, jobs],
      ]) {
        if (isolated) {
          await assertServingLedgerIsolation(owner, role);
          await assert.rejects(readLedger(sql), denied);
          await assert.rejects(
            sql`SELECT last_value FROM drizzle.__drizzle_migrations_id_seq`,
            denied,
          );
        } else {
          assert.deepEqual(await readLedger(sql), pairs(history));
        }
      }
      const description = randomUUID();
      const [{ id }] = await web`INSERT INTO public.activity_log (description, created_at)
        VALUES (${description}, now()) RETURNING id`;
      const [row] = await audit`SELECT description FROM public.activity_log WHERE id = ${id}`;
      assert.equal(row.description, description);
      await assert.rejects(
        audit`INSERT INTO public.activity_log (id, description, created_at) VALUES (${id}, 'denied', now())`,
        denied,
      );
      assert.equal((await bot`SELECT count FROM web_v1.live_counts`)[0].count, 2);
      await assert.rejects(bot`SELECT id FROM public.events`, denied);
      await probeCutoverEventSync(cutover.pgEventStore, jobs);
      if (isolated) await cutoverUp(history, projection, web);
      else if (history === first.history) await checkUp(old, web, history, 200, 0, queries, ledger);
      console.info(
        `${history.at(-1).tag}: ${isolated ? "isolated" : "original"} inherited Web/Jobs, migrator, audit and Bot reader rights verified.`,
      );
    };

    const verifyExpandedIsolation = await rehearseServingIsolation({
      owner,
      reader,
      login,
      database: catalog.db,
      migrator,
      migrationRole,
      databasePath: url.pathname,
      oldHistory: old.history,
      newHistory: first.history,
      probePrincipals,
    });

    await migrate(drizzle(migrator), first);
    const expanded = await readLedger();
    assert.deepEqual(expanded, pairs(first.history));
    await verifyExpandedIsolation();
    const [deferred] =
      await owner`SELECT to_regclass('public.announcement_send_claims') AS relation`;
    assert.equal(deferred.relation, null);
    await assert.rejects(assertServingLedgerIsolation(owner, login), /implicit USAGE/);
    await assert.rejects(reader.unsafe(`INSERT INTO ${projection} VALUES (1)`), { code: "55000" });
    await checkUp(old, reader, first.history, 200, 0, queries, ledger);
    await bridgeUp(first.history, 200, 0);
    await cutoverUp(first.history, projection);

    await owner.begin(async (tx) => {
      await grantScopedAcl(tx, login);
      await tx`SET LOCAL ROLE ${tx(grantor)}`;
      await tx`REVOKE pg_read_all_data, pg_write_all_data FROM ${tx(login)} GRANTED BY ${tx(grantor)}`;
      await tx`RESET ROLE`;
      await assertServingLedgerIsolation(tx, login);
      await assertScopedAcl(tx, login, migrationRole);
    });
    assert.deepEqual(await identity(reader), { ...catalog, role: login, login });
    await assert.rejects(reader.unsafe(`SELECT created_at FROM ${ledger}`), { code: "42501" });
    await bridgeUp(first.history, 200, 0);
    await cutoverUp(first.history, projection);
    await probeCutoverEventSync(cutover.pgEventStore, reader);
    await checkUp(old, reader, null, 503, null, queries, ledger);
    await owner`REVOKE SELECT ON web_readiness.migration_timestamps FROM ${owner(login)}`;
    await bridgeUp(null, 503, null);
    await cutoverUp(null, projection);
    await owner`GRANT SELECT ON web_readiness.migration_timestamps TO ${owner(login)}`;
    await probeWorkloads(owner, reader);

    // Keep the real ledger current and the newest projected row visible.
    // Hiding the required 1033 row alone must fail the /up check used by Web and Jobs.
    const required = old.history.at(-1);
    await owner`CREATE OR REPLACE VIEW web_readiness.migration_timestamps AS
      SELECT created_at FROM drizzle.__drizzle_migrations
      WHERE created_at <> ${owner.unsafe(required.created_at)} OFFSET 0`;
    const behind = first.history.filter(({ tag }) => tag !== required.tag);
    await cutoverUp(behind, projection);

    assert.deepEqual(await readLedger(), expanded);
    console.info("Verified scoped ACL, same database/login, workloads and unchanged journal.");
  } finally {
    try {
      for (const { sql } of roles) await sql?.end({ timeout: 0 });
      for (const { admin, role } of roles.reverse()) {
        await admin`DROP OWNED BY ${admin(role)}`;
        await admin`DROP ROLE ${admin(role)}`;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
