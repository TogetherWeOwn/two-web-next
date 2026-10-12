import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertReservedContract,
  assertRouteContract,
  expectedMarkerFor,
  isAllowlistedHost,
  runGate,
  scrubSecrets,
  summarizeLedger,
  validatePreviewPair,
} from "./kit-parity-gates.mjs";

const scriptPath = fileURLToPath(new URL("./kit-parity-gates.mjs", import.meta.url));

function runScript({ env, stub }) {
  const dir = mkdtempSync(join(tmpdir(), "kit-parity-gates-"));
  const stubPath = join(dir, "fetch-stub.mjs");
  writeFileSync(stubPath, stub);
  const childEnv = { ...process.env };
  delete childEnv.KIT_PREVIEW_URL;
  delete childEnv.HONO_PREVIEW_URL;
  Object.assign(childEnv, env);
  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(stubPath).href, scriptPath],
    {
      env: childEnv,
      encoding: "utf8",
      timeout: 120_000,
      cwd: join(scriptPath, "..", ".."),
    },
  );
  return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

const throwingFetchStub = `
globalThis.fetch = () => {
  throw new Error("kit-parity-gates: fetch must not run in misconfigured mode");
};
`;

test("exactly one preview URL exits 2 before any fetch", () => {
  for (const env of [
    { KIT_PREVIEW_URL: "https://kit.invalid.workers.dev/" },
    { HONO_PREVIEW_URL: "https://next.togetherweown.com/" },
  ]) {
    const { status, output } = runScript({ env, stub: throwingFetchStub });
    assert.equal(status, 2, `expected exit 2, got ${status}\n${output}`);
    assert.match(output, /set both KIT_PREVIEW_URL and HONO_PREVIEW_URL/);
    assert.doesNotMatch(output, /fetch must not run/);
  }
});

test("non-allowlisted preview hosts exit 2 before any fetch", () => {
  const { status, output } = runScript({
    env: {
      KIT_PREVIEW_URL: "https://togetherweown.com/",
      HONO_PREVIEW_URL: "https://next.togetherweown.com/",
    },
    stub: throwingFetchStub,
  });
  assert.equal(status, 2, `expected exit 2, got ${status}\n${output}`);
  assert.match(output, /not staging-allowlisted/);
});

test("self-paired preview URLs exit 2 before any fetch", () => {
  const { status, output } = runScript({
    env: {
      KIT_PREVIEW_URL: "https://next.togetherweown.com/",
      HONO_PREVIEW_URL: "https://next.togetherweown.com/",
    },
    stub: throwingFetchStub,
  });
  assert.equal(status, 2, `expected exit 2, got ${status}\n${output}`);
  assert.match(output, /must differ/);
});

test("divergent preview sections exit 1 with the failing journey named", () => {
  const page = (key) =>
    `<html><head><link rel="canonical" href="https://x.invalid/">` +
    `<meta name="robots" content="noindex, follow"></head>` +
    `<body><a class="skip-link" href="#main">Skip</a>` +
    `<nav aria-label="Primary"></nav><main id="main">` +
    `<section data-testid="past-events"><div data-testid="past-events-list">` +
    `<article data-event-key="${key}"></article></div></section></main>` +
    `<p>Welcome, guest</p><script src="/islands/past-events.js"></script></body></html>`;
  const stub = `
const page = ${page.toString()};
globalThis.fetch = async (input) => {
  const url = new URL(String(input.url ?? input));
  if (url.pathname === "/up") return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  const html = url.host === "kit.invalid.workers.dev" ? page("kit-only-key") : page("hono-only-key");
  return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
};
`;
  const { status, output } = runScript({
    env: {
      KIT_PREVIEW_URL: "https://kit.invalid.workers.dev/",
      HONO_PREVIEW_URL: "https://hono.invalid.workers.dev/",
    },
    stub,
  });
  assert.equal(status, 1, `expected exit 1, got ${status}\n${output}`);
  assert.match(output, /sections match/);
});

test("allowlist admits staging and preview hosts only", () => {
  assert.equal(isAllowlistedHost("next.togetherweown.com"), true);
  assert.equal(isAllowlistedHost("two-web-next-kit-preview.5150.workers.dev"), true);
  assert.equal(isAllowlistedHost("togetherweown.com"), false);
  assert.equal(isAllowlistedHost("example.com"), false);
  assert.equal(isAllowlistedHost("next.togetherweown.com.evil.invalid"), false);
});

test("pair validation trims empty strings to unit mode", () => {
  assert.equal(validatePreviewPair("", "").mode, "unit");
  assert.equal(
    validatePreviewPair("https://a.workers.dev/", "https://b.workers.dev/").mode,
    "preview",
  );
});

test("expected marker follows the shipped manifest, not a hard-coded kit", () => {
  assert.equal(expectedMarkerFor('path: "/events/past", enabled: false', "/events/past"), null);
  assert.equal(expectedMarkerFor('path: "/events/past", enabled: true', "/events/past"), "kit");
  assert.equal(expectedMarkerFor('path: "/events/past", enabled: true', "/up"), null);
  assert.throws(() => expectedMarkerFor("no manifest here", "/events/past"), /cannot derive/);
});

test("secret scrubber hits token shapes and passes clean text", () => {
  assert.equal(scrubSecrets("hello X-TWO-QA-Auth world").length, 1);
  assert.equal(scrubSecrets("cookie __Host-two_session=abc").length, 1);
  assert.equal(scrubSecrets("Welcome, guest").length, 0);
});

test("reserved probes refuse the Kit marker", () => {
  const headers = { get: () => "kit" };
  assert.ok(assertReservedContract({ label: "t", status: 200, headers }).length > 0);
});

test("ledger verdicts never report a quiet green", () => {
  assert.equal(summarizeLedger([]).verdict, "empty");
  assert.equal(
    summarizeLedger([{ name: "a", status: "skipped", reason: "r" }]).verdict,
    "all-skipped",
  );
  assert.equal(summarizeLedger([{ name: "a", status: "failed", reason: "r" }]).verdict, "fail");
  assert.equal(summarizeLedger([{ name: "a", status: "passed", reason: null }]).verdict, "pass");
});

test("unit gate passes on the shipped manifest (no network)", async () => {
  const lines = [];
  const code = await runGate({
    env: {},
    stdout: { write: (text) => void lines.push(text) },
  });
  assert.equal(code, 0, `expected exit 0, got ${code}\n${lines.join("")}`);
  assert.ok(lines.some((line) => line.includes("mutant") || line.includes("Kit parity ledger")));
});

test("route contract detects a planted break", () => {
  const headers = {
    get: (name) => ({ "content-type": "text/html", "x-two-renderer": null })[name] ?? null,
  };
  const good = assertRouteContract({
    label: "t",
    html: `<html><head><link rel="canonical" href="x"><meta name="robots" content="noindex, follow"></head><body><a class="skip-link" href="#main">s</a><nav aria-label="Primary"></nav><main><section data-testid="past-events"></section></main><p>Welcome, guest</p><script src="/islands/past-events.js"></script></body></html>`,
    headers,
    status: 200,
    expected: { status: 200, marker: null },
  });
  assert.equal(good.length, 0, good.join("; "));
  const bad = assertRouteContract({
    label: "t",
    html: `<html><head></head><body></body></html>`,
    headers,
    status: 200,
    expected: { status: 200, marker: null },
  });
  assert.ok(bad.length > 0);
});
