// Hermetic fixture-runner boundary proofs. The launch probe keeps npm, the
// production launcher, LHCI's parser/autorun and assertions real; only browser
// collection, healthcheck and upload are replaced in the child process.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL("../", import.meta.url));

function seedEvidence(root) {
  for (const name of [
    "lhr-1.json",
    "lhr-1.html",
    "assertion-results.json",
    "reports/events-report.json",
    "perf-collect.log",
    "perf-collect-diagnosis.md",
  ]) {
    const file = join(root, ".lighthouseci", name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `prior evidence: ${name}\n`);
  }
}

function snapshot(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return [path, readFileSync(path, "utf8")];
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

export async function inputSelftest(main) {
  const root = mkdtempSync(join(tmpdir(), "lh-perf-input-"));
  try {
    seedEvidence(root);
    const before = snapshot(root);
    const paths = {
      reportsDir: join(root, ".lighthouseci/reports"),
      lhciDir: join(root, ".lighthouseci"),
      logFile: join(root, ".lighthouseci/perf-collect.log"),
      diagnosisFile: join(root, ".lighthouseci/perf-collect-diagnosis.md"),
    };
    // A missing environment guard must fail before it can turn a successful
    // custom collection into a spurious short-collect retry, or erase evidence.
    for (const key of [
      "LHCI_COLLECT__NUMBER_OF_RUNS",
      "LHCI_NUMBER_OF_RUNS",
      "LHCI_N",
      "LHCI_COLLECT__URL",
      "LHCI_URL",
      "LHCI_SETTINGS__FORM_FACTOR",
      "LHCI_COLLECT__SETTINGS__FORM_FACTOR",
      "LHCI_CONFIG",
      "LHCI_NO_LIGHTHOUSERC",
      "LHCI_COLLECT__ADDITIVE",
    ]) {
      let calls = 0;
      const messages = [];
      const code = await main([], {
        ...paths,
        env: { [key]: "1" },
        run: async () => {
          calls += 1;
          return { exitCode: 0, output: "custom collection" };
        },
        log: (message) => messages.push(message),
      });
      assert.equal(code, 1, key);
      assert.equal(calls, 0, `${key}: refuse before launch`);
      assert.match(messages.join("\n"), /Unsupported collection override/, key);
      assert.deepEqual(snapshot(root), before, `${key}: no evidence writes`);
    }
    for (const flag of ["--help", "--version"]) {
      let calls = 0;
      const code = await main([flag], {
        ...paths,
        env: { LHCI_NUMBER_OF_RUNS: "1" },
        run: async () => {
          calls += 1;
          return { exitCode: 0, output: "native information" };
        },
        log: () => {},
      });
      assert.equal(code, 1, `${flag}: environment overrides remain unsupported`);
      assert.equal(calls, 0);
      assert.deepEqual(snapshot(root), before);
    }
    // A positive flag followed by its negation can make native LHCI collect.
    // Refuse mixed informational requests before forwarding or touching files.
    for (const argv of [
      ["--help", "--no-help"],
      ["--version", "--no-version", "--collect.numberOfRuns=1"],
      ["--help", "--help=false", "--collect.url=https://example.com"],
    ]) {
      let calls = 0;
      const code = await main(argv, {
        ...paths,
        env: {},
        run: async () => {
          calls += 1;
          return { exitCode: 0, output: "not an informational request" };
        },
        log: () => {},
      });
      assert.equal(code, 1, argv.join(" "));
      assert.equal(calls, 0, "mixed flags cannot bypass the fixture guard");
      assert.deepEqual(snapshot(root), before, "mixed flags preserve evidence");
    }
    // Missing early informational dispatch must fail on both native status
    // propagation and byte-for-byte preservation, independently of Chromium.
    for (const flag of ["--help", "--version", "--help=true", "--version=true"]) {
      for (const exitCode of [0, 7]) {
        let calls = 0;
        const code = await main([flag], {
          ...paths,
          env: {},
          run: async ({ extraArgs }) => {
            calls += 1;
            assert.deepEqual(extraArgs, [flag]);
            return { exitCode, output: "native information" };
          },
          log: () => {},
        });
        assert.equal(calls, 1, `${flag}: print once`);
        assert.equal(code, exitCode, `${flag}: propagate status`);
        assert.deepEqual(snapshot(root), before, `${flag}: preserve evidence`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function launcherSelftest(reports) {
  const root = mkdtempSync(join(tmpdir(), "lh-perf-launch-"));
  try {
    mkdirSync(join(root, "ci"));
    for (const name of [
      "package.json",
      "ci/lighthouse-perf-run.mjs",
      "ci/lighthouse-quality-run.mjs",
      "ci/lighthouse-samples.cjs",
      "ci/lighthouserc.cjs",
      "ci/quality-budget.json",
    ]) {
      copyFileSync(join(repo, name), join(root, name));
    }
    symlinkSync(realpathSync(join(repo, "node_modules")), join(root, "node_modules"), "dir");
    const cli = require.resolve("@lhci/cli/src/cli.js");
    const hook = join(root, "probe.cjs");
    const trace = join(root, "trace.jsonl");
    // Preload only observes the real executable boundary. Autorun and assert
    // are never mocked: a launcher override reaches LHCI's real evaluation.
    writeFileSync(
      hook,
      `const fs = require("node:fs");
const path = require("node:path");
if (process.argv[1] === ${JSON.stringify(cli)}) {
  fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(process.argv.slice(1)) + "\\n");
  for (const command of ["healthcheck", "collect", "upload"]) {
    require(path.join(path.dirname(process.argv[1]), command, command + ".js")).runCommand = async () => {
      if (command !== "collect") return;
      const dir = path.join(process.cwd(), ".lighthouseci");
      fs.mkdirSync(dir, { recursive: true });
      const reports = JSON.parse(fs.readFileSync(${JSON.stringify(join(root, "fixture.json"))}, "utf8"));
      reports.forEach((report, i) => fs.writeFileSync(path.join(dir, "lhr-" + i + ".json"), JSON.stringify(report)));
    };
  }
}
`,
    );
    // Do not inherit tokens, LHCI overrides or arbitrary Node preloads into
    // these hermetic children. No command here collects, uploads or networks.
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      NODE_OPTIONS: `--require=${hook}`,
      NO_COLOR: "1",
      npm_config_update_notifier: "false",
    };
    const invoke = (args = [], overrides = {}) => {
      writeFileSync(trace, "");
      const result = spawnSync("npm", ["run", "lighthouse", "--", ...args], {
        cwd: root,
        env: { ...env, ...overrides },
        encoding: "utf8",
        timeout: 60000,
      });
      assert.ifError(result.error);
      const launches = readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      return { ...result, launches, output: result.stdout + result.stderr };
    };
    // Dropping/replacing the launcher config or disabling an assertion must
    // kill this positive/negative pair, not merely a source-text assertion.
    for (const [audit, value] of [
      [null, 0],
      ["largest-contentful-paint", 5000],
      ["cumulative-layout-shift", 0.2],
    ]) {
      const fixture = structuredClone(reports);
      if (audit) {
        for (const report of fixture.filter(
          (report) => new URL(report.finalUrl).pathname === "/events",
        )) {
          report.audits[audit].numericValue = value;
        }
      }
      writeFileSync(join(root, "fixture.json"), JSON.stringify(fixture));
      const result = invoke();
      assert.equal(result.status, audit ? 1 : 0, result.output);
      assert.deepEqual(result.launches[0], [cli, "autorun", "--config=ci/lighthouserc.cjs"]);
      assert.deepEqual(
        result.launches.map((args) => args[1]),
        ["autorun", "healthcheck", "collect", "assert", "upload"],
      );
      if (audit) {
        assert.match(result.output, /BUDGET BREACH/);
        const failures = JSON.parse(
          readFileSync(join(root, ".lighthouseci/assertion-results.json"), "utf8"),
        );
        assert.ok(
          failures.some(
            (entry) => entry.auditId === audit && entry.level === "error" && entry.passed === false,
          ),
        );
      } else assert.match(result.output, /Collect complete: exit 0 with 24\/24 LHRs/);
    }
    for (const key of ["LHCI_COLLECT__NUMBER_OF_RUNS", "LHCI_NUMBER_OF_RUNS"]) {
      seedEvidence(root);
      const before = snapshot(join(root, ".lighthouseci"));
      const result = invoke([], { [key]: "1" });
      assert.equal(result.status, 1, result.output);
      assert.deepEqual(result.launches, [], `${key}: no LHCI launch`);
      assert.match(result.output, /Unsupported collection override/);
      assert.deepEqual(snapshot(join(root, ".lighthouseci")), before, key);
    }
    for (const args of [
      ["--help", "--no-help"],
      ["--help", "--help=false", "--collect.numberOfRuns=1"],
      ["--version", "--no-version", "--collect.numberOfRuns=1"],
    ]) {
      seedEvidence(root);
      const before = snapshot(join(root, ".lighthouseci"));
      const result = invoke(args);
      assert.equal(result.status, 1, result.output);
      assert.deepEqual(result.launches, [], "mixed informational flags do not launch LHCI");
      assert.deepEqual(snapshot(join(root, ".lighthouseci")), before);
    }
    for (const flag of ["--help", "--version"]) {
      seedEvidence(root);
      const before = snapshot(join(root, ".lighthouseci"));
      const result = invoke([flag]);
      assert.equal(result.status, 0, result.output);
      assert.deepEqual(result.launches, [[cli, "autorun", "--config=ci/lighthouserc.cjs", flag]]);
      assert.doesNotMatch(result.output, /COLLECT FAILURE|Lighthouse mobile-fixture collect/);
      assert.deepEqual(snapshot(join(root, ".lighthouseci")), before, flag);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
