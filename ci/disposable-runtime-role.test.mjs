import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("disposable migration workflows prepare the role before migrations", () => {
  for (const [path, expected] of [
    [".github/workflows/ci.yml", 3],
    [".github/workflows/e2e.yml", 1],
    [".github/workflows/kit-edit-regression-proof.yml", 1],
    [".github/workflows/discovery-title-evidence.yml", 1],
  ]) {
    const source = read(path);
    const migrations = [...source.matchAll(/npm run db:migrate\b/g)];
    const allPreparations = [...source.matchAll(/- name: Prepare disposable runtime role/g)];
    if (path === ".github/workflows/ci.yml") {
      assert.ok(
        allPreparations[0].index < source.indexOf("- name: Chromium cancellation regressions"),
      );
    }
    const preparations =
      path === ".github/workflows/ci.yml" ? allPreparations.slice(1) : allPreparations;
    assert.equal(preparations.length, expected, path);
    const apply = migrations.filter(
      (match) => !source.slice(match.index).startsWith("npm run db:migrate:selftest"),
    );
    assert.equal(apply.length, expected, path);
    for (let i = 0; i < expected; i++) {
      assert.ok(preparations[i].index < apply[i].index, path);
      assert.match(
        source.slice(preparations[i].index, apply[i].index),
        /-f ci\/disposable-runtime-role\.sql -f ci\/disposable-runtime-role\.sql/,
      );
    }
  }
  const workflow = read(".github/workflows/ci.yml");
  assert.match(workflow, /catalog-postgres:\n\s+image: postgres:17/);
  assert.match(
    workflow,
    /CATALOG_PREFLIGHT_TEST_DATABASE_URL: postgres:\/\/postgres:ci@catalog-postgres:5432\/postgres/,
  );
  const local = read("bin/local-ci.sh");
  assert.ok(
    local.indexOf("< ci/disposable-runtime-role.sql") <
      local.indexOf("npm run --silent db:migrate"),
  );
});

test("installed XFS socket and route proofs each migrate and stop their own Postgres service", () => {
  const { jobs } = parse(read(".github/workflows/xfs-qualification.yml"));
  const routes = jobs["kit-fatal-proof"];
  const sockets = jobs["kit-live-socket-proof"];
  assert.ok(sockets, "the live socket proof has its own job");
  const routeStep = routes.steps.find((step) => step.id === "installed");
  assert.equal(
    sockets.if,
    "${{ github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && !inputs.qualify_cutover && !inputs.moderator_rsvp_only) }}",
  );
  assert.equal(routeStep.env.KIT_INSTALLED_LIVE_SOCKET_SEPARATE, sockets.if);
  assert.equal(sockets.needs, undefined);
  assert.deepEqual(sockets.services, routes.services);
  assert.deepEqual(sockets.services.postgres.ports, ["127.0.0.1::5432"]);
  for (const [job, proof] of [
    [routes, "Run Kit and Hono against the installed XFS output"],
    [sockets, "Prove installed live sockets and fan-out"],
  ]) {
    const steps = job.steps;
    const roleSteps = steps.filter((step) => step.name === "Prepare disposable runtime role");
    const migrateSteps = steps.filter((step) => step.run?.includes("npm run db:migrate"));
    assert.equal(roleSteps.length, 1, proof);
    assert.equal(migrateSteps.length, 1, proof);
    const role = steps.indexOf(roleSteps[0]);
    const migrate = steps.indexOf(migrateSteps[0]);
    const installed = steps.findIndex((step) => step.name === proof);
    assert.ok(role >= 0 && role < migrate && migrate < installed, proof);
    assert.match(
      steps[role].run,
      /-f ci\/disposable-runtime-role\.sql -f ci\/disposable-runtime-role\.sql/,
    );
    assert.match(steps[installed].run, /Fixture mounts and backing file removed/);
    const stop = steps.find((step) => step.name === "Verify loopback Postgres stopped");
    assert.ok(steps.indexOf(stop) > installed, proof);
    assert.equal(stop.if, "always()");
    assert.equal(stop.env.POSTGRES_CONTAINER, "${{ job.services.postgres.id }}");
    assert.match(stop.run, /docker stop[^\n]*\n[^\n]*docker inspect/);
  }
  assert.match(routeStep.run, /proof=\(--moderator-rsvp-only\)/);
  assert.match(routeStep.run, /!= workflow_dispatch ]]; then\n\s+proof=\(--public-voice-browser\)/);
  assert.match(
    sockets.steps.find((step) => step.name === "Prove installed live sockets and fan-out").run,
    /ci\/kit-worker-installed-output\.sh --live-socket-only/,
  );
  assert.equal(jobs["isolated-cutover"].needs, "kit-fatal-proof");
});

test("installed XFS commands reject duplicate socket launches and missing teardown evidence", (t) => {
  const { jobs } = parse(read(".github/workflows/xfs-qualification.yml"));
  const routeProof = jobs["kit-fatal-proof"].steps.find((step) => step.id === "installed").run;
  const socketProof = jobs["kit-live-socket-proof"].steps.find(
    (step) => step.name === "Prove installed live sockets and fan-out",
  ).run;
  const scratch = mkdtempSync(join(tmpdir(), "installed-xfs-proof-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const launch = "Launching loopback kit-live Worker";
  const mounts = "Fixture mounts and backing file removed";
  const workers = "PASS loopback Workers and scratch cleaned up";
  const upgrade =
    "PASS Kit live socket upgrade, guest resync, frame limits, expiry, and revocation";
  const fanout =
    "PASS installed Kit expired and failed post-pull authorization closes without a frame";
  for (const [label, command, split, lines, fixtureStatus, expected] of [
    ["split route", routeProof, true, [mounts], 0, 0],
    ["duplicate socket launch", routeProof, true, [launch, mounts], 0, 1],
    ["unsplit route", routeProof, false, [launch, mounts], 0, 0],
    ["failed split route with cleanup", routeProof, true, [mounts], 42, 42],
    ["successful socket proof", socketProof, true, [upgrade, fanout, workers, mounts], 0, 0],
    [
      "successful socket run without upgrade proof",
      socketProof,
      true,
      [fanout, workers, mounts],
      0,
      1,
    ],
    [
      "successful socket run without fan-out proof",
      socketProof,
      true,
      [upgrade, workers, mounts],
      0,
      1,
    ],
    ["failed socket proof with cleanup", socketProof, true, [workers, mounts], 42, 42],
    ["failed socket proof without Worker cleanup", socketProof, true, [mounts], 42, 1],
    ["failed socket proof without mount cleanup", socketProof, true, [workers], 42, 1],
  ]) {
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-eo",
        "pipefail",
        "-c",
        `
bash() {
  printf '%s\\n' "$FIXTURE_LINES"
  return "$FIXTURE_STATUS"
}
${command}`,
      ],
      {
        cwd: scratch,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          RUNNER_TEMP: scratch,
          GITHUB_EVENT_NAME: "workflow_dispatch",
          MODERATOR_RSVP_ONLY: "false",
          KIT_INSTALLED_LIVE_SOCKET_SEPARATE: String(split),
          FIXTURE_LINES: lines.join("\n"),
          FIXTURE_STATUS: String(fixtureStatus),
        },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, expected, `${label}: ${result.stdout}${result.stderr}`);
  }
});
