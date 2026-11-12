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

test("original workflow lint and native queue smoke remain blocking", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const build = readFileSync(new URL("./actionlint/build.sh", import.meta.url), "utf8");
  const job = (id) => ci.split(`\n  ${id}:\n`)[1]?.split(/\n  [a-z][a-z-]*:\n/)[0] ?? "";
  assert.match(build, /"\$work\/actionlint" -shellcheck= -pyflakes=\s*$/);
  const smoke = job("queue-syntax-smoke");
  assert.match(smoke, /needs: scope/);
  assert.match(
    smoke,
    /group: queue-syntax-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(smoke, /cancel-in-progress: false\n      queue: max/);
  assert.match(smoke, /permissions: \{\}/);
  assert.match(smoke, /runs-on: ubuntu-latest/);
  assert.match(smoke, /timeout-minutes: 2/);
  assert.match(smoke, /- run: "true"/);
  assert.doesNotMatch(smoke, /if:|uses:|secrets\.|environment:|continue-on-error:/);
  assert.match(job("ci-ok"), /needs:[\s\S]*queue-syntax-smoke/);
  assert.match(job("ci-ok"), /QUEUE_SMOKE_RESULT: \$\{\{ needs\.queue-syntax-smoke\.result \}\}/);
  assert.match(job("ci-ok"), /run: test "\$QUEUE_SMOKE_RESULT" = success/);
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
