import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PLANETSCALE_PRODUCTION_BRANCH_ID, PLANETSCALE_PRODUCTION_HOST } from "../db-migrate.mjs";
import { planServingIsolation, runServingIsolation } from "../db-serving-ledger-isolation.mjs";

const ledger = "drizzle.__drizzle_migrations";
const projection = "web_readiness.migration_timestamps";

async function rehearseDistinctGrantor(owner, login, capture, run) {
  const grantor = `isolation_grantor_${randomUUID().replaceAll("-", "")}`;
  const members = async () => [
    ...(await owner`SELECT
    pg_get_userbyid(grantor) AS grantor, admin_option AS admin,
    inherit_option AS inherit, set_option AS "set"
    FROM pg_auth_members WHERE roleid = 'pg_read_all_data'::regrole AND member = ${login}::regrole
    ORDER BY grantor`),
  ];
  const asGrantor = (change) =>
    owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE ${tx(grantor)}`;
      await change(tx);
    });
  await owner`CREATE ROLE ${owner(grantor)} NOLOGIN`;
  try {
    await owner`GRANT pg_read_all_data TO ${owner(grantor)} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`;
    await asGrantor(
      (tx) => tx`GRANT pg_read_all_data TO ${tx(login)}
      WITH ADMIN FALSE, INHERIT FALSE, SET FALSE GRANTED BY ${tx(grantor)}`,
    );
    const initial = await members();
    assert.equal(initial.length, 2);
    assert.deepEqual(
      initial.find((entry) => entry.grantor === grantor),
      {
        grantor,
        admin: false,
        inherit: false,
        set: false,
      },
    );
    const raw = await capture();
    assert.equal(await run("forward", { raw }), "committed");
    assert.deepEqual(await members(), []);
    assert.equal(await run("undo", { raw }), "committed");
    assert.deepEqual(await members(), initial);
  } finally {
    try {
      await asGrantor(
        (tx) => tx`REVOKE pg_read_all_data FROM ${tx(login)} GRANTED BY ${tx(grantor)}`,
      );
    } finally {
      await owner`DROP ROLE ${owner(grantor)}`;
    }
  }
}

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
  await owner`GRANT two_web_app TO ${owner(login)}`;
  const [originalSequence] = await owner`SELECT
    has_sequence_privilege(${login}::text, 'public.activity_log_id_seq', 'USAGE') AS usage,
    has_sequence_privilege(${login}::text, 'public.activity_log_id_seq', 'UPDATE') AS "update"`;
  assert.deepEqual(originalSequence, { usage: false, update: true });
  const version = randomUUID();
  const artifact = { sourceSha: "b".repeat(40), digest: "c".repeat(64) };
  const sha = (data) => createHash("sha256").update(data).digest("hex");
  const identityHash = sha(`${database}\0${ownerRole}`);
  const capture = async () =>
    JSON.stringify(await planServingIsolation(owner, identityHash, version, artifact, login));
  const plan = await capture();
  const firstEnd = oldHistory.at(-1).tag;
  const lastEnd = newHistory.at(-1).tag;
  const run = (
    operation,
    { end = firstEnd, liveVersion = version, qualified = true, raw = plan, hash = sha(raw) } = {},
  ) =>
    runServingIsolation(
      operation,
      end,
      {
        PRODUCTION_DB_ISOLATION_PLAN: raw,
        PRODUCTION_DB_ISOLATION_PLAN_SHA256: hash,
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
            if (target.endsWith(`/versions/${version}`)) {
              return Response.json({
                success: true,
                result: {
                  id: version,
                  annotations: {
                    "workers/tag": `${artifact.sourceSha}-23-1`,
                    "workers/message": qualified
                      ? `two-web-cutover-undo:${artifact.digest}`
                      : "legacy",
                  },
                },
              });
            }
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
  await assert.rejects(
    run("forward", { liveVersion: randomUUID() }),
    /Approved fallback must serve all/,
  );
  await assert.rejects(run("forward", { qualified: false }), /does not identify the staged Hono/);
  await assert.rejects(run("forward", { raw: "{" }), SyntaxError);
  await assert.rejects(run("forward", { hash: "0".repeat(64) }));
  await assert.rejects(run("forward", { raw: plan.padEnd(24577, " ") }));
  await owner`GRANT SELECT ON public.events TO ${owner(login)}`;
  await assert.rejects(run("forward"));
  await owner`REVOKE SELECT ON public.events FROM ${owner(login)}`;
  await owner`CREATE TABLE public.unreviewed_serving_table (id int)`;
  await assert.rejects(run("forward"), /Public serving inventory changed/);
  await owner`DROP TABLE public.unreviewed_serving_table`;
  assert.equal(await run("readback"), "before");
  await rehearseDistinctGrantor(owner, login, capture, run);
  assert.equal(await run("forward"), "committed");
  assert.equal(await run("readback"), "after");
  await assert.rejects(reader.unsafe(`SELECT created_at FROM ${ledger}`), { code: "42501" });
  await cutoverUp(oldHistory, projection);
  await probeEventSync();
  assert.equal(await run("undo"), "committed");
  assert.equal(await run("readback"), "before");
  assert.equal(await run("forward"), "committed");

  return async () => {
    assert.equal(await run("readback", { end: lastEnd }), "after");
    await owner`REVOKE USAGE ON SEQUENCE public.event_echo_members_id_seq FROM two_web_app`;
    await assert.rejects(
      run("readback", { end: lastEnd }),
      /Required Web\/Jobs privileges are missing/,
    );
    await owner`GRANT USAGE ON SEQUENCE public.event_echo_members_id_seq TO two_web_app`;
    await cutoverUp(newHistory, projection);
    const [scope] = await reader`SELECT
      (SELECT count(*) FROM public.event_echoes) = 0 AND
      (SELECT count(*) FROM public.event_echo_members) = 0 AND
      (SELECT count(*) FROM public.bot_reconciliation_intents) = 0 AND
      (SELECT count(*) FROM public.waitlist_offers) = 0 AS readable`;
    assert.equal(scope.readable, true);
    await owner`GRANT DELETE ON public.agent_event_grants TO ${owner(login)}`;
    await assert.rejects(run("undo", { end: lastEnd }));
    await owner`REVOKE DELETE ON public.agent_event_grants FROM ${owner(login)}`;
    await owner`REVOKE SELECT ON web_readiness.migration_timestamps FROM ${owner(login)}`;
    assert.equal(await run("readback", { end: lastEnd }), "after");
    assert.equal(await run("undo", { end: lastEnd }), "committed");
    assert.equal(await run("readback", { end: lastEnd }), "before");
    await reader`SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at LIMIT 1`;
    await owner`GRANT SELECT ON web_readiness.migration_timestamps TO ${owner(login)}`;
    await owner`REVOKE USAGE ON SCHEMA drizzle FROM ${owner(login)}`;
    await owner`REVOKE SELECT (created_at) ON drizzle.__drizzle_migrations FROM ${owner(login)}`;
    await owner`REVOKE two_web_app FROM ${owner(login)}`;
  };
}
