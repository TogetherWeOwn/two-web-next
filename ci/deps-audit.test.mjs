import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { gunzipSync, gzipSync, deflateSync, deflateRawSync, brotliCompressSync } from "node:zlib";
import registry from "./deps-audit-registry.cjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditOneLockfile,
  evaluateAudit,
  isOutageTolerantEvent,
  RegistryTransportExhausted,
} from "./deps-audit.mjs";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/deps-audit/${name}.json`, import.meta.url), "utf8"));
const empty = { version: 1, exceptions: [] };
const today = "2026-09-30";
const evaluate = (report, allowlist = empty) => evaluateAudit(report, allowlist, today);
const validException = () => {
  const allowlist = fixture("expired-allowlist");
  allowlist.exceptions[0].expires = "2026-10-01";
  return allowlist;
};

test("clean fixture passes", () => {
  assert.deepEqual(evaluate(fixture("clean")), { blocked: [], allowed: [], nonBlocking: [] });
});

test("high fixture blocks", () => {
  assert.equal(evaluate(fixture("high")).blocked[0].severity, "high");
});

test("critical blocks; info, low and moderate do not", () => {
  for (const severity of ["info", "low", "moderate", "critical"]) {
    const report = fixture("high");
    report.vulnerabilities["fixture-package"].severity = severity;
    report.vulnerabilities["fixture-package"].via[0].severity = severity;
    report.metadata.vulnerabilities.high = 0;
    report.metadata.vulnerabilities[severity] = 1;
    assert.equal(evaluate(report).blocked.length, severity === "critical" ? 1 : 0);
  }
});

test("unknown fixture and unknown or missing package severity fail closed", () => {
  assert.throws(() => evaluate(fixture("unknown")), /count/);
  for (const severity of ["unrated", undefined]) {
    const report = fixture("high");
    report.vulnerabilities["fixture-package"].severity = severity;
    assert.throws(() => evaluate(report, validException()), /Unknown package severity/);
  }
});

test("advisory severity cannot be hidden by the package severity", () => {
  const report = fixture("high");
  report.vulnerabilities["fixture-package"].severity = "moderate";
  report.metadata.vulnerabilities.high = 0;
  report.metadata.vulnerabilities.moderate = 1;
  assert.equal(evaluate(report).blocked[0].severity, "high");
  report.vulnerabilities["fixture-package"].via[0].severity = "unrated";
  assert.equal(evaluate(report, validException()).blocked[0].severity, "unknown");
});

test("dated exception only permits the exact package, range, severity and advisories", () => {
  assert.equal(evaluate(fixture("high"), validException()).allowed.length, 1);
  for (const [key, value] of [
    ["package", "another-package"],
    ["range", "<3.0.0"],
    ["severity", "critical"],
    ["advisoryIds", [100002]],
  ]) {
    const allowlist = validException();
    allowlist.exceptions[0][key] = value;
    assert.equal(evaluate(fixture("high"), allowlist).blocked.length, 1);
  }
});

test("expired fixture blocks, including the expiry day and unused exceptions", () => {
  assert.throws(() => evaluate(fixture("high"), fixture("expired-allowlist")), /Expired/);
  assert.throws(() => evaluate(fixture("clean"), fixture("expired-allowlist")), /Expired/);
});

test("invalid dates, future review, missing reason, duplicates and unknown exemptions fail closed", () => {
  for (const [key, value] of [
    ["reviewed", "2026-10-01"],
    ["expires", "2026-02-30"],
    ["reason", " "],
    ["severity", "unknown"],
    ["advisoryIds", []],
  ]) {
    const allowlist = validException();
    allowlist.exceptions[0][key] = value;
    assert.throws(() => evaluate(fixture("high"), allowlist));
  }
  const duplicate = validException();
  duplicate.exceptions.push({ ...duplicate.exceptions[0] });
  assert.throws(() => evaluate(fixture("high"), duplicate), /Duplicate/);
  assert.throws(() => evaluate(fixture("clean"), {}), /allowlist/);
});

test("transitive advisories require their own exception and new IDs invalidate it", () => {
  const report = fixture("high");
  report.vulnerabilities.parent = {
    name: "parent",
    range: "*",
    severity: "high",
    via: ["fixture-package"],
  };
  report.metadata.vulnerabilities.total = 2;
  report.metadata.vulnerabilities.high = 2;
  const allowlist = validException();
  assert.deepEqual(
    evaluate(report, allowlist).blocked.map((v) => v.package),
    ["parent"],
  );
  allowlist.exceptions.push({ ...allowlist.exceptions[0], package: "parent", range: "*" });
  assert.equal(evaluate(report, allowlist).blocked.length, 0);
  report.vulnerabilities["fixture-package"].via.push({ source: 100002, severity: "high" });
  assert.equal(evaluate(report, allowlist).blocked.length, 2);
});

test("valid cycles preserve low/moderate policy and exact high/critical exceptions", () => {
  for (const severity of ["low", "moderate", "high", "critical"]) {
    const report = fixture("clean");
    report.vulnerabilities = {
      "fixture-a": {
        name: "fixture-a",
        range: "1.0.0",
        severity,
        via: [{ source: 100001, severity }, "fixture-b"],
      },
      "fixture-b": { name: "fixture-b", range: "1.0.0", severity, via: ["fixture-a"] },
    };
    report.metadata.vulnerabilities[severity] = 2;
    report.metadata.vulnerabilities.total = 2;
    const result = evaluate(report);
    if (["low", "moderate"].includes(severity)) {
      assert.deepEqual(result.nonBlocking, ["fixture-a", "fixture-b"]);
      assert.equal(result.blocked.length, 0);
      continue;
    }
    assert.deepEqual(
      result.blocked.map((finding) => finding.advisoryIds),
      [[100001], [100001]],
    );
    const allowlist = {
      version: 1,
      exceptions: ["fixture-a", "fixture-b"].map((name) => ({
        ...validException().exceptions[0],
        package: name,
        range: "1.0.0",
        severity,
      })),
    };
    assert.equal(evaluate(report, allowlist).allowed.length, 2);
    assert.equal(
      evaluate(report, { ...allowlist, exceptions: allowlist.exceptions.slice(0, 1) }).blocked[0]
        .package,
      "fixture-b",
    );
    report.vulnerabilities["fixture-b"].via.push({ source: 100002, severity });
    assert.equal(evaluate(report, allowlist).blocked.length, 2);
    report.vulnerabilities["fixture-b"].via[1].severity = "unrated";
    assert.deepEqual(
      evaluate(report, allowlist).blocked.map((finding) => finding.severity),
      ["unknown", "unknown"],
    );
  }
});

test("shared cyclic descendants are visited once per root without recursion", () => {
  const report = fixture("clean");
  // Repeated diamond paths previously caused exponential recursive expansion.
  const length = 120;
  for (let i = 0; i < length; i++) {
    const name = `package-${i}`;
    report.vulnerabilities[name] = {
      name,
      range: "*",
      severity: "low",
      via:
        i === length - 1
          ? [{ source: 100001, severity: "high" }, "package-0"]
          : [...new Set([`package-${i + 1}`, `package-${Math.min(i + 2, length - 1)}`])],
    };
  }
  report.metadata.vulnerabilities.low = length;
  report.metadata.vulnerabilities.total = length;
  const result = evaluate(report);
  assert.equal(result.blocked.length, length);
  assert.ok(
    result.blocked.every(
      (finding) => finding.severity === "high" && finding.advisoryIds.length === 1,
    ),
  );
});

test("malformed reports, registry errors, count mismatches and bad via references fail closed", () => {
  for (const report of [
    {},
    [],
    { error: { code: "E401" } },
    { ...fixture("clean"), auditReportVersion: 1 },
    { ...fixture("clean"), metadata: { vulnerabilities: { total: 1 } } },
  ]) {
    assert.throws(() => evaluate(report));
  }
  for (const via of [[], ["missing"], ["fixture-package"], [{}]]) {
    const report = fixture("high");
    report.vulnerabilities["fixture-package"].via = via;
    assert.throws(() => evaluate(report));
  }
});

test("every severity counter and total must be a non-negative safe integer", () => {
  for (const key of ["info", "low", "moderate", "high", "critical", "total"]) {
    for (const value of [
      undefined,
      null,
      "0",
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      NaN,
      Infinity,
    ]) {
      const report = fixture("clean");
      report.metadata.vulnerabilities[key] = value;
      assert.throws(() => evaluate(report), /counter/, `${key}: ${String(value)}`);
    }
  }
});

test("severity counters must reconcile with total and individual package records", () => {
  const critical = fixture("clean");
  critical.metadata.vulnerabilities.critical = 1;
  assert.throws(() => evaluate(critical), /count/);

  const swapped = fixture("high");
  swapped.metadata.vulnerabilities = {
    info: 0,
    low: 1,
    moderate: 0,
    high: 0,
    critical: 0,
    total: 1,
  };
  assert.throws(() => evaluate(swapped, validException()), /count/);

  const unexpected = fixture("clean");
  unexpected.metadata.vulnerabilities.unrated = 0;
  assert.throws(() => evaluate(unexpected), /counter/);
});

test("raw bulk schema accepts clean data but rejects missing/defaultable policy fields", () => {
  const advisory = { id: 100001, severity: "high", vulnerable_versions: "<4.17.21" };
  assert.ok(registry.validBulk({}));
  assert.ok(registry.validBulk({ lodash: [] }));
  for (const severity of ["info", "low", "moderate", "high", "critical"]) {
    assert.ok(registry.validBulk({ lodash: [{ ...advisory, severity }] }));
  }
  for (const value of [
    null,
    [],
    false,
    "clean",
    { lodash: null },
    { lodash: {} },
    { lodash: [null] },
  ]) {
    assert.equal(registry.validBulk(value), false);
  }
  for (const [key, value] of [
    ["id", undefined],
    ["id", "100001"],
    ["id", 0],
    ["id", 1.5],
    ["id", Number.MAX_SAFE_INTEGER + 1],
    ["severity", undefined],
    ["severity", null],
    ["severity", ""],
    ["severity", "unrated"],
    ["vulnerable_versions", undefined],
    ["vulnerable_versions", " "],
    ["vulnerable_versions", []],
    ["name", "wrong-package"],
  ]) {
    assert.equal(registry.validBulk({ lodash: [{ ...advisory, [key]: value }] }), false);
  }
});

async function withRegistry(run) {
  const dir = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "deps-audit-online space-",
    ),
  );
  const bulkBodies = [];
  const advisory = { severity: "high" };
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/-/npm/v1/security/advisories/bulk") {
      if (advisory.stallBulk) return;
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const requestBody = Buffer.concat(chunks);
      bulkBodies.push(
        JSON.parse(
          request.headers["content-encoding"] === "gzip" ? gunzipSync(requestBody) : requestBody,
        ),
      );
      const payload = Object.hasOwn(advisory, "response")
        ? advisory.response
        : {
            lodash: [
              {
                id: 100001,
                title: "Fixture advisory",
                url: "https://example.invalid/advisory/100001",
                severity: advisory.severity,
                vulnerable_versions: "<4.17.21",
                cwe: [],
                cvss: { score: 7.5, vectorString: null },
              },
            ],
          };
      let body = Buffer.from(advisory.raw ?? JSON.stringify(payload));
      if (advisory.encoding) {
        const compressors = {
          gzip: gzipSync,
          "x-gzip": gzipSync,
          deflate: deflateSync,
          "x-deflate": deflateRawSync,
          br: brotliCompressSync,
        };
        body = compressors[advisory.encoding](body);
        response.setHeader("Content-Encoding", advisory.encoding);
      }
      response.statusCode = advisory.status ?? 200;
      if (advisory.status === 302) response.setHeader("Location", "/redirected-advisories");
      if (advisory.truncated) {
        response.setHeader("Content-Length", body.length + 1);
        response.setHeader("Connection", "close");
      }
      response.write(body.subarray(0, Math.ceil(body.length / 2)));
      response.end(body.subarray(Math.ceil(body.length / 2)));
    } else if (request.url === "/redirected-advisories") {
      response.end("{}");
    } else if (request.url === "/lodash") {
      if (advisory.stallMetadata) return;
      response.end(
        JSON.stringify({
          name: "lodash",
          "dist-tags": { latest: "4.17.21" },
          versions: {
            "4.17.20": { name: "lodash", version: "4.17.20" },
            "4.17.21": { name: "lodash", version: "4.17.21" },
          },
        }),
      );
    } else {
      response.writeHead(404);
      response.end("{}");
    }
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const registry = `http://127.0.0.1:${server.address().port}`;
    mkdirSync(join(dir, "ci"));
    copyFileSync(new URL("./deps-audit.mjs", import.meta.url), join(dir, "ci/deps-audit.mjs"));
    copyFileSync(
      new URL("./deps-audit-registry.cjs", import.meta.url),
      join(dir, "ci/deps-audit-registry.cjs"),
    );
    writeFileSync(join(dir, "ci/deps-audit-allowlist.json"), JSON.stringify(empty));
    const lockfilePackages = (name) => ({
      name,
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name, version: "1.0.0", dependencies: { lodash: "4.17.20" } },
        "node_modules/lodash": {
          version: "4.17.20",
          resolved: `${registry}/lodash/-/lodash-4.17.20.tgz`,
        },
      },
    });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "audit-regression",
        version: "1.0.0",
        dependencies: { lodash: "4.17.20" },
      }),
    );
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify(lockfilePackages("audit-regression")),
    );
    mkdirSync(join(dir, "web"));
    writeFileSync(
      join(dir, "web/package.json"),
      JSON.stringify({
        name: "audit-regression-web",
        version: "1.0.0",
        dependencies: { lodash: "4.17.20" },
      }),
    );
    writeFileSync(
      join(dir, "web/package-lock.json"),
      JSON.stringify(lockfilePackages("audit-regression-web")),
    );
    // npm's environment and .npmrc both enable the bypass without a CLI override.
    writeFileSync(
      join(dir, ".npmrc"),
      `offline=true\nregistry=${registry}\ncache=${join(dir, "cache")}\n`,
    );
    const env = {
      ...process.env,
      npm_config_registry: registry,
      npm_config_cache: join(dir, "cache"),
    };
    delete env.npm_config_offline;
    delete env.NPM_CONFIG_OFFLINE;
    // Hermetic event default: a CI runner's GITHUB_EVENT_NAME must not flip
    // bare gate() calls onto the outage-tolerant path. Explicit per-call
    // overrides still apply (execute spreads them after this base env).
    delete env.GITHUB_EVENT_NAME;
    const execute = async (command, args, overrides = {}) => {
      const child = spawn(command, args, {
        cwd: dir,
        env: { ...env, ...overrides },
        // Transport cases exhaust 3 gate attempts per lockfile (5s+15s backoff
        // each); fast cases are unaffected by the headroom.
        timeout: 120_000,
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const [status] = await once(child, "close");
      assert.ok([0, 1].includes(status), stderr || stdout);
      return { status, stdout, stderr };
    };
    await run({
      advisory,
      bulkBodies,
      setAllowlist: (allowlist) =>
        writeFileSync(join(dir, "ci/deps-audit-allowlist.json"), JSON.stringify(allowlist)),
      gate: (overrides) => execute(process.execPath, [join(dir, "ci/deps-audit.mjs")], overrides),
      // Real npm and preload; only the exported timeout/backoff seams are shortened.
      oneAudit: (timeoutMs = 10_000) =>
        execute(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
        import { auditOneLockfile, RegistryTransportExhausted } from './ci/deps-audit.mjs';
        try {
          auditOneLockfile({ label: '.', dir: process.cwd(), guard: ${JSON.stringify(join(dir, "ci/deps-audit-registry.cjs"))},
            allowlist: { version: 1, exceptions: [] }, cacheParent: ${JSON.stringify(mkdtempSync(join(dir, "one-cache-")))},
            timeoutMs: ${timeoutMs}, retryDelaysMs: [0, 0] });
        } catch (error) {
          console.error(error instanceof RegistryTransportExhausted ? 'TRANSPORT ' + error.kind : error.message);
          process.exitCode = error instanceof RegistryTransportExhausted ? 0 : 1;
        }
      `,
          ],
          { GITHUB_EVENT_NAME: "pull_request", npm_config_fetch_retries: "0" },
        ),
      audit: () => execute("npm", ["audit", "--offline=false", "--package-lock-only", "--json"]),
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

test("real npm response tokens never turn HTTP or malformed JSON into outages", {
  timeout: 90_000,
}, async () => {
  await withRegistry(async ({ advisory, oneAudit, gate }) => {
    for (const status of [401, 403, 400]) {
      advisory.status = status;
      advisory.response = { error: "ECONNRESET ETIMEDOUT ENOTFOUND" };
      const result = await oneAudit();
      assert.equal(result.status, 1, `HTTP ${status}: ${result.stderr}`);
      assert.match(result.stderr, /schema-validated/);
      assert.doesNotMatch(result.stderr, /retrying|TRANSPORT|::warning::/);
    }
    advisory.status = 200;
    advisory.raw = "ECONNRESET ETIMEDOUT not JSON";
    const malformed = await oneAudit();
    assert.equal(malformed.status, 1, malformed.stderr);
    assert.doesNotMatch(malformed.stderr, /retrying|TRANSPORT/);
    delete advisory.raw;
    advisory.status = 401;
    for (const event of ["pull_request", "merge_group"]) {
      const result = await gate({ GITHUB_EVENT_NAME: event, npm_config_fetch_retries: "0" });
      assert.equal(result.status, 1, result.stderr);
      assert.doesNotMatch(result.stderr, /retrying|::warning::/);
    }
  });
});

test("real npm malformed bulk validation survives a later metadata timeout", {
  timeout: 30_000,
}, async () => {
  await withRegistry(async ({ advisory, bulkBodies, oneAudit }) => {
    advisory.severity = undefined;
    advisory.stallMetadata = true;
    const result = await oneAudit(1_500);
    assert.ok(bulkBodies.length > 0, "bulk response must be consumed before the metadata stall");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /schema-validated/);
    assert.doesNotMatch(result.stderr, /retrying|TRANSPORT/);
  });
});

test("real npm pending bulk evidence survives timeout termination", {
  timeout: 30_000,
}, async () => {
  await withRegistry(async ({ advisory, oneAudit }) => {
    advisory.stallBulk = true;
    const result = await oneAudit(1_500);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /TRANSPORT timeout/);
    assert.equal((result.stderr.match(/retrying/g) ?? []).length, 2);
  });
});

test("CLI validates policy even when both lockfiles would be unavailable", {
  timeout: 120_000,
}, async () => {
  await withRegistry(async ({ advisory, bulkBodies, gate, setAllowlist }) => {
    advisory.status = 503;
    for (const event of ["pull_request", "merge_group"]) {
      const duplicate = validException();
      // Keep the duplicate otherwise valid regardless of when the suite runs.
      duplicate.exceptions[0].reviewed = "2020-01-01";
      duplicate.exceptions[0].expires = "2099-01-01";
      duplicate.exceptions.push({ ...duplicate.exceptions[0] });
      for (const [allowlist, message] of [
        [fixture("expired-allowlist"), /Expired/],
        [{ version: 1, exceptions: [{}] }, /Invalid exception/],
        [{ version: 9, exceptions: [] }, /Invalid dependency audit allowlist/],
        [duplicate, /Duplicate exception/],
      ]) {
        setAllowlist(allowlist);
        const before = bulkBodies.length;
        const result = await gate({ GITHUB_EVENT_NAME: event, npm_config_fetch_retries: "0" });
        assert.equal(result.status, 1, result.stdout || result.stderr);
        assert.match(result.stderr, message);
        assert.equal(
          bulkBodies.length,
          before,
          "invalid policy must fail before any registry request",
        );
        assert.doesNotMatch(result.stderr, /::warning::/);
      }
    }
  });
});

test("real npm ignores inherited offline configuration only when the gate forces online", {
  timeout: 30_000,
}, async () => {
  await withRegistry(async ({ bulkBodies, gate }) => {
    for (const offline of ["false", "true", undefined]) {
      const before = bulkBodies.length;
      const result = await gate(offline === undefined ? {} : { npm_config_offline: offline });
      assert.equal(result.status, 1, `offline=${offline}: ${result.stderr || result.stdout}`);
      assert.ok(
        bulkBodies.length >= before + 2,
        `offline=${offline}: both lockfiles must consult the registry`,
      );
      assert.deepEqual(bulkBodies[before], { lodash: ["4.17.20"] });
      assert.deepEqual(bulkBodies[before + 1], { lodash: ["4.17.20"] });
      const parsed = JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(parsed).sort(), [".", "web"]);
      assert.equal(parsed["."].blocked[0].package, "lodash");
      assert.equal(parsed["web"].blocked[0].package, "lodash");
    }
  });
});

test("real npm gate bypasses a warmed installation cache after same-ID/range severity escalation", {
  timeout: 30_000,
}, async () => {
  await withRegistry(async ({ advisory, bulkBodies, gate, audit }) => {
    advisory.severity = "moderate";
    const warm = await audit();
    assert.equal(JSON.parse(warm.stdout).vulnerabilities.lodash.severity, "moderate");
    assert.equal((await gate()).status, 0);
    advisory.severity = "high";
    const before = bulkBodies.length;
    const stale = await audit();
    assert.ok(bulkBodies.length > before, "online warm-cache audit must contact the registry");
    // Current npm retains moderate here; a future upstream cache fix may emit high.
    assert.ok(
      ["moderate", "high"].includes(JSON.parse(stale.stdout).vulnerabilities.lodash.severity),
    );
    for (let repeat = 0; repeat < 2; repeat++) {
      const requests = bulkBodies.length;
      const result = await gate();
      assert.ok(
        bulkBodies.length >= requests + 2,
        "gate must consult the registry for both lockfiles after escalation",
      );
      assert.equal(result.status, 1, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout);
      for (const label of [".", "web"]) {
        assert.equal(parsed[label].blocked[0].severity, "high", `lockfile ${label}`);
        assert.deepEqual(parsed[label].blocked[0].advisoryIds, [100001], `lockfile ${label}`);
      }
    }
  });
});

test("real npm registry schema failures cannot normalize into clean or exempted findings", {
  timeout: 30_000,
}, async () => {
  await withRegistry(async ({ advisory, bulkBodies, gate }) => {
    const high = await gate();
    assert.equal(high.status, 1);
    const highParsed = JSON.parse(high.stdout);
    assert.equal(highParsed["."].blocked[0].severity, "high");
    assert.equal(highParsed["web"].blocked[0].severity, "high");
    advisory.response = {};
    const clean = await gate();
    assert.equal(clean.status, 0, clean.stderr);
    const cleanParsed = JSON.parse(clean.stdout);
    for (const label of [".", "web"]) {
      assert.deepEqual(
        cleanParsed[label],
        { blocked: [], allowed: [], nonBlocking: [] },
        `lockfile ${label}`,
      );
    }
    const statuses = [];
    for (const response of [null, []]) {
      advisory.response = response;
      const before = bulkBodies.length;
      const result = await gate();
      assert.ok(bulkBodies.length > before);
      assert.match(result.stderr, /Registry advisory response was not schema-validated/);
      statuses.push(result.status);
    }
    assert.deepEqual(statuses, [1, 1], "registry null and [] must fail closed");
  });
});

test("real npm missing advisory severity cannot inherit an exact high exception", {
  timeout: 30_000,
}, async () => {
  await withRegistry(async ({ advisory, gate, setAllowlist }) => {
    const reviewed = new Date().toISOString().slice(0, 10);
    const expires = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    setAllowlist({
      version: 1,
      exceptions: [
        {
          package: "lodash",
          range: "4.17.20",
          severity: "high",
          advisoryIds: [100001],
          reviewed,
          expires,
          reason: "Local fixture only",
        },
      ],
    });
    const valid = await gate();
    assert.equal(valid.status, 0, valid.stderr);
    const validParsed = JSON.parse(valid.stdout);
    assert.equal(validParsed["."].allowed[0].severity, "high");
    assert.equal(validParsed["web"].allowed[0].severity, "high");
    for (const severity of [undefined, null, "", "unrated"]) {
      advisory.severity = severity;
      const result = await gate();
      assert.equal(
        result.status,
        1,
        `invalid registry severity must not be exempted: ${result.stdout}`,
      );
      assert.match(result.stderr, /Registry advisory response was not schema-validated/);
    }
  });
});

test("real npm validates chunked/compressed registry data and rejects unchecked responses", {
  // The 503 case now exhausts 3 gate attempts per lockfile (5s+15s backoff each)
  // before failing closed; withRegistry explicitly unsets GITHUB_EVENT_NAME so
  // bare gate() calls never inherit a CI runner's outage-tolerant event.
  // Truncated may also exhaust if npm reports it as a transport error.
  timeout: 240_000,
}, async () => {
  await withRegistry(async ({ advisory, gate }) => {
    for (const encoding of ["gzip", "x-gzip", "deflate", "x-deflate", "br"]) {
      advisory.encoding = encoding;
      advisory.response = {};
      const clean = await gate();
      assert.equal(clean.status, 0, `${encoding}: ${clean.stderr}`);
      advisory.response = [];
      const malformed = await gate();
      assert.equal(malformed.status, 1, `${encoding}: ${malformed.stdout}`);
    }
    advisory.encoding = "gzip";
    advisory.raw = " ".repeat(16 * 1024 * 1024) + "{}";
    assert.equal((await gate()).status, 1, "decoded response size is bounded");
    delete advisory.encoding;
    delete advisory.raw;
    advisory.response = {};
    for (const options of [
      { status: 503 },
      { status: 302 },
      { truncated: true },
      { raw: "not JSON" },
    ]) {
      Object.assign(advisory, options);
      const result = await gate({ npm_config_fetch_retries: "0" });
      assert.equal(result.status, 1, `${JSON.stringify(options)}: ${result.stdout}`);
      for (const key of Object.keys(options)) delete advisory[key];
    }
  });
});

test("CLI exit status: npm 0/1, findings, bad JSON, registry failure, and execution failure", () => {
  const dir = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "deps-audit-",
    ),
  );
  try {
    const npm = join(dir, "npm");
    const trace = join(dir, "cache-trace");
    writeFileSync(
      npm,
      `#!/bin/sh
[ "$1" = audit ] && [ "$2" = --offline=false ] || exit 9
cache="\${3#--cache=}"
[ "$cache" != "$3" ] && [ -d "$cache" ] || exit 9
printf '%s\\n' "$cache" >> "$AUDIT_CACHE_TRACE"
printf '%s' 'owned fixture marker' > "$cache/marker"
shift 3
[ "$*" = "--package-lock-only --json --include=prod --include=dev --include=optional --include=peer" ] || exit 9
printf '%s' "$AUDIT_FIXTURE"
printf '%s' "$AUDIT_BOUNDARY" >&3
exit "$AUDIT_STATUS"
`,
    );
    chmodSync(npm, 0o700);
    const script = fileURLToPath(new URL("./deps-audit.mjs", import.meta.url));
    const moderate = fixture("high");
    moderate.vulnerabilities["fixture-package"].severity = "moderate";
    moderate.vulnerabilities["fixture-package"].via[0].severity = "moderate";
    moderate.metadata.vulnerabilities.high = 0;
    moderate.metadata.vulnerabilities.moderate = 1;
    const malformedCounters = fixture("clean");
    malformedCounters.metadata.vulnerabilities.critical = 1;
    const validated = JSON.stringify({ version: 1, valid: true, responses: 1, pending: 0 });
    for (const [report, npmStatus, expected, boundary = validated] of [
      [JSON.stringify(fixture("clean")), 0, 0],
      [JSON.stringify(moderate), 1, 0],
      [JSON.stringify(fixture("high")), 1, 1],
      [JSON.stringify(fixture("unknown")), 1, 1],
      [JSON.stringify(malformedCounters), 0, 1],
      ["not json", 0, 1],
      [JSON.stringify({ error: { code: "E401" } }), 1, 1],
      [JSON.stringify(fixture("clean")), 2, 1],
      ...[
        "",
        "not JSON",
        "null",
        "[]",
        ...[
          { version: 2, valid: true, responses: 1, pending: 0 },
          { version: 1, valid: false, responses: 1, pending: 0 },
          { version: 1, valid: true, responses: 0, pending: 0 },
          { version: 1, valid: true, responses: 1, pending: 1 },
        ].map((value) => JSON.stringify(value)),
      ].map((boundary) => [JSON.stringify(fixture("clean")), 0, 1, boundary]),
    ]) {
      const run = spawnSync(process.execPath, [script], {
        env: {
          ...process.env,
          PATH: dir,
          PAPERCLIP_RUN_SCRATCH_DIR: dir,
          AUDIT_CACHE_TRACE: trace,
          AUDIT_FIXTURE: report,
          AUDIT_STATUS: String(npmStatus),
          AUDIT_BOUNDARY: boundary,
        },
        encoding: "utf8",
      });
      assert.equal(run.status, expected, run.stderr);
      const caches = readFileSync(trace, "utf8").trim().split("\n");
      assert.equal(new Set(caches).size, caches.length, "each invocation must use a unique cache");
      assert.ok(
        caches.every((cache) => !existsSync(cache)),
        "owned cache must be removed on success and failure",
      );
    }
    rmSync(npm);
    const missing = spawnSync(process.execPath, [script], {
      env: { ...process.env, PATH: dir, PAPERCLIP_RUN_SCRATCH_DIR: dir },
      encoding: "utf8",
    });
    assert.equal(missing.status, 1);
    assert.deepEqual(readdirSync(dir), ["cache-trace"], "execution failures must also clean up");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lockfile-scoped exceptions apply only to their lockfile", () => {
  const scoped = validException();
  scoped.exceptions[0].lockfile = "web";
  assert.equal(evaluateAudit(fixture("high"), scoped, today, ".").blocked.length, 1);
  assert.equal(evaluateAudit(fixture("high"), scoped, today, "web").allowed.length, 1);
  assert.equal(evaluateAudit(fixture("high"), validException(), today, ".").allowed.length, 1);
  assert.equal(evaluateAudit(fixture("high"), validException(), today, "web").allowed.length, 1);
  assert.equal(evaluateAudit(fixture("high"), scoped, today).blocked.length, 1);
});

test("invalid lockfile scopes and duplicate scoped exceptions fail closed", () => {
  for (const lockfile of ["root", "WEB", "", "web/"]) {
    const allowlist = validException();
    allowlist.exceptions[0].lockfile = lockfile;
    assert.throws(() => evaluateAudit(fixture("high"), allowlist, today, "web"), /lockfile/);
  }
  assert.throws(() => evaluateAudit(fixture("high"), validException(), today, "root"), /lockfile/);
  const crossScope = validException();
  crossScope.exceptions.push({ ...crossScope.exceptions[0], lockfile: "web" });
  assert.equal(evaluateAudit(fixture("high"), crossScope, today, "web").allowed.length, 1);
  assert.equal(evaluateAudit(fixture("high"), crossScope, today, ".").allowed.length, 1);
  const duplicate = validException();
  duplicate.exceptions[0].lockfile = "web";
  duplicate.exceptions.push({ ...duplicate.exceptions[0] });
  assert.throws(() => evaluateAudit(fixture("high"), duplicate, today, "web"), /Duplicate/);
});

function withDualShim({ rootFixture, webFixture, rootStatus, webStatus, allowlist = empty }) {
  const dir = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "deps-audit-dual-",
    ),
  );
  mkdirSync(join(dir, "ci"));
  copyFileSync(new URL("./deps-audit.mjs", import.meta.url), join(dir, "ci/deps-audit.mjs"));
  copyFileSync(
    new URL("./deps-audit-registry.cjs", import.meta.url),
    join(dir, "ci/deps-audit-registry.cjs"),
  );
  writeFileSync(join(dir, "ci/deps-audit-allowlist.json"), JSON.stringify(allowlist));
  writeFileSync(join(dir, "package-lock.json"), "{}");
  mkdirSync(join(dir, "web"));
  writeFileSync(join(dir, "web/package-lock.json"), "{}");
  const npm = join(dir, "npm");
  writeFileSync(
    npm,
    `#!/bin/sh
[ "$1" = audit ] && [ "$2" = --offline=false ] || exit 9
cache="\${3#--cache=}"
[ "$cache" != "$3" ] && [ -d "$cache" ] || exit 9
shift 3
[ "$*" = "--package-lock-only --json --include=prod --include=dev --include=optional --include=peer" ] || exit 9
case "$(pwd)" in
  */web) printf '%s' "$AUDIT_FIXTURE_WEB"; printf '%s' "$AUDIT_BOUNDARY" >&3; exit "$AUDIT_STATUS_WEB" ;;
  *) printf '%s' "$AUDIT_FIXTURE_ROOT"; printf '%s' "$AUDIT_BOUNDARY" >&3; exit "$AUDIT_STATUS_ROOT" ;;
esac
`,
  );
  chmodSync(npm, 0o700);
  const validated = JSON.stringify({ version: 1, valid: true, responses: 1, pending: 0 });
  const run = spawnSync(process.execPath, [join(dir, "ci/deps-audit.mjs")], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      PAPERCLIP_RUN_SCRATCH_DIR: dir,
      AUDIT_FIXTURE_ROOT: rootFixture,
      AUDIT_FIXTURE_WEB: webFixture,
      AUDIT_STATUS_ROOT: String(rootStatus),
      AUDIT_STATUS_WEB: String(webStatus),
      AUDIT_BOUNDARY: validated,
    },
    encoding: "utf8",
  });
  return { dir, run };
}

test("web-only advisory fails and output names the failing lockfile", () => {
  const clean = JSON.stringify(fixture("clean"));
  const high = JSON.stringify(fixture("high"));
  const cases = [
    {
      rootFixture: clean,
      webFixture: high,
      rootStatus: 0,
      webStatus: 1,
      expected: 1,
      blocked: "web",
    },
    {
      rootFixture: high,
      webFixture: clean,
      rootStatus: 1,
      webStatus: 0,
      expected: 1,
      blocked: ".",
    },
    {
      rootFixture: clean,
      webFixture: clean,
      rootStatus: 0,
      webStatus: 0,
      expected: 0,
      blocked: null,
    },
    {
      rootFixture: high,
      webFixture: high,
      rootStatus: 1,
      webStatus: 1,
      expected: 1,
      blocked: "both",
    },
  ];
  for (const { rootFixture, webFixture, rootStatus, webStatus, expected, blocked } of cases) {
    const { dir, run } = withDualShim({ rootFixture, webFixture, rootStatus, webStatus });
    try {
      assert.equal(run.status, expected, run.stderr);
      const parsed = JSON.parse(run.stdout);
      assert.deepEqual(Object.keys(parsed).sort(), [".", "web"]);
      if (blocked === "web") {
        assert.equal(parsed["web"].blocked.length, 1);
        assert.equal(parsed["."].blocked.length, 0);
        assert.match(run.stdout, /"web"/);
      } else if (blocked === ".") {
        assert.equal(parsed["."].blocked.length, 1);
        assert.equal(parsed["web"].blocked.length, 0);
      } else if (blocked === null) {
        assert.equal(parsed["."].blocked.length, 0);
        assert.equal(parsed["web"].blocked.length, 0);
      } else {
        assert.equal(parsed["."].blocked.length, 1);
        assert.equal(parsed["web"].blocked.length, 1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("missing web lockfile fails closed and names the lockfile", () => {
  const dir = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "deps-audit-missing-",
    ),
  );
  try {
    mkdirSync(join(dir, "ci"));
    copyFileSync(new URL("./deps-audit.mjs", import.meta.url), join(dir, "ci/deps-audit.mjs"));
    copyFileSync(
      new URL("./deps-audit-registry.cjs", import.meta.url),
      join(dir, "ci/deps-audit-registry.cjs"),
    );
    writeFileSync(join(dir, "ci/deps-audit-allowlist.json"), JSON.stringify(empty));
    writeFileSync(join(dir, "package-lock.json"), "{}");
    const npm = join(dir, "npm");
    writeFileSync(
      npm,
      `#!/bin/sh
printf '%s' '${JSON.stringify(fixture("clean"))}'
printf '%s' '{"version":1,"valid":true,"responses":1,"pending":0}' >&3
exit 0
`,
    );
    chmodSync(npm, 0o700);
    const run = spawnSync(process.execPath, [join(dir, "ci/deps-audit.mjs")], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        PAPERCLIP_RUN_SCRATCH_DIR: dir,
      },
      encoding: "utf8",
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /web/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const validBoundary = JSON.stringify({ version: 1, valid: true, responses: 1, pending: 0 });

function retryHarnessDir() {
  const dir = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "deps-audit-retry-",
    ),
  );
  writeFileSync(join(dir, "package-lock.json"), "{}");
  return dir;
}

function completedNpm({ stdout, status = 0, boundary = validBoundary }) {
  return {
    error: undefined,
    status,
    signal: null,
    stdout,
    stderr: "",
    output: [null, stdout, "", boundary],
  };
}

// Real spawnSync error shape: { code } only. spawnSync never sets `killed` (a
// ChildProcess instance property), so fixtures must not either: a fake
// `killed: true` would let the ETIMEDOUT retry term be deleted unnoticed.
function failedNpm({ code, status = null, signal = null, boundary = null }) {
  return {
    error: Object.assign(new Error(`spawn npm ${code ?? signal}`), { code }),
    status,
    signal,
    stdout: "",
    stderr: "",
    output: [null, "", "", boundary],
  };
}

test("audit retries a timed-out npm execution with a fresh cache, then succeeds", () => {
  const dir = retryHarnessDir();
  try {
    const caches = [];
    const sleeps = [];
    const runs = [
      failedNpm({ code: "ETIMEDOUT", signal: "SIGTERM" }),
      completedNpm({ stdout: JSON.stringify(fixture("clean")) }),
    ];
    const spawn = (_command, args) => {
      caches.push(args.find((arg) => arg.startsWith("--cache=")));
      return runs.splice(0, 1)[0];
    };
    const result = auditOneLockfile({
      label: ".",
      dir,
      guard: join(dir, "guard"),
      allowlist: empty,
      cacheParent: join(dir, "cache-parent"),
      spawn,
      sleep: (ms) => sleeps.push(ms),
    });
    assert.deepEqual(result, { blocked: [], allowed: [], nonBlocking: [] });
    assert.equal(caches.length, 2);
    assert.equal(new Set(caches).size, 2);
    assert.deepEqual(sleeps, [5_000]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Real shape of a spawnSync result whose child was killed by a signal (OOM,
// runner SIGKILL): no error, null status, signal set.
function signalKilledNpm({ signal = "SIGKILL" }) {
  return {
    error: undefined,
    status: null,
    signal,
    stdout: "",
    stderr: "",
    output: [null, "", "", null],
  };
}

test("audit retries a signal-killed npm execution, then succeeds", () => {
  const dir = retryHarnessDir();
  try {
    const caches = [];
    const sleeps = [];
    const runs = [
      signalKilledNpm({ signal: "SIGKILL" }),
      completedNpm({ stdout: JSON.stringify(fixture("clean")) }),
    ];
    const spawn = (_command, args) => {
      caches.push(args.find((arg) => arg.startsWith("--cache=")));
      return runs.splice(0, 1)[0];
    };
    const result = auditOneLockfile({
      label: ".",
      dir,
      guard: join(dir, "guard"),
      allowlist: empty,
      cacheParent: join(dir, "cache-parent"),
      spawn,
      sleep: (ms) => sleeps.push(ms),
    });
    assert.deepEqual(result, { blocked: [], allowed: [], nonBlocking: [] });
    assert.equal(caches.length, 2);
    assert.equal(new Set(caches).size, 2);
    assert.deepEqual(sleeps, [5_000]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit fails fast when npm cannot be spawned", () => {
  const dir = retryHarnessDir();
  try {
    let calls = 0;
    const sleeps = [];
    const spawn = () => {
      calls++;
      return failedNpm({ code: "ENOENT" });
    };
    assert.throws(
      () =>
        auditOneLockfile({
          label: ".",
          dir,
          guard: join(dir, "guard"),
          allowlist: empty,
          cacheParent: join(dir, "cache-parent"),
          spawn,
          sleep: (ms) => sleeps.push(ms),
        }),
      /did not complete successfully/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit retries bad npm exit statuses, then fails closed", () => {
  const dir = retryHarnessDir();
  try {
    const caches = [];
    const sleeps = [];
    const spawn = (_command, args) => {
      caches.push(args.find((arg) => arg.startsWith("--cache=")));
      return {
        error: undefined,
        status: 2,
        signal: null,
        stdout: "",
        stderr: "npm ERR! boom",
        output: [null, "", "npm ERR! boom", null],
      };
    };
    assert.throws(
      () =>
        auditOneLockfile({
          label: ".",
          dir,
          guard: join(dir, "guard"),
          allowlist: empty,
          cacheParent: join(dir, "cache-parent"),
          spawn,
          sleep: (ms) => sleeps.push(ms),
        }),
      /did not complete successfully/,
    );
    assert.equal(caches.length, 3);
    assert.equal(new Set(caches).size, 3);
    assert.deepEqual(sleeps, [5_000, 15_000]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit does not retry completed runs with findings", () => {
  const dir = retryHarnessDir();
  try {
    let calls = 0;
    const sleeps = [];
    const spawn = () => {
      calls++;
      return completedNpm({ stdout: JSON.stringify(fixture("high")), status: 1 });
    };
    const result = auditOneLockfile({
      label: ".",
      dir,
      guard: join(dir, "guard"),
      allowlist: empty,
      cacheParent: join(dir, "cache-parent"),
      spawn,
      sleep: (ms) => sleeps.push(ms),
    });
    assert.equal(result.blocked.length, 1);
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI retries a failed npm invocation and succeeds on the next attempt", () => {
  const dir = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "deps-audit-cli-retry-",
    ),
  );
  try {
    const npm = join(dir, "npm");
    const count = join(dir, "count");
    writeFileSync(
      npm,
      `#!/bin/sh
read n x < "$AUDIT_COUNT" 2>/dev/null
n=\${n:-0}
n=$((n + 1))
printf '%s' "$n" > "$AUDIT_COUNT"
if [ "$n" -eq 1 ]; then exit 2; fi
printf '%s' "$AUDIT_FIXTURE"
printf '%s' "$AUDIT_BOUNDARY" >&3
exit 0
`,
    );
    chmodSync(npm, 0o700);
    const script = fileURLToPath(new URL("./deps-audit.mjs", import.meta.url));
    const run = spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        PATH: dir,
        PAPERCLIP_RUN_SCRATCH_DIR: dir,
        AUDIT_COUNT: count,
        AUDIT_FIXTURE: JSON.stringify(fixture("clean")),
        AUDIT_BOUNDARY: validBoundary,
      },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /attempt 1 of 3 did not complete; retrying/);
    // Root attempt 1 fails, root attempt 2 succeeds, web attempt 1 succeeds.
    assert.equal(readFileSync(count, "utf8"), "3");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Registry-outage classification: warn on pull_request/merge_group, fail closed elsewhere ---

const invalidBoundary = JSON.stringify({
  version: 1,
  valid: false,
  responses: 1,
  pending: 0,
  permanent: true,
  transport: null,
});
const transportBoundary = (transport, overrides = {}) =>
  JSON.stringify({
    version: 1,
    valid: false,
    responses: 1,
    pending: 0,
    permanent: false,
    transport,
    ...overrides,
  });
const httpBoundary = (statusCode) => transportBoundary({ kind: "http", statusCode });
const networkBoundary = (code) => transportBoundary({ kind: "network", code });
const pendingBoundary = transportBoundary(null, { valid: true, responses: 0, pending: 1 });

function auditSequence(runs) {
  const dir = retryHarnessDir();
  let calls = 0;
  const sleeps = [];
  try {
    const result = auditOneLockfile({
      label: ".",
      dir,
      guard: join(dir, "guard"),
      allowlist: empty,
      cacheParent: join(dir, "cache"),
      spawn: () => runs[Math.min(calls++, runs.length - 1)],
      sleep: (ms) => sleeps.push(ms),
    });
    return { result, calls, sleeps };
  } catch (error) {
    return { error, calls, sleeps };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const httpFailure = (statusCode = 503, overrides = {}) =>
  completedNpm({
    status: 1,
    stdout: npmHttpError(statusCode, "ECONNRESET"),
    boundary: httpBoundary(statusCode),
    ...overrides,
  });

test("response-body transport tokens cannot override permanent registry evidence", () => {
  for (const stdout of [
    npmHttpError(401, "ECONNRESET"),
    npmHttpError(403, "ETIMEDOUT"),
    npmHttpError(400, "ENOTFOUND"),
    npmNetworkError(`invalid json response body ECONNRESET at ${deadBulkUrl}`),
  ]) {
    const { error, calls, sleeps } = auditSequence([
      completedNpm({ status: 1, stdout, boundary: invalidBoundary }),
    ]);
    assert.ok(error && !(error instanceof RegistryTransportExhausted), stdout);
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
  }
});

test("transport evidence rejects invalid boundary fields and HTTP range edges", () => {
  for (const changes of [
    { version: 0 },
    { version: 2 },
    { valid: null },
    { responses: 0 },
    { responses: -1 },
    { responses: 1.5 },
    { responses: "1" },
    { pending: 1 },
    { pending: -1 },
    { pending: "0" },
    { permanent: true },
    { permanent: undefined },
    { transport: null },
    { transport: { kind: "network", code: "UNKNOWN" } },
  ]) {
    const boundary = transportBoundary({ kind: "http", statusCode: 503 }, changes);
    const { error, calls } = auditSequence([httpFailure(503, { boundary })]);
    assert.ok(error && !(error instanceof RegistryTransportExhausted), boundary);
    assert.equal(calls, 1, boundary);
  }
  for (const statusCode of [499, 500, 599, 600]) {
    const { error, calls } = auditSequence([httpFailure(statusCode)]);
    assert.equal(
      error instanceof RegistryTransportExhausted,
      statusCode >= 500 && statusCode <= 599,
      `HTTP ${statusCode}`,
    );
    assert.equal(calls, statusCode >= 500 && statusCode <= 599 ? 3 : 1);
  }
});

test("timeouts preserve permanent validation and require a pending observed bulk request", () => {
  for (const boundary of [
    null,
    validBoundary,
    invalidBoundary,
    httpBoundary(503),
    networkBoundary("ECONNRESET"),
    transportBoundary(null, { pending: 0, responses: 0 }),
    transportBoundary(null, { pending: 1, permanent: true }),
  ]) {
    const { error } = auditSequence([
      failedNpm({ code: "ETIMEDOUT", signal: "SIGTERM", boundary }),
    ]);
    assert.ok(error && !(error instanceof RegistryTransportExhausted), String(boundary));
  }
  const { error, calls } = auditSequence([
    failedNpm({ code: "ETIMEDOUT", signal: "SIGTERM", boundary: invalidBoundary }),
  ]);
  assert.match(error.message, /schema-validated/);
  assert.equal(calls, 1, "already-invalid registry data must not retry");
});

test("mixed crash and transport exhaustion stays blocking in either order", () => {
  const crash = signalKilledNpm({});
  const timeout = failedNpm({ code: "ETIMEDOUT", signal: "SIGTERM", boundary: pendingBoundary });
  const unknownTimeout = failedNpm({ code: "ETIMEDOUT", signal: "SIGTERM" });
  for (const runs of [
    [crash, crash, httpFailure()],
    [crash, httpFailure(), httpFailure()],
    [httpFailure(), crash, httpFailure()],
    [httpFailure(), httpFailure(), crash],
    [crash, crash, timeout],
    [timeout, crash, timeout],
    [unknownTimeout, httpFailure(), httpFailure()],
  ]) {
    const { error, calls, sleeps } = auditSequence(runs);
    assert.ok(error && !(error instanceof RegistryTransportExhausted));
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [5_000, 15_000]);
  }
  const recovered = auditSequence([
    crash,
    httpFailure(),
    completedNpm({ stdout: JSON.stringify(fixture("clean")) }),
  ]);
  assert.deepEqual(recovered.result, { blocked: [], allowed: [], nonBlocking: [] });
  assert.equal(recovered.calls, 3);
});
// Dead loopback port shape (mirrors real npm error JSON; no real registry, no credentials).
const deadBulkUrl = "http://127.0.0.1:9/-/npm/v1/security/advisories/bulk";
const npmHttpError = (statusCode, phrase) =>
  JSON.stringify({
    message: `${statusCode} ${phrase} - POST ${deadBulkUrl} - ${phrase}`,
    method: "POST",
    uri: deadBulkUrl,
    statusCode,
    error: { summary: "", detail: "" },
  });
const npmNetworkError = (reason) =>
  JSON.stringify({
    message: `request to ${deadBulkUrl} failed, reason: ${reason}`,
    error: { summary: "", detail: "" },
  });

test("audit retries registry HTTP 5xx with a fresh cache, then succeeds", () => {
  const dir = retryHarnessDir();
  try {
    const caches = [];
    const sleeps = [];
    const runs = [
      completedNpm({
        stdout: npmHttpError(503, "Service Unavailable"),
        status: 1,
        boundary: httpBoundary(503),
      }),
      completedNpm({ stdout: JSON.stringify(fixture("clean")) }),
    ];
    const spawn = (_command, args) => {
      caches.push(args.find((arg) => arg.startsWith("--cache=")));
      return runs.splice(0, 1)[0];
    };
    const result = auditOneLockfile({
      label: ".",
      dir,
      guard: join(dir, "guard"),
      allowlist: empty,
      cacheParent: join(dir, "cache-parent"),
      spawn,
      sleep: (ms) => sleeps.push(ms),
    });
    assert.deepEqual(result, { blocked: [], allowed: [], nonBlocking: [] });
    assert.equal(caches.length, 2);
    assert.equal(new Set(caches).size, 2);
    assert.deepEqual(sleeps, [5_000]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exhausted HTTP 5xx throws transport-unavailable, never a generic failure", () => {
  const dir = retryHarnessDir();
  try {
    const caches = [];
    const sleeps = [];
    const spawn = (_command, args) => {
      caches.push(args.find((arg) => arg.startsWith("--cache=")));
      return completedNpm({
        stdout: npmHttpError(503, "Service Unavailable"),
        status: 1,
        boundary: httpBoundary(503),
      });
    };
    assert.throws(
      () =>
        auditOneLockfile({
          label: "web",
          dir,
          guard: join(dir, "guard"),
          allowlist: empty,
          cacheParent: join(dir, "cache-parent"),
          spawn,
          sleep: (ms) => sleeps.push(ms),
        }),
      (error) =>
        error instanceof RegistryTransportExhausted &&
        error.kind === "http-5xx" &&
        error.attempts === 3 &&
        error.label === "web" &&
        /unavailable/.test(error.message),
    );
    assert.equal(caches.length, 3);
    assert.equal(new Set(caches).size, 3);
    assert.deepEqual(sleeps, [5_000, 15_000]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exhausted transient network errors throw transport-unavailable", () => {
  for (const reason of [
    "connect ECONNREFUSED 127.0.0.1:9",
    "read ECONNRESET",
    "getaddrinfo EAI_AGAIN registry.npmjs.org",
    ...[
      "EPIPE",
      "ETIMEDOUT",
      "ENOTFOUND",
      "ECONNABORTED",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "ENETRESET",
      "ENETDOWN",
      "EHOSTDOWN",
    ].map((code) => `read ${code}`),
  ]) {
    const dir = retryHarnessDir();
    try {
      let calls = 0;
      const sleeps = [];
      const spawn = () => {
        calls++;
        return completedNpm({
          stdout: npmNetworkError(reason),
          status: 1,
          boundary: networkBoundary(reason.match(/\bE[A-Z_]+\b/)[0]),
        });
      };
      assert.throws(
        () =>
          auditOneLockfile({
            label: ".",
            dir,
            guard: join(dir, "guard"),
            allowlist: empty,
            cacheParent: join(dir, "cache-parent"),
            spawn,
            sleep: (ms) => sleeps.push(ms),
          }),
        (error) =>
          error instanceof RegistryTransportExhausted &&
          error.kind === "network" &&
          error.attempts === 3,
        reason,
      );
      assert.equal(calls, 3, reason);
      assert.deepEqual(sleeps, [5_000, 15_000], reason);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("exhausted timeouts throw transport-unavailable", () => {
  const dir = retryHarnessDir();
  try {
    let calls = 0;
    const sleeps = [];
    const spawn = () => {
      calls++;
      return failedNpm({ code: "ETIMEDOUT", signal: "SIGTERM", boundary: pendingBoundary });
    };
    assert.throws(
      () =>
        auditOneLockfile({
          label: ".",
          dir,
          guard: join(dir, "guard"),
          allowlist: empty,
          cacheParent: join(dir, "cache-parent"),
          spawn,
          sleep: (ms) => sleeps.push(ms),
        }),
      (error) =>
        error instanceof RegistryTransportExhausted &&
        error.kind === "timeout" &&
        error.attempts === 3,
    );
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [5_000, 15_000]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry 401/403 fail immediately without retry and stay blocking", () => {
  for (const [statusCode, phrase] of [
    [401, "Unauthorized"],
    [403, "Forbidden"],
  ]) {
    const dir = retryHarnessDir();
    try {
      let calls = 0;
      const sleeps = [];
      const spawn = () => {
        calls++;
        return completedNpm({
          stdout: npmHttpError(statusCode, phrase),
          status: 1,
          boundary: invalidBoundary,
        });
      };
      assert.throws(
        () =>
          auditOneLockfile({
            label: ".",
            dir,
            guard: join(dir, "guard"),
            allowlist: empty,
            cacheParent: join(dir, "cache-parent"),
            spawn,
            sleep: (ms) => sleeps.push(ms),
          }),
        (error) =>
          !(error instanceof RegistryTransportExhausted) && /schema-validated/.test(error.message),
        `HTTP ${statusCode}`,
      );
      assert.equal(calls, 1, `HTTP ${statusCode} must not retry`);
      assert.deepEqual(sleeps, [], `HTTP ${statusCode} must not sleep`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("invalid registry response bodies fail immediately without retry", () => {
  const dir = retryHarnessDir();
  try {
    let calls = 0;
    const sleeps = [];
    const spawn = () => {
      calls++;
      return completedNpm({
        stdout: JSON.stringify({
          message: `invalid json response body at ${deadBulkUrl} reason: Unexpected token 'o', "not json" is not valid JSON`,
          error: { summary: "", detail: "" },
        }),
        status: 1,
        boundary: invalidBoundary,
      });
    };
    assert.throws(
      () =>
        auditOneLockfile({
          label: ".",
          dir,
          guard: join(dir, "guard"),
          allowlist: empty,
          cacheParent: join(dir, "cache-parent"),
          spawn,
          sleep: (ms) => sleeps.push(ms),
        }),
      (error) =>
        !(error instanceof RegistryTransportExhausted) && /schema-validated/.test(error.message),
    );
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exhausted signal kills stay blocking, never transport", () => {
  const dir = retryHarnessDir();
  try {
    let calls = 0;
    const sleeps = [];
    const spawn = () => {
      calls++;
      return signalKilledNpm({ signal: "SIGKILL" });
    };
    assert.throws(
      () =>
        auditOneLockfile({
          label: ".",
          dir,
          guard: join(dir, "guard"),
          allowlist: empty,
          cacheParent: join(dir, "cache-parent"),
          spawn,
          sleep: (ms) => sleeps.push(ms),
        }),
      (error) =>
        !(error instanceof RegistryTransportExhausted) &&
        /did not complete successfully/.test(error.message),
    );
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [5_000, 15_000]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transport classification requires preload observation and the bulk endpoint", () => {
  const cases = [
    {
      name: "missing preload boundary",
      stdout: npmHttpError(503, "Service Unavailable"),
      boundary: "null",
      message: /schema-validated/,
    },
    {
      name: "contradictory valid boundary with error report",
      stdout: npmHttpError(503, "Service Unavailable"),
      boundary: validBoundary,
      message: /Invalid npm audit v2 report/,
    },
    {
      name: "5xx without the bulk endpoint",
      stdout: JSON.stringify({
        message: "503 Service Unavailable - POST http://127.0.0.1:9/other - x",
        method: "POST",
        uri: "http://127.0.0.1:9/other",
        statusCode: 503,
        error: { summary: "", detail: "" },
      }),
      boundary: invalidBoundary,
      message: /schema-validated/,
    },
    {
      name: "network code without the bulk endpoint",
      stdout: JSON.stringify({
        message:
          "request to http://127.0.0.1:9/other failed, reason: connect ECONNREFUSED 127.0.0.1:9",
        error: { summary: "", detail: "" },
      }),
      boundary: invalidBoundary,
      message: /schema-validated/,
    },
  ];
  for (const { name, stdout, boundary, message } of cases) {
    const dir = retryHarnessDir();
    try {
      let calls = 0;
      const spawn = () => {
        calls++;
        return completedNpm({ stdout, status: 1, boundary });
      };
      assert.throws(
        () =>
          auditOneLockfile({
            label: ".",
            dir,
            guard: join(dir, "guard"),
            allowlist: empty,
            cacheParent: join(dir, "cache-parent"),
            spawn,
            sleep: () => {},
          }),
        (error) => !(error instanceof RegistryTransportExhausted) && message.test(error.message),
        name,
      );
      assert.equal(calls, 1, `${name} must not retry`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("only pull_request and merge_group tolerate registry outages", () => {
  assert.equal(isOutageTolerantEvent("pull_request"), true);
  assert.equal(isOutageTolerantEvent("merge_group"), true);
  for (const event of [
    "push",
    "schedule",
    "workflow_dispatch",
    "",
    "Pull_Request",
    "merge-queue",
  ]) {
    assert.equal(isOutageTolerantEvent(event), false, `event ${JSON.stringify(event)}`);
  }
  const previous = process.env.GITHUB_EVENT_NAME;
  try {
    process.env.GITHUB_EVENT_NAME = "merge_group";
    assert.equal(isOutageTolerantEvent(), true);
    delete process.env.GITHUB_EVENT_NAME;
    assert.equal(isOutageTolerantEvent(), false);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_EVENT_NAME;
    else process.env.GITHUB_EVENT_NAME = previous;
  }
});

async function withBlockedRegistry(run) {
  // A port that was free an instant ago: nothing listens, so real npm fails
  // fast with ECONNREFUSED. No real registry is contacted, no credentials used.
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const deadPort = probe.address().port;
  probe.closeAllConnections();
  await new Promise((resolve) => probe.close(resolve));
  const registry = `http://127.0.0.1:${deadPort}`;
  const dir = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "deps-audit-blocked-",
    ),
  );
  try {
    mkdirSync(join(dir, "ci"));
    copyFileSync(new URL("./deps-audit.mjs", import.meta.url), join(dir, "ci/deps-audit.mjs"));
    copyFileSync(
      new URL("./deps-audit-registry.cjs", import.meta.url),
      join(dir, "ci/deps-audit-registry.cjs"),
    );
    writeFileSync(join(dir, "ci/deps-audit-allowlist.json"), JSON.stringify(empty));
    const lockfilePackages = (name) => ({
      name,
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name, version: "1.0.0", dependencies: { lodash: "4.17.20" } },
        "node_modules/lodash": { version: "4.17.20" },
      },
    });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "audit-blocked",
        version: "1.0.0",
        dependencies: { lodash: "4.17.20" },
      }),
    );
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify(lockfilePackages("audit-blocked")),
    );
    mkdirSync(join(dir, "web"));
    writeFileSync(
      join(dir, "web/package.json"),
      JSON.stringify({
        name: "audit-blocked-web",
        version: "1.0.0",
        dependencies: { lodash: "4.17.20" },
      }),
    );
    writeFileSync(
      join(dir, "web/package-lock.json"),
      JSON.stringify(lockfilePackages("audit-blocked-web")),
    );
    writeFileSync(
      join(dir, ".npmrc"),
      `offline=true\nregistry=${registry}\ncache=${join(dir, "cache")}\n`,
    );
    const env = {
      ...process.env,
      npm_config_registry: registry,
      npm_config_cache: join(dir, "cache"),
      // Disable npm-internal retries for speed; the gate still makes 3 attempts.
      npm_config_fetch_retries: "0",
    };
    delete env.npm_config_offline;
    delete env.NPM_CONFIG_OFFLINE;
    const gate = (overrides = {}) =>
      new Promise((resolve, reject) => {
        // Two lockfiles x (3 fast attempts + 5s/15s backoff) take ~45s.
        const child = spawn(process.execPath, [join(dir, "ci/deps-audit.mjs")], {
          cwd: dir,
          env: { ...env, ...overrides },
          timeout: 120_000,
        });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
    await run({ gate });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const event of ["pull_request", "merge_group"]) {
  test(`blocked registry warns with exit 0 on ${event} after 3 attempts per lockfile`, {
    timeout: 150_000,
  }, async () => {
    await withBlockedRegistry(async ({ gate }) => {
      const result = await gate({ GITHUB_EVENT_NAME: event });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /::warning::/);
      assert.match(result.stderr, /unavailable, not clean/);
      assert.match(result.stderr, /3 attempts/);
      assert.ok(!result.stderr.includes("http://"), "warning output must be redacted");
      assert.ok(!result.stderr.includes("127.0.0.1"), "warning output must be redacted");
      const parsed = JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(parsed).sort(), [".", "web"]);
      for (const label of [".", "web"]) {
        assert.equal(parsed[label].unavailable, true, `lockfile ${label}`);
        assert.ok(!("blocked" in parsed[label]), `lockfile ${label} must never look clean`);
      }
      assert.ok(!result.stdout.includes("http://"), "result JSON must be redacted");
      const retries = result.stderr.match(/retrying in/g) ?? [];
      assert.equal(retries.length, 4, "two retries per lockfile before exhaustion");
    });
  });
}

for (const event of ["push", "schedule"]) {
  test(`blocked registry fails closed on ${event} after 3 attempts per lockfile`, {
    timeout: 150_000,
  }, async () => {
    await withBlockedRegistry(async ({ gate }) => {
      const result = await gate({ GITHUB_EVENT_NAME: event });
      assert.equal(result.status, 1, result.stdout);
      assert.ok(!result.stderr.includes("::warning::"), "fail-closed must not warn");
      assert.match(result.stderr, /unavailable/);
      assert.match(result.stderr, /failing closed/);
      const parsed = JSON.parse(result.stdout);
      for (const label of [".", "web"]) {
        assert.equal(parsed[label].unavailable, true, `lockfile ${label}`);
        assert.ok(!("blocked" in parsed[label]), `lockfile ${label} must never look clean`);
      }
      const retries = result.stderr.match(/retrying in/g) ?? [];
      assert.equal(retries.length, 4, "two retries per lockfile before exhaustion");
    });
  });
}

test("outage in one lockfile still blocks on an advisory in the other", {
  timeout: 90_000,
}, () => {
  const dir = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "deps-audit-mixed-",
    ),
  );
  try {
    mkdirSync(join(dir, "ci"));
    copyFileSync(new URL("./deps-audit.mjs", import.meta.url), join(dir, "ci/deps-audit.mjs"));
    copyFileSync(
      new URL("./deps-audit-registry.cjs", import.meta.url),
      join(dir, "ci/deps-audit-registry.cjs"),
    );
    writeFileSync(join(dir, "ci/deps-audit-allowlist.json"), JSON.stringify(empty));
    writeFileSync(join(dir, "package-lock.json"), "{}");
    mkdirSync(join(dir, "web"));
    writeFileSync(join(dir, "web/package-lock.json"), "{}");
    const npm = join(dir, "npm");
    writeFileSync(
      npm,
      `#!/bin/sh
case "$(pwd)" in
  */web) printf '%s' "$AUDIT_FIXTURE_WEB"; printf '%s' "$AUDIT_BOUNDARY_WEB" >&3; exit "$AUDIT_STATUS_WEB" ;;
  *) printf '%s' "$AUDIT_FIXTURE_ROOT"; printf '%s' "$AUDIT_BOUNDARY_ROOT" >&3; exit "$AUDIT_STATUS_ROOT" ;;
esac
`,
    );
    chmodSync(npm, 0o700);
    const run = spawnSync(process.execPath, [join(dir, "ci/deps-audit.mjs")], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        PAPERCLIP_RUN_SCRATCH_DIR: dir,
        GITHUB_EVENT_NAME: "pull_request",
        AUDIT_FIXTURE_ROOT: npmNetworkError("connect ECONNREFUSED 127.0.0.1:9"),
        AUDIT_STATUS_ROOT: "1",
        AUDIT_BOUNDARY_ROOT: networkBoundary("ECONNREFUSED"),
        AUDIT_FIXTURE_WEB: JSON.stringify(fixture("high")),
        AUDIT_STATUS_WEB: "1",
        AUDIT_BOUNDARY_WEB: validBoundary,
      },
      encoding: "utf8",
    });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /::warning::/, "the outage stays loud even when blocked elsewhere");
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed["."].unavailable, true);
    assert.equal(parsed.web.blocked.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry 401 stays blocking on pull_request without retry", {
  timeout: 30_000,
}, async () => {
  await withRegistry(async ({ advisory, gate }) => {
    advisory.status = 401;
    const result = await gate({ GITHUB_EVENT_NAME: "pull_request", npm_config_fetch_retries: "0" });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /schema-validated/);
    assert.ok(!result.stderr.includes("::warning::"));
    assert.ok(!result.stderr.includes("retrying"), "permanent failures must not retry");
  });
});
