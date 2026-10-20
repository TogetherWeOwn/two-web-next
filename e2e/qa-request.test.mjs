import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  fetchTokenRequest,
  parseSetCookie,
  qaLogin,
  sendTokenRequest,
  transportFailureReason,
} from "./qa-request.mjs";

// TOG-13046: the staging QA token must not reach a Playwright failure
// artifact. The canary stands in for the real token; it is never a secret.
const CANARY = "canary-QA-token-do-not-leak-9f3a";

// Shape of a Playwright 1.63 transport failure: the first line names the
// failure, the call log that follows carries the request headers.
function playwrightTransportError() {
  return new Error(
    [
      "apiRequestContext.post: socket hang up",
      "Call log:",
      "  - → POST https://next.togetherweown.com/auth/qa/qa-member",
      "  -   user-agent: Playwright/1.63.0",
      `  -   X-TWO-QA-Auth: ${CANARY}`,
      "  -   Origin: https://next.togetherweown.com",
    ].join("\n"),
  );
}

function everyErrorText(error) {
  const own = Object.getOwnPropertyNames(error).map((key) => String(error[key]));
  return [error.message, error.stack, String(error), ...own, JSON.stringify(error)];
}

test("a canary header in a transport error's call log does not survive", async () => {
  await assert.rejects(
    sendTokenRequest("staging QA login as qa-member", CANARY, () =>
      Promise.reject(playwrightTransportError()),
    ),
    (error) => {
      assert.equal(
        error.message,
        "staging QA login as qa-member failed: apiRequestContext.post: socket hang up",
      );
      assert.equal(error.cause, undefined);
      for (const text of everyErrorText(error)) {
        assert.ok(!text.includes(CANARY), "canary leaked into the rethrown error");
        assert.ok(!text.includes("Call log"), "call log leaked into the rethrown error");
        assert.ok(!text.includes("X-TWO-QA-Auth"), "request header leaked into the rethrown error");
      }
      return true;
    },
  );
});

test("a node error code is the whole reason", () => {
  const error = Object.assign(playwrightTransportError(), { code: "ECONNRESET" });
  assert.equal(transportFailureReason(error, CANARY), "ECONNRESET");
});

test("the token is scrubbed even from a one-line message or a code field", () => {
  assert.equal(
    transportFailureReason(new Error(`request failed with X-TWO-QA-Auth: ${CANARY}`), CANARY),
    "request failed with X-TWO-QA-Auth: [redacted]",
  );
  assert.equal(
    transportFailureReason(Object.assign(new Error("x"), { code: "TOKEN_ABC" }), "TOKEN_ABC"),
    "[redacted]",
  );
});

test("an unusable error value gives a generic reason", () => {
  for (const value of [undefined, null, "boom", 42, {}, new Error("")]) {
    assert.equal(transportFailureReason(value, CANARY), "request error");
  }
});

test("a long first line is bounded", () => {
  const reason = transportFailureReason(new Error("x".repeat(500)), CANARY);
  assert.equal(reason.length, 120);
});

test("a successful request passes its response through untouched", async () => {
  const response = { status: () => 204 };
  assert.equal(await sendTokenRequest("probe", CANARY, async () => response), response);
});

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRUB = join(REPO_ROOT, "ci", "scrub-qa-token.py");
const PLAYWRIGHT_CLI = join(REPO_ROOT, "node_modules", "playwright", "cli.js");

function sweep(token, ...dirs) {
  return spawnSync("python3", [SCRUB, ...dirs], {
    env: { PATH: process.env.PATH, ...(token === undefined ? {} : { QA_AUTH_TOKEN: token }) },
    encoding: "utf8",
  });
}

// The workflow uploads only when the sweep wrote `swept=true` to GITHUB_OUTPUT.
function sweepWithOutput(token, ...dirs) {
  const dir = mkdtempSync(join(tmpdir(), "scrub-qa-output-"));
  const output = join(dir, "output");
  writeFileSync(output, "");
  try {
    const run = spawnSync("python3", [SCRUB, ...dirs], {
      env: { PATH: process.env.PATH, QA_AUTH_TOKEN: token, GITHUB_OUTPUT: output },
      encoding: "utf8",
    });
    return { run, output: readFileSync(output, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Real Playwright output for a failing spec, no browser needed. The spec makes
// a token-bearing request to a closed port, so its error text carries the
// request headers (the real failure), records a standalone request trace, and
// rethrows. That leaves the token in the places the sweep must reach: the
// html report's embedded data zip, a trace zip, and plain error files.
function realFailureArtifacts(token) {
  const root = mkdtempSync(join(tmpdir(), "scrub-qa-token-"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(
    join(root, "playwright.config.mjs"),
    `import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "canary.spec.mjs",
  outputDir: "test-results",
  retries: 0,
  reporter: [["html", { open: "never", outputFolder: "playwright-report" }]],
});
`,
  );
  writeFileSync(
    join(root, "canary.spec.mjs"),
    `import { test, request } from "@playwright/test";
test("canary", async ({}, testInfo) => {
  const context = await request.newContext();
  await context.tracing.start();
  let failure;
  try {
    await context.post("http://127.0.0.1:1/auth/qa/qa-member", {
      headers: { "X-TWO-QA-Auth": process.env.CANARY },
    });
  } catch (error) {
    failure = error;
  }
  await context.tracing.stop({ path: testInfo.outputPath("trace.zip") });
  await context.dispose();
  throw failure;
});
`,
  );
  const run = spawnSync(process.execPath, [PLAYWRIGHT_CLI, "test", "-c", "playwright.config.mjs"], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CANARY: token },
    encoding: "utf8",
  });
  assert.equal(run.status, 1, `the canary spec must fail:\n${run.stdout}\n${run.stderr}`);
  return {
    root,
    results: join(root, "test-results"),
    report: join(root, "playwright-report"),
  };
}

// Only a real Playwright run proves the report really hides the token in its
// embedded zip rather than in plain text, so a grep of index.html finds nothing.
test("a real failing run keeps the token out of a plain-text search of index.html", () => {
  const { root, report } = realFailureArtifacts(CANARY);
  try {
    assert.ok(!readFileSync(join(report, "index.html"), "latin1").includes(CANARY));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the sweep removes the report whose embedded zip holds the token", () => {
  const { root, report } = realFailureArtifacts(CANARY);
  try {
    const only = join(root, "only-report");
    mkdirSync(only);
    copyFileSync(join(report, "index.html"), join(only, "index.html"));
    const run = sweep(CANARY, only);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /removed .*index\.html \(embedded archive member /);
    assert.ok(!run.stdout.includes(CANARY) && !run.stderr.includes(CANARY), "token printed");
    assert.deepEqual(readdirSync(only), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the sweep removes a trace zip whose members hold the token", () => {
  const { root, results } = realFailureArtifacts(CANARY);
  try {
    const only = join(root, "only-trace");
    mkdirSync(only);
    copyFileSync(join(results, "canary-canary", "trace.zip"), join(only, "trace.zip"));
    const run = sweep(CANARY, only);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /removed .*trace\.zip \(archive member /);
    assert.ok(!run.stdout.includes(CANARY) && !run.stderr.includes(CANARY), "token printed");
    assert.deepEqual(readdirSync(only), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the sweep leaves a whole real artifact tree token-free, loudly, and keeps clean files", () => {
  const { root, results, report } = realFailureArtifacts(CANARY);
  try {
    const run = sweep(CANARY, results, report);
    assert.equal(run.status, 1, run.stderr);
    assert.ok(!run.stdout.includes(CANARY) && !run.stderr.includes(CANARY), "token printed");
    assert.match(run.stdout, /::error::QA_AUTH_TOKEN was found in \d+ failure artifact file\(s\)/);
    assert.ok(!existsSync(join(report, "index.html")), "index.html left behind");
    assert.ok(!existsSync(join(results, "canary-canary", "trace.zip")), "trace.zip left behind");
    // What survives holds no token the sweep can read.
    const rerun = sweep(CANARY, results, report);
    assert.equal(rerun.status, 0, rerun.stderr);
    // `.last-run.json` never held it, so it stays.
    assert.ok(existsSync(join(results, ".last-run.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a sweep for a different token passes and changes nothing", () => {
  const { root, results, report } = realFailureArtifacts(CANARY);
  try {
    const before = readdirSync(report, { recursive: true }).sort();
    assert.equal(sweep("a-different-staging-token-7c41", results, report).status, 0);
    assert.deepEqual(readdirSync(report, { recursive: true }).sort(), before);
    assert.ok(existsSync(join(results, "canary-canary", "trace.zip")));
    // A missing directory is not an error: a failed run may not have produced it.
    assert.equal(sweep(CANARY, join(root, "absent")).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a finished sweep marks the tree swept, a sweep that cannot remove a file does not", {
  skip: process.getuid?.() === 0 ? "root can remove files from a read-only directory" : false,
}, () => {
  const { root, results, report } = realFailureArtifacts(CANARY);
  try {
    const hit = sweepWithOutput(CANARY, results, report);
    assert.equal(hit.run.status, 1, hit.run.stderr);
    assert.equal(hit.output, "swept=true\n");
    assert.equal(sweepWithOutput(CANARY, results, report).output, "swept=true\n");

    const stuck = join(root, "stuck");
    mkdirSync(stuck);
    writeFileSync(join(stuck, "leak.md"), CANARY);
    chmodSync(stuck, 0o555);
    try {
      const refused = sweepWithOutput(CANARY, stuck);
      assert.equal(refused.run.status, 2, refused.run.stderr);
      assert.equal(refused.output, "", "an unswept tree must not be marked swept");
      assert.ok(!refused.run.stdout.includes(CANARY) && !refused.run.stderr.includes(CANARY));
    } finally {
      chmodSync(stuck, 0o755);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty or unset token never sweeps (an empty pattern matches every file)", () => {
  const { root, results, report } = realFailureArtifacts(CANARY);
  try {
    for (const token of ["", undefined]) {
      assert.equal(sweep(token, results, report).status, 0);
    }
    assert.ok(existsSync(join(report, "index.html")));
    assert.ok(existsSync(join(results, "canary-canary", "trace.zip")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The token must never pass through Playwright at all: Playwright traces
// record `APIRequestContext.fetch` call params (headers verbatim) for every
// context created during a run, including a standalone `chromium.launch()`
// context and the `request` fixture, so sanitizing a caught error is not
// enough — under a hook/test timeout the pending call is already in the
// retained trace. The login therefore travels over Node `fetch`, which
// Playwright does not instrument. The synthetic canary and loopback servers
// below stand in for staging; no live token or staging host is touched.

const SESSION_COOKIE =
  "__Host-two_session=synthetic-session-value; Path=/; Max-Age=7200; HttpOnly; Secure; SameSite=Lax";

// A loopback stand-in for POST /auth/qa/:identity. Known identities answer
// 204 with the session cookies when the canary header arrives, anything else
// is the byte-identical 404 the real route gives a bad token or unknown
// identity. `throttleOnce` makes the first member login answer 429 with a
// one-second Retry-After so the bounded retry is exercised quickly.
function loopbackQaServer({ throttleOnce = false } = {}) {
  const seen = { logins: 0, tokens: [] };
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/auth/qa/")) {
      seen.tokens.push(req.headers["x-two-qa-auth"]);
      const identity = req.url.slice("/auth/qa/".length);
      if (
        !["qa-member", "qa-moderator"].includes(identity) ||
        req.headers["x-two-qa-auth"] !== CANARY
      ) {
        res.writeHead(404);
        res.end();
        return;
      }
      seen.logins += 1;
      if (throttleOnce && seen.logins === 1) {
        res.writeHead(429, { "Retry-After": "1" });
        res.end();
        return;
      }
      res.writeHead(204, {
        "Set-Cookie": [
          SESSION_COOKIE,
          "__Host-two_session_status=synthetic-status; Path=/; Max-Age=7200; HttpOnly; Secure; SameSite=Lax",
        ],
      });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  return { server, seen };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function shutDown(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

test("parseSetCookie keeps the storage-state fields Playwright persists", () => {
  const cookie = parseSetCookie(SESSION_COOKIE, "http://127.0.0.1:1234");
  assert.equal(cookie.name, "__Host-two_session");
  assert.equal(cookie.value, "synthetic-session-value");
  assert.equal(cookie.domain, "127.0.0.1");
  assert.equal(cookie.path, "/");
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.sameSite, "Lax");
  assert.ok(cookie.expires > Math.floor(Date.now() / 1000), "Max-Age must become an expiry");
  assert.equal(parseSetCookie("not-a-cookie", "http://127.0.0.1:1234"), null);
});

test("qaLogin over fetch returns the session storage state and honors one 429 retry", async () => {
  const { server, seen } = loopbackQaServer({ throttleOnce: true });
  const origin = await listen(server);
  try {
    const state = await qaLogin({
      origin,
      identity: "qa-member",
      token: CANARY,
      header: "X-TWO-QA-Auth",
    });
    assert.equal(seen.logins, 2, "the 429 attempt and the retry both reach the route");
    assert.deepEqual(seen.tokens, [CANARY, CANARY], "every attempt carries the token header");
    const session = state.cookies.find((cookie) => cookie.name === "__Host-two_session");
    assert.ok(session, "the session cookie is persisted");
    assert.equal(session.httpOnly, true);
    assert.equal(session.secure, true);
    assert.equal(session.domain, "127.0.0.1");
    assert.ok(
      state.cookies.some((cookie) => cookie.name === "__Host-two_session_status"),
      "the status cookie the route also sets is persisted",
    );
    assert.deepEqual(state.origins, []);
  } finally {
    await shutDown(server);
  }
});

test("qaLogin rejects a 404 and a dead port without the token in the error", async () => {
  const { server } = loopbackQaServer();
  const origin = await listen(server);
  try {
    await assert.rejects(
      qaLogin({ origin, identity: "no-such-identity", token: CANARY, header: "X-TWO-QA-Auth" }),
      (error) => {
        assert.ok(!error.message.includes(CANARY), "canary leaked into the status error");
        return true;
      },
    );
  } finally {
    await shutDown(server);
  }
  await assert.rejects(
    fetchTokenRequest(
      "staging QA login as qa-member",
      CANARY,
      "http://127.0.0.1:1/auth/qa/qa-member",
      {
        method: "POST",
        headers: { "X-TWO-QA-Auth": CANARY },
      },
    ),
    (error) => {
      assert.ok(!error.message.includes(CANARY), "canary leaked into the transport error");
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

// Real Playwright run, no browser: the `request` fixture is traced, so a
// token sent through Playwright lands in the retained trace (the old capture
// path), while the fetch-based login must leave every decompressed trace,
// report and JSON payload canary-free. A harmless traced request to a marker
// path proves tracing was actually recording, so the absence is not vacuous.
test("a real run keeps the canary out of retained traces across hook timeout, failure and test timeout", async () => {
  const ok = loopbackQaServer();
  const okOrigin = await listen(ok.server);
  const hang = createServer(() => {});
  const hangOrigin = await listen(hang);
  const root = mkdtempSync(join(tmpdir(), "qa-trace-capture-"));
  try {
    symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
    const qaRequestUrl = pathToFileURL(join(REPO_ROOT, "e2e", "qa-request.mjs")).href;
    writeFileSync(
      join(root, "playwright.config.mjs"),
      `import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  outputDir: "test-results",
  workers: 1,
  retries: 0,
  timeout: 4_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }], ["json", { outputFile: "results.json" }]],
  use: { trace: "retain-on-failure" },
});
`,
    );
    writeFileSync(
      join(root, "hook.spec.mjs"),
      `import { test, expect } from "@playwright/test";
import { qaLogin } from ${JSON.stringify(qaRequestUrl)};
// The profile incident shape: the beforeAll login is still in flight when
// the hook timeout fires and the trace is retained.
test.beforeAll(async () => {
  await qaLogin({ origin: process.env.HANG_ORIGIN, identity: "qa-member", token: process.env.CANARY, header: "X-TWO-QA-Auth" });
});
test("never runs", async () => {
  expect(true).toBe(true);
});
`,
    );
    writeFileSync(
      join(root, "body.spec.mjs"),
      `import { test, expect } from "@playwright/test";
import { fetchTokenRequest, qaLogin } from ${JSON.stringify(qaRequestUrl)};

test("login and probes succeed, then a plain failure retains the trace", async ({ request }) => {
  const state = await qaLogin({ origin: process.env.OK_ORIGIN, identity: "qa-member", token: process.env.CANARY, header: "X-TWO-QA-Auth" });
  expect(state.cookies.some((cookie) => cookie.name === "__Host-two_session")).toBe(true);
  const probe = await fetchTokenRequest("staging QA unknown-identity probe", process.env.CANARY, process.env.OK_ORIGIN + "/auth/qa/no-such-identity", {
    method: "POST",
    headers: { "X-TWO-QA-Auth": process.env.CANARY, Origin: process.env.OK_ORIGIN },
  });
  expect(probe.status).toBe(404);
  // A harmless request through Playwright, so the retained trace provably
  // recorded traced traffic while the token stayed out of it.
  await request.get(process.env.OK_ORIGIN + "/marker-path");
  expect("retain").toBe("trace");
});

test("a token probe still in flight at the test timeout stays out of the trace", async () => {
  await fetchTokenRequest("staging QA login as qa-member", process.env.CANARY, process.env.HANG_ORIGIN + "/auth/qa/qa-member", {
    method: "POST",
    headers: { "X-TWO-QA-Auth": process.env.CANARY, Origin: process.env.HANG_ORIGIN },
  });
});
`,
    );
    // Async spawn: the loopback servers live in this process, so a
    // spawnSync would freeze them mid-run and every fetch would hang.
    const run = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [PLAYWRIGHT_CLI, "test", "-c", "playwright.config.mjs"],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            CANARY,
            OK_ORIGIN: okOrigin,
            HANG_ORIGIN: hangOrigin,
          },
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(run.status, 1, `the capture specs must fail:\n${run.stdout}\n${run.stderr}`);
    assert.ok(
      !run.stdout.includes(CANARY) && !run.stderr.includes(CANARY),
      "canary printed by the run",
    );
    // The login and probe really executed against the loopback route during
    // the run (the hang-server calls never arrive anywhere countable).
    assert.ok(
      ok.seen.tokens.length >= 2,
      "the run never sent the token, so the scan would be vacuous",
    );
    assert.ok(ok.seen.tokens.every((token) => token === CANARY));
    const traces = readdirSync(join(root, "test-results"), { recursive: true }).filter((path) =>
      String(path).endsWith("trace.zip"),
    );
    assert.ok(
      traces.length >= 3,
      `expected a retained trace per failed test, got ${traces.length}`,
    );
    // Decompress everything the way a reader of the public artifact would:
    // raw bytes, zip members and the report's embedded zip, across traces,
    // the HTML report and the JSON results — before any scrub runs.
    const scan = spawnSync(
      "python3",
      [
        "-c",
        `
import base64, binascii, io, os, re, sys, zipfile
needles = {name: os.environ[name].encode() for name in ("CANARY", "MARKER")}
EMBEDDED = re.compile(rb"data:application/zip;base64,([A-Za-z0-9+/=\\s]+)")
def zip_hits(data, depth=0):
    found = []
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        for info in archive.infolist():
            if info.is_dir(): continue
            member = archive.read(info)
            for name, needle in needles.items():
                if needle in member: found.append((name, info.filename))
            if depth < 4 and member.startswith(b"PK\\x03\\x04"):
                found += zip_hits(member, depth + 1)
    except Exception:
        pass
    return found
for top in sys.argv[1:]:
    paths = [top] if os.path.isfile(top) else [
        os.path.join(root, name) for root, _dirs, names in os.walk(top) for name in sorted(names)
    ]
    for path in paths:
        data = open(path, "rb").read()
        for name, needle in needles.items():
            if needle in data: print(f"HIT {name} {path} (raw)")
        if data.startswith(b"PK\\x03\\x04"):
            for name, member in zip_hits(data): print(f"HIT {name} {path} (zip member {member})")
        for match in EMBEDDED.finditer(data):
            try: blob = base64.b64decode(re.sub(rb"\\s", b"", match.group(1)))
            except binascii.Error: continue
            for name, member in zip_hits(blob): print(f"HIT {name} {path} (embedded zip member {member})")
`,
        join(root, "test-results"),
        join(root, "playwright-report"),
        join(root, "results.json"),
      ],
      { env: { PATH: process.env.PATH, CANARY, MARKER: "marker-path" }, encoding: "utf8" },
    );
    assert.equal(scan.status, 0, scan.stderr);
    const hits = scan.stdout.split("\n").filter(Boolean);
    assert.deepEqual(
      hits.filter((hit) => hit.startsWith("HIT CANARY")),
      [],
      `the canary reached a failure artifact before any scrub:\n${hits.join("\n")}`,
    );
    assert.ok(
      hits.some(
        (hit) =>
          hit.startsWith("HIT MARKER") &&
          hit.includes("trace.zip") &&
          /zip member .*trace\.(trace|network)/.test(hit),
      ),
      `tracing recorded no traced traffic, so the canary absence would be vacuous:\n${hits.join("\n")}`,
    );
    // Defense in depth still agrees the tree is clean, and keeps the traces.
    const sweepRun = sweep(CANARY, join(root, "test-results"), join(root, "playwright-report"));
    assert.equal(sweepRun.status, 0, sweepRun.stderr);
    assert.equal(
      readdirSync(join(root, "test-results"), { recursive: true }).filter((path) =>
        String(path).endsWith("trace.zip"),
      ).length,
      traces.length,
      "the sweep must not need to remove a trace",
    );
  } finally {
    await shutDown(ok.server);
    await shutDown(hang);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the sweep runs on failure, before the upload, with the token in its own env", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/e2e-staging.yml", import.meta.url),
    "utf8",
  );
  const steps = workflow.split(/\n {6}- /).slice(1);
  const scrub = steps.findIndex((step) => step.includes("ci/scrub-qa-token.py"));
  const upload = steps.findIndex((step) => step.includes("actions/upload-artifact"));
  assert.ok(scrub >= 0 && upload >= 0 && scrub < upload, "sweep must precede the upload");
  assert.match(steps[scrub], /\n\s+id: scrub\n/);
  assert.match(steps[scrub], /\n\s+if: failure\(\)\n/);
  assert.match(steps[scrub], /python3 ci\/scrub-qa-token\.py test-results playwright-report\n/);
  assert.match(steps[scrub], /env:\n\s+QA_AUTH_TOKEN: \$\{\{ secrets\.QA_AUTH_TOKEN \}\}/);
  // A sweep that crashed or could not delete a file leaves no `swept` output,
  // and then nothing is uploaded.
  assert.match(steps[upload], /\n\s+if: failure\(\) && steps\.scrub\.outputs\.swept == 'true'\n/);
  // Sweep both source trees, but publish only the derived ledger: raw reports,
  // HTML reports and traces may contain cookies or member data.
  assert.match(steps[scrub], /test-results playwright-report/);
  const uploads = steps.filter((step) => step.includes("actions/upload-artifact"));
  assert.equal(uploads.length, 2, "both ledger artifact paths must be checked");
  for (const uploadStep of uploads) {
    assert.match(uploadStep, /staging-journey-ledger\.json/);
    assert.match(uploadStep, /staging-journey-ledger\.md/);
    assert.doesNotMatch(uploadStep, /staging-journeys\.json|playwright-report\/|trace\.zip|\.html/);
    const pathBlock = uploadStep.match(/\n {10}path: \|\n([\s\S]*?)(?=\n {0,10}\S|$)/)?.[1];
    assert.ok(pathBlock, "upload must use an explicit path list");
    assert.deepEqual(
      pathBlock
        .split("\n")
        .map((path) => path.trim())
        .filter(Boolean),
      ["test-results/staging-journey-ledger.json", "test-results/staging-journey-ledger.md"],
      "both uploads must exclude every raw directory, extra file and glob",
    );
  }
});
