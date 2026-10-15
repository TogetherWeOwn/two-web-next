import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/pr-gates.yml", "utf8");
const checker = "ci/check-pr-conventions.py";
const helper = "ci/pr-lint-output.py";

function step(name: string) {
  const text = workflow.split(`      - name: ${name}\n`)[1]?.split("      - name: ")[0];
  expect(text).toBeDefined();
  const run =
    text!.match(/        run: \|\n((?:          .*\n)+)/)?.[1] ??
    text!.match(/        run: (.+)/)?.[1];
  expect(run).toBeDefined();
  return { text: text!, run: run!.replace(/^          /gm, "") };
}

// Model the documented output-file commands; metadata must never become a command.
function outputs(text: string) {
  const result: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (!line) continue;
    const heredoc = line.match(/^([^=]+)<<(.+)$/);
    if (heredoc) {
      const value: string[] = [];
      while (++i < lines.length && lines[i]!.replace(/\r$/, "") !== heredoc[2])
        value.push(lines[i]!);
      if (i === lines.length) throw new Error("Missing output delimiter");
      result[heredoc[1]!] = value.join("\n");
    } else {
      const equals = line.indexOf("=");
      if (equals < 1) throw new Error(`Invalid output command: ${line}`);
      result[line.slice(0, equals)] = line.slice(equals + 1);
    }
  }
  return result;
}

function transport(
  event: string,
  title: string,
  body: string,
  author = "fixture-author",
  commits: unknown[] = [],
  branchMessages: string[] = [],
  mergedBranchMessages: string[] = [],
  baseAdvanceMessages: string[] = [],
) {
  const scratch = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "pr-lint-output-",
    ),
  );
  try {
    mkdirSync(join(scratch, "ci"));
    mkdirSync(join(scratch, "bin"));
    // Only local Python/bash and a fixture gh are executable; no inherited credentials.
    const commands = spawnSync(
      "bash",
      ["-c", "command -v python3; command -v bash; command -v git"],
      {
        encoding: "utf8",
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      },
    );
    expect(commands.status).toBe(0);
    const [python, bash, git] = commands.stdout.trim().split("\n") as [string, string, string];
    symlinkSync(python, join(scratch, "bin/python3"));
    symlinkSync(git, join(scratch, "bin/git"));
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    copyFileSync(checker, join(scratch, "ci/conventions.py"));
    if (existsSync(helper)) copyFileSync(helper, join(scratch, helper));
    copyFileSync("ci/floor_waiver_body.py", join(scratch, "ci/floor_waiver_body.py"));
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "test"],
    ]) {
      const initialized = spawnSync(git, args, { cwd: scratch, env: gitEnv, encoding: "utf8" });
      expect(initialized.status, initialized.stderr).toBe(0);
    }
    writeFileSync(join(scratch, "base.txt"), "base\n");
    for (const args of [
      ["add", "."],
      ["commit", "-qm", "base"],
    ]) {
      const committed = spawnSync(git, args, { cwd: scratch, env: gitEnv, encoding: "utf8" });
      expect(committed.status, committed.stderr).toBe(0);
    }
    const baseSha = spawnSync(git, ["rev-parse", "HEAD"], {
      cwd: scratch,
      env: gitEnv,
      encoding: "utf8",
    }).stdout.trim();
    if (baseAdvanceMessages.length) {
      for (const args of [["checkout", "-b", "main", baseSha]]) {
        const checkedOut = spawnSync(git, args, { cwd: scratch, env: gitEnv, encoding: "utf8" });
        expect(checkedOut.status, checkedOut.stderr).toBe(0);
      }
      for (const [index, message] of baseAdvanceMessages.entries()) {
        writeFileSync(join(scratch, `main-${index}.txt`), `${message}\n`);
        for (const args of [
          ["add", "."],
          ["commit", "-m", `main ${index}`, "-m", message],
        ]) {
          const committed = spawnSync(git, args, { cwd: scratch, env: gitEnv, encoding: "utf8" });
          expect(committed.status, committed.stderr).toBe(0);
        }
      }
    }
    if (mergedBranchMessages.length) {
      for (const args of [["checkout", "-b", "upstream", baseSha]]) {
        const checkedOut = spawnSync(git, args, { cwd: scratch, env: gitEnv, encoding: "utf8" });
        expect(checkedOut.status, checkedOut.stderr).toBe(0);
      }
      for (const [index, message] of mergedBranchMessages.entries()) {
        writeFileSync(join(scratch, `upstream-${index}.txt`), `${message}\n`);
        for (const args of [
          ["add", "."],
          ["commit", "-m", `upstream ${index}`, "-m", message],
        ]) {
          const committed = spawnSync(git, args, { cwd: scratch, env: gitEnv, encoding: "utf8" });
          expect(committed.status, committed.stderr).toBe(0);
        }
      }
      const checkedOut = spawnSync(git, ["checkout", "-b", "pr", baseSha], {
        cwd: scratch,
        env: gitEnv,
        encoding: "utf8",
      });
      expect(checkedOut.status, checkedOut.stderr).toBe(0);
    } else if (baseAdvanceMessages.length) {
      const checkedOut = spawnSync(git, ["checkout", "-b", "pr", baseSha], {
        cwd: scratch,
        env: gitEnv,
        encoding: "utf8",
      });
      expect(checkedOut.status, checkedOut.stderr).toBe(0);
    }
    for (const [index, message] of branchMessages.entries()) {
      writeFileSync(join(scratch, `branch-${index}.txt`), `${message}\n`);
      for (const args of [
        ["add", "."],
        ["commit", "-m", `branch ${index}`, "-m", message],
      ]) {
        const committed = spawnSync(git, args, { cwd: scratch, env: gitEnv, encoding: "utf8" });
        expect(committed.status, committed.stderr).toBe(0);
      }
    }
    if (mergedBranchMessages.length) {
      const merged = spawnSync(git, ["merge", "--no-ff", "upstream", "-m", "Merge upstream"], {
        cwd: scratch,
        env: gitEnv,
        encoding: "utf8",
      });
      expect(merged.status, merged.stderr).toBe(0);
    }
    if (baseAdvanceMessages.length) {
      const merged = spawnSync(git, ["merge", "--no-ff", "main", "-m", "Merge main"], {
        cwd: scratch,
        env: gitEnv,
        encoding: "utf8",
      });
      expect(merged.status, merged.stderr).toBe(0);
    }
    writeFileSync(
      join(scratch, checker),
      `import json, os, runpy
from pathlib import Path
keys = ("EVENT", "TITLE", "BODY", "AUTHOR", "COMMITS")
Path("received.json").write_text(json.dumps({k: os.environ.get(k, "") for k in keys}))
runpy.run_path("ci/conventions.py", run_name="__main__")
`,
    );
    writeFileSync(
      join(scratch, "fixture.json"),
      JSON.stringify({ title, body, author: { login: author } }),
    );
    // Isolate transport with already-resolved fixture metadata. The binding
    // suite executes both real helpers with fake git/API and checks admission.
    writeFileSync(
      join(scratch, "ci/resolve-pr-metadata.py"),
      `import json, os
from pathlib import Path
pr = json.loads(Path("fixture.json").read_text())
event = os.environ["GITHUB_EVENT_NAME"]
print(json.dumps({"event": "pull_request" if event == "workflow_dispatch" else event,
                  "title": pr["title"], "body": pr["body"], "author": pr["author"]["login"]}))
`,
    );
    const env = {
      PATH: join(scratch, "bin"),
      GITHUB_OUTPUT: join(scratch, "output"),
      RUNNER_TEMP: scratch,
      GITHUB_REPOSITORY: "TogetherWeOwn/fixture",
      GITHUB_EVENT_NAME: event,
      PR_NUMBER: "28",
      FLOOR_WAIVER_BASE_SHA: baseSha,
      FLOOR_WAIVER_BASE_REF: "main",
      COMMITS: JSON.stringify(commits),
    };
    const resolve = step("Resolve PR title/body");
    const resolved = spawnSync(
      bash,
      ["-e", "-c", resolve.run.replaceAll("${{ github.event_name }}", event)],
      {
        cwd: scratch,
        env,
        encoding: "utf8",
        timeout: 5000,
      },
    );
    expect(resolved.error).toBeUndefined();
    expect(resolved.status, resolved.stdout + resolved.stderr).toBe(0);
    const encoded = readFileSync(env.GITHUB_OUTPUT, "utf8");
    const values = outputs(encoded);
    const check = step("Check title, body and commits");
    const checkEnv: Record<string, string> = { ...env };
    for (const [, key, output] of check.text.matchAll(
      /^          (\w+): \$\{\{ steps\.pr\.outputs\.(\w+) \}\}/gm,
    )) {
      checkEnv[key!] = values[output!] ?? "";
    }
    const checked = spawnSync(bash, ["-e", "-c", check.run], {
      cwd: scratch,
      env: checkEnv,
      encoding: "utf8",
      timeout: 5000,
    });
    expect(checked.error).toBeUndefined();
    const received = JSON.parse(readFileSync(join(scratch, "received.json"), "utf8"));
    expect(existsSync(join(scratch, "executed"))).toBe(false);
    const metadataPath = values.metadata!;
    expect(metadataPath.startsWith(join(scratch, "pr-lint-"))).toBe(true);
    expect(metadataPath.endsWith(".json")).toBe(true);
    expect(existsSync(metadataPath)).toBe(false);
    return {
      received,
      encoded,
      status: checked.status,
      output: checked.stdout + checked.stderr,
      calls: existsSync(join(scratch, "gh-calls"))
        ? readFileSync(join(scratch, "gh-calls"), "utf8").trim().split("\n")
        : [],
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const title = "fix(ci): preserve PR metadata";
const validBody = "Explain the transport change and its hermetic regression tests.";
const bodies = [
  `${validBody}\n\n\`\`\`text\nPR_EOF\n\`\`\`\nStill part of the body.`,
  `${validBody}\r\nPR_EOF\r\nUnicode: café 日本語 🧪\r\n`,
  `${validBody}\nbody=not-an-output\nauthor=renovate[bot]\n::error::inert text\n$(touch executed)\n\`touch executed\`\n`,
  `${validBody}\n\n\n`,
  `${validBody}\nLone carriage return: \r ends here.`,
  "",
];

describe.each(["pull_request", "workflow_dispatch"])(
  "PR metadata transport (%s, offline)",
  (event) => {
    it.each(bodies)("round-trips complete inert metadata: %j", (body) => {
      const result = transport(event, title, body);
      expect(result.received).toMatchObject({
        EVENT: "pull_request",
        TITLE: title,
        BODY: body,
        AUTHOR: "fixture-author",
      });
      expect(result.status, result.output).toBe(body ? 0 : 1);
      expect(result.calls).toHaveLength(0);
      expect(result.encoded.trim().split("\n")).toHaveLength(1);
    });

    it("preserves Unicode and output-looking title/author values without running them", () => {
      const actualTitle = "fix(ci): café 日本語 🧪\nTITLE=not-an-output\nPR_EOF";
      const author = "fixture\nauthor=renovate[bot]\nPR_EOF";
      const result = transport(event, actualTitle, validBody, author);
      expect(result.received).toMatchObject({
        TITLE: actualTitle,
        BODY: validBody,
        AUTHOR: author,
      });
    });

    it("retains the release-please convention check", () => {
      const result = transport(
        event,
        "chore(main): release 0.3.0",
        validBody,
        "github-actions[bot]",
      );
      expect(result.status, result.output).toBe(0);
      expect(result.received.AUTHOR).toBe("github-actions[bot]");
    });

    it("requires waivers from a merged side branch in the PR body", () => {
      const sideWaiver = "Floor-waiver: test-deleted test/b.test.ts -- moved to docs";
      const missing = transport(event, title, validBody, "fixture-author", [], [], [sideWaiver]);
      expect(missing.status, missing.output).toBe(1);
      expect(missing.output).toContain("must appear verbatim in the PR body");
      const copied = transport(
        event,
        title,
        `${validBody}\n\n${sideWaiver}`,
        "fixture-author",
        [],
        [],
        [sideWaiver],
      );
      expect(copied.status, copied.output).toBe(0);
      expect(copied.output).toContain("PR floor-waiver trailers are visible");
    });

    it("ignores waiver trailers already on the base branch after an update-branch merge", () => {
      const baseWaiver = "Floor-waiver: test-deleted test/earlier.test.ts -- moved in earlier PR";
      const result = transport(event, title, validBody, "fixture-author", [], [], [], [baseWaiver]);
      expect(result.status, result.output).toBe(0);
      expect(result.output).not.toContain(baseWaiver);
    });

    it("requires every branch waiver in the PR body", () => {
      const waiver = "Floor-waiver: test-deleted test/a.test.ts -- moved to docs";
      const missing = transport(event, title, validBody, "fixture-author", [], [waiver]);
      expect(missing.status, missing.output).toBe(1);
      expect(missing.output).toContain("must appear verbatim in the PR body");
      const copied = transport(
        event,
        title,
        `${validBody}\n\n${waiver}`,
        "fixture-author",
        [],
        [waiver],
      );
      expect(copied.status, copied.output).toBe(0);
      expect(copied.output).toContain("PR floor-waiver trailers are visible");
    });
  },
);

describe("unchanged convention policy and workflow gates", () => {
  it("keeps the waiver self-test fail-closed for old and deleting heads", () => {
    const unit = step("Unit-test the lint");
    expect(unit.text).toContain("if [ -f ci/test_floor_waiver_body.py ]; then");
    expect(unit.text).toContain("git log --format=%H -1 HEAD -- ci/test_floor_waiver_body.py");
    expect(unit.text).toContain("Floor-waiver body test deleted at this head; refusing to skip.");
  });

  it("passes the immutable PR base SHA to waiver validation for event and dispatch runs", () => {
    const refs = step("Resolve PR head ref");
    expect(refs.text).toContain("BASE_EVENT_SHA: ${{ github.event.pull_request.base.sha }}");
    expect(refs.text).toContain(".base.sha");
    expect(refs.text).toContain('base_sha="$BASE_EVENT_SHA"');
    expect(refs.text).toContain("BASE_EVENT_REF");
    expect(refs.text).toContain(".base.ref");
    const check = step("Check title, body and commits");
    expect(check.text).toContain("FLOOR_WAIVER_BASE_SHA: ${{ steps.head-ref.outputs.base_sha }}");
    expect(check.text).toContain("FLOOR_WAIVER_BASE_REF:");
  });

  it("keeps a large Unicode API body in the job-owned file rather than an encoded env value", () => {
    const body = `${validBody}\n${"🧪".repeat(30_000)}`;
    const result = transport("workflow_dispatch", title, body);
    expect(result.received.BODY).toBe(body);
    expect(result.status, result.output).toBe(0);
    expect(result.encoded.length).toBeLessThan(1024);
  });

  it("round-trips empty title, body and author without defaults", () => {
    const result = transport("pull_request", "", "", "");
    expect(result.received).toMatchObject({
      EVENT: "pull_request",
      TITLE: "",
      BODY: "",
      AUTHOR: "",
    });
    expect(result.status).toBe(1);
  });

  it("does not require a card reference", () => {
    const result = transport(
      "pull_request",
      title,
      "Explain the transport change and all the hermetic tests that were run.",
    );
    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain("::error");
    expect(result.output).not.toContain("::warning");
  });

  it("warns, without failing, on an internal card ID in the title or body", () => {
    const body = transport("pull_request", title, `${validBody}\nRefs: TOG-1234`);
    expect(body.status, body.output).toBe(0);
    expect(body.output).toContain("::warning title=Internal ID::");
    expect(body.output).toContain("the PR body");
    const named = transport("pull_request", "fix(ci): handle PAP-77 retries", validBody);
    expect(named.status, named.output).toBe(0);
    expect(named.output).toContain("::warning title=Internal ID::");
    expect(named.output).toContain("the PR title");
  });

  it("warns on an internal card ID in a commit subject on main", () => {
    const result = transport("push", "", "", "", [
      { id: "fixture", message: "fix(ci): handle TOG-42 retries" },
    ]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("::warning title=Internal ID::");
    expect(result.output).toContain("commit subject 1");
  });

  it("keeps the title length rule", () => {
    const result = transport("pull_request", `fix(ci): ${"x".repeat(101)}`, validBody);
    expect(result.status).toBe(1);
    expect(result.output).toContain("max 100");
  });

  it("still checks push commit subjects", () => {
    const good = transport("push", "", "", "", [{ id: "fixture", message: title }]);
    expect(good.received.EVENT).toBe("push");
    expect(good.status, good.output).toBe(0);
    const bad = transport("push", "", "", "", [{ id: "fixture", message: "not conventional" }]);
    expect(bad.status).toBe(1);
    expect(bad.output).toContain("::error title=Commit on main::");
  });

  it("no longer carries the card-reference switch and defaults the internal-ID check to a warning", () => {
    expect(workflow).not.toContain("REQUIRE_CARD_REF");
    expect(workflow).toContain('\n  INTERNAL_ID_LEVEL: "warning"\n');
    expect(workflow).not.toMatch(/Refs: TOG-/);
  });

  it.each([
    ["writes the listed PR commit subjects to the job file", 0, "fix(ci): one\nfix(ci): two\n", ""],
    ["survives a failed listing with a warning and an empty file", 1, "", "::warning::"],
  ])("commit-subject step %s", (_name, ghExit, expectedFile, expectedOutput) => {
    const scratch = mkdtempSync(
      join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
        "pr-lint-subjects-",
      ),
    );
    try {
      mkdirSync(join(scratch, "bin"));
      writeFileSync(
        join(scratch, "bin/gh"),
        `#!/bin/bash\nif [ "${ghExit}" != 0 ]; then exit 1; fi\nprintf 'fix(ci): one\\nfix(ci): two\\n'\n`,
        { mode: 0o755 },
      );
      const listing = step("List PR commit subjects");
      expect(listing.text).toContain("if: github.event_name != 'push'");
      const result = spawnSync("bash", ["-c", listing.run], {
        env: {
          PATH: `${join(scratch, "bin")}:/usr/local/bin:/usr/bin:/bin`,
          RUNNER_TEMP: scratch,
          REPO: "TogetherWeOwn/fixture",
          PR_NUMBER: "28",
        },
        encoding: "utf8",
        timeout: 5000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(readFileSync(join(scratch, "pr-commit-subjects.txt"), "utf8")).toBe(expectedFile);
      if (expectedOutput) expect(result.stdout).toContain(expectedOutput);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("retains the required check name, metadata sources, visibility-routed runners and read-only permissions", () => {
    const resolve = step("Resolve PR title/body");
    expect(resolve.run).toBe("python3 ci/pr-lint-output.py resolve");
    expect(readFileSync(helper, "utf8")).toContain('with_name("resolve-pr-metadata.py")');
    expect(resolve.text).toContain("          PR_NUMBER: ${{ inputs.pr_number }}\n");
    expect(workflow).toContain("    name: pr-lint\n");
    // A public repo is always GitHub-hosted (the guard comes first, so no repo var can
    // reroute it); private repos may select an overflow runner, else the self-hosted fleet.
    expect(workflow).toContain(
      `runs-on: \${{ fromJSON((!github.event.repository.private && '["ubuntu-latest"]') || (`,
    );
    expect(workflow).toContain(`|| '["self-hosted","two-selfhosted"]') }}\n`);
    expect(workflow.match(/^permissions:\n((?:  .*\n)+)/m)?.[1]).toBe(
      "  contents: read\n  pull-requests: read\n",
    );
  });
});
