import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  PLANETSCALE_PRODUCTION_BRANCH_ID,
  PLANETSCALE_PRODUCTION_HOST,
  webMigrationLockKey,
} from "../db-migrate.mjs";
import { runReadinessProjection } from "../db-readiness-projection.mjs";

const source = fileURLToPath(new URL("../../drizzle", import.meta.url));
const journal = JSON.parse(readFileSync(join(source, "meta/_journal.json"), "utf8"));
const alteredProjection = Buffer.concat([
  readFileSync(new URL("../../docs/web-readiness-projection.sql", import.meta.url)),
  Buffer.from("\nCREATE TABLE web_readiness.unreviewed_projection_change (id int);\n"),
]);

async function createLedger(sql) {
  await sql`CREATE SCHEMA drizzle`;
  await sql`CREATE TABLE drizzle.__drizzle_migrations (
    id serial PRIMARY KEY, hash text NOT NULL, created_at bigint
  )`;
}

function identityHash(database, role) {
  return createHash("sha256").update(`${database}\0${role}`).digest("hex");
}

// The caller owns a disposable database. Production endpoint admission runs
// against a synthetic DSN and the fixture supplies its own database and traffic.
export async function rehearseProjection({ client, url }) {
  const roles = ["owner", "serving", "unrelated"].map(
    (kind) => `view_${kind}_${randomUUID().replaceAll("-", "")}`,
  );
  const [ownerRole, servingRole, unrelatedRole] = roles;
  const sessions = [];
  try {
    for (const role of roles) {
      const password = randomUUID();
      await client`CREATE ROLE ${client(role)} LOGIN PASSWORD ${client.unsafe(`'${password}'`)}`;
      sessions.push(postgres(url.href, { username: role, password: () => password, max: 1 }));
    }
    const [owner, serving, unrelated] = sessions;
    await client`GRANT CREATE ON DATABASE ${client(url.pathname.slice(1))} TO ${client(ownerRole)}`;
    await createLedger(owner);
    const grantFallback = async () => {
      await owner`GRANT USAGE ON SCHEMA drizzle TO ${owner(servingRole)}`;
      await owner`GRANT SELECT (created_at) ON drizzle.__drizzle_migrations TO ${owner(servingRole)}`;
    };
    await grantFallback();
    const snapshot = async () => ({
      rows: [
        ...(await owner`SELECT id, hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY id`),
      ],
      sequence: [
        ...(await owner`SELECT last_value::text, is_called FROM drizzle.__drizzle_migrations_id_seq`),
      ],
      grants: [
        ...(await owner`SELECT n.nspacl::text, c.relacl::text, a.attacl::text
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'created_at'
        WHERE c.oid = 'drizzle.__drizzle_migrations'::regclass`),
      ],
      schema: (await owner`SELECT to_regnamespace('web_readiness')::text AS schema`)[0].schema,
    });
    const version = randomUUID();
    for (const end of ["1033_session-roles-checked-at", "1037_waitlist-offers"]) {
      const prefix = journal.entries.slice(
        0,
        journal.entries.findIndex(({ tag }) => tag === end) + 1,
      );
      const timestamps = prefix.map(({ when }) => when);
      const rows = prefix.map(({ tag, when }) => ({
        created_at: when,
        hash: createHash("sha256")
          .update(readFileSync(join(source, `${tag}.sql`)))
          .digest("hex"),
      }));
      await owner`TRUNCATE drizzle.__drizzle_migrations RESTART IDENTITY`;
      await owner`INSERT INTO drizzle.__drizzle_migrations ${owner(rows, "hash", "created_at")}`;
      const before = await snapshot();
      const run = (
        operation,
        {
          override,
          invalidDigest,
          trafficVersion = version,
          percentage = 100,
          pending = 0,
          projectionSql,
          healthResponse = (health) => Response.json(health),
        } = {},
      ) => {
        const plan = JSON.stringify({
          identity: identityHash(url.pathname.slice(1), ownerRole),
          ledger: end,
          operation,
          servingRole,
          webVersion: operation === "undo" ? version : null,
          ...override,
        });
        return runReadinessProjection(
          operation,
          {
            PRODUCTION_DB_READINESS_PLAN: plan,
            PRODUCTION_DB_READINESS_PLAN_SHA256: invalidDigest
              ? "0".repeat(64)
              : createHash("sha256").update(plan).digest("hex"),
            PRODUCTION_DB_READINESS_DATABASE_URL: `postgresql://fixture.${PLANETSCALE_PRODUCTION_BRANCH_ID}:fixture-password@${PLANETSCALE_PRODUCTION_HOST}:5432/postgres?sslmode=verify-full`,
            PRODUCTION_DB_READINESS_CF_ACCOUNT_ID: "a".repeat(32),
            PRODUCTION_DB_READINESS_CF_READ_TOKEN: "fixture",
          },
          {
            projectionSql,
            connect(config) {
              assert.ok(!invalidDigest);
              config.url.pathname = url.pathname;
              return { begin: owner.begin, end: async () => {} };
            },
            fetchImpl(target, options) {
              assert.equal(operation, "undo");
              assert.equal(options.redirect, "error");
              if (new URL(target).hostname === "api.cloudflare.com") {
                assert.equal(options.headers.authorization, "Bearer fixture");
                return Response.json({
                  success: true,
                  result: {
                    deployments: [
                      {
                        created_on: "2026-01-01T00:00:00Z",
                        versions: [{ percentage, version_id: trafficVersion }],
                      },
                    ],
                  },
                });
              }
              assert.equal(String(target), "https://togetherweown.com/up");
              assert.equal(options.headers.authorization, undefined);
              return healthResponse({
                revision: { version_id: version },
                db: "ok",
                pending_migrations: pending,
                migration_ledger: timestamps,
              });
            },
          },
        );
      };
      await assert.rejects(run("forward", { invalidDigest: true }), /plan digest/);
      await assert.rejects(
        run("forward", { projectionSql: alteredProjection }),
        /Readiness projection SQL differs from the reviewed definition/,
      );
      assert.deepEqual(await snapshot(), before);
      await assert.rejects(
        run("forward", { override: { operation: "undo" } }),
        /Invalid readiness plan/,
      );
      await assert.rejects(
        run("forward", { override: { ledger: "1038_announcement-send-claims" } }),
        /Invalid readiness plan/,
      );
      await client.begin(async (tx) => {
        await tx`LOCK TABLE drizzle.__drizzle_migrations IN ROW EXCLUSIVE MODE`;
        await assert.rejects(run("forward"), { code: "55P03" });
      });
      await client.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${webMigrationLockKey})`;
        await assert.rejects(run("forward"), /Web migration lock held/);
      });
      await client`CREATE TABLE public.announcement_send_claims (id int)`;
      await assert.rejects(run("forward"), /Unexpected ledger owner, shape, or serving role/);
      await client`DROP TABLE public.announcement_send_claims`;
      await client`GRANT ${client(ownerRole)} TO ${client(servingRole)} WITH INHERIT FALSE, SET FALSE`;
      await assert.rejects(run("forward"), /Unexpected ledger owner, shape, or serving role/);
      await client`REVOKE ${client(ownerRole)} FROM ${client(servingRole)}`;
      await owner`UPDATE drizzle.__drizzle_migrations SET hash = 'wrong' WHERE id = 1`;
      await assert.rejects(run("forward"), /not an exact prefix/);
      await owner`UPDATE drizzle.__drizzle_migrations SET hash = ${rows[0].hash} WHERE id = 1`;
      await owner`ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO ${owner(unrelatedRole)}`;
      await assert.rejects(run("forward"), /projection grants drifted/);
      assert.deepEqual(await snapshot(), before);
      await owner`ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM ${owner(unrelatedRole)}`;
      await run("forward");
      await assert.rejects(run("forward"), { code: "42P06" });
      const installed = await snapshot();
      assert.deepEqual(installed, { ...before, schema: "web_readiness" });
      const projection = () =>
        serving`SELECT created_at FROM web_readiness.migration_timestamps ORDER BY created_at`;
      const direct = () =>
        serving`SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`;
      const projected = await projection();
      assert.deepEqual(
        projected.map(({ created_at }) => Number(created_at)),
        timestamps,
      );
      assert.deepEqual(projected, await direct());
      await owner`REVOKE SELECT (created_at) ON drizzle.__drizzle_migrations FROM ${owner(servingRole)}`;
      await assert.rejects(direct(), { code: "42501" });
      assert.deepEqual(await projection(), projected);
      await assert.rejects(serving`SELECT hash FROM web_readiness.migration_timestamps`, {
        code: "42703",
      });
      await assert.rejects(serving`INSERT INTO web_readiness.migration_timestamps VALUES (1)`, {
        code: "55000",
      });
      await assert.rejects(serving`CREATE TABLE web_readiness.no_access (id int)`, {
        code: "42501",
      });
      await assert.rejects(unrelated`SELECT * FROM web_readiness.migration_timestamps`, {
        code: "42501",
      });
      await assert.rejects(run("undo"), /already have direct ledger timestamp access/);
      await grantFallback();
      await assert.rejects(run("undo", { trafficVersion: randomUUID() }), /Approved fallback/);
      await assert.rejects(run("undo", { percentage: 50 }), /not a single-version/);
      await assert.rejects(
        run("undo", { pending: 1 }),
        /Fallback Worker reports pending migrations/,
      );
      const paddedHealth = (bytes) => (health) =>
        new Response(JSON.stringify(health).padEnd(bytes));
      await assert.rejects(
        run("undo", { healthResponse: () => new Response(null) }),
        /traffic check unavailable/,
      );
      await assert.rejects(run("undo", { healthResponse: () => new Response("{") }), SyntaxError);
      await assert.rejects(
        run("undo", { healthResponse: paddedHealth(16 * 1024 + 1) }),
        /Oversized readiness traffic response/,
      );
      await owner`GRANT USAGE ON SCHEMA web_readiness TO ${owner(unrelatedRole)}`;
      await assert.rejects(run("undo"), /projection grants drifted/);
      await owner`REVOKE USAGE ON SCHEMA web_readiness FROM ${owner(unrelatedRole)}`;
      await owner`CREATE TABLE web_readiness.unrelated (id int)`;
      await assert.rejects(run("undo"), { code: "2BP01" });
      assert.deepEqual(await projection(), projected);
      await owner`DROP TABLE web_readiness.unrelated`;
      await run("undo", { healthResponse: paddedHealth(16 * 1024) });
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await direct(), projected);
      await assert.rejects(projection(), { code: "42P01" });
    }
  } finally {
    await Promise.all(sessions.map((client) => client.end({ timeout: 5 })));
    for (const role of roles.slice(0, sessions.length).reverse()) {
      await client`DROP OWNED BY ${client(role)}`;
      await client`DROP ROLE ${client(role)}`;
    }
  }
}
