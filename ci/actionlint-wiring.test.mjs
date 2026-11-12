import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("stock actionlint inventory runs on pull requests alongside the existing validator", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const scope = ci.split("\n  scope:\n")[1]?.split(/\n  [a-z][a-z-]*:\n/)[0] ?? "";
  assert.match(scope, /timeout-minutes: 15/);
  assert.match(
    scope,
    /name: Verify stock actionlint inventory\n        if: github.event_name == 'pull_request'\n        run: bash ci\/actionlint\/build.sh/,
  );
  assert.match(scope, /node ci\/workflow-lint\.mjs "\$ACTIONLINT"/);
});

test("stock build removes temporary files after setup and cleanup failures", () => {
  const temp = mkdtempSync(join(tmpdir(), "actionlint-cleanup-test-"));
  try {
    for (const createModules of [false, true]) {
      writeFileSync(
        join(temp, "mkdir"),
        `#!/bin/sh\n${createModules ? '/bin/mkdir "$3"\n' : ""}exit 42\n`,
        { mode: 0o755 },
      );
      writeFileSync(join(temp, "chmod"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
      const result = spawnSync("bash", ["ci/actionlint/build.sh"], {
        cwd: new URL("..", import.meta.url),
        env: { PATH: `${temp}:/usr/bin:/bin`, GITHUB_ACTIONS: "true", RUNNER_TEMP: temp },
        encoding: "utf8",
      });
      assert.equal(result.status, createModules ? 1 : 42, result.stderr);
      assert.deepEqual(readdirSync(temp).sort(), ["chmod", "mkdir"]);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
