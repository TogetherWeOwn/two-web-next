import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scrubSecrets } from "./check-auth-perf.mjs";

// Independent, test-author-owned contract; implementation belongs elsewhere.
// Reproduce (Node 22.23+ on 22.x, or 24+; no npm install, QA secret, DB or network):
// node --test ci/check-auth-perf-rotation.test.mjs ci/check-auth-perf-live-gate.test.mjs ci/check-auth-perf-settlement.test.mjs
//
// Receipt v2 extends the existing ledger, not its budget semantics:
// - journeys have stable id; measurements cover all five planned slots, with
//   id "<journey>:<zero-based index>", state measured/unmeasured, elapsedMs
//   (header latency or null), error (null or {code,retryable,next_action}).
// - journey.error describes a failure, including login failures before samples.
// - existing samples/medianMs retain completed header measurements only; failed
//   body validation must not erase an already observed header measurement.
// - no timing is invented for requests that never yielded response headers.
// Fixed codes tested here: transport_timeout, transport_error, body_read_failed,
// body_too_large, login_refused, missing_cookie, output_write_failed.
// Diagnostics/next_action prose is deliberately NOT pinned.
// The settlement envelope is the existing 15s request deadline across headers
// AND body, even when abort is ignored. The resource ceiling is at most 1 MiB
// decoded body bytes (a tighter documented limit is fine). These are resource
// bounds, NOT a change to the 500/1000ms header-latency performance budgets.
// summarize()/writeLedger() legacy-v1 caller compatibility remains covered by
// check-auth-perf.test.mjs; no existing assertion is removed or weakened here.

const runner = fileURLToPath(
  new URL("./fixtures/auth-perf-settlement-runner.mjs", import.meta.url),
);
const script = fileURLToPath(new URL("./check-auth-perf.mjs", import.meta.url));
const ids = ["member-rsvp", "moderator-admin"];
const qaCanary = "synthetic-qa-canary-acceptance";
const cookieCanary = "synthetic-cookie-canary-acceptance";
const canaries = [qaCanary, cookieCanary, "synthetic-url-canary-acceptance"];
const scratch =
  process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || tmpdir();

function runFixture(t, config = {}) {
  const cwd = mkdtempSync(join(scratch, "auth-perf-settlement-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [runner], {
    cwd,
    env: { NODE_NO_WARNINGS: "1" },
    input: JSON.stringify(config),
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(
    child.status,
    0,
    `fixture driver must finish independently of probe settlement: ${child.error ?? ""}\n${child.stderr}`,
  );
  const result = JSON.parse(child.stdout);
  assert.equal(
    result.networkAttempts,
    0,
    "the acceptance driver must never fall through to a real fetch",
  );
  assert.deepEqual(
    result.unhandled,
    [],
    "abandoned fetch/body/cleanup rejections must be observed",
  );
  return result;
}

function secretFree(result) {
  // Do not scan fixture request traces: they intentionally carry synthetic
  // credentials. Scan every consumer-visible channel, including thrown errors.
  for (const text of [result.output, result.rejected ?? "", ...Object.values(result.files)]) {
    for (const canary of canaries)
      assert.ok(!text.includes(canary), "a known synthetic secret escaped");
    assert.equal(scrubSecrets(text).length, 0, "existing secret-shaped guards remain mandatory");
    assert.doesNotMatch(
      text,
      /https:\/\/fixture\.test\/private/,
      "token-bearing URLs must not escape",
    );
  }
}

function settled(result, maxMs = 15_000) {
  assert.equal(result.done, true, "runLive must settle without trusting AbortSignal cooperation");
  assert.equal(
    result.rejected,
    null,
    "expected failure must return a classified exit, not reject runLive",
  );
  assert.ok(Number.isInteger(result.code), "runLive must return an exit code");
  assert.ok(
    result.settledAt <= maxMs,
    `probe settled at ${result.settledAt}ms, beyond its whole-operation bound`,
  );
}

function receipt(result, verdict = "fail") {
  assert.equal(
    typeof result.files.json,
    "string",
    "JSON receipt must exist even for early login failure",
  );
  assert.equal(
    typeof result.files.md,
    "string",
    "Markdown receipt must exist even for early login failure",
  );
  const ledger = JSON.parse(result.files.json);
  assert.equal(ledger.version, 2, "new measured/unmeasured/error contract must be versioned");
  assert.equal(ledger.verdict, verdict);
  assert.equal(ledger.counts.total, 2);
  assert.deepEqual(
    ledger.journeys.map((j) => j.id),
    ids,
    "journey IDs must not depend on URL/error prose",
  );
  for (const journey of ledger.journeys) {
    assert.equal(
      journey.measurements?.length,
      5,
      "all planned sample IDs must survive incomplete probes",
    );
    assert.deepEqual(
      journey.measurements.map((m) => m.id),
      Array.from({ length: 5 }, (_, i) => `${journey.id}:${i}`),
    );
    for (const measurement of journey.measurements) {
      assert.ok(["measured", "unmeasured"].includes(measurement.state));
      if (measurement.state === "measured")
        assert.ok(Number.isFinite(measurement.elapsedMs) && measurement.elapsedMs >= 0);
      else assert.equal(measurement.elapsedMs, null, "unmeasured slots are not zero/-1ms samples");
      assert.ok(
        result.files.md.includes(measurement.id),
        "Markdown must retain machine-correlatable sample IDs",
      );
      assert.ok(
        result.files.md.includes(measurement.state),
        "Markdown must distinguish measurement state",
      );
    }
    const completed = journey.measurements
      .filter((m) => m.state === "measured")
      .map((m) => m.elapsedMs);
    assert.deepEqual(
      journey.samples,
      completed,
      "aggregate samples must honestly retain completed header timings",
    );
    if (completed.length === 0) assert.equal(journey.medianMs, null);
  }
  assert.deepEqual(
    result.filesAfterLate,
    result.files,
    "late completion must not rewrite an emitted receipt",
  );
  secretFree(result);
  return ledger;
}

function errorFields(error, code, retryable) {
  assert.ok(error && typeof error === "object", "failure needs structured error metadata");
  assert.equal(error.code, code);
  assert.equal(error.retryable, retryable);
  assert.ok(typeof error.next_action === "string" && error.next_action.trim().length > 0);
}

function failedJourney(
  result,
  { code, retryable, targetId = "member-rsvp", phase = "journey", index = 0, measured = true },
) {
  settled(result);
  assert.ok([1, 2].includes(result.code), "an incomplete/refused probe must exit nonzero");
  const ledger = receipt(result);
  const journey = ledger.journeys.find((j) => j.id === targetId);
  assert.equal(journey.status, "failed");
  errorFields(journey.error, code, retryable);
  assert.ok(result.files.md.includes(code), "Markdown must name the fixed error code");
  assert.ok(result.files.md.includes(journey.error.next_action), "Markdown must carry remediation");
  if (phase === "login") {
    assert.ok(journey.measurements.every((m) => m.state === "unmeasured"));
  } else {
    const sample = journey.measurements[index];
    assert.equal(sample.state, measured ? "measured" : "unmeasured");
    assert.equal(sample.elapsedMs, measured ? 40 : null);
    errorFields(sample.error, code, retryable);
  }
  // A failed login/sample never amplifies traffic with retries or a re-login.
  const logins = result.calls.filter((c) => c.label.endsWith(":login"));
  assert.ok(logins.length <= 2);
  assert.equal(new Set(logins.map((c) => c.label)).size, logins.length);
  const targetCalls = result.calls.filter(
    (c) => c.label.startsWith(`${targetId}:`) && !c.label.endsWith(":login"),
  );
  if (phase === "login")
    assert.equal(targetCalls.length, 0, "no journey reads after failed authentication");
  else assert.equal(targetCalls.length, index + 1, "failed samples stop the journey, never retry");
  return ledger;
}

// Break caught: swallowing a failure by making every run return nonzero, or
// adding body-consumption time to the calibrated header-latency measurement.
test("healthy control: slow bodies do not change header timing or login count", (t) => {
  const result = runFixture(t, { bodyMs: 2_000 });
  settled(result);
  assert.equal(result.code, 0);
  const ledger = JSON.parse(result.files.json);
  assert.equal(ledger.verdict, "pass");
  assert.equal(result.calls.length, 12);
  const logins = result.calls.filter((c) => c.method === "POST");
  assert.deepEqual(
    logins.map((c) => c.path),
    ["/auth/qa/qa-member", "/auth/qa/qa-moderator"],
  );
  assert.ok(logins.every((c) => c.qa === qaCanary));
  for (const call of result.calls) {
    assert.equal(call.redirect, "manual", "the probe must not follow redirects to broader origins");
    if (call.method === "GET") assert.equal(call.cookie, `__Host-two_session=${cookieCanary}`);
  }
  for (const journey of ledger.journeys) {
    assert.deepEqual(journey.samples, [40, 40, 40, 40, 40]);
    assert.equal(journey.medianMs, 40);
  }
  secretFree(result);
});

test("healthy receipts use deterministic versioned sample IDs", (t) => {
  const first = runFixture(t);
  const second = runFixture(t);
  settled(first);
  assert.equal(first.code, 0);
  const ledger = receipt(first, "pass");
  assert.deepEqual(
    first.files,
    second.files,
    "same observations must produce byte-identical JSON and Markdown",
  );
  for (const journey of ledger.journeys) {
    assert.equal(journey.error, null);
    assert.ok(journey.measurements.every((m) => m.error === null && m.state === "measured"));
  }
});

test("early login failure receipts are byte-deterministic", (t) => {
  const config = { phase: "login", fault: "login-refused" };
  const first = runFixture(t, config);
  const second = runFixture(t, config);
  failedJourney(first, { phase: "login", code: "login_refused", retryable: false });
  assert.deepEqual(first.files, second.files);
});

for (const phase of ["login", "journey"]) {
  test(`${phase}: abort-ignoring fetch settles with transport_timeout`, (t) => {
    const result = runFixture(t, { phase, fault: "fetch-stall" });
    failedJourney(result, { phase, code: "transport_timeout", retryable: true, measured: false });
    const label = `member-rsvp:${phase === "login" ? "login" : "0"}`;
    assert.equal(result.signalsAtSettlement.find((s) => s.label === label)?.aborted, true);
  });

  test(`${phase}: raw transport exceptions become fixed, secret-free errors`, (t) => {
    const result = runFixture(t, { phase, fault: "fetch-reject" });
    secretFree(result);
    failedJourney(result, { phase, code: "transport_error", retryable: true, measured: false });
  });
}

for (const textOnly of [false, true]) {
  const kind = textOnly ? "text-only adapter" : "stream reader";
  test(`${kind}: stalled body cannot outlive the request deadline`, (t) => {
    const result = runFixture(t, { fault: "body-stall", textOnly });
    failedJourney(result, { code: "transport_timeout", retryable: true });
    assert.ok(
      result.disposalsAtSettlement.includes("member-rsvp:0"),
      "timeout must request nonblocking disposal",
    );
  });

  test(`${kind}: rejecting body returns body_read_failed, never raw text`, (t) => {
    const result = runFixture(t, { fault: "body-reject", textOnly });
    secretFree(result);
    failedJourney(result, { code: "body_read_failed", retryable: true });
  });

  test(`${kind}: UTF-8 oversize is refused even with authenticated HTML prefix`, (t) => {
    const result = runFixture(t, { fault: "oversize", textOnly });
    if (!textOnly)
      assert.ok(
        result.offeredBytes <= 1_048_576 + 32_768,
        "streaming cap must stop reads, not buffer the whole response",
      );
    failedJourney(result, { code: "body_too_large", retryable: false });
    assert.ok(result.disposalsAtSettlement.includes("member-rsvp:0"));
  });
}

// Break caught: allocating a fresh 15s timer for the body after a slow fetch.
test("one deadline covers delayed headers and an abort-ignoring body", (t) => {
  const result = runFixture(t, { fault: "headers-then-stall" });
  failedJourney(result, { code: "transport_timeout", retryable: true });
});

test("a body resolving after a slow header must not restart the deadline", (t) => {
  const result = runFixture(t, { fault: "headers-then-body-delay" });
  failedJourney(result, { code: "transport_timeout", retryable: true });
});

test("paired control: asynchronous body completion within the deadline stays measured", (t) => {
  const result = runFixture(t, { fault: "body-delay", headerMs: 40 });
  // Headers are immediate here: the body finishes at 14s, below the 15s cap.
  // This paired control prevents rejecting all asynchronous body reads.
  settled(result);
  assert.equal(result.code, 0);
  const ledger = JSON.parse(result.files.json);
  assert.deepEqual(ledger.journeys[0].samples, [40, 40, 40, 40, 40]);
});

for (const cleanup of ["throw", "reject", "stall"]) {
  test(`login refusal: ${cleanup}ing cleanup cannot suppress the receipt`, (t) => {
    const result = runFixture(t, { phase: "login", fault: "login-refused", cleanup });
    assert.ok(
      result.disposalsAtSettlement.includes("member-rsvp:login"),
      "refusal bodies must be disposed without being echoed",
    );
    failedJourney(result, { phase: "login", code: "login_refused", retryable: false });
  });

  test(`oversize: ${cleanup}ing cleanup is nonblocking and cannot leak`, (t) => {
    const result = runFixture(t, { fault: "oversize", cleanup });
    failedJourney(result, { code: "body_too_large", retryable: false });
    assert.ok(result.disposalsAtSettlement.includes("member-rsvp:0"));
  });
}

test("journey HTTP refusal disposes the body without waiting for cleanup", (t) => {
  const result = runFixture(t, { fault: "http-refused", cleanup: "stall" });
  settled(result);
  assert.equal(result.code, 1);
  assert.ok(result.disposalsAtSettlement.includes("member-rsvp:0"));
  const ledger = receipt(result);
  assert.equal(ledger.journeys[0].status, "failed");
  assert.equal(ledger.journeys[0].measurements[0].elapsedMs, 40);
});

for (const cleanup of ["throw", "reject", "stall"]) {
  test(`body-read failure tolerates ${cleanup}ing disposal`, (t) => {
    const result = runFixture(t, { fault: "body-reject", textOnly: true, cleanup });
    failedJourney(result, { code: "body_read_failed", retryable: true });
    assert.ok(result.disposalsAtSettlement.includes("member-rsvp:0"));
  });
}

test("missing login cookie emits unmeasured slots and fixed remediation", (t) => {
  const result = runFixture(t, { phase: "login", fault: "missing-cookie" });
  failedJourney(result, { phase: "login", code: "missing_cookie", retryable: false });
});

test("later login refusal preserves the already completed member journey", (t) => {
  const result = runFixture(t, {
    phase: "login",
    fault: "login-refused",
    targetId: "moderator-admin",
  });
  const ledger = failedJourney(result, {
    phase: "login",
    targetId: "moderator-admin",
    code: "login_refused",
    retryable: false,
  });
  assert.equal(ledger.journeys[0].status, "passed");
  assert.deepEqual(ledger.journeys[0].samples, [40, 40, 40, 40, 40]);
  assert.equal(ledger.journeys[0].medianMs, 40);
});

test("mid-journey transport failure keeps prior observations, not fake latency", (t) => {
  const result = runFixture(t, { fault: "fetch-reject", sampleIndex: 2 });
  const ledger = failedJourney(result, {
    code: "transport_error",
    retryable: true,
    index: 2,
    measured: false,
  });
  assert.deepEqual(ledger.journeys[0].samples, [40, 40]);
  assert.equal(ledger.journeys[0].medianMs, 40);
  assert.ok(ledger.journeys[0].measurements.slice(2).every((m) => m.state === "unmeasured"));
});

test("late abort-ignoring response is disposed and cannot rewrite the timeout", (t) => {
  const result = runFixture(t, { fault: "late-headers", cleanup: "reject" });
  failedJourney(result, { code: "transport_timeout", retryable: true, measured: false });
  assert.equal(result.lateResponse, true);
  assert.ok(
    result.disposals.includes("member-rsvp:0"),
    "a response arriving after timeout still needs disposal",
  );
});

test("untrusted response metadata cannot put canaries into failure output", (t) => {
  const result = runFixture(t, { fault: "bad-content-type" });
  secretFree(result);
  settled(result);
  assert.notEqual(result.code, 0);
  receipt(result);
});

// Break caught: misclassifying a real measured slowdown as a transport failure,
// or loosening the calibrated thresholds while fixing settlement.
for (const headerMs of [600, 1_001]) {
  test(`negative control: ${headerMs}ms headers still fail the existing budget`, (t) => {
    const result = runFixture(t, { headerMs });
    settled(result);
    assert.equal(result.code, 1);
    const ledger = JSON.parse(result.files.json);
    assert.equal(ledger.verdict, "fail");
    for (const journey of ledger.journeys) {
      assert.equal(journey.status, "failed");
      assert.deepEqual(journey.samples, Array(5).fill(headerMs));
      assert.equal(journey.medianMs, headerMs);
    }
    secretFree(result);
  });
}

for (const outputFault of ["directory", "json", "md"]) {
  test(`output obstruction (${outputFault}) returns a bounded fixed-code diagnostic`, (t) => {
    const result = runFixture(t, { outputFault });
    settled(result);
    assert.notEqual(result.code, 0);
    assert.match(result.output, /output_write_failed/);
    assert.ok(
      result.output.length <= 2_048,
      "write failure must not dump exception/stack/path data",
    );
    assert.doesNotMatch(result.output, /verdict: pass|ENOENT|EISDIR|ENOTDIR|at writeFileSync/);
    secretFree(result);
  });
}

function runCli(t, args) {
  const cwd = mkdtempSync(join(scratch, "auth-perf-cli-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const marker = join(cwd, "fetch-called");
  const preload = fileURLToPath(new URL("./fixtures/auth-perf-fetch-preload.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", preload, script, ...args], {
    cwd,
    env: {
      NODE_NO_WARNINGS: "1",
      AUTH_PERF_URL: "https://fixture.test",
      E2E_QA_TOKEN: qaCanary,
      AUTH_PERF_FETCH_MARKER: marker,
    },
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.signal, null, "non-live modes must finish, not hang");
  assert.ok(!result.error, "CLI must start cleanly");
  assert.equal(
    existsSync(marker),
    false,
    "fixture/dry-run/help/wrong flag combinations must never dispatch fetch",
  );
  for (const text of [result.stdout, result.stderr]) {
    for (const value of canaries) assert.ok(!text.includes(value));
  }
  return result;
}

test("--help is short, effect-free discovery of the hermetic check and repo procedure", (t) => {
  const result = runCli(t, ["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--selftest/);
  assert.match(result.stdout, /docs\/performance-budgets\.md/);
  assert.ok(result.stdout.length <= 6_000);
});

for (const args of [
  ["--selftest"],
  ["--dry-run"],
  ["--selftest", "--mutant", "no-cookie"],
  ["--dry-run", "--mutant", "no-cookie"],
  ["--selftes"],
  ["--mutant", "unknown"],
]) {
  test(`non-live CLI flags never fall through to probes: ${args.join(" ")}`, (t) => {
    const result = runCli(t, args);
    assert.ok(
      [0, 2].includes(result.status),
      "valid fixture mode succeeds; invalid combinations are usage refusals",
    );
    if (args[0] === "--selftest" && args.length === 1) assert.equal(result.status, 0);
  });
}

for (const env of [
  { AUTH_PERF_URL: "http://example.test" },
  { AUTH_PERF_URL: "ftp://example.test" },
  { AUTH_PERF_MUTANT: "unsupported" },
]) {
  test(`existing origin/mutant refusal makes zero fetches: ${JSON.stringify(env)}`, (t) => {
    const result = runFixture(t, { env });
    settled(result);
    assert.equal(result.code, 2);
    assert.deepEqual(result.calls, []);
  });
}
