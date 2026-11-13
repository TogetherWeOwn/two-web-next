import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CLIENT_DIR, collect } from "./kit-css-collect.mjs";

describe("kit css diagnostic workflow", () => {
  const url = new URL("../.github/workflows/kit-css-diagnostic.yml", import.meta.url);
  const text = readFileSync(url, "utf8");
  const code = text.split("\n").filter((line) => !/^\s*#/.test(line));
  it("keeps inputs inert, tokens empty and the run bounded", () => {
    const inputLines = code.filter((line) => line.includes("inputs."));
    assert.equal(inputLines.length, 2);
    for (const line of inputLines)
      assert.match(line, /^ {10}(BASE|HEAD)_SHA: \$\{\{ inputs\.\w+ \}\}$/);
    assert.equal(code.filter((line) => /^ {4}permissions: \{\}$/.test(line)).length, 2);
    assert.equal(code.filter((line) => /^ {4}timeout-minutes: 15$/.test(line)).length, 1);
    assert.match(text, /^permissions: \{\}$/m);
    assert.doesNotMatch(text, /secrets\.|id-token|environment:|self-hosted|GITHUB_TOKEN/);
    assert.match(text, /leg: \[base, head\]/);
    assert.match(text, /--ignore-scripts --min-release-age=3/);
    assert.equal((text.match(/WORKFLOW_SHA: \$\{\{ job\.workflow_sha \}\}/g) ?? []).length, 2);
    assert.match(text, /DEFINITION_REPOSITORY: \$\{\{ job\.workflow_repository \}\}/);
    assert.match(text, /workflow_call:/);
    assert.match(text, /include-hidden-files: true/);
  });

  it("retains hidden CSS paths in the inventory and artifact directory", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kit-css-hidden-"));
    try {
      const root = join(tmp, "source");
      const out = join(tmp, "out");
      mkdirSync(join(root, CLIENT_DIR, ".hidden"), { recursive: true });
      writeFileSync(join(root, CLIENT_DIR, ".hidden", ".file.css"), "a{b:c}");
      const manifest = collect({
        root,
        out,
        leg: "head",
        sourceSha: "a".repeat(40),
        workflowSha: "b".repeat(40),
        runId: "1",
        runAttempt: "1",
        repository: "o/r",
      });
      assert.equal(manifest.files[0].path, ".hidden/.file.css");
      assert.equal(readFileSync(join(out, "css", ".hidden", ".file.css"), "utf8"), "a{b:c}");
      assert.match(text, /include-hidden-files: true/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("executes SHA binding and fails closed for malformed or unreachable inputs", () => {
    const script = text.match(/id: bind\n[\s\S]*?run: \|\n([\s\S]*?)\n  leg:/)?.[1];
    assert.ok(script);
    const tmp = mkdtempSync(join(tmpdir(), "kit-css-bind-"));
    try {
      const bin = join(tmp, "bin");
      mkdirSync(bin);
      const git = join(bin, "git");
      writeFileSync(
        git,
        '#!/bin/sh\ncase "$*" in *fetch*) [ "$FETCH_FAIL" != 1 ] ;; *cat-file*) printf "commit\\n" ;; *branch*) [ "$UNREACHABLE" = 1 ] || printf "origin/main\\n" ;; esac\n',
      );
      chmodSync(git, 0o755);
      const sha = "a".repeat(40);
      for (const [input, unreachable, status, event, repository] of [
        ["bad;exit 0", false, 1, "workflow_dispatch", "TogetherWeOwn/two-web-next"],
        [sha, true, 1, "workflow_dispatch", "TogetherWeOwn/two-web-next"],
        [sha, "fetch", 1, "workflow_dispatch", "TogetherWeOwn/two-web-next"],
        [sha, false, 0, "workflow_dispatch", "TogetherWeOwn/two-web-next"],
        [sha, false, 0, "pull_request", "TogetherWeOwn/two-web-next"],
        ["ignored", "direct", 0, "pull_request", "TogetherWeOwn/two-web-next"],
        [sha, false, 1, "pull_request", "other/repo"],
      ]) {
        const output = join(
          tmp,
          `output-${input.length}-${unreachable}-${event}-${repository.replace("/", "-")}`,
        );
        const result = spawnSync("bash", ["-c", script], {
          encoding: "utf8",
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            RUNNER_TEMP: tmp,
            GITHUB_OUTPUT: output,
            GITHUB_EVENT_NAME: event,
            GITHUB_REPOSITORY: repository,
            DEFINITION_REPOSITORY: "TogetherWeOwn/two-web-next",
            CALLER_REF: "caller",
            DEFINITION_REF: unreachable === "direct" ? "caller" : "definition",
            PR_SHA: unreachable === "direct" ? sha : "",
            BASE_SHA: input,
            HEAD_SHA: sha,
            UNREACHABLE: unreachable === true ? "1" : "0",
            FETCH_FAIL: unreachable === "fetch" ? "1" : "0",
          },
        });
        assert.equal(result.status, status, result.stderr);
        assert.deepEqual(
          readdirSync(tmp).filter((name) => name.startsWith("bind.")),
          [],
        );
        assert.equal(existsSync(output), status === 0);
        if (status === 0) assert.equal(readFileSync(output, "utf8"), `base=${sha}\nhead=${sha}\n`);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a weakened collector boundary", () => {
    const section = text
      .split("- name: Collect bounded client CSS and manifest")[1]
      ?.split("- uses: actions/upload-artifact")[0];
    assert.ok(section);
    const check = (s) => {
      assert.match(s, /--network none/);
      assert.match(s, /--read-only/);
      assert.match(s, /dst=\/src,readonly/);
      assert.match(s, /dst=\/tools,readonly/);
      assert.doesNotMatch(s, /docker\.sock|GITHUB_ENV|GITHUB_OUTPUT|ACTIONS_RUNTIME_TOKEN/);
    };
    check(section);
    for (const [from, to] of [
      ["--network none", ""],
      ["--read-only", ""],
      ["dst=/src,readonly", "dst=/src"],
    ]) {
      assert.throws(() => check(section.replace(from, to)));
    }
  });

  it("reports cleanup failures and removes the task export", () => {
    const script = text.match(
      /- name: Remove the isolated export, caches and output\n\s+if: always\(\)\n\s+run: \|\n([\s\S]+)$/,
    )?.[1];
    assert.ok(script, "cleanup step must be present");
    assert.equal((script.match(/timeout 30s docker /g) ?? []).length, 3);
    const tmp = mkdtempSync(join(tmpdir(), "kit-css-cleanup-"));
    try {
      const bin = join(tmp, "bin");
      mkdirSync(bin);
      const docker = join(bin, "docker");
      writeFileSync(
        docker,
        '#!/bin/sh\ncase "$1" in ps) [ -f "$STATE" ] && printf "container\\n"; exit 0 ;; rm) [ "$FAIL_REMOVE" = 1 ] && exit 1; rm -f "$STATE" ;; *) exit 2 ;; esac\n',
      );
      chmodSync(docker, 0o755);
      for (const fail of [false, true]) {
        const work = join(tmp, `kit-css.${fail}`);
        const state = join(tmp, `state-${fail}`);
        mkdirSync(join(work, "export", "restricted"), { recursive: true });
        writeFileSync(join(work, "export", "restricted", "data"), "fixture");
        chmodSync(join(work, "export", "restricted"), 0o000);
        writeFileSync(state, "running");
        const result = spawnSync("bash", ["-c", script], {
          encoding: "utf8",
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            RUNNER_TEMP: tmp,
            KIT_CSS_WORK: work,
            KIT_CSS_CONTAINER: "test",
            STATE: state,
            FAIL_REMOVE: fail ? "1" : "0",
          },
        });
        assert.equal(result.status, fail ? 1 : 0, result.stderr);
        assert.equal(existsSync(work), fail);
        assert.equal(existsSync(state), fail);
        if (fail) chmodSync(join(work, "export", "restricted"), 0o700);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
