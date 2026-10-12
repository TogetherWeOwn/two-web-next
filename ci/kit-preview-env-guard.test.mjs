import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// The one-sided preview-URL guard (exactly one of
// KIT_PREVIEW_URL / HONO_PREVIEW_URL set) must exit 2 with the
// set-both-or-neither diagnostic before any fetch, and the both-URLs preview
// path must be able to reject divergent origins with exit 1. The script runs
// on import, so each case drives it as a child process with a fetch stub
// injected via --import; no network is ever touched.
const scriptPath = fileURLToPath(new URL("./kit-preview-e2e.mjs", import.meta.url));

function runScript({ env, stub }) {
  const dir = mkdtempSync(join(tmpdir(), "kit-env-guard-"));
  const stubPath = join(dir, "fetch-stub.mjs");
  writeFileSync(stubPath, stub);
  const childEnv = { ...process.env };
  delete childEnv.KIT_PREVIEW_URL;
  delete childEnv.HONO_PREVIEW_URL;
  Object.assign(childEnv, env);
  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(stubPath).href, scriptPath],
    { env: childEnv, encoding: "utf8", timeout: 120_000 },
  );
  return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

const throwingFetchStub = `
globalThis.fetch = () => {
  throw new Error("kit-preview-env-guard: fetch must not run in one-sided config");
};
`;

for (const [name, env] of [
  ["kit URL only", { KIT_PREVIEW_URL: "https://kit.invalid/" }],
  ["hono URL only", { HONO_PREVIEW_URL: "https://hono.invalid/" }],
]) {
  test(`exactly one preview URL (${name}) exits 2 with the diagnostic and no fetch`, () => {
    const { status, output } = runScript({ env, stub: throwingFetchStub });
    assert.equal(status, 2, `expected exit 2, got ${status}\n${output}`);
    assert.match(output, /set both KIT_PREVIEW_URL and HONO_PREVIEW_URL/);
    assert.doesNotMatch(output, /fetch must not run/);
    assert.doesNotMatch(output, /all parity assertions passed/);
  });
}

test("both preview URLs against divergent origins exit 1 on the section mismatch", () => {
  const page = (key) =>
    `<html><head><meta name="robots" content="noindex, follow"></head>` +
    `<body class="theme-schedule">` +
    `<section data-testid="past-events"><div data-testid="past-events-list">` +
    `<article data-event-key="${key}"></article></div></section>` +
    `<script src="/islands/past-events.js"></script></body></html>`;
  const stub = `
const page = ${page.toString()};
globalThis.fetch = async (input) => {
  const url = new URL(String(input.url ?? input));
  if (url.pathname === "/api/agent-events") {
    return new Response("{}", {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  const html = url.host === "kit.invalid" ? page("kit-only-key") : page("hono-only-key");
  return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
};
`;
  const { status, output } = runScript({
    env: { KIT_PREVIEW_URL: "https://kit.invalid/", HONO_PREVIEW_URL: "https://hono.invalid/" },
    stub,
  });
  assert.equal(status, 1, `expected exit 1, got ${status}\n${output}`);
  assert.match(output, /FAIL .*preview sections match staging/);
});
