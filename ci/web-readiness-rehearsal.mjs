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
import { assertServingLedgerIsolation } from "./migration-runtime-rights.mjs";
import { assertScopedAcl, grantScopedAcl, probeWorkloads } from "./web-readiness-scoped-acl.mjs";

const legacy = "57f1abbc25d0b39a77d83b46eb8b803b0249bb66";
const bridge = "ac9024ed0150df44dfcde1bdce64e3fa9699924e";
const successor = "88e73791dd84b4e81a8d89687032185fa694cb3b";
const bridges = [bridge, successor];
const git = (...args) => execFileSync("git", args, { maxBuffer: 32 * 1024 * 1024 });
const fixture = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const projection = "web_readiness.migration_timestamps";
const ledger = "drizzle.__drizzle_migrations";

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
    const hash = createHash("sha256").update(readFileSync(join(dir, path))).digest("hex");
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

async function checkUp(build, reader, expected, status, pending, queries, relation) {
  queries.length = 0;
  const appUrl = "https://next.example.test";
  const response = await build.app.request(`${appUrl}/up`, {}, {
    APP_URL: appUrl,
    SESSION_SECRET: randomUUID(),
    DISCORD_CLIENT_SECRET: "fixture",
    DISCORD_BOT_TOKEN: "fixture",
    QUEUE_DEPTH_STORE: reader,
  });
  assert.equal(response.status, status, `${build.sha} /up status`);
  const { db, pending_migrations, migration_ledger } = await response.json();
  assert.deepEqual(
    { db, pending_migrations, migration_ledger },
    {
      db: "ok",
      pending_migrations: pending,
      migration_ledger: expected?.map(({ created_at }) => Number(created_at)) ?? null,
    },
  );
  assert.ok(
    queries.some((query) => query.includes(`FROM ${relation}`)),
    `${build.sha} read ${relation}`,
  );
  if (relation === projection) {
    assert.ok(!queries.some((query) => query.includes(`FROM ${ledger}`)));
  }
  const rows = migration_ledger?.length ?? "unreadable";
  console.info(`${build.sha} /up: HTTP ${status}, pending=${pending}, rows=${rows}`);
}

// The migration selftest owns the fresh database and validates its URL before
// connecting; the reader changes only the identity on that same target.
export async function rehearseWebReadiness(owner, url) {
  const login = `runtime_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();
  const queries = [];
  const root = mkdtempSync(join(tmpdir(), "web-readiness-"));
  let reader;
  let createdLogin = false;
  try {
    symlinkSync(resolve("node_modules"), join(root, "node_modules"));
    assert.equal(new Set([legacy, ...bridges]).size, bridges.length + 1);
    const old = await pinnedApp(root, legacy);
    const candidates = [];
    for (const sha of bridges) candidates.push(await pinnedApp(root, sha));
    const [first] = candidates;
    const bridgeUp = async (expected, status, pending) => {
      for (const candidate of candidates) {
        await checkUp(candidate, reader, expected, status, pending, queries, projection);
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

    await owner`CREATE ROLE ${owner(login)} LOGIN PASSWORD ${owner.unsafe(`'${password}'`)}`;
    createdLogin = true;
    await owner`GRANT pg_read_all_data, pg_write_all_data TO ${owner(login)}`;
    const runtimeUrl = new URL(url);
    runtimeUrl.username = login;
    runtimeUrl.password = "";
    reader = postgres(runtimeUrl.href, {
      port: 5432,
      max: 2,
      connect_timeout: 5,
      password: () => password,
      debug: (_connection, query) => queries.push(query),
    });
    const identity = async (sql) => {
      const [row] = await sql`SELECT current_database() AS db, oid, current_user AS role,
        session_user AS login, pg_get_userbyid(datdba) AS owner
        FROM pg_database WHERE datname = current_database()`;
      return row;
    };
    const catalog = await identity(owner);
    assert.equal(catalog.db, url.pathname.slice(1));
    assert.equal(catalog.role, catalog.owner);
    assert.deepEqual(await identity(reader), { ...catalog, role: login, login });
    await owner`REVOKE CREATE ON SCHEMA public FROM PUBLIC`;
    const readLedger = async () => [
      ...(await owner`SELECT created_at::text, hash
        FROM drizzle.__drizzle_migrations ORDER BY created_at, id`),
    ];
    const pairs = (history) => history.map(({ created_at, hash }) => ({ created_at, hash }));
    await migrate(drizzle(owner), old);
    assert.deepEqual(await readLedger(), pairs(old.history));
    await owner.unsafe(fixture("../docs/web-readiness-projection.sql"));
    await owner`GRANT USAGE ON SCHEMA public, web_readiness TO ${owner(login)}`;
    await owner`GRANT SELECT ON web_readiness.migration_timestamps TO ${owner(login)}`;
    await bridgeUp(old.history, 503, 4);

    await migrate(drizzle(owner), first);
    const expanded = await readLedger();
    assert.deepEqual(expanded, pairs(first.history));
    await assert.rejects(assertServingLedgerIsolation(owner, login), /implicit USAGE/);
    await assert.rejects(reader.unsafe(`INSERT INTO ${projection} VALUES (1)`), { code: "55000" });
    await checkUp(old, reader, first.history, 200, 0, queries, ledger);
    await bridgeUp(first.history, 200, 0);

    await owner.begin(async (tx) => {
      await grantScopedAcl(tx, login);
      await tx`REVOKE pg_read_all_data, pg_write_all_data FROM ${tx(login)}`;
      await assertServingLedgerIsolation(tx, login);
      await assertScopedAcl(tx, login, catalog.role);
    });
    assert.deepEqual(await identity(reader), { ...catalog, role: login, login });
    await assert.rejects(reader.unsafe(`SELECT created_at FROM ${ledger}`), { code: "42501" });
    await bridgeUp(first.history, 200, 0);
    await checkUp(old, reader, null, 503, null, queries, ledger);
    await owner`REVOKE SELECT ON web_readiness.migration_timestamps FROM ${owner(login)}`;
    await bridgeUp(null, 503, null);
    await owner`GRANT SELECT ON web_readiness.migration_timestamps TO ${owner(login)}`;
    await probeWorkloads(owner, reader);
    assert.deepEqual(await readLedger(), expanded);
    console.info("Scoped ACL, same database/login, workloads and unchanged locked journal verified.");
  } finally {
    try {
      await reader?.end({ timeout: 0 });
      if (createdLogin) {
        await owner`DROP OWNED BY ${owner(login)}`;
        await owner`DROP ROLE ${owner(login)}`;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
