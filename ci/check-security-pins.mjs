// Security-pin contracts gate: Host admission ignores forwarding headers, and
// no Hono route outside the five inline-critical paths emits an inline
// <style> block with its hash lifecycle intact. Executable contracts only:
// this gate changes no admission, header or CSP behavior.
//
// Static half (offline, read-only, no dependencies): pins the source facts
// the Worker suites assume — admission reads only the Host header, the
// recorded leaf hash matches the regenerated bundle bytes, the allowlist is
// exactly the five documented paths, and the threat-model rows point here.
// Dynamic half: runs the two contract suites and maps each result onto its
// stable check ID. Stdout is pure JSON (pipe it to jq); the human one-liner
// goes to stderr. Exit 0 only when everything passes.
//
// The threat-model gaps rows stay the single source of truth; the IDs, codes
// and next_action strings below are documented in
// docs/security-pin-contracts.md.
//
// Usage: node ci/check-security-pins.mjs [--selftest] [--static-only]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TRUST_HOSTS_PATH = "src/trust-hosts.ts";
const HEADERS_PATH = "src/headers.ts";
const LEAF_MODULE_PATH = "src/leaf-critical-css.ts";
// Same inputs, same order as ci/build-leaf-css.mjs SOURCES.
const LEAF_SOURCES = ["public/styles.css", "public/theme-tokens.css", "public/theme.css"];
const THREAT_MODEL_PATH = "docs/threat-model.md";

const INLINE_CRITICAL_PATHS = ["/", "/about", "/faq", "/rules", "/privacy"];

// Stable check ID -> suite describe matcher. This table is the single source
// for the dynamic IDs (unlike the Kit payloads split truth): a renamed or
// added describe misses every matcher and fails closed as unmapped.
const CHECK_MATCHERS = [
  { id: "host-forward-matrix", describe: "host-admission forwarding contract" },
  { id: "style-route-sweep", describe: "inline-style route sweep" },
  { id: "leaf-hash-lifecycle", describe: "leaf-bundle hash lifecycle" },
];
const SUITES = ["test/host-admission-forwarding.test.ts", "test/inline-style-route-sweep.test.ts"];

const file = (rel) => readFileSync(join(ROOT, rel), "utf8");

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** Admission must read the Host header and no other request header. */
export function extractHeaderReads(source) {
  const code = stripComments(source);
  const reads = [];
  for (const match of code.matchAll(/\.header\s*\(\s*["'`]([^"'`]+)["'`]/gi)) {
    reads.push(match[1].toLowerCase());
  }
  return [...new Set(reads)].sort();
}

export function checkHostSourcePin(source = file(TRUST_HOSTS_PATH)) {
  if (!source.includes("deliberately ignored")) {
    return { id: "host-source-pin", status: "fail", detail: "deliberate-ignore marker missing" };
  }
  const code = stripComments(source);
  // Fail closed on header-access shapes the literal extractor cannot see: a
  // raw headers.get read or any .raw access blinds the Host-only pin, as does
  // a .header() call whose argument is not a string literal (variable,
  // computed or template name). Each shape fails even when no literal
  // non-Host read is visible.
  if (/\.headers\s*\.\s*get\s*\(/i.test(code)) {
    return {
      id: "host-source-pin",
      status: "fail",
      detail: "admission uses raw headers.get (non-Host read)",
    };
  }
  if (/\.raw\b/i.test(code)) {
    return {
      id: "host-source-pin",
      status: "fail",
      detail: "admission uses .raw request access (non-Host read)",
    };
  }
  const totalHeaderCalls = (code.match(/\.header\s*\(/gi) ?? []).length;
  const literalHeaderCalls = [...code.matchAll(/\.header\s*\(\s*["'`][^"'`]+["'`]/gi)].length;
  if (totalHeaderCalls > literalHeaderCalls) {
    return {
      id: "host-source-pin",
      status: "fail",
      detail: "admission uses non-literal .header() argument (pin is blind)",
    };
  }
  // Residual backstop: after removing every canonical .header("host") call,
  // no header-access token may remain. Shape enumeration cannot list every
  // spelling (bracket reads, bind aliases, destructuring), so anything left
  // fails. The file is tiny and contains no other header token today.
  const withoutAllowedReads = code.replace(/\.header\s*\(\s*["'`]host["'`]\s*\)/gi, " ");
  if (/headers?\b/i.test(withoutAllowedReads) || /\.raw\b/i.test(withoutAllowedReads)) {
    return {
      id: "host-source-pin",
      status: "fail",
      detail: "admission uses a non-canonical header access (pin is blind)",
    };
  }
  const reads = extractHeaderReads(source);
  if (reads.length === 0) {
    return { id: "host-source-pin", status: "fail", detail: "no header read found (pin is blind)" };
  }
  const extra = reads.filter((name) => name !== "host");
  if (extra.length > 0) {
    return {
      id: "host-source-pin",
      status: "fail",
      detail: `admission reads non-Host headers: ${extra.join(", ")}`,
    };
  }
  return { id: "host-source-pin", status: "pass" };
}

/** The recorded bytes and hash must match a fresh regeneration. */
export function verifyBundleBytes(sources, moduleSource) {
  const regenerated = sources.join("\n");
  const cssMatch = /export const LEAF_CRITICAL_CSS: string =\n {2}("(?:[^"\\]|\\.)*");/.exec(
    moduleSource,
  );
  const hashMatch = /export const LEAF_CRITICAL_CSS_SHA256: string = "([^"]+)";/.exec(moduleSource);
  if (!cssMatch || !hashMatch) {
    return { ok: false, detail: "recorded bundle or hash does not parse" };
  }
  if (JSON.parse(cssMatch[1]) !== regenerated) {
    return { ok: false, detail: "recorded bundle bytes differ from regenerated sources" };
  }
  const actual = createHash("sha256").update(regenerated, "utf8").digest("base64");
  if (actual !== hashMatch[1]) {
    return { ok: false, detail: "recorded hash differs from the regenerated bundle hash" };
  }
  return { ok: true };
}

export function checkLeafLifecycleStatic(
  sources = LEAF_SOURCES.map((entry) => readFileSync(join(ROOT, entry), "utf8")),
  moduleSource = file(LEAF_MODULE_PATH),
) {
  const generatedMarker = `// GENERATED from ${LEAF_SOURCES.join(", ")}`;
  if (!moduleSource.startsWith(generatedMarker)) {
    return {
      id: "leaf-lifecycle-static",
      status: "fail",
      detail: "generated input list differs from this gate's inputs",
    };
  }
  const verdict = verifyBundleBytes(sources, moduleSource);
  if (!verdict.ok) {
    return { id: "leaf-lifecycle-static", status: "fail", detail: verdict.detail };
  }
  return { id: "leaf-lifecycle-static", status: "pass" };
}

/** The allowlist is exactly the five documented inline-critical paths. */
export function parseAllowlist(source) {
  const block = /INLINE_CRITICAL_CSS_PATHS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(source);
  if (!block) return null;
  // Literals and residual derive from ONE comment-stripped text: a
  // commented-out path must not satisfy the runtime allowlist.
  const entries = stripComments(block[1]);
  const literals = [...entries.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  // Fail closed on non-literal Set entries: a spread, identifier,
  // single-quoted or template-literal path would otherwise be invisible to
  // the literal extractor while widening the runtime allowlist. Anything
  // besides double-quoted literals, commas and whitespace rejects the pin.
  const rest = entries.replace(/"[^"]*"/g, "").replace(/[\s,]/g, "");
  if (rest.length > 0 || literals.length === 0) return null;
  return literals;
}

export function checkInlineAllowlist(source = file(HEADERS_PATH)) {
  const parsed = parseAllowlist(source);
  if (!parsed) {
    return { id: "inline-allowlist", status: "fail", detail: "allowlist does not parse" };
  }
  const expected = [...INLINE_CRITICAL_PATHS].sort();
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    return {
      id: "inline-allowlist",
      status: "fail",
      detail: `allowlist is [${parsed.join(", ")}], expected [${expected.join(", ")}]`,
    };
  }
  // Fail closed on post-definition widening: the identifier may only appear
  // in its definition and direct .has() call sites. A cast .add(), aliasing
  // or reassignment widens the runtime set while the literal stays exact.
  const withoutDefinition = stripComments(source)
    .replace(/INLINE_CRITICAL_CSS_PATHS[^=]*=\s*new Set\(\[[\s\S]*?\]\)/, " ")
    .replace(/INLINE_CRITICAL_CSS_PATHS\s*\.\s*has\s*\(/g, " ");
  if (withoutDefinition.includes("INLINE_CRITICAL_CSS_PATHS")) {
    return {
      id: "inline-allowlist",
      status: "fail",
      detail: "allowlist identifier used outside its definition and .has() calls",
    };
  }
  return { id: "inline-allowlist", status: "pass" };
}

// Row locators use stable row text, never line numbers.
const EVIDENCE_ROWS = [
  {
    marker: "X-Forwarded-Host` (or other forwarding headers)",
    pointers: ["test/host-admission-forwarding.test.ts", "ci/check-security-pins.mjs"],
  },
  {
    marker: "outside the five inline-critical paths",
    pointers: ["test/inline-style-route-sweep.test.ts", "ci/check-security-pins.mjs"],
  },
];

/** Both residual rows keep fresh pointers to these contracts. */
export function checkThreatEvidence(model = file(THREAT_MODEL_PATH)) {
  for (const row of EVIDENCE_ROWS) {
    const line = model.split("\n").find((candidate) => candidate.includes(row.marker));
    if (!line) {
      return {
        id: "threat-evidence",
        status: "fail",
        detail: `threat-model row missing: ${row.marker}`,
      };
    }
    const missing = row.pointers.filter((pointer) => !line.includes(pointer));
    if (missing.length > 0) {
      return {
        id: "threat-evidence",
        status: "fail",
        detail: `threat-model row drops pointers: ${missing.join(", ")}`,
      };
    }
  }
  return { id: "threat-evidence", status: "pass" };
}

export function matchCheckId(matchers, ancestorTitles) {
  const describe = ancestorTitles[0] ?? "";
  return matchers.find((m) => m.describe === describe)?.id ?? null;
}

export function summarizeSuite(matchers, checkIds, report) {
  const results = (report.testResults ?? []).flatMap((r) => r.assertionResults ?? []);
  const byCheck = new Map(checkIds.map((id) => [id, { passed: 0, failed: 0 }]));
  const unmapped = [];
  for (const a of results) {
    const id = matchCheckId(matchers, a.ancestorTitles ?? []);
    if (!id || !byCheck.has(id)) {
      unmapped.push([...(a.ancestorTitles ?? []), a.title].join(" > "));
      continue;
    }
    const bucket = byCheck.get(id);
    if (a.status === "passed") bucket.passed += 1;
    else bucket.failed += 1;
  }
  const checks = checkIds.map((id) => {
    const bucket = byCheck.get(id);
    const total = bucket.passed + bucket.failed;
    return {
      id,
      status: total === 0 ? "vacuous" : bucket.failed > 0 ? "fail" : "pass",
      tests: total,
    };
  });
  return {
    total: results.length,
    passed: results.filter((a) => a.status === "passed").length,
    failed: results.filter((a) => a.status !== "passed").length,
    checks,
    unmapped,
  };
}

export function runDynamic(suites = SUITES, runner = spawnSync) {
  const scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "sec-pins-"));
  const outputFile = join(scratch, "vitest.json");
  const failure = (code, next_action) => ({ code, retryable: false, next_action });
  const vitestAction = `Run npx vitest run ${suites.join(" ")} and fix the Vitest process, hooks or assertions before rerunning this check.`;
  try {
    const run = runner(
      "npx",
      ["vitest", "run", ...suites, "--reporter=json", `--outputFile=${outputFile}`],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
    );
    const execution = {
      suites,
      exitStatus: run.status ?? null,
      signal: run.signal ?? null,
      spawnError: run.error ? (run.error.code ?? run.error.name) : null,
    };
    if (!existsSync(outputFile)) {
      return { ok: false, ...execution, ...failure("suite_report_missing", vitestAction) };
    }
    let report;
    try {
      report = JSON.parse(readFileSync(outputFile, "utf8"));
    } catch {
      return { ok: false, ...execution, ...failure("suite_report_invalid", vitestAction) };
    }
    if (!report || !Array.isArray(report.testResults)) {
      return { ok: false, ...execution, ...failure("suite_report_invalid", vitestAction) };
    }
    const runOk = run.status === 0 && !run.error && !run.signal;
    const reportOk =
      report.success === true &&
      report.numFailedTestSuites === 0 &&
      report.testResults.every((result) => result.status === "passed");
    const checkIds = CHECK_MATCHERS.map((m) => m.id);
    const summary = summarizeSuite(CHECK_MATCHERS, checkIds, report);
    const ok =
      runOk &&
      reportOk &&
      summary.failed === 0 &&
      summary.unmapped.length === 0 &&
      summary.checks.every((c) => c.status === "pass");
    return {
      ok,
      ...execution,
      ...summary,
      ...(ok
        ? {}
        : failure(
            !runOk || !reportOk ? "suite_run_failed" : "suite_contract_failed",
            !runOk || !reportOk
              ? vitestAction
              : "Map every failing or unmapped assertion back to its stable check ID (host-forward-matrix, style-route-sweep, leaf-hash-lifecycle) and fix the contract or the suite; a renamed describe fails this gate on purpose.",
          )),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function run(staticOnly) {
  const staticChecks = [
    checkHostSourcePin(),
    checkLeafLifecycleStatic(),
    checkInlineAllowlist(),
    checkThreatEvidence(),
  ];
  const staticOk = staticChecks.every((c) => c.status === "pass");
  const dynamic = staticOnly ? { skipped: true } : runDynamic();
  const dynamicOk = staticOnly || dynamic.ok === true;
  const ok = staticOk && dynamicOk;
  const report = {
    check: "security-pins",
    version: 1,
    contract: "docs/threat-model.md gaps rows: forwarding-host admission, inline-style CSP",
    ok,
    static: { ok: staticOk, checks: staticChecks },
    dynamic,
  };
  if (!ok) {
    if (!staticOk) {
      const failed = staticChecks.find((c) => c.status !== "pass");
      report.error_code = "pin_violation";
      report.retryable = false;
      report.next_action = `Fix the ${failed.id} pin (${failed.detail}); see docs/security-pin-contracts.md.`;
    } else {
      report.error_code = dynamic.code;
      report.retryable = dynamic.retryable;
      report.next_action = dynamic.next_action;
    }
  }
  console.log(JSON.stringify(report, null, 2));
  console.error(
    ok
      ? `security-pins: ok (${staticChecks.length} static pins${staticOnly ? "; suites skipped" : `; suites ${dynamic.passed}/${dynamic.total} passed`})`
      : `security-pins: FAIL (${report.error_code}; see JSON report above)`,
  );
  return ok ? 0 : 1;
}

function selftest() {
  let cases = 0;
  const assert = (cond, label) => {
    cases += 1;
    if (!cond) throw new Error(`selftest case failed: ${label}`);
  };
  // Host source pin: only the Host read passes; any forwarding read fails;
  // header names inside comments are not reads; zero reads is blind, not clean.
  const hostOnly =
    '// X is deliberately ignored\nc.req.header("host") // header("x-forwarded-host")\n';
  assert(checkHostSourcePin(hostOnly).status === "pass", "host-only read passes");
  assert(checkHostSourcePin('c.req.header("host")').status === "fail", "missing marker fails");
  assert(
    checkHostSourcePin(
      '// deliberately ignored\nc.req.header("host")\nc.req.header("x-forwarded-host")',
    ).status === "fail",
    "forwarding read fails",
  );
  assert(
    checkHostSourcePin("// deliberately ignored\nc.req.header('Forwarded')").status === "fail",
    "capitalized forwarding read fails",
  );
  assert(
    checkHostSourcePin("// deliberately ignored\nno reads here").status === "fail",
    "zero reads fails blind",
  );
  assert(
    JSON.stringify(extractHeaderReads('a.header("Host"); b.header(`X-Host`);')) ===
      JSON.stringify(["host", "x-host"]),
    "reads dedupe and lowercase",
  );
  assert(
    checkHostSourcePin('// deliberately ignored\nc.req.header ("host")').status === "pass",
    "spaced host read passes",
  );
  assert(
    checkHostSourcePin('// deliberately ignored\nc.req.header ("x-forwarded-host")').status ===
      "fail",
    "spaced forwarding read fails",
  );
  assert(
    checkHostSourcePin(
      '// deliberately ignored\nconst fwd = c.req.raw.headers.get("x-original-host");\nc.req.header("host")',
    ).status === "fail",
    "raw headers.get read fails",
  );
  assert(
    checkHostSourcePin("// deliberately ignored\nc.req.raw.url").status === "fail",
    "raw request access fails",
  );
  assert(
    checkHostSourcePin('// deliberately ignored\nconst name = "host";\nc.req.header(name)')
      .status === "fail",
    "variable header name fails",
  );
  assert(
    checkHostSourcePin(
      '// deliberately ignored\nconst fwd = c.req["header"]("x-forwarded-server");\nisTrustedHost(u, [fwd ?? c.req.header("host"), urlHost])',
    ).status === "fail",
    "bracket header read fails",
  );
  assert(
    checkHostSourcePin(
      '// deliberately ignored\nconst readHeader = c.req.header.bind(c.req);\nisTrustedHost(u, [readHeader("x-forwarded-server") ?? c.req.header("host"), urlHost])',
    ).status === "fail",
    "bind-aliased header read fails",
  );
  // Lifecycle: matching bytes pass; drifted bytes or hash fail; the input
  // list must match the generated marker or the gate is checking the wrong files.
  assert(
    verifyBundleBytes(
      ["a", "b"],
      'export const LEAF_CRITICAL_CSS: string =\n  "a\\nb";\nexport const LEAF_CRITICAL_CSS_SHA256: string = "fhj3NzEbLcOy8mndeDlrA1HxT7Zu+oefdoyyMYGIPHg=";\n',
    ).ok === true,
    "matching bytes pass",
  );
  assert(
    verifyBundleBytes(
      ["a", "CHANGED"],
      'export const LEAF_CRITICAL_CSS: string =\n  "a\\nb";\nexport const LEAF_CRITICAL_CSS_SHA256: string = "fhj3NzEbLcOy8mndeDlrA1HxT7Zu+oefdoyyMYGIPHg=";\n',
    ).ok === false,
    "drifted bytes fail",
  );
  assert(
    verifyBundleBytes(
      ["a", "b"],
      'export const LEAF_CRITICAL_CSS: string =\n  "a\\nb";\nexport const LEAF_CRITICAL_CSS_SHA256: string = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";\n',
    ).ok === false,
    "wrong hash fails",
  );
  assert(verifyBundleBytes(["a"], "not a module").ok === false, "unparseable module fails");
  assert(
    checkLeafLifecycleStatic(["x"], "// GENERATED from other.css\nrest").status === "fail",
    "input-list skew fails",
  );
  // Allowlist: exactly the five paths pass; any drift or unparseable set fails.
  const allowlistSource = (entries) =>
    `const INLINE_CRITICAL_CSS_PATHS: ReadonlySet<string> = new Set([\n${entries}\n]);`;
  assert(
    checkInlineAllowlist(
      allowlistSource('  "/",\n  "/about",\n  "/faq",\n  "/rules",\n  "/privacy",'),
    ).status === "pass",
    "five paths pass",
  );
  assert(
    checkInlineAllowlist(allowlistSource('  "/",\n  "/about",')).status === "fail",
    "narrowed allowlist fails",
  );
  assert(
    checkInlineAllowlist(
      allowlistSource('  "/",\n  "/about",\n  "/faq",\n  "/rules",\n  "/privacy",\n  "/join",'),
    ).status === "fail",
    "widened allowlist fails",
  );
  assert(
    checkInlineAllowlist(
      allowlistSource(
        '  "/",\n  "/about",\n  "/faq",\n  "/rules",\n  "/privacy",\n  ...EXTRA_INLINE_PATHS,',
      ),
    ).status === "fail",
    "spread widening fails",
  );
  assert(
    checkInlineAllowlist(
      allowlistSource('  "/",\n  "/about",\n  "/faq",\n  "/rules",\n  "/privacy",\n  EXTRA_PATH,'),
    ).status === "fail",
    "identifier entry fails",
  );
  assert(
    checkInlineAllowlist(
      allowlistSource("  '/',\n  '/about',\n  '/faq',\n  '/rules',\n  '/privacy',"),
    ).status === "fail",
    "single-quoted entries fail",
  );
  assert(
    checkInlineAllowlist(
      allowlistSource('  "/",\n  "/about",\n  "/faq",\n  "/rules",\n  // "/privacy",'),
    ).status === "fail",
    "commented-out path fails",
  );
  assert(
    checkInlineAllowlist(
      `${allowlistSource('  "/",\n  "/about",\n  "/faq",\n  "/rules",\n  "/privacy",')}\n(INLINE_CRITICAL_CSS_PATHS as unknown as Set<string>).add("/profile");`,
    ).status === "fail",
    "post-definition .add widening fails",
  );
  assert(checkInlineAllowlist("no set here").status === "fail", "unparseable allowlist fails");
  // Threat evidence: both rows with both pointers pass; a missing row or a
  // dropped pointer fails.
  const evidenceModel = (forwardRow, styleRow) => ["# model", forwardRow, styleRow, ""].join("\n");
  const forwardOk =
    "| row | X-Forwarded-Host` (or other forwarding headers) ... test/host-admission-forwarding.test.ts ... ci/check-security-pins.mjs |";
  const styleOk =
    "| row | outside the five inline-critical paths ... test/inline-style-route-sweep.test.ts ... ci/check-security-pins.mjs |";
  assert(
    checkThreatEvidence(evidenceModel(forwardOk, styleOk)).status === "pass",
    "both rows with pointers pass",
  );
  assert(
    checkThreatEvidence(evidenceModel(forwardOk, "| row | other |")).status === "fail",
    "missing style row fails",
  );
  assert(
    checkThreatEvidence(
      evidenceModel(
        "| row | X-Forwarded-Host` (or other forwarding headers) ... no pointers |",
        styleOk,
      ),
    ).status === "fail",
    "dropped pointer fails",
  );
  // Matcher: exact describes map; anything else misses; vacuous and unmapped
  // summaries fail closed.
  assert(
    matchCheckId(CHECK_MATCHERS, ["host-admission forwarding contract"]) === "host-forward-matrix",
    "forwarding describe maps",
  );
  assert(
    matchCheckId(CHECK_MATCHERS, ["inline-style route sweep"]) === "style-route-sweep",
    "sweep describe maps",
  );
  assert(
    matchCheckId(CHECK_MATCHERS, ["leaf-bundle hash lifecycle"]) === "leaf-hash-lifecycle",
    "lifecycle describe maps",
  );
  assert(matchCheckId(CHECK_MATCHERS, ["Renamed describe"]) === null, "renamed describe misses");
  const summary = summarizeSuite(CHECK_MATCHERS, ["host-forward-matrix", "style-route-sweep"], {
    testResults: [
      {
        assertionResults: [
          { ancestorTitles: ["host-admission forwarding contract"], title: "t", status: "passed" },
          { ancestorTitles: ["New describe"], title: "t", status: "passed" },
        ],
      },
    ],
  });
  assert(summary.checks.find((c) => c.id === "host-forward-matrix").status === "pass", "pass maps");
  assert(
    summary.checks.find((c) => c.id === "style-route-sweep").status === "vacuous",
    "vacuous fails",
  );
  assert(summary.unmapped.length === 1, "unmapped reported");
  console.log(`security pins selftest: ${cases} cases passed.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  try {
    if (args.length === 1 && args[0] === "--selftest") process.exitCode = selftest();
    else if (args.length === 0) process.exitCode = run(false);
    else if (args.length === 1 && args[0] === "--static-only") process.exitCode = run(true);
    else {
      console.log(
        JSON.stringify(
          {
            check: "security-pins",
            version: 1,
            ok: false,
            error_code: "invalid_arguments",
            retryable: false,
            next_action:
              "Run node ci/check-security-pins.mjs with no flags (full gate), --static-only (no suites), or --selftest.",
          },
          null,
          2,
        ),
      );
      console.error("Usage: node ci/check-security-pins.mjs [--selftest] [--static-only]");
      process.exitCode = 2;
    }
  } catch (err) {
    console.log(
      JSON.stringify(
        {
          check: "security-pins",
          version: 1,
          ok: false,
          error_code: "check_error",
          retryable: false,
          next_action: `The gate itself failed: ${err instanceof Error ? err.message : err}. Fix the gate or the files it reads, then rerun.`,
        },
        null,
        2,
      ),
    );
    console.error(`security-pins: error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
