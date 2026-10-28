#!/usr/bin/env node
// Authenticated perf gate: server-response budgets for the session-cookie
// journeys the guest Lighthouse gate never covers (docs/performance-budgets.md:
// the fixture worker refuses authenticated requests, so member/admin latency
// has no lighthouse/bundle coverage).
//
// Journeys (ci/auth-perf-budget.json): member-rsvp (GET /e/:key with a member
// session cookie) and moderator-admin (GET /admin/events with a moderator
// session cookie). Each sample asserts status 200 AND authenticated content
// (member chrome / admin chrome, never the guest banner), then records the
// elapsed time; the median and the slowest sample must fit the ceilings.
//
// Two modes, like ci/kit-parity-gates.mjs:
// - --selftest (default in `npm run check`): hermetic. Validates the shipped
//   budget file shape, proves every assertion passes on good fixtures AND
//   fails on planted mutants (slow sample, cookie-stripped guest body,
//   bounce/refusal status), and proves malformed budgets fail closed.
//   No database, no browser, no network, no secrets.
// - Live (AUTH_PERF_URL set): mints one QA session per journey identity via
//   POST /auth/qa/:identity (exactly two logins against the shared qa-login
//   throttle), replays the __Host-two_session cookie over local HTTPS, times
//   `samples` reads per journey (following Set-Cookie rotation like the
//   browser journeys do), and writes a secret-free ledger to test-results/.
//   --mutant no-cookie strips the cookie to prove the gate goes red without it.
//
// Exit codes: 0 pass, 1 journeys failed, 2 misconfigured (missing env, bad
// budget, QA login refused) or empty ledger.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repoRoot = resolve(new URL("../", import.meta.url).pathname);

export const JOURNEY_IDS = ["member-rsvp", "moderator-admin"];

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const SECRET_PATTERNS = [/__Host-two_session\s*=/, /X-TWO-QA-Auth/i, /Bearer\s+[A-Za-z0-9._-]+/];

export function scrubSecrets(text) {
  const hits = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) hits.push(String(pattern));
  }
  return hits;
}

export function loadBudget(root = repoRoot) {
  let budget;
  try {
    budget = JSON.parse(readFileSync(join(root, "ci/auth-perf-budget.json"), "utf8"));
  } catch {
    return { error: "auth perf budget: cannot enforce: unreadable or invalid budget" };
  }
  if (!isObject(budget) || !Number.isSafeInteger(budget.samples) || budget.samples < 5) {
    return { error: "auth perf budget: cannot enforce: samples must be an integer of at least 5" };
  }
  if (!isObject(budget.journeys)) {
    return { error: "auth perf budget: cannot enforce: journeys must be an object" };
  }
  for (const id of JOURNEY_IDS) {
    const entry = budget.journeys[id];
    if (
      !isObject(entry) ||
      typeof entry.path !== "string" ||
      !entry.path.startsWith("/") ||
      (entry.identity !== "qa-member" && entry.identity !== "qa-moderator") ||
      !Number.isSafeInteger(entry.maxMedianMs) ||
      entry.maxMedianMs <= 0 ||
      !Number.isSafeInteger(entry.maxSingleMs) ||
      entry.maxSingleMs <= 0 ||
      entry.maxSingleMs < entry.maxMedianMs
    ) {
      return { error: `auth perf budget: cannot enforce: invalid journey entry: ${id}` };
    }
  }
  return { budget };
}

// Member detail content: the personalized read proves the session cookie was
// honored. A published event answers 200 to guests too, so status alone is
// not session proof: the member render carries the account chrome (username +
// Sign out) while the guest render carries the anonymous banner and the join
// pitch. A cookie-stripped fetch must fail here, never read green.
export function assertMemberHtml(html) {
  const failures = [];
  if (!html.includes("Sign out"))
    failures.push("member detail must show the signed-in account chrome");
  if (html.includes("Welcome, guest"))
    failures.push("member detail must not show the guest banner");
  if (!html.includes("event-going-count") && !html.includes("rsvp-going"))
    failures.push("member detail must render the RSVP aggregate or control");
  return failures;
}

// Admin list content: behind adminGuard, so a guest bounce (302) or a member
// refusal (403) never reaches this helper with a 200. The body pin is the
// second net: admin chrome with no guest banner and no canonical URL.
export function assertAdminHtml(html) {
  const failures = [];
  if (!html.includes('aria-label="Administration"'))
    failures.push("admin list must show the administration nav");
  if (!html.includes("moderators only")) failures.push("admin list must show the moderator footer");
  if (html.includes("Welcome, guest")) failures.push("admin list must not show guest chrome");
  if (html.includes('<link rel="canonical"')) failures.push("admin list carries no canonical URL");
  return failures;
}

export function assertJourney({ id, samples, budget }) {
  const failures = [];
  if (samples.length === 0) {
    failures.push(`${id}: no samples measured`);
    return failures;
  }
  const assertHtml = id === "member-rsvp" ? assertMemberHtml : assertAdminHtml;
  for (const [index, sample] of samples.entries()) {
    if (sample.status !== 200) {
      failures.push(`${id} sample ${index}: status ${sample.status} !== 200`);
      continue;
    }
    const contentType = sample.contentType ?? "";
    if (!/text\/html/.test(contentType))
      failures.push(`${id} sample ${index}: content-type ${contentType} is not HTML`);
    for (const failure of assertHtml(sample.html))
      failures.push(`${id} sample ${index}: ${failure}`);
    if (!Number.isFinite(sample.elapsedMs) || sample.elapsedMs < 0)
      failures.push(`${id} sample ${index}: elapsedMs ${sample.elapsedMs} is not measurable`);
    else if (sample.elapsedMs > budget.maxSingleMs)
      failures.push(
        `${id} sample ${index}: ${sample.elapsedMs}ms over the single-sample ceiling ${budget.maxSingleMs}ms`,
      );
  }
  const timed = samples
    .map((sample) => sample.elapsedMs)
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  if (timed.length > 0) {
    const med = median(timed);
    if (med > budget.maxMedianMs)
      failures.push(`${id}: median ${med}ms over the ceiling ${budget.maxMedianMs}ms`);
  }
  return failures;
}

function firstSessionCookie(setCookieText) {
  const pair = (setCookieText ?? "")
    .split("\n")
    .map((line) => line.split(";")[0]?.trim())
    .find((line) => line?.startsWith("__Host-two_session="));
  return pair ?? null;
}

// Resource bounds, not performance budgets: timing still ends at headers.
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1_048_576;
const ERRORS = {
  transport_timeout: [
    true,
    "Check transport availability before starting a new probe; no automatic retry.",
  ],
  transport_error: [
    true,
    "Check transport configuration and availability; no credential substitution or automatic retry.",
  ],
  body_read_failed: [
    true,
    "Check response delivery before starting a new probe; no automatic retry.",
  ],
  body_too_large: [false, "Inspect response size with the service maintainer; keep the body cap."],
  login_refused: [
    false,
    "Verify the QA seam configuration with its authorized maintainer; do not retry credentials.",
  ],
  missing_cookie: [
    false,
    "Verify QA session issuance with its authorized maintainer; do not re-login.",
  ],
  http_refused: [false, "Inspect authenticated route availability and access; do not re-login."],
  unexpected_content: [false, "Inspect the authenticated HTML contract; do not loosen assertions."],
  budget_exceeded: [false, "Investigate header latency; do not relax performance budgets."],
  probe_not_started: [false, "Resolve the preceding failure before starting a new probe."],
  invalid_configuration: [
    false,
    "Check the budget and documented AUTH_PERF settings; no request was sent.",
  ],
  output_write_failed: [
    false,
    "Restore writable test-results output and rerun verification; receipts are incomplete.",
  ],
  probe_failed: [
    false,
    "Run the hermetic verification command and inspect the probe implementation.",
  ],
};

function failure(code) {
  if (!Object.hasOwn(ERRORS, code)) code = "probe_failed";
  const [retryable, next_action] = ERRORS[code];
  return { code, retryable, next_action };
}

// Cleanup is best effort, never a second await boundary. Both synchronous
// throws and abandoned cleanup rejections are consumed without inspecting text.
function cleanup(action) {
  try {
    Promise.resolve(action()).catch(() => undefined);
  } catch {
    return; // A broken disposer must not replace the classified probe result.
  }
}

function dispose(res, reader) {
  cleanup(() => (reader ? reader.cancel() : res?.body?.cancel?.()));
  if (reader) cleanup(() => reader.releaseLock());
}

async function readBody(res, setReader) {
  if (!res.body?.getReader) {
    // Compatibility with injected text-only adapters. They cannot offer an
    // incremental allocation bound, but still get a deadline and UTF-8 cap.
    const html = await res.text();
    return new TextEncoder().encode(html).byteLength > MAX_BODY_BYTES
      ? { error: failure("body_too_large") }
      : { html };
  }
  const reader = res.body.getReader();
  setReader(reader);
  const decoder = new TextDecoder();
  let size = 0;
  let html = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return { html: html + decoder.decode() };
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) return { error: failure("body_too_large") };
    html += decoder.decode(value, { stream: true });
  }
}

async function probeRequest({ url, options, login = false, fetchImpl, now, secrets }) {
  const controller = new AbortController();
  let res;
  let reader;
  let finished = false;
  let elapsedMs = null;
  let status = null;
  let timer;
  const started = now();
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => {
      finished = true;
      controller.abort();
      dispose(res, reader);
      resolveTimeout({ elapsedMs, status, error: failure("transport_timeout") });
    }, REQUEST_TIMEOUT_MS);
  });
  const operation = (async () => {
    let phase = "transport_error";
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      if (finished) {
        dispose(response); // An abort-ignoring transport can yield headers late.
        return { elapsedMs: null, status: null, error: failure("transport_timeout") };
      }
      res = response;
      // Do not include body delivery in the calibrated server-response metric.
      if (!login) elapsedMs = Math.round(now() - started);
      status =
        Number.isInteger(res.status) && res.status >= 100 && res.status <= 599 ? res.status : null;
      if (login && status !== 204) return { elapsedMs, status, error: failure("login_refused") };
      if (!login && status !== 200) return { elapsedMs, status, error: failure("http_refused") };
      const cookie = firstSessionCookie(
        res.headers.getSetCookie?.().join("\n") ?? res.headers.get("set-cookie") ?? "",
      );
      if (cookie) secrets.add(cookie.slice(cookie.indexOf("=") + 1));
      if (login) {
        return cookie ? { cookie } : { error: failure("missing_cookie") };
      }
      // Response metadata is untrusted too: only a classification reaches
      // assertJourney/receipts, never the original header or response URL.
      const contentType = /text\/html/.test(res.headers.get("content-type") ?? "")
        ? "text/html"
        : "non_html";
      phase = "body_read_failed";
      const body = await readBody(res, (value) => {
        reader = value;
      });
      return { elapsedMs, status, cookie, contentType, ...body };
    } catch {
      return { elapsedMs, status, error: failure(phase) };
    }
  })();
  const result = await Promise.race([operation, timeout]);
  finished = true;
  clearTimeout(timer);
  if (result.error || login) {
    controller.abort();
    dispose(res, reader);
  } else if (reader) {
    cleanup(() => reader.releaseLock());
  }
  return result;
}

function plannedJourney(id, count) {
  const error = failure("probe_not_started");
  return {
    id,
    name: id,
    status: "failed",
    reason: error.code,
    samples: [],
    medianMs: null,
    error,
    measurements: Array.from({ length: count }, (_, index) => ({
      id: `${id}:${index}`,
      state: "unmeasured",
      elapsedMs: null,
      error,
    })),
  };
}

function failJourney(journey, error) {
  journey.error = error;
  journey.reason = error.code;
}

export async function runLive({
  env = process.env,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const { budget, error } = loadBudget();
  const journeys = JOURNEY_IDS.map((id) => plannedJourney(id, budget?.samples ?? 0));
  const secrets = new Set();
  const finish = (exitCode) => {
    const summary = { ...summarize(journeys), version: 2 };
    const written = writeLedger(summary, { secrets: [...secrets] });
    return written === 0 ? exitCode : exitCode || written;
  };
  const invalid = () => {
    for (const journey of journeys) failJourney(journey, failure("invalid_configuration"));
    return finish(2);
  };
  if (error) return invalid();
  const base = (env.AUTH_PERF_URL ?? "").trim();
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    return invalid();
  }
  if (
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && parsed.hostname === "127.0.0.1")) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    return invalid();
  const mutant = (env.AUTH_PERF_MUTANT ?? "").trim();
  if (mutant !== "" && mutant !== "no-cookie") return invalid();
  const stripCookie = mutant === "no-cookie";
  const token = (env.E2E_QA_TOKEN ?? env.AUTH_PERF_QA_TOKEN ?? "").trim();
  if (token) secrets.add(token);
  if (!stripCookie && !token) return invalid();
  const eventKey = (env.AUTH_PERF_EVENT_KEY ?? "").trim();

  for (const journey of journeys) {
    const { id } = journey;
    const entry = { ...budget.journeys[id] };
    if (id === "member-rsvp" && eventKey) entry.path = `/e/${eventKey}`;
    let jar = null;
    if (!stripCookie) {
      const login = await probeRequest({
        url: new URL(`/auth/qa/${entry.identity}`, parsed.origin),
        options: {
          method: "POST",
          redirect: "manual",
          headers: { "x-two-qa-auth": token, origin: parsed.origin },
        },
        login: true,
        fetchImpl,
        now,
        secrets,
      });
      if (login.error) {
        failJourney(journey, login.error);
        for (const slot of journey.measurements) slot.error = login.error;
        return finish(2); // No retries or later login after credential refusal.
      }
      jar = login.cookie;
    }
    const observed = [];
    journey.error = null;
    for (const [index, slot] of journey.measurements.entries()) {
      const sample = await probeRequest({
        url: new URL(entry.path, parsed.origin),
        options: { redirect: "manual", headers: stripCookie ? {} : { cookie: jar } },
        fetchImpl,
        now,
        secrets,
      });
      if (sample.elapsedMs !== null) {
        slot.state = "measured";
        slot.elapsedMs = sample.elapsedMs;
        journey.samples.push(sample.elapsedMs);
      }
      slot.error = sample.error ?? null;
      if (sample.error) {
        failJourney(journey, sample.error);
        break;
      }
      // Exactly one login per identity; each read replays the fresh bare pair.
      if (sample.cookie) jar = sample.cookie;
      observed.push(sample);
      console.log(
        `auth perf: ${id} sample ${index}: status ${sample.status}, ${sample.elapsedMs}ms`,
      );
    }
    journey.medianMs = journey.samples.length ? median(journey.samples) : null;
    if (!journey.error) {
      const failures = assertJourney({ id, samples: observed, budget: entry });
      if (failures.length) {
        failJourney(
          journey,
          failure(
            failures.some((f) => f.includes("ceiling")) ? "budget_exceeded" : "unexpected_content",
          ),
        );
        journey.reason = failures.join("; ").slice(0, 300);
      } else {
        journey.status = "passed";
        journey.reason = null;
      }
    }
  }
  return finish(journeys.some((journey) => journey.status === "failed") ? 1 : 0);
}

export function summarize(journeys) {
  const counts = {
    total: journeys.length,
    passed: journeys.filter((j) => j.status === "passed").length,
    failed: journeys.filter((j) => j.status === "failed").length,
  };
  return { version: 1, counts, journeys, verdict: counts.failed > 0 ? "fail" : "pass" };
}

export function writeLedger(summary, { stdout = process.stdout, secrets = [] } = {}) {
  const ledgerText = JSON.stringify(summary, null, 2);
  if (
    scrubSecrets(ledgerText).length ||
    secrets.some(
      (secret) =>
        secret &&
        (ledgerText.includes(secret) || ledgerText.includes(JSON.stringify(secret).slice(1, -1))),
    )
  ) {
    stdout.write("auth perf gate: secret-shaped content in ledger — failing.\n");
    return 1;
  }
  const lines = [
    "## Auth perf ledger",
    "",
    `Verdict: **${summary.verdict}** — ${summary.counts.passed} passed, ${summary.counts.failed} failed, ${summary.counts.total} total.`,
    "",
    "| Journey | Status | Median | Samples (ms) | Reason |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const journey of summary.journeys) {
    const cells = [
      journey.name,
      journey.status,
      journey.medianMs ?? "—",
      (journey.samples ?? []).join(", ") || "—",
      journey.reason ?? "—",
    ].map((cell) => String(cell).replace(/\\/g, "\\\\").replace(/\|/g, "\\|"));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  if (summary.version === 2) {
    lines.push(
      "",
      "### Measurements",
      "",
      "| Sample ID | State | Header ms | Error code | Retryable | Next action |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const journey of summary.journeys) {
      if (journey.error)
        lines.push(
          `| ${journey.id} | ${journey.status} | — | ${journey.error.code} | ${journey.error.retryable} | ${journey.error.next_action} |`,
        );
      for (const slot of journey.measurements) {
        lines.push(
          `| ${slot.id} | ${slot.state} | ${slot.elapsedMs ?? "—"} | ${slot.error?.code ?? "—"} | ${slot.error?.retryable ?? "—"} | ${slot.error?.next_action ?? "—"} |`,
        );
      }
    }
  }
  lines.push("");
  try {
    mkdirSync("test-results", { recursive: true });
    writeFileSync("test-results/auth-perf-ledger.json", `${ledgerText}\n`);
    writeFileSync("test-results/auth-perf-ledger.md", `${lines.join("\n")}\n`);
  } catch {
    stdout.write(`auth perf gate: ${JSON.stringify(failure("output_write_failed"))}\n`);
    return 1;
  }
  stdout.write(
    `auth perf gate: ${summary.counts.passed} passed, ${summary.counts.failed} failed, ${summary.counts.total} total (verdict: ${summary.verdict}).\n`,
  );
  if (summary.verdict === "fail") return 1;
  return 0;
}

function selftest() {
  let cases = 0;
  const check = (name, condition, extra = "") => {
    assert.ok(condition, `selftest FAIL: ${name} ${extra}`);
    cases += 1;
    console.log(`PASS ${name}`);
  };

  // Budget shape: the shipped file must name at least the two journeys.
  const { budget, error } = loadBudget();
  check("shipped budget loads", budget !== undefined, error ?? "");
  check("member-rsvp journey budgeted", isObject(budget.journeys["member-rsvp"]));
  check("moderator-admin journey budgeted", isObject(budget.journeys["moderator-admin"]));
  check("missing budget fails closed", loadBudget("/nonexistent-root-xyz").error !== undefined);
  const badRoot = mkdtempSync(join(tmpdir(), "auth-perf-bad-"));
  mkdirSync(join(badRoot, "ci"), { recursive: true });
  writeFileSync(
    join(badRoot, "ci/auth-perf-budget.json"),
    JSON.stringify({ samples: 5, journeys: { "member-rsvp": budget.journeys["member-rsvp"] } }),
  );
  const missingJourneyError = loadBudget(badRoot).error;
  check(
    "budget missing a journey fails closed",
    missingJourneyError ===
      "auth perf budget: cannot enforce: invalid journey entry: moderator-admin",
    missingJourneyError ?? "",
  );
  writeFileSync(
    join(badRoot, "ci/auth-perf-budget.json"),
    JSON.stringify({ samples: 3, journeys: budget.journeys }),
  );
  check(
    "fewer than five samples fails closed",
    loadBudget(badRoot).error !== undefined,
    loadBudget(badRoot).error ?? "",
  );

  const memberBudget = budget.journeys["member-rsvp"];
  const adminBudget = budget.journeys["moderator-admin"];
  const memberGood = {
    status: 200,
    contentType: "text/html",
    elapsedMs: 120,
    html: `<html><body><span class="who">qa-member</span><button>Sign out</button><span data-testid="event-going-count">3 of 20 going</span></body></html>`,
  };
  const adminGood = {
    status: 200,
    contentType: "text/html",
    elapsedMs: 140,
    html: `<html><body><nav aria-label="Administration"></nav><footer>moderators only</footer></body></html>`,
  };
  const sample = (overrides) => ({ ...memberGood, ...overrides });

  check(
    "member good fixture passes",
    assertJourney({
      id: "member-rsvp",
      samples: Array(5).fill(memberGood),
      budget: memberBudget,
    }).length === 0,
  );
  check(
    "admin good fixture passes",
    assertJourney({
      id: "moderator-admin",
      samples: Array(5).fill(adminGood),
      budget: adminBudget,
    }).length === 0,
  );
  // Forced-failure proof: a slow sample, a cookie-stripped guest body and a
  // bounce/refusal status must each FAIL. A gate that cannot fail on a
  // planted break proves nothing.
  const slow = assertJourney({
    id: "member-rsvp",
    samples: [memberGood, memberGood, sample({ elapsedMs: memberBudget.maxSingleMs + 1 })],
    budget: memberBudget,
  });
  check(
    "slow sample fails",
    slow.some((f) => f.includes("single-sample ceiling")),
    slow.join("; "),
  );
  const slowMedian = assertJourney({
    id: "member-rsvp",
    samples: [
      sample({ elapsedMs: memberBudget.maxMedianMs + 50 }),
      sample({ elapsedMs: memberBudget.maxMedianMs + 50 }),
      sample({ elapsedMs: memberBudget.maxMedianMs + 50 }),
    ],
    budget: memberBudget,
  });
  check(
    "slow median fails",
    slowMedian.some((f) => f.includes("median")),
    slowMedian.join("; "),
  );
  const noCookieMember = assertJourney({
    id: "member-rsvp",
    samples: [
      {
        ...memberGood,
        html: `<html><body><span class="account-caption">Welcome, guest</span><div data-testid="event-join-pitch"></div></body></html>`,
      },
    ],
    budget: memberBudget,
  });
  check("cookie-stripped member body fails", noCookieMember.length > 0, noCookieMember.join("; "));
  const bounce = assertJourney({
    id: "moderator-admin",
    samples: [{ status: 302, contentType: "text/html", elapsedMs: 40, html: "" }],
    budget: adminBudget,
  });
  check(
    "guest bounce fails the admin journey",
    bounce.some((f) => f.includes("302")),
    bounce.join("; "),
  );
  const refusal = assertJourney({
    id: "moderator-admin",
    samples: [{ status: 403, contentType: "text/html", elapsedMs: 40, html: "" }],
    budget: adminBudget,
  });
  check(
    "member refusal fails the admin journey",
    refusal.some((f) => f.includes("403")),
    refusal.join("; "),
  );
  const guestAdminBody = assertJourney({
    id: "moderator-admin",
    samples: [{ ...adminGood, html: `<html><body><span>Welcome, guest</span></body></html>` }],
    budget: adminBudget,
  });
  check("guest-chromed admin body fails", guestAdminBody.length > 0, guestAdminBody.join("; "));
  const jsonEnvelope = assertJourney({
    id: "member-rsvp",
    samples: [{ ...memberGood, contentType: "application/json; charset=utf-8", elapsedMs: 120 }],
    budget: memberBudget,
  });
  check(
    "non-HTML content type fails",
    jsonEnvelope.some((f) => f.includes("content-type") && f.includes("is not HTML")),
    jsonEnvelope.join("; "),
  );
  const canonicalAdminBody = assertJourney({
    id: "moderator-admin",
    samples: [
      {
        ...adminGood,
        html: `<html><body><nav aria-label="Administration"></nav><footer>moderators only</footer><link rel="canonical" href="https://example.com/admin/events"></body></html>`,
      },
    ],
    budget: adminBudget,
  });
  check(
    "canonical-linked admin body fails",
    canonicalAdminBody.some((f) => f.includes("canonical")),
    canonicalAdminBody.join("; "),
  );
  check(
    "empty samples fail",
    assertJourney({ id: "member-rsvp", samples: [], budget: memberBudget }).length > 0,
  );
  check(
    "session cookie is secret-shaped",
    scrubSecrets("__Host-two_session=abc.def; Path=/").length === 1,
  );
  check("clean ledger text", scrubSecrets("member-rsvp passed in 120ms").length === 0);

  console.log(`auth perf gate selftest: ${cases} cases passed.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , ...args] = process.argv;
  if (args.length === 1 && args[0] === "--help") {
    console.log(`Usage: node ci/check-auth-perf.mjs [--help | --selftest | --dry-run | --mutant no-cookie]
--selftest / --dry-run: fixtures only; no network, DB or credentials.
Verify: node --test ci/check-auth-perf*.test.mjs
No flags: live probe using AUTH_PERF_URL and E2E_QA_TOKEN; authorized fixture origin only.
--mutant no-cookie: live negative control; never combined with fixture flags.
Receipts: test-results/auth-perf-ledger.{json,md} (v2, fixed errors and sample IDs).
Procedure, bounds and recovery: docs/performance-budgets.md`);
  } else if (args.length === 1 && ["--selftest", "--dry-run"].includes(args[0])) {
    process.exitCode = selftest();
  } else if (args.length === 0) {
    runLive().then(
      (code) => {
        process.exitCode = code;
      },
      () => {
        console.error(`auth perf gate: ${JSON.stringify(failure("probe_failed"))}`);
        process.exitCode = 1;
      },
    );
  } else if (args.length === 2 && args[0] === "--mutant" && args[1] === "no-cookie") {
    process.env.AUTH_PERF_MUTANT = "no-cookie";
    runLive().then(
      (code) => {
        process.exitCode = code;
      },
      () => {
        console.error(`auth perf gate: ${JSON.stringify(failure("probe_failed"))}`);
        process.exitCode = 1;
      },
    );
  } else {
    console.error(
      "Usage: node ci/check-auth-perf.mjs [--help | --selftest | --dry-run | --mutant no-cookie]",
    );
    process.exitCode = 2;
  }
}
