import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
    assert.ok(formatLedgerMarkdown(summary).includes(expected));
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
      assert.ok(output.includes(expected), "each output must contain the exact scrubbed reason");
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
