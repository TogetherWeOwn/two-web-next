import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const { steps } = parse(
  readFileSync(new URL("../.github/workflows/xfs-qualification.yml", import.meta.url), "utf8"),
).jobs["kit-fatal-proof"];

test("installed XFS and Postgres teardown precede browser screenshot retention", (t) => {
  const installed = steps.find((step) => step.id === "installed");
  const parity = steps.find((step) => step.id === "production-parity");
  const postgres = steps.find((step) => step.name === "Verify loopback Postgres stopped");
  const screenshots = steps.find(
    (step) => step.name === "Retain installed Kit public voice screenshots",
  );
  assert.ok(installed && parity && postgres && screenshots, "all proof steps are present");
  assert.ok(steps.indexOf(installed) < steps.indexOf(parity), "installed proof precedes parity");
  assert.ok(steps.indexOf(parity) < steps.indexOf(postgres), "parity precedes service stop");
  assert.ok(
    steps.indexOf(postgres) < steps.indexOf(screenshots),
    "service stop precedes screenshot upload",
  );
  assert.equal(postgres.if, "always()");
  assert.equal(postgres.env.POSTGRES_CONTAINER, "${{ job.services.postgres.id }}");

  const scratch = mkdtempSync(join(tmpdir(), "xfs-qualification-workflow-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  assert.equal(installed.shell, "bash");
  const stub = `
bash() {
  if [[ "$1:$2:$3" != 'ci/xfs-qualification-fixture.sh:bash:ci/kit-worker-installed-output.sh' ]]; then
    return 99
  fi
  shift 3
  test "$*" = "$EXPECTED_ARGUMENTS" || return 99
  printf '%s\\n' 'PASS installed fixture case'
  if [[ "$CLEANUP" == yes ]]; then
    printf '%s\\n' 'Fixture mounts and backing file removed'
  fi
  return "$PROOF_STATUS"
}
`;
  for (const [event, cleanup, proofStatus, expected] of [
    ["pull_request", "yes", "0", 0],
    ["workflow_dispatch", "yes", "0", 0],
    ["pull_request", "yes", "42", 42],
    ["pull_request", "no", "0", 1],
  ]) {
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", stub + installed.run],
      {
        cwd: scratch,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          RUNNER_TEMP: scratch,
          GITHUB_EVENT_NAME: event,
          EXPECTED_ARGUMENTS: event === "workflow_dispatch" ? "" : "--public-voice-browser",
          CLEANUP: cleanup,
          PROOF_STATUS: proofStatus,
        },
      },
    );
    assert.ifError(result.error);
    assert.match(result.stdout, /PASS installed fixture case/);
    assert.equal(result.status, expected, `${event}, cleanup=${cleanup}, proof=${proofStatus}`);
  }

  assert.equal(postgres.shell, "bash");
  const dockerStub = `
docker() {
  case "$*" in
    'stop fixture-postgres') return "$STOP_STATUS" ;;
    'inspect --format {{.State.Running}} fixture-postgres') printf '%s\\n' "$RUNNING" ;;
    *) return 99 ;;
  esac
}
`;
  for (const [stopStatus, running, expected] of [
    ["0", "false", 0],
    ["42", "false", 42],
    ["0", "true", 1],
  ]) {
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", dockerStub + postgres.run],
      {
        cwd: scratch,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          POSTGRES_CONTAINER: "fixture-postgres",
          STOP_STATUS: stopStatus,
          RUNNING: running,
        },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, expected, `docker stop=${stopStatus}, running=${running}`);
    assert.equal(result.stdout.includes("Disposable Postgres stopped"), expected === 0);
  }
});
