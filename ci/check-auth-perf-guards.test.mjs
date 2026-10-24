import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Implementation-owned guard pins for the settlement slice. The independent
// acceptance suite (check-auth-perf-settlement.test.mjs) is test-author-owned
// and stays untouched; these tests pin the three guards Paperclip Review
// proved deletable with the acceptance suite green: known-value secret-guard
// wiring, invalid-configuration receipt emission, and AUTH_PERF_URL
// userinfo/query/fragment refusal. Hermetic: injected fetch/clock only.
// Run: node --test ci/check-auth-perf*.test.mjs

const runner = fileURLToPath(
  new URL("./fixtures/auth-perf-settlement-runner.mjs", import.meta.url),
);
const ids = ["member-rsvp", "moderator-admin"];
const scratch =
  process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || tmpdir();

function runFixture(t, config = {}) {
  const cwd = mkdtempSync(join(scratch, "auth-perf-guards-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [runner], {
    cwd,
    env: { NODE_NO_WARNINGS: "1" },
    input: JSON.stringify(config),
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(child.status, 0, `fixture driver must finish: ${child.error ?? ""}\n${child.stderr}`);
  const result = JSON.parse(child.stdout);
  assert.equal(result.networkAttempts, 0, "the driver must never fall through to a real fetch");
  assert.deepEqual(result.unhandled, [], "abandoned rejections must be observed");
  return result;
}

function invalidReceipt(result) {
  assert.equal(typeof result.files.json, "string", "JSON receipt must exist on refusal");
  assert.equal(typeof result.files.md, "string", "Markdown receipt must exist on refusal");
  const ledger = JSON.parse(result.files.json);
  assert.equal(ledger.version, 2);
  assert.equal(ledger.verdict, "fail");
  assert.equal(ledger.counts.total, 2);
  assert.deepEqual(ledger.journeys.map((j) => j.id), ids);
  for (const journey of ledger.journeys) {
    assert.equal(journey.status, "failed");
    assert.equal(journey.error?.code, "invalid_configuration");
    assert.equal(journey.error.retryable, false);
    assert.ok(typeof journey.error.next_action === "string" && journey.error.next_action.length > 0);
    assert.equal(journey.measurements?.length, 5, "planned slots survive a loaded-budget refusal");
    for (const slot of journey.measurements) {
      assert.equal(slot.state, "unmeasured");
      assert.equal(slot.elapsedMs, null);
    }
    assert.deepEqual(journey.samples, []);
    assert.equal(journey.medianMs, null);
    assert.ok(result.files.md.includes(journey.id));
  }
  assert.ok(result.files.md.includes("invalid_configuration"));
  assert.deepEqual(result.filesAfterLate, result.files, "refusal receipts are final");
  return ledger;
}

// Findings 2+3: every configuration refusal exits 2 with zero fetches AND
// emits the documented v2 invalid_configuration receipt. Deleting the receipt
// emission (invalid() returning 2 without finish()) or any URL-guard clause
// fails these tests.
for (const env of [
  { AUTH_PERF_URL: "http://example.test" },
  { AUTH_PERF_URL: "ftp://example.test" },
  { AUTH_PERF_MUTANT: "unsupported" },
  { AUTH_PERF_URL: "https://qa:secret@fixture.test/" },
  { AUTH_PERF_URL: "https://fixture.test/private?token=x" },
  { AUTH_PERF_URL: "https://fixture.test/private#frag" },
]) {
  test(`configuration refusal emits an invalid_configuration receipt: ${JSON.stringify(env)}`, (t) => {
    const result = runFixture(t, { env });
    assert.equal(result.done, true);
    assert.equal(result.rejected, null);
    assert.equal(result.code, 2);
    assert.deepEqual(result.calls, [], "refused configuration must send no request");
    invalidReceipt(result);
  });
}

// Finding 1: the known QA value is the journey id, a word the receipt
// legitimately contains, so the end-to-end secrets wiring must refuse the
// write. Dropping the secrets argument (or any secrets.add site) lets the
// write succeed and fails this test.
test("known QA value reaching the ledger refuses both artifact writes", (t) => {
  const result = runFixture(t, { env: { E2E_QA_TOKEN: "member-rsvp" } });
  assert.equal(result.done, true);
  assert.equal(result.rejected, null);
  assert.notEqual(result.code, 0, "guard refusal must exit nonzero");
  assert.match(result.output, /secret-shaped content in ledger/);
  assert.deepEqual(result.files, {}, "a refused ledger must write no receipts");
  assert.deepEqual(result.filesAfterLate, {});
  const logins = result.calls.filter((c) => c.label.endsWith(":login"));
  assert.equal(logins.length, 2, "the probe ran; refusal happened at write time");
});
