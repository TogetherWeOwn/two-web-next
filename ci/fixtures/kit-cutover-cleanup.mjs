import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { fixtureNames } from "../kit-cutover-database.mjs";
import { LEDGER_STATES, STAGING_WORKER } from "../kit-cutover-evidence.mjs";
import { cleanup, rehearseIsolatedCutover, verifyServed } from "../kit-cutover-staging.mjs";

const identity = {
  sourceSha: "a".repeat(40),
  runId: "21",
  runAttempt: "3",
  digest: "b".repeat(64),
};
const names = fixtureNames(identity.runId, identity.runAttempt);
const other = fixtureNames(identity.runId, "2");
const worker = `${STAGING_WORKER}-${names.suffix}`;
const otherWorker = `${STAGING_WORKER}-${other.suffix}`;
const hono = "11111111-1111-1111-1111-111111111111";
const kit = "22222222-2222-2222-2222-222222222222";

test("isolated cutover always cleans up before uploading successful proof", async () => {
  const url = new URL("../../.github/workflows/xfs-qualification.yml", import.meta.url);
  const job = parse(await readFile(url, "utf8")).jobs["isolated-cutover"];
  const { steps } = job;
  const qualify = steps.findIndex(
    ({ run }) =>
      run ===
      'node ci/kit-cutover-staging.mjs "$RUNNER_TEMP/kit-cutover-packet" "$RUNNER_TEMP/proof.json"',
  );
  const remove = steps.findIndex(({ run }) => run === "node ci/kit-cutover-staging.mjs --cleanup");
  const upload = steps.findIndex(
    ({ with: inputs }) => inputs?.path === "${{ runner.temp }}/proof.json",
  );
  assert.ok(qualify >= 0 && qualify < remove && remove < upload);
  assert.equal(steps[remove].if, "always()");
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(steps[qualify]["continue-on-error"], undefined);
  assert.equal(steps[remove]["continue-on-error"], undefined);
  assert.equal(steps[upload].if, undefined); // The default condition is success().
});

for (const failure of ["validation", "recording"]) {
  test(`isolated cutover ${failure} failure cleans its claim and emits no success`, async (t) => {
    const runnerTemp = await mkdtemp(join(tmpdir(), "kit-cutover-cleanup-test-"));
    t.after(() => rm(runnerTemp, { recursive: true, force: true }));
    const claim = join(runnerTemp, "kit-cutover-claimed.json");
    const proofPath = join(runnerTemp, "proof.json");
    if (failure === "recording") await writeFile(proofPath, "prior proof", { flag: "wx" });

    const info = t.mock.method(console, "info", () => {});
    const fetch = t.mock.method(globalThis, "fetch", () =>
      assert.fail("unexpected network request"),
    );
    const database = {};
    const workers = new Set([otherWorker]);
    const databases = new Set([other.db]);
    const logins = new Set([other.login]);
    const owner = { end: t.mock.fn() };
    let scratch;
    const api = async (path, method = "GET") => {
      if (method === "DELETE") {
        assert.equal(path, `scripts/${worker}`);
        assert.equal(workers.delete(worker), true);
        return;
      }
      assert.equal(method, "GET");
      assert.equal(path, `scripts/${worker}/settings`);
      return workers.has(worker) ? {} : null;
    };
    const removeDatabase = async (target, claimedNames) => {
      assert.equal(target, database);
      assert.deepEqual(claimedNames, names);
      assert.equal(databases.delete(claimedNames.db), true);
      assert.equal(logins.delete(claimedNames.login), true);
    };
    const ctx = { identity, names, worker, claim };
    const prefixes = { 1033: [1033], 1037: [1033, 1037] };
    const options = {
      database,
      api,
      origin: "https://cutover.example.invalid",
      prefixes,
      runnerTemp,
      profile: "all-off",
    };
    const effects = {
      async allocate(target, claimedNames, recordClaim) {
        assert.equal(target, database);
        assert.deepEqual(claimedNames, names);
        await recordClaim();
        databases.add(names.db);
        logins.add(names.login);
        return { owner };
      },
      async advance(connection, ledger, login) {
        assert.equal(connection, owner);
        assert.equal(ledger, prefixes["1033"]);
        assert.equal(login, names.login);
      },
      async deploy(_dir, scratchPath, proof) {
        scratch = scratchPath;
        await writeFile(join(scratch, "synthetic-scratch"), "fixture", { flag: "wx" });
        workers.add(proof.worker);
        Object.assign(proof, {
          hono,
          kit,
          configs: { hono: identity.digest, kit: identity.digest },
        });
      },
      async runChecks(proof) {
        for (const state of LEDGER_STATES) {
          for (const step of ["hono", "kit", "undo"]) {
            const version = step === "kit" ? kit : hono;
            const routes = await verifyServed(
              options.origin,
              prefixes,
              identity,
              version,
              state,
              "hono",
              {
                probeReady: async () => {},
                probeRoutes: async (_origin, { onRoute }) => {
                  onRoute("/");
                  return true;
                },
                wait: async () => assert.fail("unexpected serving retry"),
              },
            );
            if (failure === "recording") proof.routeCount = routes;
            proof.checks.push({ state, step, version, status: 200, pending: 0, smoke: "passed" });
          }
        }
        proof.kitReadinessSamples = 6;
      },
    };

    // Mirror the separate always() cleanup step, including after a refusal.
    const run = async () => {
      try {
        await rehearseIsolatedCutover(runnerTemp, proofPath, ctx, options, effects);
      } finally {
        await cleanup(ctx, api, database, removeDatabase);
      }
    };
    await assert.rejects(
      run(),
      failure === "validation" ? /empty staged route smoke/ : { code: "EEXIST" },
    );
    assert.deepEqual(
      owner.end.mock.calls.map(({ arguments: args }) => args),
      [[{ timeout: 0 }]],
    );
    await assert.rejects(readdir(scratch), { code: "ENOENT" });
    assert.deepEqual(workers, new Set([otherWorker]));
    assert.deepEqual(databases, new Set([other.db]));
    assert.deepEqual(logins, new Set([other.login]));
    await assert.rejects(readFile(claim), { code: "ENOENT" });
    if (failure === "recording") assert.equal(await readFile(proofPath, "utf8"), "prior proof");
    else await assert.rejects(readFile(proofPath), { code: "ENOENT" });
    assert.equal(info.mock.callCount(), 0);
    assert.equal(fetch.mock.callCount(), 0);
  });
}
