// Test-only subprocess fixture. Never use a real transport or inherited QA env.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mock } from "node:test";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { runLive } from "../check-auth-perf.mjs";

const config = JSON.parse(readFileSync(0, "utf8"));
const qaCanary = "synthetic-qa-canary-acceptance";
const cookieCanary = "synthetic-cookie-canary-acceptance";
const urlCanary = "https://fixture.test/private?token=synthetic-url-canary-acceptance";
const hostileText = `${qaCanary} ${cookieCanary} ${urlCanary}`;
const memberHtml = `<button>Sign out</button><span data-testid="event-going-count">3</span><p>${hostileText}</p>`;
const adminHtml = `<nav aria-label="Administration"></nav><footer>moderators only</footer><p>${hostileText}</p>`;
const calls = [];
const disposals = [];
const reads = [];
const signals = [];
const unhandled = [];
const output = [];
let measuredClock = 100_000;
let virtualMs = 0;
let networkAttempts = 0;
let offeredBytes = 0;
let lateResponse = false;
let settledAt = null;
let code = null;
let rejected = null;
let done = false;
const originalTimeout = AbortSignal.timeout;
const originalLog = console.log;
const originalError = console.error;
const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;
const onUnhandled = () => unhandled.push("unhandled_rejection");
process.on("unhandledRejection", onUnhandled);
console.log = (...args) => output.push(args.map(String).join(" "));
console.error = (...args) => output.push(args.map(String).join(" "));
process.stdout.write = (chunk) => {
  output.push(String(chunk));
  return true;
};
process.stderr.write = (chunk) => {
  output.push(String(chunk));
  return true;
};
globalThis.fetch = () => {
  networkAttempts += 1;
  throw new Error("fixture refused real fetch");
};
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
// Node's native AbortSignal.timeout uses an internal timer, outside mock.timers.
// Keep its semantics but put it on the same virtual scheduler as Promise races.
AbortSignal.timeout = (ms) => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException("fixture deadline", "TimeoutError")), ms);
  return controller.signal;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise(() => {});
const drain = async () => {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
  await yieldTurn();
};

function cancel(label) {
  disposals.push(label);
  if (config.cleanup === "throw") throw new Error(hostileText);
  if (config.cleanup === "reject") return Promise.reject(new Error(hostileText));
  if (config.cleanup === "stall") return never();
  return undefined;
}

function response({ label, status = 200, html = "", cookie = false, fault = false }) {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  if (cookie)
    headers.set("set-cookie", `__Host-two_session=${cookieCanary}; Path=/; Secure; HttpOnly`);
  if (fault && config.fault === "bad-content-type") headers.set("content-type", hostileText);
  if (status === 204) return new Response(null, { status, headers });
  const encoder = new TextEncoder();
  if (config.textOnly && fault) {
    return {
      status,
      headers,
      body: { cancel: () => cancel(label) },
      text: async () => {
        reads.push(label);
        if (config.fault === "body-stall") return never();
        if (config.fault === "body-reject") throw new Error(hostileText);
        if (config.fault === "oversize") return html + "\u{1f642}".repeat(300_000);
        measuredClock += config.bodyMs ?? 2_000;
        return html;
      },
    };
  }
  let sent = false;
  let chunks = 0;
  const body = new ReadableStream(
    {
      async pull(controller) {
        reads.push(label);
        if (fault && ["body-stall", "headers-then-stall"].includes(config.fault)) return never();
        if (fault && config.fault === "body-reject") {
          controller.error(new Error(hostileText));
          return;
        }
        if (fault && config.fault === "oversize") {
          // Authenticated prefix makes a silent truncation look valid: it must
          // still fail oversize, and stop reading rather than buffer all 4 MiB.
          if (chunks === 0) controller.enqueue(encoder.encode(html));
          if (chunks < 256) {
            const chunk = encoder.encode("\u{1f642}".repeat(4_096));
            offeredBytes += chunk.byteLength;
            controller.enqueue(chunk);
            chunks += 1;
          } else controller.close();
          return;
        }
        if (sent) {
          controller.close();
          return;
        }
        if (fault && ["body-delay", "headers-then-body-delay"].includes(config.fault))
          await wait(14_000);
        measuredClock += config.bodyMs ?? 2_000;
        controller.enqueue(encoder.encode(html));
        sent = true;
        controller.close();
      },
      cancel: () => cancel(label),
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status, headers });
}

const counters = { "member-rsvp": 0, "moderator-admin": 0 };
async function fetchImpl(urlInput, opts = {}) {
  const url = new URL(urlInput);
  const login = url.pathname.startsWith("/auth/qa/");
  const id = login
    ? url.pathname.endsWith("qa-member")
      ? "member-rsvp"
      : "moderator-admin"
    : url.pathname.startsWith("/e/")
      ? "member-rsvp"
      : "moderator-admin";
  const index = login ? null : counters[id]++;
  const label = login ? `${id}:login` : `${id}:${index}`;
  const headers = new Headers(opts.headers);
  calls.push({
    label,
    method: opts.method ?? "GET",
    path: url.pathname,
    cookie: headers.get("cookie"),
    qa: headers.get("x-two-qa-auth"),
    redirect: opts.redirect,
  });
  if (opts.signal) signals.push({ label, signal: opts.signal });
  const fault =
    id === (config.targetId ?? "member-rsvp") &&
    (config.phase === "login" ? login : !login && index === (config.sampleIndex ?? 0));
  if (fault && config.fault === "fetch-stall") return never();
  if (fault && config.fault === "fetch-reject") throw new Error(hostileText);
  if (fault && config.fault === "late-headers") {
    await wait(17_000); // Ignores AbortSignal and arrives after the 15s deadline.
    lateResponse = true;
  }
  if (fault && ["headers-then-stall", "headers-then-body-delay"].includes(config.fault))
    await wait(14_000);
  measuredClock += config.headerMs ?? 40;
  if (login) {
    return response({
      label,
      status: fault && config.fault === "login-refused" ? 403 : 204,
      html: hostileText,
      cookie: !(fault && config.fault === "missing-cookie"),
      fault,
    });
  }
  return response({
    label,
    status: fault && config.fault === "http-refused" ? 403 : 200,
    html: id === "member-rsvp" ? memberHtml : adminHtml,
    fault: fault && config.fault !== "late-headers",
  });
}

function artifacts() {
  const result = {};
  for (const extension of ["json", "md"]) {
    const path = `test-results/auth-perf-ledger.${extension}`;
    if (existsSync(path)) result[extension] = readFileSync(path, "utf8");
  }
  return result;
}

let files;
let filesAfterLate;
let signalsAtSettlement;
let disposalsAtSettlement;
try {
  if (config.outputFault) {
    if (config.outputFault === "directory") writeFileSync("test-results", "fixture obstacle");
    else {
      mkdirSync("test-results");
      mkdirSync(`test-results/auth-perf-ledger.${config.outputFault}`);
    }
  }
  // A pending promise never escapes this child. The outer runner also has an
  // OS timeout; neither guard turns a stalled probe into a successful receipt.
  Promise.resolve(
    runLive({
      env: { AUTH_PERF_URL: "https://fixture.test", E2E_QA_TOKEN: qaCanary, ...config.env },
      fetchImpl,
      now: () => measuredClock,
    }),
  ).then(
    (result) => {
      code = result;
      settledAt = virtualMs;
      done = true;
    },
    (error) => {
      rejected = String(error?.message ?? error);
      settledAt = virtualMs;
      done = true;
    },
  );
  await drain();
  while (!done && virtualMs < 180_000) {
    virtualMs += 1_000;
    mock.timers.tick(1_000);
    await drain();
  }
  // Directory obstacles aren't artifacts. Do not attempt to read them as files.
  files = config.outputFault ? {} : artifacts();
  signalsAtSettlement = signals.map(({ label, signal }) => ({ label, aborted: signal.aborted }));
  disposalsAtSettlement = [...disposals];
  for (let i = 0; i < 20; i += 1) {
    virtualMs += 1_000;
    mock.timers.tick(1_000);
    await drain();
  }
  filesAfterLate = config.outputFault ? {} : artifacts();
} finally {
  mock.timers.reset();
  AbortSignal.timeout = originalTimeout;
  console.log = originalLog;
  console.error = originalError;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  process.removeListener("unhandledRejection", onUnhandled);
}
console.log(
  JSON.stringify({
    done,
    code,
    rejected,
    settledAt,
    output: output.join("\n"),
    calls,
    disposals,
    reads,
    offeredBytes,
    lateResponse,
    files,
    filesAfterLate,
    networkAttempts,
    unhandled,
    signalsAtSettlement,
    disposalsAtSettlement,
    signals: signals.map(({ label, signal }) => ({ label, aborted: signal.aborted })),
  }),
);
