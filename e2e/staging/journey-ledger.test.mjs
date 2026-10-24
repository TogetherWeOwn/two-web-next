import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runGate } from "../../ci/check-staging-journeys.mjs";
import { formatLedgerMarkdown, summarizeJourneys } from "./journey-ledger.mjs";

function reportWith(specs) {
  return {
    suites: [{ title: "e2e/staging/auth.spec.ts", file: "e2e/staging/auth.spec.ts", specs }],
  };
}

function passingSpec() {
  return {
    title: "staging QA member session opens the member profile",
    file: "e2e/staging/auth.spec.ts",
    tests: [{ projectName: "chromium", status: "expected", annotations: [], results: [] }],
  };
}

function skippedSpec(title, reason) {
  return {
    title,
    file: "e2e/staging/event-rsvp.spec.ts",
    tests: [
      {
        projectName: "chromium",
        status: "skipped",
        annotations: reason ? [{ type: "skip", description: reason }] : [],
        results: [],
      },
    ],
  };
}

test("all-skipped run names every journey with its reason and fails loud", () => {
  const summary = summarizeJourneys(
    reportWith([
      skippedSpec(
        "staging member RSVPs going on a fixture, then withdraws",
        "no events on staging",
      ),
      skippedSpec("staging moderator creates a draft then cancels it without publishing", ""),
    ]),
  );
  assert.equal(summary.verdict, "all-skipped");
  assert.deepEqual(summary.counts, { total: 2, passed: 0, failed: 0, skipped: 2, flaky: 0 });
  assert.equal(summary.journeys[0].status, "skipped");
  assert.equal(summary.journeys[0].reason, "no events on staging");
  assert.equal(summary.journeys[1].reason, "no reason recorded");
  const markdown = formatLedgerMarkdown(summary);
  assert.match(markdown, /LOUD ALL-SKIPPED/);
  assert.match(markdown, /no events on staging/);
  assert.match(markdown, /no reason recorded/);
});

test("skip diagnostics remove configured tokens and member identifiers", () => {
  const token = "qa-token-canary-value";
  const summary = summarizeJourneys(
    reportWith([
      skippedSpec(
        "skipped journey",
        `email=member@example.com; memberId=123456789012345678; ${token}`,
      ),
    ]),
    { qaAuthToken: token },
  );
  const reason = summary.journeys[0].reason ?? "";
  assert.doesNotMatch(reason, /qa-token-canary-value|member@example\.com|123456789012345678/);
  assert.match(reason, /redacted/);
});

test("mixed pass and skip stays green while the skip stays visible", () => {
  const summary = summarizeJourneys(reportWith([passingSpec(), skippedSpec("journey b", "empty")]));
  assert.equal(summary.verdict, "pass");
  assert.deepEqual(summary.counts, { total: 2, passed: 1, failed: 0, skipped: 1, flaky: 0 });
  const markdown = formatLedgerMarkdown(summary);
  assert.doesNotMatch(markdown, /LOUD ALL-SKIPPED/);
  assert.match(markdown, /journey b/);
});

test("any failure is a fail verdict with the first-line reason", () => {
  const summary = summarizeJourneys(
    reportWith([
      passingSpec(),
      {
        title: "staging events list searches, clears and steps the calendar month",
        file: "e2e/staging/events-list.spec.ts",
        tests: [
          {
            projectName: "mobile-375",
            status: "unexpected",
            annotations: [],
            results: [
              { status: "failed", error: { message: "Timeout 30000ms exceeded\nCall log:\n..." } },
            ],
          },
        ],
      },
    ]),
  );
  assert.equal(summary.verdict, "fail");
  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.journeys[1].reason, "Timeout 30000ms exceeded");
  assert.equal(summary.journeys[1].project, "mobile-375");
});

test("unexpected failure reasons redact credentials and member identifiers", () => {
  const token = "qa-token-canary-value";
  const summary = summarizeJourneys(
    reportWith([
      {
        title: "unexpected journey",
        file: "e2e/staging/auth.spec.ts",
        tests: [
          {
            projectName: "chromium",
            status: "unexpected",
            annotations: [],
            results: [
              {
                status: "failed",
                error: {
                  message:
                    `Timeout: ${token}; Cookie: session=secret; email=member@example.com; ` +
                    "memberId=123456789012345678",
                },
              },
            ],
          },
        ],
      },
    ]),
    { qaAuthToken: token },
  );
  const reason = summary.journeys[0].reason ?? "";
  assert.match(reason, /Timeout/);
  assert.doesNotMatch(
    reason,
    /qa-token-canary-value|secret|member@example\.com|123456789012345678/,
  );
  assert.match(reason, /redacted/);
});

test("empty report fails closed instead of reporting green", () => {
  for (const report of [undefined, null, {}, { suites: [] }, { suites: [{ specs: [] }] }]) {
    const summary = summarizeJourneys(report);
    assert.equal(summary.verdict, "empty");
    assert.equal(summary.counts.total, 0);
    assert.match(formatLedgerMarkdown(summary), /LOUD EMPTY/);
  }
});

function flakySpec(title = "nested journey", message = "Timeout 30000ms exceeded\nCall log:\n...") {
  return {
    title,
    file: "e2e/staging/profile.spec.ts",
    tests: [
      {
        projectName: "chromium",
        status: "flaky",
        annotations: [],
        results: [{ status: "failed", error: { message } }, { status: "passed" }],
      },
    ],
  };
}

test("unexpected flaky fails closed and is not counted as a clean pass", () => {
  // Staging sets retries:0, so a flaky row is unexpected and must fail closed.
  const summary = summarizeJourneys({
    suites: [
      {
        title: "outer",
        specs: [],
        suites: [{ title: "inner", specs: [flakySpec()] }],
      },
    ],
  });
  assert.equal(summary.verdict, "fail", "flaky must fail the run, not pass");
  assert.equal(summary.counts.flaky, 1);
  assert.equal(summary.counts.passed, 0, "flaky must not count toward passed");
  assert.equal(summary.counts.failed, 1, "flaky must count toward failed");
  assert.equal(summary.counts.total, 1);
  assert.equal(summary.journeys[0].name, "nested journey [chromium]");
  assert.equal(summary.journeys[0].status, "flaky", "row keeps flaky identity for the table");
});

test("nested suites are still collected for expected journeys", () => {
  // Preserves the nested-collection behavior after the flaky verdict change.
  const summary = summarizeJourneys({
    suites: [
      {
        title: "outer",
        specs: [],
        suites: [{ title: "inner", specs: [passingSpec()] }],
      },
    ],
  });
  assert.equal(summary.verdict, "pass");
  assert.equal(summary.counts.passed, 1);
  assert.equal(
    summary.journeys[0].name,
    "staging QA member session opens the member profile [chromium]",
  );
});

test("flaky preserves first-attempt failure context as a bounded single-line reason", () => {
  const summary = summarizeJourneys(
    reportWith([flakySpec("flaky journey", "First attempt timeout\nSecond line\n...")]),
  );
  assert.equal(summary.journeys[0].status, "flaky");
  assert.equal(summary.journeys[0].reason, "First attempt timeout");
  assert.ok(summary.journeys[0].reason.length <= 200, "flaky reason stays bounded");
  assert.doesNotMatch(summary.journeys[0].reason, /[\u0000-\u001f\u007f\n]/);
  const row = formatLedgerMarkdown(summary)
    .split("\n")
    .find((line) => line.startsWith("| flaky journey"));
  assert.ok(row, "flaky row renders in markdown");
  assert.match(row ?? "", /First attempt timeout/);
});

test("flaky reasons redact common credentials and member identifiers", () => {
  const message =
    "Timeout 30000ms exceeded; Cookie: session=secret; email=member@example.com; memberId=123456789012345678";
  const summary = summarizeJourneys(reportWith([flakySpec("flaky journey", message)]));
  const reason = summary.journeys[0].reason ?? "";
  assert.match(reason, /Timeout 30000ms exceeded/);
  assert.doesNotMatch(reason, /secret|member@example\.com|123456789012345678/);
  assert.match(reason, /redacted/);
});

test("flaky reason removes the configured QA token before log or summary output", () => {
  const token = "qa-token-canary-value";
  const summary = summarizeJourneys(
    reportWith([flakySpec("flaky journey", `Timeout 30000ms exceeded: ${token}`)]),
    { qaAuthToken: token },
  );
  assert.equal(summary.journeys[0].reason, "Timeout 30000ms exceeded: [redacted token]");
});

for (const [label, message, expected] of [
  ["quoted cookie", '{"cookie": "fixture-cookie-value"}', "{[redacted credential data]"],
  [
    "quoted authorization",
    '{"authorization":"Basic fixture-basic-value"}',
    "{[redacted credential data]",
  ],
  [
    "escaped credential",
    '{\\"client_secret\\": \\"fixture-canary-value\\"}',
    "{\\[redacted credential data]",
  ],
  [
    "escaped host cookie",
    '{\\"__Host-two_oauth_state\\": \\"fixture-canary-value\\"}',
    "{\\[redacted credential data]",
  ],
  [
    "escaped member",
    '{\\"display_name\\": \\"fixture-canary-value\\"}',
    "{\\[redacted member data]",
  ],
  [
    "suffixed token",
    "GET /cb?access_token=fixture-access-value",
    "GET /cb?[redacted credential data]",
  ],
  ["hyphenated token", "refresh-token=fixture-refresh-value", "[redacted credential data]"],
  ["password", "password=fixture-password-value", "[redacted credential data]"],
  ["underscore API key", "api_key=fixture-api-value", "[redacted credential data]"],
  ["hyphenated API key", "api-key=fixture-api-value", "[redacted credential data]"],
  ["compact API key", "apikey=fixture-api-value", "[redacted credential data]"],
  ["secret", "secret=fixture-secret-value", "[redacted credential data]"],
  ["session cookie", "__Host-two_session=fixture-session-value", "[redacted credential data]"],
  ["quoted member", '{"username": "fixture-member-name"}', "{[redacted member data]"],
  ["single-quoted member", "{'username': 'fixture-member-name'}", "{[redacted member data]"],
  ["21-digit ID", "member ID 123456789012345678901", "member ID [redacted id]"],
  ["Bearer", "request failed: Bearer fixture-bearer-value", "request failed: Bearer [redacted]"],
  [
    "URL query credential",
    "request failed: https://example.com/cb?credential=fixture-query-value",
    "request failed: [redacted url]",
  ],
]) {
  test(`flaky diagnostic redacts ${label} serialization`, () => {
    const summary = summarizeJourneys(reportWith([flakySpec("flaky journey", message)]));
    assert.equal(summary.journeys[0].reason, expected);
    // Escaped fixtures keep a lone escape backslash that markdown doubles; collapse
    // doubles before comparing so the containment check stays exact (no-op otherwise).
    assert.ok(formatLedgerMarkdown(summary).replace(/\\\\/g, "\\").includes(expected));
  });
}

const hostCookieKeys = [
  "__Host-two_session",
  "__Host-two_session_status",
  "__Host-two_oauth_state",
  "__Host-two_join_state",
  "__Host-two_join_next",
  "__Host-two_join_result",
  "__Host-two_join_source",
  "__Host-two_login_next",
  "__Host-two_login_intended",
  "__Host-two_expired_write",
  "__Host-future_state",
];

const urlDiagnostics = [
  "https://example.com/members/fixture@example.com/profile?code=fixture-url-canary",
  "https://example.com/members/123456789012345678/profile?code=fixture-url-canary",
  "https://example.com/callback?qa=qa-token-canary-value&code=fixture-url-canary",
  "https://example.com/qa-token-canary-value/profile?code=fixture-url-canary",
  "https://fixture@example.com/callback?code=fixture-url-canary",
  "HTTP://example.com/members/123456789012345678901?signature=fixture-url-canary",
];

for (const url of urlDiagnostics) {
  test(`URL redaction removes the complete original span: ${url}`, () => {
    const summary = summarizeJourneys(
      reportWith([flakySpec("flaky journey", `Timeout: GET ${url}`)]),
      { qaAuthToken: "qa-token-canary-value" },
    );
    assert.equal(summary.journeys[0].reason, "Timeout: GET [redacted url]");
  });
}

test("overlapping URL and configured-token spans cannot leave either one's tail", () => {
  for (const [message, token] of [
    ["prefixhttps://example.com/path?code=fixture-url-canary", "prefixhttps://example.com"],
    ["https://example.com/path suffix-canary", "path suffix-canary"],
    ["https://example.com/a between https://example.org/b", "a between https://example.org"],
  ]) {
    const summary = summarizeJourneys(
      reportWith([flakySpec("flaky journey", `Timeout: ${message}`)]),
      { qaAuthToken: token },
    );
    assert.equal(summary.journeys[0].reason, "Timeout: [redacted url]");
  }
});

const compoundCredentialKeys = [
  ...hostCookieKeys,
  "client_secret",
  "db_password",
  "user_password",
  "app_secret",
  "clientSecret",
  "secret_key",
  "token_value",
  "passwd",
  "private_key",
  "private-key",
  "privateKey",
  "session_id",
  "sessionId",
  "client_api_key_value",
  "app-password-hash",
  "appPasswdValue",
  "refresh_token_value",
  "request_authorization",
  "response_set_cookie",
  "secret key",
  "API Key",
  "private key",
  "session id",
  "token value",
];
const memberFieldKeys = [
  "display_name",
  "display-name",
  "display name",
  "displayName",
  "user_id",
  "user-id",
  "user id",
  "userId",
  "member_id",
  "member-id",
  "member id",
  "memberId",
  "discord_id",
  "discord-id",
  "discord id",
  "discordId",
  "user_name",
  "user-name",
  "user name",
  "member_name",
  "memberName",
  "preferred_display_name",
  "cachedUserId",
  "user_id_value",
];

for (const [category, keys] of [
  ["credential", compoundCredentialKeys],
  ["member", memberFieldKeys],
]) {
  for (const key of keys) {
    test(`flaky diagnostic redacts ${category} field ${key} exactly`, () => {
      const summary = summarizeJourneys(
        reportWith([flakySpec("flaky journey", `Timeout: ${key}=fixture-canary-value`)]),
      );
      assert.equal(summary.journeys[0].reason, `Timeout: [redacted ${category} data]`);
    });
  }

  test(`${category} field serialization sweep redacts quoted keys, separators and casing`, () => {
    for (const key of keys) {
      for (const spelling of [key, key.toUpperCase()]) {
        for (const quote of ["", '"', "'"]) {
          for (const separator of ["=", ":", " : "]) {
            const message = `Timeout: {${quote}${spelling}${quote}${separator}${quote}fixture-canary-value${quote}}`;
            const summary = summarizeJourneys(reportWith([flakySpec("flaky journey", message)]));
            assert.equal(
              summary.journeys[0].reason,
              `Timeout: {[redacted ${category} data]`,
              `${category} key ${spelling}, quote ${quote}, separator ${separator}`,
            );
            assert.ok(!formatLedgerMarkdown(summary).includes("fixture-canary-value"));
          }
        }
      }
    }
  });
}

test("quoted member values with punctuation cannot leave a partial identifier", () => {
  for (const message of [
    'Timeout: {"display_name":"Fixture, Member"}',
    "Timeout: user_id='fixture;identifier'",
  ]) {
    const summary = summarizeJourneys(reportWith([flakySpec("flaky journey", message)]));
    assert.equal(
      summary.journeys[0].reason,
      message.startsWith("Timeout: {")
        ? "Timeout: {[redacted member data]"
        : "Timeout: [redacted member data]",
    );
  }
});

for (const [message, expected] of [
  ["request failed: Basic Zml4dHVyZTpvbmx5", "request failed: Basic [redacted]"],
  ["request failed: basic fixture-canary-value", "request failed: Basic [redacted]"],
  ["request failed: bAsIc fixture-canary-value", "request failed: Basic [redacted]"],
  ["request failed: BEARER fixture-canary-value", "request failed: Bearer [redacted]"],
  ["request failed: Digest fixture-canary-value", "request failed: Digest [redacted]"],
  ["request failed: Bearer: fixture-canary-value", "request failed: Bearer [redacted]"],
  ["request failed: Basic=fixture-canary-value", "request failed: Basic [redacted]"],
  ["request failed: Digest : fixture-canary-value", "request failed: Digest [redacted]"],
  ['request failed: {"Basic": "fixture-canary-value"}', "request failed: {Basic [redacted]"],
  ["request failed: {'Digest' = 'fixture-canary-value'}", "request failed: {Digest [redacted]"],
  [
    'request failed: digest username="fixture-name", realm="fixture-realm", nonce="fixture-nonce", response="fixture-response"',
    "request failed: Digest [redacted]",
  ],
]) {
  test(`standalone auth scheme is scrubbed: ${message.split(/\s+/)[2]}`, () => {
    const summary = summarizeJourneys(reportWith([flakySpec("flaky journey", message)]));
    assert.equal(summary.journeys[0].reason, expected);
  });
}

test("auth scheme delimiters do not match an unrelated word prefix", () => {
  for (const message of ["basicTimeout: exceeded", "bearerish=value", "digestion: failed"]) {
    const summary = summarizeJourneys(reportWith([flakySpec("flaky journey", message)]));
    assert.equal(summary.journeys[0].reason, message);
  }
});

test("configured token is scrubbed before the 200-character reason limit", () => {
  const token = "qa-token-canary-value";
  const prefix = `${"x".repeat(190)} `;
  const summary = summarizeJourneys(reportWith([flakySpec("flaky journey", `${prefix}${token}`)]), {
    qaAuthToken: token,
  });
  assert.equal(summary.journeys[0].reason, `${prefix}[redacted token]`.slice(0, 200));
  assert.doesNotMatch(summary.journeys[0].reason, /qa-token/);
});

test("flaky timedOut first attempt retains its exact scrubbed reason", () => {
  const spec = flakySpec(
    "timed out journey",
    "First timeout: Bearer fixture-bearer-value\nCall log",
  );
  spec.tests[0].results[0].status = "timedOut";
  const summary = summarizeJourneys(reportWith([spec]));
  assert.equal(summary.verdict, "fail");
  assert.equal(summary.journeys[0].reason, "First timeout: Bearer [redacted]");
});

test("flaky summary explains retries and config provenance must be checked", () => {
  const summary = summarizeJourneys(reportWith([flakySpec()]));
  const markdown = formatLedgerMarkdown(summary);
  assert.match(markdown, /Verdict: \*\*fail\*\*/, "flaky markdown must show fail verdict");
  assert.match(markdown, /retries/i, "summary must name retries");
  assert.match(markdown, /config|provenance|--retries/i, "summary must name config provenance");
});

test("pipe characters in names do not break the markdown table", () => {
  const summary = summarizeJourneys(reportWith([skippedSpec("a | b", "x | y")]));
  const row = formatLedgerMarkdown(summary)
    .split("\n")
    .find((line) => line.startsWith("| a"));
  assert.match(row ?? "", /a \\| b/);
  assert.match(row ?? "", /x \\| y/);
});

test("a backslash before a pipe stays one escaped cell", () => {
  const summary = summarizeJourneys(reportWith([skippedSpec("a\\|b", "x\\|y")]));
  const row = formatLedgerMarkdown(summary)
    .split("\n")
    .find((line) => line.startsWith("| a"));
  // Backslash escaped first, then the pipe: `a\\\|b` renders as one cell, so
  // the row still splits into exactly 6 segments on unescaped pipes (a live
  // pipe inside the cell would make 7).
  assert.match(row ?? "", /a\\\\\\\|b/);
  assert.equal((row ?? "").split(/(?<!\\)\|/).length, 6);
});

test("the always-run ledger upload ships only derived files, never the raw report", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/e2e-staging.yml", import.meta.url),
    "utf8",
  );
  const step = workflow
    .split(/\n {6}- name: /)
    .find((s) => s.startsWith("Journey ledger artifact"));
  assert.ok(step, "Journey ledger artifact step exists");
  // The step runs on green runs too, where the token scrub never ran, so it
  // must not upload the raw Playwright JSON report.
  // The ledger quotes failure error text, so on a failed run it must wait for
  // the scrub sweep like the failure upload does, and a scrub crash (swept
  // unset) must upload nothing. A green run (scrub skipped) still uploads.
  assert.doesNotMatch(step, /if: always\(\)/);
  assert.match(
    step,
    /if: \$\{\{ !cancelled\(\) && \(steps\.scrub\.outcome == 'skipped' \|\| steps\.scrub\.outputs\.swept == 'true'\) \}\}/,
  );
  assert.doesNotMatch(step, /staging-journeys\.json/);
  assert.match(step, /staging-journey-ledger\.json/);
  assert.match(step, /staging-journey-ledger\.md/);
});

function statusSpec(title, status) {
  return {
    title,
    file: "e2e/staging/auth.spec.ts",
    tests: [{ projectName: "chromium", status, annotations: [], results: [] }],
  };
}

test("unknown, missing or non-string statuses fail closed with bounded diagnostics", () => {
  for (const status of ["interrupted", "passed", "timedOut", "", 123, null, undefined, {}]) {
    const summary = summarizeJourneys(
      reportWith([statusSpec(`journey with ${String(status)}`, status)]),
    );
    assert.equal(summary.verdict, "fail", `status ${String(status)} must fail`);
    assert.deepEqual(summary.counts, { total: 1, passed: 0, failed: 1, skipped: 0, flaky: 0 });
    assert.equal(summary.journeys[0].status, "failed");
    assert.match(summary.journeys[0].reason ?? "", /^unknown test status: /);
    assert.ok(
      (summary.journeys[0].reason ?? "").length <= 200,
      "unknown-status reason stays bounded",
    );
    assert.doesNotMatch(summary.journeys[0].reason ?? "", /[\u0000-\u001f\u007f\n]/);
  }
});

test("unknown status diagnostics remove configured tokens and member identifiers", () => {
  const token = "qa-token-canary-value";
  const summary = summarizeJourneys(
    reportWith([
      statusSpec("unknown status", `bad-${token}-member@example.com-123456789012345678`),
    ]),
    { qaAuthToken: token },
  );
  const reason = summary.journeys[0].reason ?? "";
  assert.doesNotMatch(reason, /qa-token-canary-value|member@example\.com|123456789012345678/);
  assert.match(reason, /redacted/);
});

test("unknown-status reason stays bounded and single-line for long input", () => {
  const summary = summarizeJourneys(
    reportWith([statusSpec("long status", `x${"y".repeat(500)}|pipe`)]),
  );
  assert.equal(summary.verdict, "fail");
  assert.ok(summary.journeys[0].reason.length <= 200);
  assert.doesNotMatch(summary.journeys[0].reason, /\n/);
  const row = formatLedgerMarkdown(summary)
    .split("\n")
    .find((line) => line.startsWith("| long status"));
  assert.ok(row, "unknown-status row renders in markdown");
  assert.match(row ?? "", /unknown test status/);
});

test("expected still passes and an unknown beside it still fails the run", () => {
  const summary = summarizeJourneys(
    reportWith([passingSpec(), statusSpec("interrupted journey", "interrupted")]),
  );
  assert.equal(summary.verdict, "fail");
  assert.deepEqual(summary.counts, { total: 2, passed: 1, failed: 1, skipped: 0, flaky: 0 });
});

function gateScratch(prefix) {
  const base =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
  const dir = mkdtempSync(join(base, prefix));
  return {
    dir,
    reportPath: join(dir, "staging-journeys.json"),
    ledgerJsonPath: join(dir, "staging-journey-ledger.json"),
    ledgerMdPath: join(dir, "staging-journey-ledger.md"),
    stepSummaryPath: join(dir, "step-summary.md"),
  };
}

function gateStreams() {
  let out = "";
  let err = "";
  return {
    get out() {
      return out;
    },
    get err() {
      return err;
    },
    stdout: {
      write: (chunk) => {
        out += String(chunk);
        return true;
      },
    },
    stderr: {
      write: (chunk) => {
        err += String(chunk);
        return true;
      },
    },
  };
}

function writeReport(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

test("gate exit 0 on mixed expected and skipped with ledger and step-summary output", () => {
  const paths = gateScratch("journey-gate-pass-");
  writeReport(paths.reportPath, reportWith([passingSpec(), skippedSpec("journey b", "empty")]));
  const streams = gateStreams();
  const code = runGate({ ...paths, stdout: streams.stdout, stderr: streams.stderr });
  assert.equal(code, 0);
  const ledger = JSON.parse(readFileSync(paths.ledgerJsonPath, "utf8"));
  assert.equal(ledger.verdict, "pass");
  assert.deepEqual(ledger.counts, { total: 2, passed: 1, failed: 0, skipped: 1, flaky: 0 });
  const markdown = readFileSync(paths.ledgerMdPath, "utf8");
  assert.match(markdown, /## Staging journey ledger/);
  assert.match(markdown, /journey b/);
  const summary = readFileSync(paths.stepSummaryPath, "utf8");
  assert.match(summary, /## Staging journey ledger/);
  assert.match(streams.out, /1 passed, 0 failed, 1 skipped/);
});

test("gate exit 1 on unexpected failure and on unknown or missing status", () => {
  for (const [label, specs] of [
    ["unexpected", reportWith([passingSpec(), statusSpec("bad journey", "unexpected")])],
    ["interrupted", reportWith([passingSpec(), statusSpec("cut short", "interrupted")])],
    ["missing", reportWith([passingSpec(), statusSpec("no status", undefined)])],
    ["non-string", reportWith([passingSpec(), statusSpec("weird status", 123)])],
  ]) {
    const paths = gateScratch(`journey-gate-fail-${label}-`);
    writeReport(paths.reportPath, specs);
    const streams = gateStreams();
    const code = runGate({ ...paths, stdout: streams.stdout, stderr: streams.stderr });
    assert.equal(code, 1, `${label} must exit 1`);
    const ledger = JSON.parse(readFileSync(paths.ledgerJsonPath, "utf8"));
    assert.equal(ledger.verdict, "fail");
    assert.equal(ledger.counts.failed, 1);
    assert.match(streams.err, /Staging journeys failed/);
  }
});

test("gate exit 1 on unexpected flaky with ledger and step-summary output (negative control)", () => {
  // A flaky row must not pass: exit 1 triggers the existing failure-only scrubbed upload.
  const paths = gateScratch("journey-gate-flaky-");
  writeReport(paths.reportPath, reportWith([passingSpec(), flakySpec("flaky journey")]));
  const streams = gateStreams();
  const code = runGate({ ...paths, stdout: streams.stdout, stderr: streams.stderr });
  assert.equal(code, 1, "flaky must exit 1, not 0");
  const ledger = JSON.parse(readFileSync(paths.ledgerJsonPath, "utf8"));
  assert.equal(ledger.verdict, "fail");
  assert.equal(ledger.counts.failed, 1);
  assert.equal(ledger.counts.passed, 1, "only the expected journey counts as passed");
  assert.equal(ledger.counts.flaky, 1);
  assert.match(ledger.journeys[1].reason ?? "", /Timeout 30000ms exceeded/);
  assert.match(streams.err, /Staging journeys failed/);
  assert.match(readFileSync(paths.stepSummaryPath, "utf8"), /retries/i);
});

test("gate scrubs its environment token from every diagnostic output before any sweep", () => {
  const token = "qa-token-canary-value";
  const paths = gateScratch("journey-gate-token-");
  const failed = flakySpec("failed journey", `first failure ${token}`);
  failed.tests[0].status = "unexpected";
  writeReport(
    paths.reportPath,
    reportWith([
      flakySpec("flaky journey", `first attempt ${token}`),
      failed,
      skippedSpec("skipped journey", `skip precondition ${token}`),
      statusSpec("unknown journey", `unknown ${token}`),
    ]),
  );
  const streams = gateStreams();
  const previousToken = process.env.QA_AUTH_TOKEN;
  try {
    process.env.QA_AUTH_TOKEN = token;
    assert.equal(runGate({ ...paths, stdout: streams.stdout, stderr: streams.stderr }), 1);
  } finally {
    if (previousToken === undefined) delete process.env.QA_AUTH_TOKEN;
    else process.env.QA_AUTH_TOKEN = previousToken;
  }
  const json = readFileSync(paths.ledgerJsonPath, "utf8");
  assert.deepEqual(
    JSON.parse(json).journeys.map((journey) => journey.reason),
    [
      "first attempt [redacted token]",
      "first failure [redacted token]",
      "skip precondition [redacted token]",
      "unknown test status: unknown [redacted token]",
    ],
  );
  for (const output of [
    json,
    readFileSync(paths.ledgerMdPath, "utf8"),
    readFileSync(paths.stepSummaryPath, "utf8"),
    streams.out,
  ]) {
    assert.ok(!output.includes(token), "configured token must never reach a diagnostic output");
    assert.ok(output.includes("[redacted token]"), "each output must contain the scrubbed reason");
  }
  assert.ok(!streams.err.includes(token));
});

test("gate scrubs compound fields and auth schemes on every diagnostic path and output", () => {
  for (const [message, expected] of [
    ["client_secret=fixture-canary-value", "[redacted credential data]"],
    ['{\\"client_secret\\": \\"fixture-canary-value\\"}', "{\\[redacted credential data]"],
    ["db_password=fixture-canary-value", "[redacted credential data]"],
    ["secret_key=fixture-canary-value", "[redacted credential data]"],
    ["token_value=fixture-canary-value", "[redacted credential data]"],
    ['{"display_name":"fixture-canary-value"}', "{[redacted member data]"],
    ["user_id=fixture-canary-value", "[redacted member data]"],
    ["Basic fixture-canary-value", "Basic [redacted]"],
    ["API Key: fixture-canary-value", "[redacted credential data]"],
    ["secret key: fixture-canary-value", "[redacted credential data]"],
    ['{"Basic":"fixture-canary-value"}', "{Basic [redacted]"],
    ['Digest nonce="fixture-canary-value", opaque="fixture-canary-value"', "Digest [redacted]"],
  ]) {
    const paths = gateScratch("journey-gate-compound-");
    const failed = flakySpec("failed journey", message);
    failed.tests[0].status = "unexpected";
    writeReport(
      paths.reportPath,
      reportWith([
        flakySpec("flaky journey", message),
        failed,
        skippedSpec("skipped journey", message),
        statusSpec("unknown journey", message),
      ]),
    );
    const streams = gateStreams();
    assert.equal(runGate({ ...paths, stdout: streams.stdout, stderr: streams.stderr }), 1);
    const json = readFileSync(paths.ledgerJsonPath, "utf8");
    assert.deepEqual(
      JSON.parse(json).journeys.map((journey) => journey.reason),
      [expected, expected, expected, `unknown test status: ${expected}`],
    );
    for (const output of [
      json,
      readFileSync(paths.ledgerMdPath, "utf8"),
      readFileSync(paths.stepSummaryPath, "utf8"),
      streams.out,
    ]) {
      assert.ok(!output.includes("fixture-canary-value"), "canary must never reach an output");
      // JSON and markdown outputs double the lone escape backslash an escaped key
      // leaves behind; collapse doubles so the check stays exact (no-op otherwise).
      assert.ok(
        output.replace(/\\\\/g, "\\").includes(expected),
        "each output must contain the exact scrubbed reason",
      );
    }
    assert.ok(!streams.err.includes("fixture-canary-value"));
  }
});

test("gate removes whole URLs and host cookie values on every diagnostic path and output", () => {
  const previousToken = process.env.QA_AUTH_TOKEN;
  try {
    process.env.QA_AUTH_TOKEN = "qa-token-canary-value";
    for (const [message, expected] of [
      ...urlDiagnostics.map((url) => [`GET ${url}`, "GET [redacted url]"]),
      ...hostCookieKeys.map((key) => [
        `${key}=fixture-cookie-canary`,
        "[redacted credential data]",
      ]),
    ]) {
      const paths = gateScratch("journey-gate-url-cookie-");
      const failed = flakySpec("failed journey", message);
      failed.tests[0].status = "unexpected";
      writeReport(
        paths.reportPath,
        reportWith([
          flakySpec("flaky journey", message),
          failed,
          skippedSpec("skipped journey", message),
          statusSpec("unknown journey", message),
        ]),
      );
      const streams = gateStreams();
      assert.equal(runGate({ ...paths, stdout: streams.stdout, stderr: streams.stderr }), 1);
      const json = readFileSync(paths.ledgerJsonPath, "utf8");
      assert.deepEqual(
        JSON.parse(json).journeys.map((journey) => journey.reason),
        [expected, expected, expected, `unknown test status: ${expected}`],
      );
      for (const output of [
        json,
        readFileSync(paths.ledgerMdPath, "utf8"),
        readFileSync(paths.stepSummaryPath, "utf8"),
        streams.out,
      ]) {
        assert.doesNotMatch(output, /fixture-(?:url|cookie)-canary|qa-token-canary-value/);
        assert.ok(output.includes(expected), "each output contains the exact scrubbed reason");
      }
      assert.doesNotMatch(streams.err, /fixture-(?:url|cookie)-canary|qa-token-canary-value/);
    }
  } finally {
    if (previousToken === undefined) delete process.env.QA_AUTH_TOKEN;
    else process.env.QA_AUTH_TOKEN = previousToken;
  }
});

test("both artifact uploads have exactly the two derived ledger paths", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/e2e-staging.yml", import.meta.url),
    "utf8",
  );
  const uploads = workflow
    .split(/\n {6}- name: /)
    .filter((step) => step.includes("uses: actions/upload-artifact@"));
  assert.equal(uploads.length, 2);
  for (const step of uploads) {
    const pathBlock = step.match(/\n {10}path: \|\n([\s\S]*?)(?=\n {0,10}\S|$)/)?.[1];
    assert.ok(pathBlock, "upload must use an explicit path list");
    assert.deepEqual(
      pathBlock
        .split("\n")
        .map((path) => path.trim())
        .filter(Boolean),
      ["test-results/staging-journey-ledger.json", "test-results/staging-journey-ledger.md"],
      "no raw directories, extra files or globs may be uploaded",
    );
  }
});

test("flaky evidence uploads only via the scrubbed failure path, never raw before scrub", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/e2e-staging.yml", import.meta.url),
    "utf8",
  );
  const steps = workflow.split(/\n {6}- name: /);
  const scrub = steps.find((s) => s.startsWith("Scrub QA token from failure artifacts"));
  assert.ok(scrub, "scrub step exists");
  assert.match(scrub, /if: failure\(\)/, "scrub runs when the gate fails (flaky exits 1)");
  const failure = steps.find((s) =>
    s.startsWith("Failure traces and report (sanitized ledger only)"),
  );
  assert.ok(failure, "failure upload step exists");
  assert.match(
    failure,
    /if: failure\(\) && steps\.scrub\.outputs\.swept == 'true'/,
    "failure upload waits for a swept tree",
  );
  assert.match(failure, /staging-journey-ledger\.json/);
  assert.match(failure, /staging-journey-ledger\.md/);
  assert.doesNotMatch(failure, /staging-journeys\.json|playwright-report\/|trace\.zip|\.html/i);
  const gateStep = steps.find((s) => s.startsWith("Journey ledger (pass/skip/fail accounting)"));
  assert.ok(gateStep, "journey ledger gate exists");
  assert.match(gateStep, /QA_AUTH_TOKEN: \$\{\{ secrets\.QA_AUTH_TOKEN \}\}/);
  const ledgerStep = steps.find((s) => s.startsWith("Journey ledger artifact"));
  assert.ok(ledgerStep, "ledger artifact step exists");
  assert.match(ledgerStep, /staging-journey-ledger\.json/);
  assert.match(ledgerStep, /staging-journey-ledger\.md/);
  assert.doesNotMatch(
    ledgerStep,
    /staging-journeys\.json|playwright-report\/|test-results\/$|trace\.zip|\.html/i,
    "ledger artifact never ships raw reports, traces, or HTML",
  );
});

test("expected, failed, skipped and unknown keep explicit reasons and exit codes", () => {
  // Preservation control: only flaky changes; the other four statuses stay pinned.
  const failedSpec = {
    title: "failed journey",
    file: "e2e/staging/auth.spec.ts",
    tests: [
      {
        projectName: "chromium",
        status: "unexpected",
        annotations: [],
        results: [{ status: "failed", error: { message: "boom\nsecond line" } }],
      },
    ],
  };
  const summary = summarizeJourneys(
    reportWith([
      passingSpec(),
      failedSpec,
      skippedSpec("skipped journey", "empty staging"),
      statusSpec("unknown journey", "interrupted"),
    ]),
  );
  assert.equal(summary.verdict, "fail");
  assert.deepEqual(summary.counts, { total: 4, passed: 1, failed: 2, skipped: 1, flaky: 0 });
  assert.equal(summary.journeys[0].status, "passed");
  assert.equal(summary.journeys[0].reason, null);
  assert.equal(summary.journeys[1].status, "failed");
  assert.equal(summary.journeys[1].reason, "boom");
  assert.equal(summary.journeys[2].status, "skipped");
  assert.equal(summary.journeys[2].reason, "empty staging");
  assert.equal(summary.journeys[3].status, "failed");
  assert.match(summary.journeys[3].reason ?? "", /^unknown test status: /);
  const paths = gateScratch("journey-gate-preserve-");
  writeReport(paths.reportPath, reportWith([passingSpec(), failedSpec]));
  const streams = gateStreams();
  assert.equal(runGate({ ...paths, stdout: streams.stdout, stderr: streams.stderr }), 1);
  const passPaths = gateScratch("journey-gate-preserve-pass-");
  writeReport(passPaths.reportPath, reportWith([passingSpec(), skippedSpec("s", "empty")]));
  const passStreams = gateStreams();
  assert.equal(
    runGate({ ...passPaths, stdout: passStreams.stdout, stderr: passStreams.stderr }),
    0,
  );
});

test("gate exit 2 on unreadable, empty and all-skipped reports", () => {
  const unreadable = gateScratch("journey-gate-unreadable-");
  {
    const streams = gateStreams();
    const code = runGate({ ...unreadable, stdout: streams.stdout, stderr: streams.stderr });
    assert.equal(code, 2);
    assert.match(streams.err, /LOUD ALL-SKIPPED: no readable Playwright JSON report/);
  }
  for (const [label, report] of [
    ["empty-object", {}],
    ["empty-suites", { suites: [] }],
  ]) {
    const paths = gateScratch(`journey-gate-empty-${label}-`);
    writeReport(paths.reportPath, report);
    const streams = gateStreams();
    const code = runGate({ ...paths, stdout: streams.stdout, stderr: streams.stderr });
    assert.equal(code, 2, `${label} must exit 2`);
    const ledger = JSON.parse(readFileSync(paths.ledgerJsonPath, "utf8"));
    assert.equal(ledger.verdict, "empty");
    assert.match(readFileSync(paths.ledgerMdPath, "utf8"), /LOUD EMPTY/);
    assert.match(streams.err, /LOUD ALL-SKIPPED/);
  }
  {
    const paths = gateScratch("journey-gate-all-skipped-");
    writeReport(
      paths.reportPath,
      reportWith([skippedSpec("journey a", "no events on staging"), skippedSpec("journey b", "")]),
    );
    const streams = gateStreams();
    const code = runGate({ ...paths, stdout: streams.stdout, stderr: streams.stderr });
    assert.equal(code, 2);
    const ledger = JSON.parse(readFileSync(paths.ledgerJsonPath, "utf8"));
    assert.equal(ledger.verdict, "all-skipped");
    assert.match(readFileSync(paths.stepSummaryPath, "utf8"), /LOUD ALL-SKIPPED/);
    assert.match(streams.err, /LOUD ALL-SKIPPED/);
  }
});

test("critical-journeys guide explains flaky fail-closed accounting with zero retries and no rerun-until-green", () => {
  const guide = readFileSync(new URL("../../docs/critical-journeys.md", import.meta.url), "utf8");
  const stagingConfig = readFileSync(
    new URL("../../playwright.staging.config.ts", import.meta.url),
    "utf8",
  );
  const normalizedGuide = guide.replace(/\s+/g, " ");
  const sectionStart = guide.indexOf("Ledger statuses map");
  assert.ok(sectionStart !== -1, "ledger section exists");
  const normalizedSection = guide.slice(sectionStart).replace(/\s+/g, " ");
  assert.match(stagingConfig, /retries:\s*0/);
  for (const status of ["`expected`", "`flaky`", "`unexpected`", "`skipped`"]) {
    assert.ok(guide.includes(status), `guide must name ${status}`);
  }
  assert.match(guide, /unknown test status/);
  // Flaky fails closed: not counted as passed, verdict fail.
  assert.match(
    normalizedSection,
    /`flaky`.*does not count toward `passed`/i,
    "guide must say flaky does not count toward passed",
  );
  assert.match(normalizedSection, /flaky.*fails? closed/i, "guide must say flaky fails closed");
  assert.doesNotMatch(
    normalizedSection,
    /counts toward `passed` in the headline and CLI line; the separate `flaky` count appears only/,
    "old pass-counting sentence must be gone",
  );
  // First-attempt reason preserved in the scrubbed ledger.
  assert.match(
    normalizedSection,
    /flaky row preserv/i,
    "guide must say the flaky row preserves its reason",
  );
  assert.match(
    normalizedSection,
    /preserv(es|ed).*first-attempt/i,
    "guide must tie the preserved reason to the first attempt",
  );
  assert.match(
    normalizedSection,
    /flaky.*scrub/i,
    "guide must say flaky evidence uses the scrubbed path",
  );
  assert.doesNotMatch(
    normalizedSection,
    /has no reason and does not trigger/,
    "old no-reason sentence must be gone",
  );
  assert.doesNotMatch(
    normalizedSection,
    /before trusting the pass/,
    "flaky must not be described as a pass to trust",
  );
  assert.ok(
    normalizedSection.includes(
      "The staging config sets `retries: 0` (`playwright.staging.config.ts`), so a report from this config cannot legitimately contain `flaky`.",
    ),
    "guide must keep the retries:0 provenance note",
  );
  assert.match(normalizedSection, /--retries.*override|report produced by another config/i);
  assert.match(normalizedGuide, /`e2e-staging-failure-\*` artifact, retained for seven days/);
  assert.match(normalizedGuide, /documented host-flake loop/);
  assert.match(guide, /[Nn]ever rerun-until-green/);
});

test("gate without a step summary still writes ledger files and exits by verdict", () => {
  const paths = gateScratch("journey-gate-no-summary-");
  writeReport(paths.reportPath, reportWith([passingSpec()]));
  const streams = gateStreams();
  const code = runGate({
    reportPath: paths.reportPath,
    ledgerJsonPath: paths.ledgerJsonPath,
    ledgerMdPath: paths.ledgerMdPath,
    stepSummaryPath: "",
    stdout: streams.stdout,
    stderr: streams.stderr,
  });
  assert.equal(code, 0);
  assert.match(readFileSync(paths.ledgerMdPath, "utf8"), /## Staging journey ledger/);
});

// Independent diagnostic acceptance contract. Deliberate breaks caught below:
// ignored runner errors, unchecked collections, unbounded traversal/input/output,
// early returns without receipts, raw diagnostic leakage, and unstable identities.
// schemaVersion is a positive integer; diagnostics use fixed code/count/retryable/
// next_action fields. Provenance uses sha/runId/runAttempt, with literal "unknown".
// These tests impose generous safety ceilings, not the implementation's exact limits.
const diagnosticCli = fileURLToPath(
  new URL("../../ci/check-staging-journeys.mjs", import.meta.url),
);
const diagnosticCanary = "fixture-diagnostic-canary";
const diagnosticCounts = { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 };

function diagnosticSummary(report) {
  let summary;
  assert.doesNotThrow(() => {
    summary = summarizeJourneys(report);
  }, "invalid input must produce a non-pass summary, not a traversal exception");
  return summary;
}

function assertDiagnostic(ledger, code, count) {
  assert.ok(Array.isArray(ledger.diagnostics), "ledger exposes structured diagnostics");
  assert.ok(ledger.diagnostics.length <= 32, "diagnostic entries have a fixed small cap");
  const diagnostic = ledger.diagnostics.find((entry) => entry.code === code);
  assert.ok(diagnostic, `missing stable diagnostic code ${code}`);
  assert.equal(typeof diagnostic.retryable, "boolean");
  assert.equal(typeof diagnostic.next_action, "string");
  assert.ok(diagnostic.next_action.trim().length > 0, "diagnostic gives a recovery action");
  assert.ok(diagnostic.next_action.length <= 240, "recovery action is bounded");
  assert.doesNotMatch(diagnostic.next_action, /[\u0000-\u001f\u007f]/);
  assert.ok(Number.isSafeInteger(diagnostic.count) && diagnostic.count > 0);
  assert.ok(diagnostic.count <= 10000, "diagnostic count is bounded");
  if (count !== undefined) assert.equal(diagnostic.count, count);
}

function diagnosticRun(
  t,
  {
    report,
    raw,
    missing = false,
    directory = false,
    env = {},
    help = false,
    splitOutputs = false,
    reportName,
  } = {},
) {
  const paths = gateScratch("journey-diagnostic-acceptance-");
  t.after(() => rmSync(paths.dir, { recursive: true, force: true }));
  if (reportName) paths.reportPath = join(paths.dir, reportName);
  if (splitOutputs) {
    paths.ledgerJsonPath = join(paths.dir, "json", "ledger.json");
    paths.ledgerMdPath = join(paths.dir, "markdown", "ledger.md");
  }
  if (directory) mkdirSync(paths.reportPath);
  else if (!missing) writeFileSync(paths.reportPath, raw ?? JSON.stringify(report));
  const fencePath = join(paths.dir, "effect-fence.cjs");
  const effectsPath = join(paths.dir, "unexpected-effects.txt");
  // Child-only tripwire: a fixture receipt may read/write local files, but must
  // never make a socket connection, fetch, or launch a deploy/other subprocess.
  writeFileSync(
    fencePath,
    `const fs = require('node:fs');
const deny = () => {
  fs.appendFileSync(${JSON.stringify(effectsPath)}, 'unexpected external effect\\n');
  throw new Error('fixture external-effect fence');
};
globalThis.fetch = deny;
for (const [name, methods] of [
  ['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
  ['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']],
  ['node:dgram', ['createSocket']], ['node:dns', ['lookup', 'resolve']],
  ['node:child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
]) for (const method of methods) require(name)[method] = deny;
require('node:net').Socket.prototype.connect = deny;
require('node:module').syncBuiltinESMExports();
`,
  );
  const args = help
    ? ["--help"]
    : [
        "--report",
        paths.reportPath,
        "--out-json",
        paths.ledgerJsonPath,
        "--out-md",
        paths.ledgerMdPath,
      ];
  const child = spawnSync(process.execPath, ["--require", fencePath, diagnosticCli, ...args], {
    cwd: paths.dir,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 1024 * 1024,
    // Do not inherit real tokens, database URLs, Node preloads or target settings.
    env: {
      PATH: process.env.PATH,
      HOME: paths.dir,
      TZ: "UTC",
      LANG: "C",
      GITHUB_STEP_SUMMARY: paths.stepSummaryPath,
      QA_AUTH_TOKEN: diagnosticCanary,
      ...env,
    },
  });
  assert.equal(child.error, undefined, "CLI must finish within time/output budgets");
  assert.equal(child.signal, null, "CLI must exit normally, not from a signal");
  assert.equal(
    existsSync(effectsPath),
    false,
    "fixture mode must make no external effect attempts",
  );
  return { paths, ...child };
}

function diagnosticReceipt(run) {
  assert.ok(existsSync(run.paths.ledgerJsonPath), "every input verdict writes the JSON receipt");
  assert.ok(existsSync(run.paths.ledgerMdPath), "every input verdict writes the Markdown receipt");
  assert.ok(existsSync(run.paths.stepSummaryPath), "every input verdict appends a step summary");
  const json = readFileSync(run.paths.ledgerJsonPath, "utf8");
  const markdown = readFileSync(run.paths.ledgerMdPath, "utf8");
  const step = readFileSync(run.paths.stepSummaryPath, "utf8");
  const ledger = JSON.parse(json);
  assert.ok(
    Number.isSafeInteger(ledger.schemaVersion) && ledger.schemaVersion >= 1,
    "receipt is versioned",
  );
  assert.ok(Array.isArray(ledger.journeys));
  for (const value of Object.values(ledger.counts)) {
    assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= 10000, "counts stay bounded");
  }
  assert.match(markdown, /## Staging journey ledger/);
  assert.ok(step.includes(markdown.trim()), "step summary contains the same receipt");
  assert.doesNotMatch(
    `${run.stdout}\n${run.stderr}`,
    /\n\s+at .+:\d+:\d+|TypeError:|RangeError:|SyntaxError:/,
  );
  return { ledger, json, markdown, step };
}

for (const [label, specs, verdict, exit, counts] of [
  ["clean", [passingSpec()], "pass", 0, diagnosticCounts],
  [
    "mixed",
    [passingSpec(), skippedSpec("optional journey", "no fixture")],
    "pass",
    0,
    { total: 2, passed: 1, failed: 0, skipped: 1, flaky: 0 },
  ],
  [
    "flaky negative control",
    [flakySpec()],
    "fail",
    1,
    { total: 1, passed: 0, failed: 1, skipped: 0, flaky: 1 },
  ],
  [
    "failed",
    [statusSpec("failed journey", "unexpected")],
    "fail",
    1,
    { total: 1, passed: 0, failed: 1, skipped: 0, flaky: 0 },
  ],
  [
    "unknown",
    [statusSpec("unknown journey", "interrupted")],
    "fail",
    1,
    { total: 1, passed: 0, failed: 1, skipped: 0, flaky: 0 },
  ],
  [
    "all skipped",
    [skippedSpec("optional journey", "no fixture")],
    "all-skipped",
    2,
    { total: 1, passed: 0, failed: 0, skipped: 1, flaky: 0 },
  ],
  ["empty", [], "empty", 2, { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 }],
]) {
  test(`diagnostic control: ${label} preserves actual CLI exit and journey accounting`, (t) => {
    const run = diagnosticRun(t, { report: { ...reportWith(specs), errors: [] } });
    assert.equal(run.status, exit);
    assert.deepEqual(JSON.parse(readFileSync(run.paths.ledgerJsonPath, "utf8")).counts, counts);
    assert.equal(JSON.parse(readFileSync(run.paths.ledgerJsonPath, "utf8")).verdict, verdict);
  });
}

for (const errors of [
  [{ message: "Global teardown did not finish" }],
  [{ message: "Runner initialization failed" }, { message: "Global teardown failed" }],
]) {
  const report = { ...reportWith([passingSpec()]), errors };
  test(`diagnostic acceptance: ${errors.length} runner errors override otherwise passing rows`, () => {
    const summary = diagnosticSummary(report);
    assert.equal(summary.verdict, "fail", "runner failure must never be a clean pass");
    assert.deepEqual(
      summary.counts,
      diagnosticCounts,
      "runner errors are not invented failed journeys",
    );
    assertDiagnostic(summary, "runner_error", errors.length);
  });
  test(`diagnostic acceptance: CLI exits 1 with a receipt for ${errors.length} runner errors`, (t) => {
    const run = diagnosticRun(t, { report });
    assert.equal(run.status, 1);
    const { ledger, markdown } = diagnosticReceipt(run);
    assertDiagnostic(ledger, "runner_error", errors.length);
    assert.ok(markdown.includes("runner_error"));
    assert.doesNotMatch(markdown, /Verdict: \*\*pass\*\*/);
  });
}

const malformedReports = [
  ["suites object", { suites: {} }],
  ["suites string", { suites: "not an array" }],
  ["suites null", { suites: null }],
  ["null suite", { suites: [null] }],
  ["specs object", { suites: [{ specs: {} }] }],
  ["specs null", { suites: [{ specs: null }] }],
  ["null spec", { suites: [{ specs: [null] }] }],
  ["tests object", reportWith([{ ...passingSpec(), tests: {} }])],
  ["tests null", reportWith([{ ...passingSpec(), tests: null }])],
  ["null test", reportWith([{ ...passingSpec(), tests: [null] }])],
  [
    "results object",
    reportWith([{ ...passingSpec(), tests: [{ status: "expected", results: {} }] }]),
  ],
  [
    "results null",
    reportWith([{ ...passingSpec(), tests: [{ status: "expected", results: null }] }]),
  ],
  [
    "null result",
    reportWith([{ ...passingSpec(), tests: [{ status: "expected", results: [null] }] }]),
  ],
  [
    "annotations object",
    reportWith([{ ...passingSpec(), tests: [{ status: "skipped", annotations: {} }] }]),
  ],
  [
    "annotations null",
    reportWith([{ ...passingSpec(), tests: [{ status: "skipped", annotations: null }] }]),
  ],
  [
    "null annotation",
    reportWith([{ ...passingSpec(), tests: [{ status: "skipped", annotations: [null] }] }]),
  ],
  ["errors object", { suites: [], errors: {} }],
  ["errors null", { suites: [], errors: null }],
  ["null runner error", { suites: [], errors: [null] }],
];

for (const [label, badReport] of malformedReports) {
  const report = {
    suites: [
      ...reportWith([passingSpec()]).suites,
      { title: "broken branch", suites: badReport.suites },
      ...reportWith([{ ...passingSpec(), title: "healthy sibling after invalid branch" }]).suites,
    ],
    ...(Object.hasOwn(badReport, "errors") ? { errors: badReport.errors } : {}),
  };
  test(`diagnostic acceptance: malformed ${label} retains good sibling rows and fails closed`, () => {
    const summary = diagnosticSummary(report);
    assert.equal(summary.verdict, "fail", "partial input is never clean");
    assert.ok(
      summary.journeys.some(
        (row) => row.name === "staging QA member session opens the member profile [chromium]",
      ),
    );
    assert.ok(
      summary.journeys.some(
        (row) => row.name === "healthy sibling after invalid branch [chromium]",
      ),
    );
    assertDiagnostic(summary, "report_invalid_shape");
  });
  test(`diagnostic acceptance: CLI handles malformed ${label} without raw stacks or losing good rows`, (t) => {
    const run = diagnosticRun(t, { report });
    assert.equal(run.status, 2, "malformed reports use the input-error exit, not a process crash");
    const { ledger } = diagnosticReceipt(run);
    assertDiagnostic(ledger, "report_invalid_shape");
    assert.equal(ledger.verdict, "fail");
    assert.ok(
      ledger.journeys.some(
        (row) => row.name === "staging QA member session opens the member profile [chromium]",
      ),
    );
    assert.ok(
      ledger.journeys.some((row) => row.name === "healthy sibling after invalid branch [chromium]"),
    );
  });
}

for (const [label, input, code] of [
  ["missing file", { missing: true }, "report_unreadable"],
  ["directory instead of file", { directory: true }, "report_unreadable"],
  ["invalid JSON", { raw: `{\"${diagnosticCanary}\":` }, "report_invalid_json"],
  ["empty file", { raw: "" }, "report_invalid_json"],
  ["root array", { report: [] }, "report_invalid_shape"],
  ["root scalar", { report: 3 }, "report_invalid_shape"],
  ["root null", { report: null }, "report_invalid_shape"],
]) {
  test(`diagnostic acceptance: ${label} writes an honest empty diagnostic receipt`, (t) => {
    const run = diagnosticRun(t, input);
    assert.equal(run.status, 2);
    const { ledger, json, markdown, step } = diagnosticReceipt(run);
    assert.notEqual(ledger.verdict, "pass");
    assert.deepEqual(ledger.counts, { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 });
    assert.deepEqual(ledger.journeys, [], "unreadable input cannot fabricate completed journeys");
    assertDiagnostic(ledger, code);
    assert.ok(markdown.includes(code), "Markdown gives the same actionable error code");
    assert.doesNotMatch(
      [json, markdown, step, run.stdout, run.stderr].join("\n"),
      /fixture-diagnostic-canary/,
    );
  });
}

for (const [label, report, code] of [
  [
    "deep suites",
    (() => {
      let node = { specs: [passingSpec()] };
      for (let depth = 0; depth < 2048; depth += 1) node = { suites: [node] };
      return { suites: [node] };
    })(),
    "report_too_deep",
  ],
  [
    "deep ignored metadata",
    (() => {
      let metadata = {};
      for (let depth = 0; depth < 2048; depth += 1) metadata = { nested: metadata };
      return { ...reportWith([passingSpec()]), metadata };
    })(),
    "report_too_deep",
  ],
  [
    "oversized valid JSON",
    { ...reportWith([passingSpec()]), metadata: { padding: "x".repeat(16 * 1024 * 1024) } },
    "report_too_large",
  ],
]) {
  test(`diagnostic acceptance: ${label} is bounded with a diagnostic, not a stack or pass`, (t) => {
    const run = diagnosticRun(t, { report });
    assert.equal(run.status, 2);
    const { ledger, json, markdown, step } = diagnosticReceipt(run);
    assert.notEqual(ledger.verdict, "pass");
    assertDiagnostic(ledger, code);
    for (const output of [json, markdown, step, run.stdout, run.stderr]) {
      assert.ok(
        Buffer.byteLength(output) <= 64 * 1024,
        "rejected input produces only a bounded receipt",
      );
    }
  });
}

test("diagnostic acceptance: many runner errors are aggregated without unbounded copies", (t) => {
  const report = {
    ...reportWith([passingSpec()]),
    errors: Array.from({ length: 4096 }, () => ({ message: `teardown ${diagnosticCanary}` })),
  };
  const run = diagnosticRun(t, { report });
  assert.equal(run.status, 1);
  const { ledger, json, markdown } = diagnosticReceipt(run);
  assertDiagnostic(ledger, "runner_error", 4096);
  assert.deepEqual(ledger.counts, diagnosticCounts);
  assert.ok(Buffer.byteLength(json) + Buffer.byteLength(markdown) <= 64 * 1024);
  assert.doesNotMatch(
    [json, markdown, run.stdout, run.stderr].join("\n"),
    /fixture-diagnostic-canary/,
  );
});

test("diagnostic acceptance: global errors emit only safe fields, never raw report content", (t) => {
  const rawError = {
    message: `teardown ${diagnosticCanary}; https://example.com/private/member?cookie=fixture-url-canary`,
    stack: "Error: fixture-stack-canary\n    at private-member-file:1:2",
    value: "Cookie: session=fixture-cookie-canary; memberId=123456789012345678",
    snippet: "member@example.com fixture-member-canary",
    location: { file: "fixture-location-canary", line: 1, column: 2 },
  };
  const run = diagnosticRun(t, {
    report: {
      ...reportWith([passingSpec()]),
      errors: [rawError],
      config: { private: "fixture-config-canary" },
    },
  });
  assert.equal(run.status, 1);
  const { ledger, json, markdown, step } = diagnosticReceipt(run);
  assertDiagnostic(ledger, "runner_error", 1);
  const emitted = [json, markdown, step, run.stdout, run.stderr].join("\n");
  assert.doesNotMatch(
    emitted,
    /fixture-(?:diagnostic|url|stack|cookie|member|location|config)-canary|member@example\.com|123456789012345678|https:\/\/example\.com\/private/,
  );
  for (const diagnostic of ledger.diagnostics) {
    assert.ok(
      Object.keys(diagnostic).every((key) =>
        ["code", "count", "retryable", "next_action"].includes(key),
      ),
      "runner diagnostics are allowlisted, not copied report objects",
    );
  }
});

test("diagnostic acceptance: new runner-error handling preserves scrubbed flaky first-attempt context", (t) => {
  const run = diagnosticRun(t, {
    report: {
      ...reportWith([
        flakySpec(
          "flaky journey",
          `First timeout: ${diagnosticCanary}; Cookie: fixture-cookie-canary\nprivate second line`,
        ),
      ]),
      errors: [{ message: `teardown ${diagnosticCanary}` }],
    },
  });
  assert.equal(run.status, 1);
  const { ledger, json, markdown, step } = diagnosticReceipt(run);
  assert.equal(ledger.journeys[0].status, "flaky");
  assert.equal(ledger.counts.flaky, 1);
  assert.equal(ledger.counts.passed, 0);
  assert.match(ledger.journeys[0].reason, /^First timeout: \[redacted token\]/);
  assert.doesNotMatch(
    [json, markdown, step, run.stdout, run.stderr].join("\n"),
    /fixture-diagnostic-canary|fixture-cookie-canary|private second line/,
  );
});

test("diagnostic acceptance: identical inputs produce byte-identical JSON and Markdown receipts", (t) => {
  const report = { ...reportWith([passingSpec()]), errors: [{ message: "teardown failed" }] };
  const env = { GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "987654321", GITHUB_RUN_ATTEMPT: "2" };
  const first = diagnosticRun(t, { report, env });
  const second = diagnosticRun(t, { report, env });
  assert.equal(first.status, 1);
  assert.equal(second.status, 1);
  const a = diagnosticReceipt(first);
  const b = diagnosticReceipt(second);
  assert.equal(a.json, b.json, "no wall-clock, output directory, or random IDs in the ledger");
  assert.equal(a.markdown, b.markdown);
  assert.deepEqual(a.ledger.provenance, {
    sha: "a".repeat(40),
    runId: "987654321",
    runAttempt: "2",
  });
});

test("diagnostic acceptance: absent run provenance is explicit unknown, never guessed", (t) => {
  const run = diagnosticRun(t, { report: reportWith([passingSpec()]) });
  assert.equal(run.status, 0);
  assert.deepEqual(diagnosticReceipt(run).ledger.provenance, {
    sha: "unknown",
    runId: "unknown",
    runAttempt: "unknown",
  });
});

test("diagnostic acceptance: journey IDs survive reorder, status change and different run provenance", (t) => {
  const a = passingSpec();
  const b = { ...passingSpec(), title: "second journey" };
  const c = { ...passingSpec(), file: "e2e/staging/profile.spec.ts" };
  const d = { ...passingSpec(), tests: [{ ...passingSpec().tests[0], projectName: "mobile-375" }] };
  const first = diagnosticRun(t, { report: reportWith([a, b, c, d]) });
  const failedA = { ...a, tests: [{ ...a.tests[0], status: "unexpected" }] };
  const second = diagnosticRun(t, {
    report: reportWith([d, c, b, failedA]),
    env: { GITHUB_SHA: "b".repeat(40), GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "3" },
  });
  assert.equal(first.status, 0);
  assert.equal(second.status, 1);
  const left = diagnosticReceipt(first).ledger.journeys;
  const right = diagnosticReceipt(second).ledger.journeys;
  assert.equal(left.length, 4);
  assert.equal(right.length, 4);
  for (const row of [...left, ...right]) {
    assert.equal(typeof row.id, "string");
    assert.match(row.id, /^[a-zA-Z0-9_.:-]{1,128}$/);
  }
  assert.equal(
    new Set(left.map((row) => row.id)).size,
    4,
    "file/title/project distinguish identities",
  );
  assert.deepEqual(
    left.map((row) => row.id),
    right.map((row) => row.id).reverse(),
  );
});

test("diagnostic acceptance: help is effect-free and discovers the contract and hermetic check", (t) => {
  const run = diagnosticRun(t, { missing: true, help: true });
  assert.equal(run.status, 0, "help succeeds without a report, credentials or a target");
  assert.equal(run.stderr, "");
  assert.ok(
    run.stdout.includes("docs/critical-journeys.md"),
    "help links the existing contract entry point",
  );
  const check = "node --test e2e/staging/journey-ledger.test.mjs";
  assert.ok(run.stdout.includes(check), "help gives one fixture-only check command");
  const guide = readFileSync(new URL("../../docs/critical-journeys.md", import.meta.url), "utf8");
  assert.ok(guide.includes(check), "the contract entry point discovers the same runnable check");
  assert.equal(existsSync(run.paths.ledgerJsonPath), false);
  assert.equal(existsSync(run.paths.ledgerMdPath), false);
  assert.equal(existsSync(run.paths.stepSummaryPath), false);
});

for (const [label, input] of [
  ["missing", { missing: true, reportName: `${diagnosticCanary}.json` }],
  ["invalid", { raw: `{"token":"${diagnosticCanary}"` }],
]) {
  test(`diagnostic acceptance: ${label} receipts are deterministic and withhold input paths/content`, (t) => {
    const first = diagnosticRun(t, input);
    const second = diagnosticRun(t, input);
    assert.equal(first.status, 2);
    assert.equal(second.status, 2);
    const a = diagnosticReceipt(first);
    const b = diagnosticReceipt(second);
    assert.equal(a.json, b.json);
    assert.equal(a.markdown, b.markdown);
    assert.doesNotMatch(
      [
        a.json,
        a.markdown,
        a.step,
        first.stdout,
        first.stderr,
        b.json,
        b.markdown,
        b.step,
        second.stdout,
        second.stderr,
      ].join("\n"),
      /fixture-diagnostic-canary/,
    );
  });
}

test("diagnostic acceptance: separate new output directories both receive the receipt", (t) => {
  const run = diagnosticRun(t, { report: reportWith([passingSpec()]), splitOutputs: true });
  assert.equal(run.status, 0);
  assert.equal(diagnosticReceipt(run).ledger.verdict, "pass");
});
