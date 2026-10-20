import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertJourney, runLive, scrubSecrets } from "./check-auth-perf.mjs";

// Proves ci/check-auth-perf.mjs follows Set-Cookie rotation with exactly one
// login per identity: fake cookies rotate A -> B -> C with old values
// invalidated, and the test asserts the actual Cookie header sequence. Runs
// runLive with injected fetch/clock only; no real HTTP, no real QA token, no
// staging login. The ledger lands in a run-owned temp directory, never the
// repo's test-results/.

const TOKEN = "synth-qa-token-rotation-probe";
const MEMBER_ROT = ["synth-rot-member-A", "synth-rot-member-B", "synth-rot-member-C"];
const MODERATOR_ROT = ["synth-rot-moderator-A", "synth-rot-moderator-B", "synth-rot-moderator-C"];
const SESSION_PAIR = (value) => `__Host-two_session=${value}`;
const ALL_SYNTH_VALUES = [...MEMBER_ROT, ...MODERATOR_ROT];

const MEMBER_HTML = `<html><body><span class="who">qa-member</span><button>Sign out</button><span data-testid="event-going-count">3 of 20 going</span></body></html>`;
const ADMIN_HTML = `<html><body><nav aria-label="Administration"></nav><footer>moderators only</footer></body></html>`;
const GUEST_MEMBER_HTML = `<html><body><span class="account-caption">Welcome, guest</span><div data-testid="event-join-pitch"></div></body></html>`;

const makeEnv = () => ({
  AUTH_PERF_URL: "https://auth-perf-rotation.test",
  E2E_QA_TOKEN: TOKEN,
});

function makeClock(stepMs = 50) {
  let t = 1_000_000;
  return () => (t += stepMs);
}

function makeRotationServer() {
  const state = {
    "qa-member": { rot: MEMBER_ROT, valid: null, next: 0 },
    "qa-moderator": { rot: MODERATOR_ROT, valid: null, next: 0 },
  };
  const logins = [];
  const gets = [];
  const responses = [];

  const presentedValue = (cookieHeader) => {
    const match = /__Host-two_session=([^;\s]+)/.exec(cookieHeader ?? "");
    return match ? match[1] : null;
  };
  const sessionSetCookie = (value) =>
    `__Host-two_session=${value}; Path=/; Secure; HttpOnly; SameSite=Lax`;

  const fetchImpl = async (urlInput, opts = {}) => {
    const url = new URL(String(urlInput));
    const path = url.pathname;
    const method = (opts.method ?? "GET").toUpperCase();
    const headers = opts.headers ?? {};
    if (path.startsWith("/auth/qa/")) {
      const identity = path.slice("/auth/qa/".length);
      assert.ok(
        identity === "qa-member" || identity === "qa-moderator",
        `unexpected login identity ${identity}`,
      );
      const sentToken = headers["x-two-qa-auth"] ?? headers["X-TWO-QA-Auth"] ?? "";
      if (sentToken !== TOKEN) {
        return { status: 401, headers: new Headers(), text: async () => "" };
      }
      logins.push({ identity, method });
      const entry = state[identity];
      entry.valid = entry.rot[0];
      entry.next = 1;
      const loginHeaders = new Headers();
      loginHeaders.append("set-cookie", sessionSetCookie(entry.rot[0]));
      loginHeaders.append("set-cookie", "other=decoy; Path=/");
      return { status: 204, headers: loginHeaders, text: async () => "" };
    }
    const identity = path.startsWith("/e/")
      ? "qa-member"
      : path.startsWith("/admin/")
        ? "qa-moderator"
        : null;
    assert.ok(identity, `unexpected journey path ${path}`);
    assert.equal(method, "GET", `journey reads stay GET-only (got ${method} ${path})`);
    const cookieHeader = headers.cookie ?? headers.Cookie ?? "";
    gets.push({ identity, cookie: cookieHeader, path });
    const entry = state[identity];
    if (presentedValue(cookieHeader) !== entry.valid) {
      responses.push({ identity, rotated: false, stale: true });
      const staleHeaders = new Headers();
      staleHeaders.set("content-type", "text/html");
      if (identity === "qa-member") {
        return { status: 200, headers: staleHeaders, text: async () => GUEST_MEMBER_HTML };
      }
      return { status: 302, headers: staleHeaders, text: async () => "" };
    }
    const journeyHeaders = new Headers();
    journeyHeaders.set("content-type", "text/html; charset=utf-8");
    if (entry.next < entry.rot.length) {
      const nextValue = entry.rot[entry.next];
      // Decoy first: the jar must filter by cookie name, not take the first
      // pair. The login path keeps session-first order, so both orders are
      // covered across the two extraction sites.
      journeyHeaders.append("set-cookie", "other=decoy; Path=/");
      journeyHeaders.append("set-cookie", sessionSetCookie(nextValue));
      entry.valid = nextValue;
      entry.next += 1;
      responses.push({ identity, rotated: true, stale: false });
    } else {
      responses.push({ identity, rotated: false, stale: false });
    }
    const html = identity === "qa-member" ? MEMBER_HTML : ADMIN_HTML;
    return { status: 200, headers: journeyHeaders, text: async () => html };
  };

  return { fetchImpl, logins, gets, responses };
}

async function captureOutput(fn) {
  const chunks = [];
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  const origLog = console.log;
  const origError = console.error;
  process.stdout.write = (chunk, ...args) => {
    chunks.push(String(chunk));
    return Reflect.apply(origStdoutWrite, process.stdout, [chunk, ...args]);
  };
  process.stderr.write = (chunk, ...args) => {
    chunks.push(String(chunk));
    return Reflect.apply(origStderrWrite, process.stderr, [chunk, ...args]);
  };
  console.log = (...parts) => {
    chunks.push(`${parts.map(String).join(" ")}\n`);
  };
  console.error = (...parts) => {
    chunks.push(`${parts.map(String).join(" ")}\n`);
  };
  try {
    const result = await fn();
    return { result, output: chunks.join("") };
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origLog;
    console.error = origError;
  }
}

async function runLiveIsolated({ env, fetchImpl, now }) {
  const prev = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "auth-perf-rot-"));
  process.chdir(dir);
  try {
    const captured = await captureOutput(() => runLive({ env, fetchImpl, now }));
    return { code: captured.result, output: captured.output, dir };
  } finally {
    process.chdir(prev);
  }
}

function assertSecretFree(label, ...texts) {
  for (const text of texts) {
    assert.ok(!text.includes(TOKEN), `${label} leaks the synthetic QA token`);
    for (const value of ALL_SYNTH_VALUES) {
      assert.ok(!text.includes(value), `${label} leaks synthetic cookie value ${value}`);
    }
    assert.ok(
      !text.includes("__Host-two_session="),
      `${label} carries secret-shaped session content`,
    );
    assert.equal(scrubSecrets(text).length, 0, `${label} trips the secret scrubber`);
  }
}

test("runLive follows rotating cookies with one login per identity", async () => {
  const server = makeRotationServer();
  const { code, output, dir } = await runLiveIsolated({
    env: makeEnv(),
    fetchImpl: server.fetchImpl,
    now: makeClock(),
  });
  assert.equal(code, 0, `expected exit 0, got ${code}\n${output}`);

  // Exactly one login per identity: the shared qa-login throttle sees two
  // logins total, never a per-sample login.
  assert.equal(server.logins.length, 2, `expected 2 logins, got ${server.logins.length}`);
  assert.deepEqual(server.logins.map((login) => login.identity).sort(), [
    "qa-member",
    "qa-moderator",
  ]);

  // The actual Cookie header sequence follows the rotation A -> B -> C.
  const memberCookies = server.gets
    .filter((get) => get.identity === "qa-member")
    .map((get) => get.cookie);
  const moderatorCookies = server.gets
    .filter((get) => get.identity === "qa-moderator")
    .map((get) => get.cookie);
  // The shipped budget takes five samples per journey; once the rotation is
  // exhausted the server keeps answering with the last issued value.
  const SAMPLES = 5;
  const padToSamples = (rot) => [
    ...rot,
    ...Array(Math.max(0, SAMPLES - rot.length)).fill(rot[rot.length - 1]),
  ];
  assert.deepEqual(memberCookies, padToSamples(MEMBER_ROT).map(SESSION_PAIR));
  assert.deepEqual(moderatorCookies, padToSamples(MODERATOR_ROT).map(SESSION_PAIR));

  // Replacement extraction: the jar carries the bare pair only, never the
  // Set-Cookie attributes or the decoy cookie.
  for (const cookie of [...memberCookies, ...moderatorCookies]) {
    assert.ok(!cookie.includes(";"), `jar leaks cookie attributes: ${cookie}`);
    assert.ok(!cookie.includes("decoy"), `jar picks up the decoy cookie: ${cookie}`);
  }

  // No-rotation preservation: the final sample answers with no Set-Cookie
  // and the client still presents the last rotated value.
  const memberRotations = server.responses
    .filter((response) => response.identity === "qa-member")
    .map((response) => response.rotated);
  const moderatorRotations = server.responses
    .filter((response) => response.identity === "qa-moderator")
    .map((response) => response.rotated);
  const rotatedThenQuiet = [true, true, ...Array(SAMPLES - 2).fill(false)];
  assert.deepEqual(memberRotations, rotatedThenQuiet);
  assert.deepEqual(moderatorRotations, rotatedThenQuiet);

  // Jar isolation: neither identity ever presents the other's cookie.
  for (const cookie of memberCookies) {
    for (const value of MODERATOR_ROT) assert.ok(!cookie.includes(value));
  }
  for (const cookie of moderatorCookies) {
    for (const value of MEMBER_ROT) assert.ok(!cookie.includes(value));
  }

  // Old values are invalidated: replaying the rotated-out cookie is refused
  // (guest body on the member path, bounce on the admin path), so a client
  // that did not follow the rotation could not stay green.
  const staleMember = await server.fetchImpl(
    new URL("/e/01J00000000000000000000001", "https://auth-perf-rotation.test"),
    { headers: { cookie: SESSION_PAIR(MEMBER_ROT[0]) } },
  );
  assert.equal(staleMember.status, 200);
  assert.ok((await staleMember.text()).includes("Welcome, guest"));
  const staleModerator = await server.fetchImpl(
    new URL("/admin/events", "https://auth-perf-rotation.test"),
    { headers: { cookie: SESSION_PAIR(MODERATOR_ROT[0]) } },
  );
  assert.equal(staleModerator.status, 302);
  const staleFailures = assertJourney({
    id: "member-rsvp",
    samples: [{ status: 200, contentType: "text/html", elapsedMs: 50, html: GUEST_MEMBER_HTML }],
    budget: { maxMedianMs: 500, maxSingleMs: 1000 },
  });
  assert.ok(staleFailures.length > 0, "stale replay must fail the journey assertions");

  const ledgerJson = readFileSync(join(dir, "test-results/auth-perf-ledger.json"), "utf8");
  const ledgerMd = readFileSync(join(dir, "test-results/auth-perf-ledger.md"), "utf8");
  const ledger = JSON.parse(ledgerJson);
  assert.equal(ledger.verdict, "pass");
  assert.equal(ledger.counts.passed, 2);
  assertSecretFree("ledger/stdout", ledgerJson, ledgerMd, output);
});

test("without the jar update the rotating gate goes red (negative control)", async () => {
  const server = makeRotationServer();
  // Simulate removing the jar update (ci/check-auth-perf.mjs:205-208): the
  // login cookie still lands, but rotation Set-Cookie never reaches the jar,
  // so every sample after the first replays a dead session.
  const strippingFetch = async (urlInput, opts = {}) => {
    const res = await server.fetchImpl(urlInput, opts);
    if (new URL(String(urlInput)).pathname.startsWith("/auth/qa/")) return res;
    const stripped = new Headers();
    const contentType = res.headers.get("content-type");
    if (contentType) stripped.set("content-type", contentType);
    return { status: res.status, headers: stripped, text: res.text };
  };
  const { code, output, dir } = await runLiveIsolated({
    env: makeEnv(),
    fetchImpl: strippingFetch,
    now: makeClock(),
  });
  assert.equal(code, 1, `expected exit 1 without rotation following, got ${code}\n${output}`);

  // The failure comes from stale reuse, not extra logins: still exactly one
  // login per identity.
  assert.equal(server.logins.length, 2, `expected 2 logins, got ${server.logins.length}`);
  const ledgerJson = readFileSync(join(dir, "test-results/auth-perf-ledger.json"), "utf8");
  const ledgerMd = readFileSync(join(dir, "test-results/auth-perf-ledger.md"), "utf8");
  const ledger = JSON.parse(ledgerJson);
  assert.equal(ledger.verdict, "fail");
  for (const journey of ledger.journeys) {
    assert.equal(journey.status, "failed", `${journey.name} should fail on stale replay`);
    assert.ok(journey.reason, `${journey.name} should name the stale failure`);
  }
  assertSecretFree("ledger/stdout", ledgerJson, ledgerMd, output);
});
