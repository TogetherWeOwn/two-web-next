import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/pr-lint.yml", "utf8");
const checker = "ci/check-pr-conventions.py";
const helper = "ci/pr-lint-output.py";

function step(name: string) {
  const text = workflow.split(`      - name: ${name}\n`)[1]?.split("      - name: ")[0];
  expect(text).toBeDefined();
  const run = text!.match(/        run: \|\n((?:          .*\n)+)/)?.[1]
    ?? text!.match(/        run: (.+)/)?.[1];
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
      while (++i < lines.length && lines[i]!.replace(/\r$/, "") !== heredoc[2]) value.push(lines[i]!);
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

function transport(event: string, title: string, body: string, author = "fixture-author", commits: unknown[] = []) {
  const scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "pr-lint-output-"));
  try {
    mkdirSync(join(scratch, "ci"));
    mkdirSync(join(scratch, "bin"));
    // Only local Python/bash and a fixture gh are executable; no inherited credentials.
    const commands = spawnSync("bash", ["-c", "command -v python3; command -v bash"], {
      encoding: "utf8", env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    });
    expect(commands.status).toBe(0);
    const [python, bash] = commands.stdout.trim().split("\n") as [string, string];
    symlinkSync(python, join(scratch, "bin/python3"));
    copyFileSync(checker, join(scratch, "ci/conventions.py"));
    if (existsSync(helper)) copyFileSync(helper, join(scratch, helper));
    writeFileSync(join(scratch, checker), `import json, os, runpy
from pathlib import Path
keys = ("EVENT", "TITLE", "BODY", "AUTHOR", "COMMITS")
Path("received.json").write_text(json.dumps({k: os.environ.get(k, "") for k in keys}))
runpy.run_path("ci/conventions.py", run_name="__main__")
`);
    writeFileSync(join(scratch, "fixture.json"), JSON.stringify({ title, body, author: { login: author } }));
    writeFileSync(join(scratch, "bin/gh"), `#!/usr/bin/env python3
import json, sys
from pathlib import Path
args = sys.argv[1:]
assert args[:3] == ["pr", "view", "28"]
assert args[3:5] == ["--repo", "TogetherWeOwn/fixture"]
with Path("gh-calls").open("a") as calls:
    calls.write(json.dumps(args) + "\\n")
pr = json.loads(Path("fixture.json").read_text())
fields = args[args.index("--json") + 1]
if "--jq" in args:
    value = pr[fields]
    print(value["login"] if fields == "author" else value)
else:
    assert fields == "title,body,author"
    print(json.dumps(pr))
`, { mode: 0o700 });
    const env = {
      PATH: join(scratch, "bin"),
      GITHUB_OUTPUT: join(scratch, "output"),
      RUNNER_TEMP: scratch,
      GITHUB_REPOSITORY: "TogetherWeOwn/fixture",
      EVENT: event,
      EVENT_TITLE: event === "workflow_dispatch" ? "stale title" : title,
      EVENT_BODY: event === "workflow_dispatch" ? "stale body" : body,
      EVENT_AUTHOR: event === "workflow_dispatch" ? "stale author" : author,
      PR_NUMBER: "28",
      REQUIRE_CARD_REF: "true",
      COMMITS: JSON.stringify(commits),
    };
    const resolve = step("Resolve PR title/body");
    const resolved = spawnSync(bash, ["-e", "-c", resolve.run.replaceAll("${{ github.event_name }}", event)], {
      cwd: scratch, env, encoding: "utf8", timeout: 5000,
    });
    expect(resolved.error).toBeUndefined();
    expect(resolved.status, resolved.stdout + resolved.stderr).toBe(0);
    const encoded = readFileSync(env.GITHUB_OUTPUT, "utf8");
    const values = outputs(encoded);
    const check = step("Check title, body and commits");
    const checkEnv: Record<string, string> = { ...env };
    for (const [, key, output] of check.text.matchAll(/^          (\w+): \$\{\{ steps\.pr\.outputs\.(\w+) \}\}/gm)) {
      checkEnv[key!] = values[output!] ?? "";
    }
    const checked = spawnSync(bash, ["-e", "-c", check.run], { cwd: scratch, env: checkEnv, encoding: "utf8", timeout: 5000 });
    expect(checked.error).toBeUndefined();
    const received = JSON.parse(readFileSync(join(scratch, "received.json"), "utf8"));
    expect(existsSync(join(scratch, "executed"))).toBe(false);
    const metadataPath = values.metadata!;
    expect(metadataPath.startsWith(join(scratch, "pr-lint-"))).toBe(true);
    expect(metadataPath.endsWith(".json")).toBe(true);
    expect(existsSync(metadataPath)).toBe(false);
    return {
      received, encoded, status: checked.status, output: checked.stdout + checked.stderr,
      calls: existsSync(join(scratch, "gh-calls")) ? readFileSync(join(scratch, "gh-calls"), "utf8").trim().split("\n") : [],
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const title = "fix(ci): preserve PR metadata";
const validBody = "Explain the transport change and its hermetic regression tests.\nRefs: TOG-11400";
const bodies = [
  `${validBody}\n\n\`\`\`text\nPR_EOF\n\`\`\`\nStill part of the body.`,
  `${validBody}\r\nPR_EOF\r\nUnicode: café 日本語 🧪\r\n`,
  `${validBody}\nbody=not-an-output\nauthor=renovate[bot]\n::error::inert text\n$(touch executed)\n\`touch executed\`\n`,
  `${validBody}\n\n\n`,
  `${validBody}\nLone carriage return: \r ends here.`,
  "",
];

describe.each(["pull_request", "workflow_dispatch"])("PR metadata transport (%s, offline)", (event) => {
  it.each(bodies)("round-trips complete inert metadata: %j", (body) => {
    const result = transport(event, title, body);
    expect(result.received).toMatchObject({ EVENT: "pull_request", TITLE: title, BODY: body, AUTHOR: "fixture-author" });
    expect(result.status, result.output).toBe(body ? 0 : 1);
    expect(result.calls).toHaveLength(event === "workflow_dispatch" ? 1 : 0);
    expect(result.encoded.trim().split("\n")).toHaveLength(1);
  });

  it("preserves Unicode and output-looking title/author values without running them", () => {
    const actualTitle = "fix(ci): café 日本語 🧪\nTITLE=not-an-output\nPR_EOF";
    const author = "fixture\nauthor=renovate[bot]\nPR_EOF";
    const result = transport(event, actualTitle, validBody, author);
    expect(result.received).toMatchObject({ TITLE: actualTitle, BODY: validBody, AUTHOR: author });
  });

  it("retains the release-please convention check", () => {
    const result = transport(event, "chore(main): release 0.3.0", validBody, "github-actions[bot]");
    expect(result.status, result.output).toBe(0);
    expect(result.received.AUTHOR).toBe("github-actions[bot]");
  });
});

describe("unchanged convention policy and workflow gates", () => {
  it("keeps a large Unicode API body in the job-owned file rather than an encoded env value", () => {
    const body = `${validBody}\n${"🧪".repeat(30_000)}`;
    const result = transport("workflow_dispatch", title, body);
    expect(result.received.BODY).toBe(body);
    expect(result.status, result.output).toBe(0);
    expect(result.encoded.length).toBeLessThan(1024);
  });

  it("round-trips empty title, body and author without defaults", () => {
    const result = transport("pull_request", "", "", "");
    expect(result.received).toMatchObject({ EVENT: "pull_request", TITLE: "", BODY: "", AUTHOR: "" });
    expect(result.status).toBe(1);
  });

  it("keeps the card-reference rule", () => {
    const result = transport("pull_request", title, "Explain the transport change and all the hermetic tests that were run.");
    expect(result.status).toBe(1);
    expect(result.output).toContain("::error title=Card reference::");
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

  it("retains the required check name, metadata sources, self-hosted runners and read-only permissions", () => {
    const resolve = step("Resolve PR title/body");
    expect(resolve.text).toContain("          EVENT: ${{ github.event_name }}\n");
    expect(resolve.text).toContain("          EVENT_TITLE: ${{ github.event.pull_request.title }}\n");
    expect(resolve.text).toContain("          EVENT_BODY: ${{ github.event.pull_request.body }}\n");
    expect(resolve.text).toContain("          EVENT_AUTHOR: ${{ github.event.pull_request.user.login }}\n");
    expect(resolve.text).toContain("          PR_NUMBER: ${{ inputs.pr_number }}\n");
    expect(workflow).toContain("    name: pr-lint\n");
    expect(workflow).toContain("    runs-on: [self-hosted, two-selfhosted]\n");
    expect(workflow.match(/^permissions:\n((?:  .*\n)+)/m)?.[1]).toBe("  contents: read\n  pull-requests: read\n");
  });
});
