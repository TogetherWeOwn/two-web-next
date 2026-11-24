import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import {
  PLANETSCALE_PRODUCTION_BRANCH_ID,
  PLANETSCALE_PRODUCTION_HOST,
  migrationClient,
} from "./db-migrate.mjs";
import { checkProductionIdentity } from "./production-db-identity.mjs";

const identity = {
  database: "fixture_db",
  authenticated: "fixture_login",
  effective: "fixture_login",
};
const fingerprint = createHash("sha256")
  .update(`${identity.database}\0${identity.authenticated}`)
  .digest("hex");
const dsn = `postgresql://fixture.${PLANETSCALE_PRODUCTION_BRANCH_ID}:fixture-password@${PLANETSCALE_PRODUCTION_HOST}:5432/${identity.database}?sslmode=verify-full`;
const env = { PRODUCTION_DB_IDENTITY_SHA256: fingerprint, PRODUCTION_DATABASE_URL: dsn };
const workflow = parse(
  readFileSync(new URL("../.github/workflows/db-production-identity.yml", import.meta.url), "utf8"),
);
const { preflight, identity: readJob } = workflow.jobs;
const [scope] = preflight.steps;
const gate = readJob.steps[0];
const read = readJob.steps.at(-1);
const refusal = "Production database identity check refused.\n";

function shell(step, env, setup = "") {
  const result = spawnSync("/bin/bash", ["-c", `${setup}\n${step.run}`], {
    env,
    encoding: "utf8",
  });
  return [result.status, result.stdout, result.stderr];
}

test("dispatch admits only protected main with Environment-scoped pins on the same attempt", (t) => {
  assert.deepEqual(workflow.on, { workflow_dispatch: null });
  assert.deepEqual(Object.keys(workflow.jobs), ["preflight", "identity"]);
  assert.equal(preflight.environment, undefined);
  assert.equal(readJob.needs, "preflight");
  assert.equal(readJob.environment, "production");
  assert.deepEqual(readJob.steps[1].with, {
    ref: "${{ github.sha }}",
    "persist-credentials": false,
  });
  for (const name of [
    "PRODUCTION_DB_IDENTITY_APPROVED_SHA",
    "PRODUCTION_DB_IDENTITY_SHA256",
    "PRODUCTION_DATABASE_URL",
  ]) {
    assert.ok(scope.env.BROADER_SCOPE_SECRETS.includes(`secrets.${name} != ''`));
  }
  const fixtureDir = mkdtempSync(join(tmpdir(), "db-identity-fixture-"));
  t.after(() => rmSync(fixtureDir, { recursive: true }));
  const context = {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_PROTECTED: "true",
    BROADER_SCOPE_SECRETS: "false",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_OUTPUT: join(fixtureDir, "output"),
  };
  assert.deepEqual(shell(scope, context), [0, "", ""]);
  assert.equal(readFileSync(context.GITHUB_OUTPUT, "utf8"), "checked_attempt=2\n");
  for (const override of [
    { GITHUB_EVENT_NAME: "workflow_call" },
    { GITHUB_REF: "refs/tags/main" },
    { GITHUB_REF: "refs/heads/other" },
    { GITHUB_REF_PROTECTED: "false" },
    { BROADER_SCOPE_SECRETS: "true" },
  ]) {
    assert.deepEqual(shell(scope, { ...context, ...override }), [1, "", refusal]);
  }
  const pins = {
    GITHUB_RUN_ATTEMPT: "2",
    CHECKED_ATTEMPT: "2",
    GITHUB_SHA: "a".repeat(40),
    APPROVED_SHA: "a".repeat(40),
    PRODUCTION_DB_IDENTITY_SHA256: fingerprint,
  };
  assert.deepEqual(shell(gate, pins), [0, "", ""]);
  for (const override of [
    { CHECKED_ATTEMPT: "1" },
    { APPROVED_SHA: "b".repeat(40) },
    { APPROVED_SHA: "" },
    { PRODUCTION_DB_IDENTITY_SHA256: "" },
    { PRODUCTION_DB_IDENTITY_SHA256: identity.authenticated },
  ]) {
    assert.deepEqual(shell(gate, { ...pins, ...override }), [1, "", refusal]);
  }
});

test("the isolated read step receives the DSN and emits only fixed verdicts", () => {
  assert.equal(read.env.PRODUCTION_DATABASE_URL, "${{ secrets.PRODUCTION_DATABASE_URL }}");
  assert.equal(
    JSON.stringify(workflow).split("${{ secrets.PRODUCTION_DATABASE_URL }}").length - 1,
    1,
  );
  assert.equal(readJob.steps.length, 5);
  for (const status of [0, 1, 143]) {
    const setup = `node() {
      [[ "$*" == "ci/production-db-identity.mjs" ]] || return 99
      printf '%s\\n' "$PRODUCTION_DATABASE_URL" '${identity.authenticated}'
      printf '%s\\n' 'driver diagnostic' >&2
      ${status === 143 ? "/bin/bash -c 'kill -TERM $$'" : `return ${status}`}
    }`;
    assert.deepEqual(
      shell(read, env, setup),
      status === 0 ? [0, "Production database identity matched.\n", ""] : [1, "", refusal],
    );
  }
});

test("the probe pins a verified TLS connection and issues only the read-only identity query", async () => {
  for (const [rows, expected] of [
    [[identity], true],
    [[{ ...identity, effective: "wrong_role" }], false],
    [[{ ...identity, authenticated: "wrong_role", effective: "wrong_role" }], false],
    [[{ ...identity, database: "wrong_db" }], false],
    [[], false],
    [new Error(`private driver diagnostic: ${dsn}`), false],
  ]) {
    const queries = [];
    const closed = [];
    const actual = await checkProductionIdentity(env, (config, options) => {
      // postgres.js constructs its client lazily. Inspect the actual options
      // with an invalid host and never call any connection/query methods.
      assert.equal(config.url.hostname, PLANETSCALE_PRODUCTION_HOST);
      const url = new URL(config.url);
      url.hostname = "fixture.invalid";
      const client = migrationClient({ ...config, url }, options);
      assert.deepEqual(client.options.ssl, { rejectUnauthorized: true });
      assert.deepEqual(client.options.port, [5432]);
      assert.equal(client.options.max, 1);
      assert.equal(client.options.fetch_types, false);
      assert.equal(client.options.connection.default_transaction_read_only, "on");
      return {
        begin: async (mode, callback) => {
          assert.equal(mode, "read only");
          await callback(async (sql, ...parameters) => {
            queries.push([sql.join("").replace(/\s+/g, " "), parameters]);
            if (rows instanceof Error) throw rows;
            return rows;
          });
        },
        end: async (...args) => closed.push(args),
      };
    });
    assert.equal(actual, expected);
    assert.deepEqual(queries, [
      [
        "select pg_catalog.current_database()::text as database, session_user::text as authenticated, current_user::text as effective",
        [],
      ],
    ]);
    assert.deepEqual(closed, [[{ timeout: 5 }]]);
  }
});

test("invalid fingerprint, endpoint and TLS settings refuse before constructing a client", async () => {
  const calls = [];
  for (const override of [
    { PRODUCTION_DB_IDENTITY_SHA256: "" },
    ...[
      "",
      dsn.replace(PLANETSCALE_PRODUCTION_HOST, "fixture.invalid"),
      dsn.replace(PLANETSCALE_PRODUCTION_BRANCH_ID, "wrong-branch"),
      dsn.replace(":5432/", ":5433/"),
      dsn.replace("verify-full", "disable"),
      `${dsn}&options=-crole=wrong_role`,
    ].map((value) => ({ PRODUCTION_DATABASE_URL: value })),
  ]) {
    assert.equal(
      await checkProductionIdentity({ ...env, ...override }, () => calls.push(true)),
      false,
    );
  }
  assert.deepEqual(calls, []);
});
