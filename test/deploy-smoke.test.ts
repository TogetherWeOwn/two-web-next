import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { upBody } from "../src/up";
import { healthSql } from "./helpers/up";

// Execute the deployed workflow's actual shell block, not a copied predicate.
// curl/sleep are local fakes: no staging requests, DB connections or retry waits.
function smoke(body: string, code = "200", curlExit = "0") {
  const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");
  const block = workflow.match(/      - name: Smoke test \/up\n[\s\S]*?        run: \|\n((?:          .*\n)+)/)?.[1];
  expect(block).toBeDefined();
  const scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "up-smoke-"));
  try {
    writeFileSync(join(scratch, "curl"), `#!/bin/sh
printf x >> "$RUNNER_TEMP/attempts"
output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    https://next.togetherweown.com/up) shift ;;
    https://*) exit 2 ;;
    *) shift ;;
  esac
done
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

describe("deploy smoke /up (offline)", () => {
  it.each(["healthy", "degraded", "unknown", "unconfigured"])("accepts the existing %s response", async (state) => {
    const body = await upBody(state === "unconfigured" ? null : async () => {
      if (state === "unknown") throw new Error("fixture outage");
      return depth(state === "degraded" ? 20 : 0);
    }, healthSql());
    const result = smoke(JSON.stringify(body));
    expect(result.status, result.output).toBe(0);
    expect(result.attempts).toBe(1);
  });

  it.each([
    ['{"status":"degraded","db":"ok","pending_migrations":1,"queue":{"status":"healthy"}}', "503", "0"],
    ['{"status":"degraded","db":"ok","pending_migrations":1,"queue":{"status":"healthy"}}', "200", "0"],
    ['{"status":"degraded","db":"ok","pending_migrations":null,"queue":{"status":"healthy"}}', "503", "0"],
    ['{"status":"healthy","db":"error","pending_migrations":0,"queue":{"status":"healthy"}}', "200", "0"],
    ['{"status":"healthy","db":"ok","pending_migrations":"0","queue":{"status":"healthy"}}', "200", "0"],
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
    const result = smoke(body, code, curlExit);
    expect(result.status, result.output).toBe(1);
    expect(result.attempts).toBe(6);
    expect(result.output).toContain("::error::staging /up");
  });
});
