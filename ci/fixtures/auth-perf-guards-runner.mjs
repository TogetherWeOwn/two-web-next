// Guards-owned subprocess fixture for the observed-cookie secret test. Minimal
// happy-path runner with a configurable issued cookie value; the acceptance
// runner hardcodes its cookie canary and cannot express a cookie value that
// legitimately appears in a receipt. Never use a real transport or QA env.
import { existsSync, readFileSync } from "node:fs";
import { runLive } from "../check-auth-perf.mjs";

const config = JSON.parse(readFileSync(0, "utf8"));
const cookieValue = config.cookieValue ?? "synthetic-cookie-guards-canary";
const qaCanary = "synthetic-qa-guards-canary";
const memberHtml = `<button>Sign out</button><span data-testid="event-going-count">3</span>`;
const adminHtml = `<nav aria-label="Administration"></nav><footer>moderators only</footer>`;
const calls = [];
const output = [];
const unhandled = [];
let measuredClock = 100_000;
let networkAttempts = 0;
let code = null;
let rejected = null;
const originalLog = console.log;
const originalError = console.error;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
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
  const headers = new Headers(opts.headers);
  calls.push({
    label: login ? `${id}:login` : `${id}:sample`,
    method: opts.method ?? "GET",
    path: url.pathname,
    cookie: headers.get("cookie"),
    qa: headers.get("x-two-qa-auth"),
  });
  measuredClock += 40;
  if (login) {
    const loginHeaders = new Headers();
    loginHeaders.set("set-cookie", `__Host-two_session=${cookieValue}; Path=/; Secure; HttpOnly`);
    return new Response(null, { status: 204, headers: loginHeaders });
  }
  const html = id === "member-rsvp" ? memberHtml : adminHtml;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

try {
  code = await runLive({
    env: {
      AUTH_PERF_URL: "https://fixture.test",
      E2E_QA_TOKEN: qaCanary,
      ...config.env,
    },
    fetchImpl,
    now: () => measuredClock,
  });
} catch (error) {
  rejected = String(error?.message ?? error);
}
const files = {};
for (const extension of ["json", "md"]) {
  const path = `test-results/auth-perf-ledger.${extension}`;
  if (existsSync(path)) files[extension] = readFileSync(path, "utf8");
}
console.log = originalLog;
console.error = originalError;
process.stdout.write = originalStdoutWrite;
process.stderr.write = originalStderrWrite;
process.removeListener("unhandledRejection", onUnhandled);
originalStdoutWrite(
  `${JSON.stringify({ code, rejected, output: output.join("\n"), calls, files, networkAttempts, unhandled })}\n`,
);
