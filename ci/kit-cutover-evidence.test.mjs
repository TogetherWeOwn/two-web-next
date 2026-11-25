import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LEDGER_STATES,
  STAGING_WORKER,
  WranglerOperationError,
  ledgerPrefixes,
  productionUploadConfig,
  readReady,
  sourceInputs,
  verifyPackage,
  verifyReady,
  verifyStagingProof,
  writeManifest,
} from "./kit-cutover-evidence.mjs";
import { verifyServed } from "./kit-cutover-staging.mjs";

const sourceSha = "a".repeat(40);
const digest = "b".repeat(64);
const hono = "11111111-1111-1111-1111-111111111111";
const kit = "22222222-2222-2222-2222-222222222222";
const identity = { sourceSha, runId: "21", runAttempt: "3", digest };
const ledgerJournal = [
  "1032_event-public-join-details",
  "1033_session-roles-checked-at",
  "1034_event-echoes",
  "1035_bot-reconciliation-intents",
  "1036_event-sync-claim-started",
  "1037_waitlist-offers",
  "1038_announcement-send-claims",
].map((tag, i) => ({ tag, when: 1700000000000 + i }));

const inputs = await sourceInputs();

const readyOrigin = "https://cutover.example.invalid";
const readyPrefixes = ledgerPrefixes(ledgerJournal);
const readyIdentity = { version: kit, commit: sourceSha, state: "1033" };
const readyBody = {
  db: "ok",
  pending_migrations: 0,
  migration_ledger: readyPrefixes["1033"],
  revision: { version_id: kit, commit: sourceSha },
};

test("readReady admits exact 200 and approved deferred 503 responses", async () => {
  const jsonAtLimit = JSON.stringify(readyBody).padEnd(16 * 1024);
  const response = async (url, { headers, redirect, signal }) => {
    assert.equal(url.href, `${readyOrigin}/up`);
    assert.deepEqual(headers, { "cache-control": "no-cache" });
    assert.equal(redirect, "error");
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    return new Response(jsonAtLimit);
  };
  assert.equal(await readReady(readyOrigin, readyPrefixes, readyIdentity, response), "1033");

  const deferred = async () =>
    Response.json({ ...readyBody, pending_migrations: 1 }, { status: 503 });
  assert.equal(
    await readReady(
      readyOrigin,
      readyPrefixes,
      { ...readyIdentity, allowDeferred: true },
      deferred,
    ),
    "1033",
  );
  await assert.rejects(readReady(readyOrigin, readyPrefixes, readyIdentity, deferred), /readiness/);
});

test("readReady cancels and refuses an oversized stream without Content-Length", {
  timeout: 2_000,
}, async () => {
  const atLimit = new TextEncoder().encode(JSON.stringify(readyBody).padEnd(16 * 1024));
  const chunks = [atLimit, Uint8Array.of(0x20)];
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream(
    {
      pull(controller) {
        const chunk = chunks[pulls++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
        // An unsettled cleanup must leave the refusal prompt.
        return new Promise(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  const response = new Response(stream);
  assert.equal(response.headers.get("content-length"), null);
  await assert.rejects(
    readReady(readyOrigin, readyPrefixes, readyIdentity, async () => response),
    /readiness response exceeds/,
  );
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("readReady refuses empty, invalid or truncated JSON", async () => {
  await assert.rejects(
    readReady(readyOrigin, readyPrefixes, readyIdentity, async () => new Response()),
    /missing readiness response body/i,
  );
  const json = JSON.stringify(readyBody);
  for (const body of ["", `${json} garbage`, json.slice(0, -1)]) {
    await assert.rejects(
      readReady(readyOrigin, readyPrefixes, readyIdentity, async () => new Response(body)),
      /invalid readiness JSON/i,
    );
  }
});

test("cutover packet refuses wrong bytes, package identity, or source config", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "cutover-packet-test-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  for (const profile of ["hono", "kit"]) {
    await mkdir(join(scratch, profile, "modules"), { recursive: true });
    await mkdir(join(scratch, profile, "assets"));
    await writeFile(join(scratch, profile, "assets", ".assetsignore"), "fixture");
  }
  await writeFile(join(scratch, "hono/modules/worker.js"), "pure Hono");
  await writeFile(join(scratch, "kit/modules/_worker.js"), "facade");
  await writeFile(join(scratch, "kit/modules/kit-adapter.js"), "Kit adapter");
  const context = { sourceSha, runId: identity.runId, runAttempt: identity.runAttempt };
  const pin = { ...context, digest: await writeManifest(scratch, context, inputs) };
  await verifyPackage(scratch, pin, inputs);
  await assert.rejects(verifyPackage(scratch, { ...pin, digest }, inputs), /manifest digest/);
  for (const [field, value] of [
    ["sourceSha", "d".repeat(40)],
    ["runId", "22"],
    ["runAttempt", "4"],
  ]) {
    await assert.rejects(
      verifyPackage(scratch, { ...pin, [field]: value }, inputs),
      new RegExp(field),
    );
  }
  await assert.rejects(
    verifyPackage(scratch, pin, {
      digests: { ...inputs.digests, honoConfig: digest },
    }),
    /config or journal digest/,
  );
  await assert.rejects(
    verifyPackage(scratch, pin, {
      ...inputs,
      honoBuild: { ...inputs.honoBuild, define: "__TWO_WEB_1033_COMPAT__:false" },
    }),
    /Hono build profile/,
  );
  await writeFile(join(scratch, "kit/modules/kit-adapter.js"), "changed");
  await assert.rejects(verifyPackage(scratch, pin, inputs), /kit bytes mismatch/);
  await writeFile(join(scratch, "kit/modules/kit-adapter.js"), "Kit adapter");
  await writeFile(join(scratch, "hono/assets/.assetsignore"), "changed Hono asset control file");
  await assert.rejects(verifyPackage(scratch, pin, inputs), /hono bytes mismatch/);
});

test("cutover ledger admits exactly 1033 or 1037 and exact version readiness", () => {
  const prefixes = ledgerPrefixes(ledgerJournal);
  assert.throws(
    () => ledgerPrefixes([...ledgerJournal, { tag: "1039_later", when: 1700000000007 }]),
    /approved cutover window/,
  );
  const body = {
    db: "ok",
    pending_migrations: 0,
    migration_ledger: prefixes["1033"],
    revision: { version_id: hono, commit: sourceSha },
  };
  const expected = { version: hono, commit: sourceSha };
  for (const [state, rows] of Object.entries(prefixes)) {
    assert.equal(verifyReady(200, { ...body, migration_ledger: rows }, prefixes, expected), state);
  }
  assert.throws(() => verifyReady(503, body, prefixes, expected), /readiness/);
  assert.throws(() => verifyReady(200, { ...body, pending_migrations: 1 }, prefixes), /readiness/);
  assert.throws(() => verifyReady(200, body, prefixes, { version: kit }), /version or commit/);
  assert.throws(
    () => verifyReady(200, body, prefixes, { ...expected, commit: "c".repeat(40) }),
    /version or commit/,
  );
  assert.throws(() => verifyReady(200, body, prefixes, { ...expected, state: "1037" }), /state/);
  for (const rows of [
    prefixes["1037"].slice(0, -1),
    [...prefixes["1033"], prefixes["1037"].at(-1)],
    [...prefixes["1037"], ledgerJournal.at(-1).when],
    [...prefixes["1033"], prefixes["1033"].at(-1)],
    prefixes["1033"].map(String),
  ]) {
    assert.throws(
      () => verifyReady(200, { ...body, migration_ledger: rows }, prefixes),
      /canonical/,
    );
  }
});

test("isolated cutover repeats readiness and smoke when rollback is still propagating", async () => {
  const origin = "https://cutover.example.invalid";
  const prefixes = ledgerPrefixes(ledgerJournal);
  const calls = [];
  let attempt = 0;
  const routeCount = await verifyServed(origin, prefixes, identity, hono, "1033", "hono", {
    probeReady: async (url, ledger, expected) => {
      assert.equal(url, origin);
      assert.equal(ledger, prefixes);
      assert.deepEqual(expected, { version: hono, commit: sourceSha, state: "1033" });
      calls.push("readiness");
      attempt += 1;
      if (attempt === 2) throw new Error("Worker readiness version or commit mismatch");
    },
    probeRoutes: async (url, { expectedVersionId, expectedCutoverRenderer, onRoute }) => {
      assert.equal(url, origin);
      assert.equal(expectedVersionId, hono);
      assert.equal(expectedCutoverRenderer, "hono");
      // Smoke would pass on attempt two even though readiness just regressed.
      const converged = attempt > 1;
      calls.push("smoke");
      onRoute("/up", converged ? 0 : 1);
      onRoute("/", converged ? 0 : 1);
      return converged;
    },
    wait: async (ms) => {
      assert.equal(ms, 10_000);
      calls.push("wait");
    },
  });
  assert.equal(routeCount, 2);
  assert.deepEqual(calls, [
    "readiness",
    "smoke",
    "wait",
    "readiness",
    "wait",
    "readiness",
    "smoke",
  ]);
});

test("isolated cutover refuses persistent smoke failures after six attempts", async () => {
  const calls = [];
  await assert.rejects(
    verifyServed(
      "https://cutover.example.invalid",
      ledgerPrefixes(ledgerJournal),
      identity,
      hono,
      "1033",
      "hono",
      {
        probeReady: async () => {
          calls.push("readiness");
        },
        probeRoutes: async (_origin, { onRoute }) => {
          calls.push("smoke");
          onRoute("/", 1);
          return false;
        },
        wait: async () => {
          calls.push("wait");
        },
      },
    ),
    /isolated public-route smoke failed/,
  );
  assert.deepEqual(calls, [
    ...Array.from({ length: 5 }, () => ["readiness", "smoke", "wait"]).flat(),
    "readiness",
    "smoke",
  ]);
});

test("isolated cutover proof requires both exact versions and six healthy transitions", () => {
  const checks = LEDGER_STATES.flatMap((state) =>
    ["hono", "kit", "undo"].map((step) => ({
      state,
      step,
      version: step === "kit" ? kit : hono,
      status: 200,
      pending: 0,
      smoke: "passed",
    })),
  );
  const proof = {
    schema: 1,
    identity,
    worker: `${STAGING_WORKER}-21-3`,
    hono,
    kit,
    checks,
    configs: { kit: digest, hono: digest },
    routeCount: 24,
    kitReadinessSamples: 6,
    bindingCheck: "isolated-and-all-off",
  };
  verifyStagingProof(proof, identity);
  const ember = { ...proof, bindingCheck: "isolated-and-ember" };
  verifyStagingProof(ember, { ...identity, mode: "ember" });
  verifyStagingProof(ember, { ...identity, mode: "hono" });
  assert.throws(() => verifyStagingProof(ember, { ...identity, mode: "kit" }), /profile/);
  assert.throws(() => verifyStagingProof(proof, { ...identity, mode: "ember" }), /profile/);
  assert.throws(() => verifyStagingProof({ ...proof, kitReadinessSamples: 5 }, identity));
  assert.throws(() => verifyStagingProof({ ...proof, bindingCheck: "unobserved" }, identity));
  for (const change of [{ status: 503 }, { pending: 1 }, { version: kit }, { smoke: "failed" }]) {
    assert.throws(
      () =>
        verifyStagingProof(
          {
            ...proof,
            checks: checks.map((row, i) => (i === 2 ? { ...row, ...change } : row)),
          },
          identity,
        ),
      /must prove/,
    );
  }
  assert.throws(() => verifyStagingProof(proof, { ...identity, runAttempt: "2" }), /identity/);
  assert.throws(
    () => verifyStagingProof({ ...proof, checks: checks.slice(0, 3) }, identity),
    /must prove/,
  );
  const adminPin = { ...identity, mode: "admin" };
  const admin = {
    ...proof,
    ember: hono,
    configs: { kit: digest, ember: digest },
    checks: checks
      .slice(3)
      .map((row) => ({ ...row, step: row.step === "hono" ? "ember" : row.step })),
    kitReadinessSamples: 3,
    bindingCheck: "isolated-and-admin",
    adminChecks: ["default-denied", "credential-separation", "ownership-undo"],
  };
  verifyStagingProof(admin, adminPin);
  assert.throws(
    () => verifyStagingProof({ ...admin, bindingCheck: ember.bindingCheck }, adminPin),
    /profile/,
  );
  assert.throws(() => verifyStagingProof({ ...admin, adminChecks: [] }, adminPin));
  assert.throws(() => verifyStagingProof({ ...admin, checks: admin.checks.slice(0, 2) }, adminPin));
});

test("Ember cutover configuration opts in only the Ember documents", () => {
  const allOff = productionUploadConfig("kit", inputs);
  assert.equal(allOff.vars.KIT_ROUTE_EMBER_PAGES, "false");
  const vars = {
    ...allOff.vars,
    KIT_ROUTE_ADMIN: "false",
    KIT_ROUTE_EMBER_PAGES: "true",
    KIT_ROUTE_AUTH: "false",
    KIT_ROUTE_FEEDS: "false",
    KIT_ROUTE_SEO: "false",
    KIT_ROUTE_SECURITY_TXT: "false",
    DISCORD_LIVE_SOCKET_ENABLED: "false",
  };
  assert.deepEqual(productionUploadConfig("kit", inputs, "ember"), { ...allOff, vars });
  assert.throws(() => productionUploadConfig("hono", inputs, "ember"), /requires the Kit artifact/);
  assert.deepEqual(productionUploadConfig("kit", inputs, "admin"), {
    ...allOff,
    vars: { ...vars, KIT_ROUTE_ADMIN: "true" },
  });
});

test("isolated database admission fixes the host, database, owner, and run scope", async () => {
  const { fixtureDatabase, fixtureNames } = await import("./kit-cutover-database.mjs");
  const host = "ep-fixture.us-east-2.aws.neon.tech";
  const fixture = `postgresql://two_web_cutover_owner:synthetic@${host}/two_web_cutover`;
  assert.equal(fixtureDatabase(fixture, host).searchParams.get("sslmode"), "verify-full");
  assert.throws(() => fixtureDatabase(fixture, "ep-different.us-east-2.aws.neon.tech"));
  assert.throws(() => fixtureDatabase(fixture.replace("/two_web_cutover", "/main"), host));
  assert.throws(() => fixtureDatabase(`${fixture}?options=override`, host));
  assert.deepEqual(fixtureNames("21", "3"), {
    suffix: "21-3",
    db: "two_web_cutover_21_3",
    login: "two_web_cutover_21_3_runtime",
  });
  assert.throws(() => fixtureNames("21", "03"));
});

test("isolated upload diagnostics keep only the operation, exit status and provider code", () => {
  const error = new WranglerOperationError(["versions", "upload", "configured-entry"], {
    status: 1,
    stderr: "untrusted binding details [code: 10007]",
  });
  assert.equal(error.message, "Wrangler versions upload failed (exit 1), provider code 10007");
  for (const stderr of [
    undefined,
    "[code: 123]",
    Buffer.from("[code: 123456789]"),
    "[code: TOKEN]",
  ]) {
    const refusal = new WranglerOperationError(
      ["rollback", "11111111-1111-1111-1111-111111111111"],
      {
        status: null,
        stderr,
      },
    );
    assert.equal(refusal.message, "Wrangler rollback failed");
  }
});
