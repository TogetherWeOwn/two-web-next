import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(ROOT, "ci/check-design-kit-drift.mjs");

test("design-kit drift selftest passes on the vendored pin", () => {
  const out = execFileSync("node", [SCRIPT, "--selftest"], { encoding: "utf8" });
  const last = out.trim().split("\n").at(-1);
  assert.deepEqual(JSON.parse(last), {
    ok: true,
    tag: readFileSync(join(ROOT, "vendor/design-kit/VERSION"), "utf8").trim(),
    mode: "selftest",
  });
});

test("design-kit network failures keep JSON output and bounded requests", () => {
  for (const bodyFailure of [false, true]) {
    const out = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import assert from "node:assert/strict";
        AbortSignal.timeout = (milliseconds) => {
          assert.equal(milliseconds, 15_000);
          return new AbortController().signal;
        };
        globalThis.fetch = async (_url, options) => {
          assert.ok(options?.signal instanceof AbortSignal);
          if (${bodyFailure}) return { ok: true, text: async () => { throw new Error("fixture body failure"); } };
          throw new Error("fixture network failure");
        };
        await import(${JSON.stringify(SCRIPT)});`,
      ],
      { encoding: "utf8", timeout: 5_000, env: {} },
    );
    assert.ifError(out.error);
    assert.equal(out.status, 1);
    const receipt = JSON.parse(out.stdout.trim());
    assert.equal(receipt.ok, false);
    assert.match(receipt.error, /kit fetch failed for https:\/\/raw\.githubusercontent\.com\//);
    assert.ok(receipt.error.endsWith(`fixture ${bodyFailure ? "body" : "network"} failure`));
    assert.ok(out.stderr.includes(receipt.error));
    assert.doesNotMatch(out.stderr, /\n\s+at /);
  }
});

test("required CI checks kit provenance and adapters after installing dependencies", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const job = workflow.split("\n  check:\n")[1]?.split(/\n  [\w-]+:\n/)[0] ?? "";
  const step =
    job.split("      - name: Design-kit provenance and adapter drift\n")[1]?.split("      - ")[0] ??
    "";
  assert.match(
    step,
    /if: \(needs\.scope\.outputs\.docs_only != 'true' && needs\.scope\.outputs\.draft != 'true'\)/,
  );
  assert.ok(
    step.includes(
      "run: npm run check:design-kit-drift:selftest && npm run check:design-kit-drift && npm run check:ember-sync:selftest && npm run check:ember-sync",
    ),
  );
  assert.ok(
    job.indexOf("run: npm ci --no-audit --no-fund") <
      job.indexOf("- name: Design-kit provenance and adapter drift"),
  );
});

test("vendored kit outputs carry the generated headers", () => {
  assert.ok(
    readFileSync(join(ROOT, "vendor/design-kit/tokens.css"), "utf8").startsWith("/* DO NOT EDIT"),
  );
  assert.ok(
    readFileSync(join(ROOT, "vendor/design-kit/tokens.ts"), "utf8").startsWith("// DO NOT EDIT"),
  );
});
