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
  } catch (error) {
    return { error: `auth perf budget: cannot enforce: ${error.message}` };
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
    if (!(sample.elapsedMs >= 0))
      failures.push(`${id} sample ${index}: elapsedMs ${sample.elapsedMs} is not measurable`);
    else if (sample.elapsedMs > budget.maxSingleMs)
      failures.push(
        `${id} sample ${index}: ${sample.elapsedMs}ms over the single-sample ceiling ${budget.maxSingleMs}ms`,
      );
  }
  const timed = samples.map((sample) => sample.elapsedMs).filter((ms) => ms >= 0);
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

async function qaLoginCookie({ base, identity, token, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(new URL(`/auth/qa/${identity}`, base), {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { "x-two-qa-auth": token, origin: base },
    });
  } catch (error) {
    return {
      error: `QA login request failed on ${new URL(base).host}: ${String(error?.message ?? error).slice(0, 120)}`,
    };
  }
  if (res.status !== 204) {
    return {
      error: `QA login answered ${res.status} on ${new URL(base).host} (seam unavailable or token rejected)`,
    };
  }
  const raw = res.headers.getSetCookie?.().join("\n") ?? res.headers.get("set-cookie") ?? "";
  const cookie = firstSessionCookie(raw);
  if (!cookie) return { error: `QA login set no session cookie on ${new URL(base).host}` };
  return { cookie };
}

async function timeJourney({ base, journey, samples, cookie, stripCookie, fetchImpl, now }) {
  const measured = [];
  let jar = cookie;
  for (let i = 0; i < samples; i += 1) {
    const started = now();
    let res;
    try {
      res = await fetchImpl(new URL(journey.path, base), {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        headers: stripCookie ? {} : { cookie: jar },
      });
    } catch (error) {
      measured.push({ status: -1, html: "", contentType: "", elapsedMs: -1 });
      return { measured, fetchError: String(error?.message ?? error).slice(0, 200) };
    }
    const elapsedMs = Math.round(now() - started);
    // Rotating page reads replace the presented bearer: follow the fresh
    // pair like the browser journeys replay the jar, or the next sample
    // presents a dead session and the gate misreads rotation as slowness.
    const rotated = firstSessionCookie(
      res.headers.getSetCookie?.().join("\n") ?? res.headers.get("set-cookie") ?? "",
    );
    if (rotated) jar = rotated;
    const html = res.status === 200 ? await res.text() : "";
    measured.push({
      status: res.status,
      html,
      contentType: res.headers.get("content-type") ?? "",
      elapsedMs,
    });
  }
  return { measured };
}

export async function runLive({
  env = process.env,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const { budget, error } = loadBudget();
  if (error) {
    console.error(error);
    return 2;
  }
  const base = (env.AUTH_PERF_URL ?? "").trim() || null;
  if (!base) {
    console.error(
      "auth perf gate: cannot enforce: set AUTH_PERF_URL (the worker origin to measure)",
    );
    return 2;
  }
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    console.error("auth perf gate: cannot enforce: AUTH_PERF_URL is not a valid URL");
    return 2;
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1") {
    console.error("auth perf gate: cannot enforce: AUTH_PERF_URL must be https (or local http)");
    return 2;
  }
  const mutant = (env.AUTH_PERF_MUTANT ?? "").trim();
  if (mutant !== "" && mutant !== "no-cookie") {
    console.error(
      `auth perf gate: cannot enforce: unknown AUTH_PERF_MUTANT ${JSON.stringify(mutant)}`,
    );
    return 2;
  }
  const stripCookie = mutant === "no-cookie";
  const token = (env.E2E_QA_TOKEN ?? env.AUTH_PERF_QA_TOKEN ?? "").trim() || null;
  if (!stripCookie && !token) {
    console.error("auth perf gate: cannot enforce: set E2E_QA_TOKEN (the ephemeral QA token)");
    return 2;
  }
  const eventKey = (env.AUTH_PERF_EVENT_KEY ?? "").trim() || null;

  const journeys = [];
  for (const id of JOURNEY_IDS) {
    const entry = { ...budget.journeys[id] };
    if (id === "member-rsvp" && eventKey) entry.path = `/e/${eventKey}`;
    let cookie = null;
    if (!stripCookie) {
      const login = await qaLoginCookie({ base, identity: entry.identity, token, fetchImpl });
      if (login.error) {
        console.error(`auth perf gate: cannot enforce: ${login.error}`);
        return 2;
      }
      cookie = login.cookie;
    }
    const { measured, fetchError } = await timeJourney({
      base,
      journey: entry,
      samples: budget.samples,
      cookie,
      stripCookie,
      fetchImpl,
      now,
    });
    if (fetchError) {
      journeys.push({ name: `${id} (${entry.path})`, status: "failed", reason: fetchError });
      continue;
    }
    const failures = assertJourney({ id, samples: measured, budget: entry });
    const timed = measured.map((sample) => sample.elapsedMs);
    journeys.push({
      name: `${id} (${entry.path})`,
      status: failures.length ? "failed" : "passed",
      reason: failures.join("; ").slice(0, 300) || null,
      samples: timed,
      medianMs: median(timed),
    });
    for (const [index, sample] of measured.entries()) {
      console.log(
        `auth perf: ${id} sample ${index}: status ${sample.status}, ${sample.elapsedMs}ms`,
      );
    }
  }

  const summary = summarize(journeys);
  return writeLedger(summary);
}

export function summarize(journeys) {
  const counts = {
    total: journeys.length,
    passed: journeys.filter((j) => j.status === "passed").length,
    failed: journeys.filter((j) => j.status === "failed").length,
  };
  return { version: 1, counts, journeys, verdict: counts.failed > 0 ? "fail" : "pass" };
}

export function writeLedger(summary, { stdout = process.stdout } = {}) {
  mkdirSync("test-results", { recursive: true });
  const ledgerText = JSON.stringify(summary, null, 2);
  if (scrubSecrets(ledgerText).length) {
    stdout.write("auth perf gate: secret-shaped content in ledger — failing.\n");
    return 1;
  }
  writeFileSync("test-results/auth-perf-ledger.json", `${ledgerText}\n`);
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
  lines.push("");
  writeFileSync("test-results/auth-perf-ledger.md", `${lines.join("\n")}\n`);
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
  if (args.length === 1 && args[0] === "--selftest") {
    process.exitCode = selftest();
  } else if (args.length === 0) {
    runLive().then(
      (code) => {
        process.exitCode = code;
      },
      (error) => {
        console.error(`auth perf gate: ${error?.message ?? error}`);
        process.exitCode = 1;
      },
    );
  } else if (args.length === 2 && args[0] === "--mutant" && args[1] === "no-cookie") {
    process.env.AUTH_PERF_MUTANT = "no-cookie";
    runLive().then(
      (code) => {
        process.exitCode = code;
      },
      (error) => {
        console.error(`auth perf gate: ${error?.message ?? error}`);
        process.exitCode = 1;
      },
    );
  } else {
    console.error("Usage: node ci/check-auth-perf.mjs [--selftest | --mutant no-cookie]");
    process.exitCode = 2;
  }
}
