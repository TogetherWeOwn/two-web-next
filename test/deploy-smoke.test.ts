import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { upBody } from "../src/up";

// Execute the staging workflow's actual shell block with a fake checker and sleep.
// The checker itself has loopback-fixture coverage in smoke.test.mjs.
function stagingSmoke(succeedOnAttempt: number) {
  const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");
  const block = workflow.match(/      - name: Smoke test staging public routes\n[\s\S]*?        run: \|\n((?:          .*\n)+)/)?.[1];
  expect(block).toBeDefined();
  const scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "route-smoke-"));
  try {
    writeFileSync(join(scratch, "node"), `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const attempts = join(process.env.RUNNER_TEMP, "attempts");
appendFileSync(attempts, "x");
if (process.argv.length !== 4 || process.argv[2] !== "bin/smoke.mjs" || process.argv[3] !== "https://next.togetherweown.com") {
  console.error("unexpected checker invocation");
  process.exit(2);
}
const count = readFileSync(attempts, "utf8").length;
const pass = count === Number(process.env.SMOKE_SUCCEED_ON_ATTEMPT);
console.log(pass ? "smoke: 16 routes, 0 failed assertions" : "FAIL /faq: expected HTTP 200; actual HTTP 503");
process.exit(pass ? 0 : 1);
`, { mode: 0o700 });
    writeFileSync(join(scratch, "sleep"), "#!/bin/sh\nprintf x >> \"$RUNNER_TEMP/sleeps\"\nexit 0\n", { mode: 0o700 });
    writeFileSync(join(scratch, "sleeps"), "");
    writeFileSync(join(scratch, "attempts"), "");
    const bash = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" });
    expect(bash.status).toBe(0);
    // Only our fakes are on PATH: no real network request or retry delay.
    const result = spawnSync(bash.stdout.trim(), ["-e", "-c", block!.replace(/^          /gm, "")], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        PATH: scratch,
        RUNNER_TEMP: scratch,
        SMOKE_SUCCEED_ON_ATTEMPT: String(succeedOnAttempt),
      },
    });
    expect(result.error).toBeUndefined();
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      attempts: readFileSync(join(scratch, "attempts"), "utf8").length,
      sleeps: readFileSync(join(scratch, "sleeps"), "utf8").length,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Execute the production workflow's actual /up shell block, not a copied predicate.
// curl/sleep are local fakes: no production requests, DB connections or retry waits.
function productionSmoke(body: string, code = "200", curlExit = "0") {
  const workflow = readFileSync(".github/workflows/deploy-production.yml", "utf8");
  const block = workflow.match(/      - name: Smoke test \/up\n[\s\S]*?        run: \|\n((?:          .*\n)+)/)?.[1];
  expect(block).toBeDefined();
  const scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "up-smoke-"));
  try {
    writeFileSync(join(scratch, "curl"), `#!/bin/sh
printf x >> "$RUNNER_TEMP/attempts"
output=
seen=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    "$SMOKE_URL") seen=1; shift ;;
    https://*) exit 2 ;;
    *) shift ;;
  esac
done
[ "$seen" = 1 ] || exit 2
printf '%s' "$SMOKE_BODY" > "$output"
printf '%s' "$SMOKE_CODE"
exit "$SMOKE_CURL_EXIT"
`, { mode: 0o700 });
    writeFileSync(join(scratch, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    symlinkSync(process.execPath, join(scratch, "node"));
    const bash = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" });
    expect(bash.status).toBe(0);
    // Only Node and our fakes are on PATH: system jq must not be required.
    const result = spawnSync(bash.stdout.trim(), ["-e", "-c", block!.replace(/^          /gm, "")], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        PATH: scratch,
        RUNNER_TEMP: scratch,
        SMOKE_URL: "https://togetherweown.com/up",
        SMOKE_BODY: body,
        SMOKE_CODE: code,
        SMOKE_CURL_EXIT: curlExit,
      },
    });
    expect(result.error).toBeUndefined();
    return { status: result.status, output: result.stdout + result.stderr, attempts: readFileSync(join(scratch, "attempts"), "utf8").length };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const depth = (pending: number) => ({ pending, delayed: 0, reserved: 0, total: pending, failed: 0, oldestPendingAgeSeconds: null });

describe("deploy public-route smoke (offline)", () => {
  it.each([1, 3, 6])("stops on successful attempt %s", (attempt) => {
    const result = stagingSmoke(attempt);
    expect(result.status, result.output).toBe(0);
    expect(result.attempts).toBe(attempt);
    expect(result.sleeps).toBe(attempt - 1);
    expect(result.output).toContain(`staging smoke ok (attempt ${attempt})`);
    expect(result.output).not.toContain("unexpected checker invocation");
    expect(result.output).not.toContain("::error::");
  });

  it("fails closed after six failed checker runs without a final sleep", () => {
    const result = stagingSmoke(0);
    expect(result.status, result.output).toBe(1);
    expect(result.attempts).toBe(6);
    expect(result.sleeps).toBe(5);
    expect(result.output).toContain("FAIL /faq: expected HTTP 200; actual HTTP 503");
    expect(result.output).toContain("::error::staging public-route smoke failed after deploy");
    expect(result.output).not.toContain("unexpected checker invocation");
  });

  it("runs the loopback selftest in required CI as well as pre-deploy check", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    const checkJob = ci.slice(ci.indexOf("  check:\n"));
    expect(checkJob).toMatch(/      - name: Public-route smoke selftest \(loopback fixtures\)\n        run: npm run test:smoke\n/);
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts.check).toContain("npm run test:smoke");
    expect(pkg.scripts["test:smoke"]).toBe("node --test test/smoke.test.mjs");
  });
});

describe("production deploy smoke /up (offline)", () => {
  it.each(["healthy", "degraded", "unknown", "unconfigured"])("accepts the existing %s response", async (state) => {
    const body = await upBody(state === "unconfigured" ? null : async () => {
      if (state === "unknown") throw new Error("fixture outage");
      return depth(state === "degraded" ? 20 : 0);
    });
    const result = productionSmoke(JSON.stringify(body));
    expect(result.status, result.output).toBe(0);
    expect(result.attempts).toBe(1);
  });

  it.each([
    ['{"ok":true}', "200", "0"],
    ["null", "200", "0"],
    ['{"status":"healthy","queue":null}', "200", "0"],
    ['{"status":"unknown","queue":{"status":"healthy"}}', "200", "0"],
    ['{"status":"healthy","queue":{"status":"unknown"}} trailing', "200", "0"],
    ["<html>not JSON</html>", "200", "0"],
    ['{"status":"healthy"}', "200", "0"],
    ['{"status":"healthy","queue":{"status":"unexpected"}}', "200", "0"],
    ['{"status":"healthy","queue":{"status":"unknown"}}', "503", "0"],
    ['{"status":"healthy","queue":{"status":"unknown"}}', "200", "28"],
  ])("fails closed on an invalid envelope, HTTP error or curl failure (%s / %s / %s)", (body, code, curlExit) => {
    const result = productionSmoke(body, code, curlExit);
    expect(result.status, result.output).toBe(1);
    expect(result.attempts).toBe(6);
    expect(result.output).toContain("::error::production /up");
  });
});
