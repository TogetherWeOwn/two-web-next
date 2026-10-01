import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repository = "TogetherWeOwn/two-web-next";
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const mergeSha = "c".repeat(40);
// An offline baseline workflow fixture lets the same assertions reproduce the
// old-source failure without modifying the checkout or dispatching live jobs.
const workflow = readFileSync(process.env.PR_LINT_WORKFLOW_FIXTURE ?? ".github/workflows/pr-lint.yml", "utf8");
const resolverShell = workflow.split("        run: |\n")[1]!
  .split("\n      - name: Check title, body and commits")[0]!
  .split("\n").map((line) => line.slice(10)).join("\n");

function releasePr() {
  return {
    number: 28,
    state: "open",
    title: "chore(main): release 0.3.0",
    body: "## Summary\nPrepare the release from conventional commits and validate it with fixtures.\n\nRefs: TOG-11399",
    user: { login: "github-actions[bot]" },
    head: { sha: headSha, repo: { full_name: repository } },
    base: { sha: baseSha, ref: "main", repo: { full_name: repository } },
  };
}

type Pr = ReturnType<typeof releasePr>;
type Fixture = {
  eventName: string;
  workflowSha: string;
  checkedSha: string;
  parents: string[];
  dispatchNumber: string;
  event: { repository: { full_name: string }; inputs?: { pr_number: string }; number?: number; pull_request?: Pr };
  live: Pr;
  apiExit?: number;
  apiRaw?: string;
};

function dispatch(): Fixture {
  return {
    eventName: "workflow_dispatch", workflowSha: headSha, checkedSha: headSha, parents: [baseSha],
    dispatchNumber: "28", event: { repository: { full_name: repository }, inputs: { pr_number: "28" } },
    live: releasePr(),
  };
}

function pullRequest(fork = false): Fixture {
  const pr = releasePr();
  if (fork) pr.head.repo.full_name = "contributor/two-web-next";
  return {
    eventName: "pull_request", workflowSha: mergeSha, checkedSha: mergeSha, parents: [baseSha, headSha],
    dispatchNumber: "", event: { repository: { full_name: repository }, number: 28, pull_request: structuredClone(pr) },
    live: pr,
  };
}

// Execute the actual workflow resolver and unchanged checker. Both gh and git
// are fixture executables; the minimal child env cannot inherit credentials/DBs.
function runWorkflow(fixture: Fixture) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "pr-lint-binding-"));
  try {
    writeFileSync(join(dir, "event.json"), JSON.stringify(fixture.event));
    writeFileSync(join(dir, "gh"), `#!/usr/bin/env python3
import json, os, sys
f = json.loads(os.environ['FIXTURE'])
args = sys.argv[1:]
with open(os.environ['GH_CALL_LOG'], 'a') as log:
    log.write(json.dumps(args) + '\\n')
if f.get('apiExit'):
    sys.exit(f['apiExit'])
if args == ['api', 'repos/TogetherWeOwn/two-web-next/pulls/28']:
    print(f.get('apiRaw', json.dumps(f['live'])))
elif args[:3] == ['pr', 'view', '28']:
    assert args[3:6] == ['--repo', 'TogetherWeOwn/two-web-next', '--json']
    field = args[6]
    assert args[7] == '--jq'
    print(f['live']['user']['login'] if field == 'author' else f['live'][field])
else:
    sys.exit('Unexpected gh invocation: ' + repr(args))
`, { mode: 0o755 });
    writeFileSync(join(dir, "git"), `#!/usr/bin/env python3
import json, os, sys
f = json.loads(os.environ['FIXTURE'])
args = sys.argv[1:]
if args == ['rev-parse', 'HEAD']:
    print(f['checkedSha'])
elif args == ['cat-file', '-p', 'HEAD']:
    print('tree ' + 'e' * 40)
    for parent in f['parents']:
        print('parent ' + parent)
    print('\\nauthor fixture\\n\\nparent ' + 'f' * 40)
else:
    sys.exit('Unexpected git invocation: ' + repr(args))
`, { mode: 0o755 });
    const env = {
      PATH: `${dir}:${process.env.PATH}`,
      FIXTURE: JSON.stringify(fixture),
      GH_CALL_LOG: join(dir, "gh-calls.jsonl"),
      GITHUB_EVENT_NAME: fixture.eventName,
      GITHUB_EVENT_PATH: join(dir, "event.json"),
      GITHUB_REPOSITORY: repository,
      GITHUB_SHA: fixture.workflowSha,
      GITHUB_OUTPUT: join(dir, "output"),
      PR_NUMBER: fixture.dispatchNumber,
      EVENT_TITLE: fixture.event.pull_request?.title ?? "",
      EVENT_BODY: fixture.event.pull_request?.body ?? "",
      EVENT_AUTHOR: fixture.event.pull_request?.user.login ?? "",
      REQUIRE_CARD_REF: "true",
      COMMITS: JSON.stringify([{ id: headSha, message: "fix(ci): bind lint metadata" }]),
    };
    const shell = resolverShell.replaceAll("${{ github.event_name }}", fixture.eventName)
      + "\nexport EVENT TITLE BODY AUTHOR\npython3 ci/check-pr-conventions.py\n";
    const result = spawnSync("bash", ["-c", shell], { env, encoding: "utf8", timeout: 5000 });
    const optionalFile = (name: string) => {
      try { return readFileSync(join(dir, name), "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      }
    };
    return { ...result, output: optionalFile("output"), calls: optionalFile("gh-calls.jsonl") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectRejected(fixture: Fixture) {
  const result = runWorkflow(fixture);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.output).toBe("");
  expect(result.stdout).not.toContain("PR conventions OK");
}

describe("PR lint dispatch binding (hermetic workflow/API fixtures)", () => {
  it("validates actual current metadata of a matching open release PR in one API snapshot", () => {
    const fixture = dispatch();
    fixture.live.title = "chore(main): release '0.3.0'";
    const result = runWorkflow(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PR conventions OK");
    expect(result.output).toContain(fixture.live.title);
    expect(result.output).toContain(fixture.live.body);
    expect(result.output).toContain(`author=${fixture.live.user.login}`);
    expect(result.output).toContain("event=pull_request");
    expect(result.calls.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      ["api", "repos/TogetherWeOwn/two-web-next/pulls/28"],
    ]);
  });

  it.each([
    ["wrong PR number", (f: Fixture) => { f.live.number = 29; }],
    ["wrong or moved head SHA", (f: Fixture) => { f.live.head.sha = "d".repeat(40); }],
    ["closed PR", (f: Fixture) => { f.live.state = "closed"; }],
    ["foreign base repository", (f: Fixture) => { f.live.base.repo.full_name = "other/repo"; }],
    ["foreign source repository", (f: Fixture) => { f.live.head.repo.full_name = "other/repo"; }],
    ["wrong event repository", (f: Fixture) => { f.event.repository.full_name = "other/repo"; }],
    ["checkout differs from workflow SHA", (f: Fixture) => { f.checkedSha = mergeSha; }],
    ["missing head SHA", (f: Fixture) => { f.live.head.sha = ""; }],
    ["missing base repository", (f: Fixture) => { f.live.base.repo.full_name = ""; }],
    ["missing source repository", (f: Fixture) => { f.live.head.repo.full_name = ""; }],
    ["API failure", (f: Fixture) => { f.apiExit = 1; }],
    ["malformed API JSON", (f: Fixture) => { f.apiRaw = "{"; }],
    ["missing API source repo", (f: Fixture) => { f.apiRaw = JSON.stringify({ ...f.live, head: { sha: headSha, repo: null } }); }],
    ["wrong dispatch event number", (f: Fixture) => { f.event.inputs!.pr_number = "29"; }],
    ["missing metadata author", (f: Fixture) => { f.live.user.login = ""; }],
  ] as const)("rejects %s before lint/output success", (_name, modify) => {
    const fixture = dispatch();
    modify(fixture);
    expectRejected(fixture);
  });

  it.each(["", "0", "-1", "028", "28/../29", "28\n29"])("rejects malformed dispatch number %j before an API read", (number) => {
    const fixture = dispatch();
    fixture.dispatchNumber = number;
    fixture.event.inputs!.pr_number = number;
    const result = runWorkflow(fixture);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.output).toBe("");
    expect(result.calls).toBe("");
  });

  it.each([false, true])("preserves normal merge-ref PR binding (fork: %s)", (fork) => {
    const fixture = pullRequest(fork);
    // The edited trigger can carry older metadata, but not a different head.
    fixture.event.pull_request!.title = "old event title";
    const result = runWorkflow(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain(fixture.live.title);
    expect(result.output).not.toContain("old event title");
    expect(result.stdout).toContain("PR conventions OK");
  });

  it("accepts a supported PR head checkout and case-insensitive GitHub repo identities", () => {
    const fixture = pullRequest(true);
    fixture.workflowSha = headSha;
    fixture.checkedSha = headSha;
    fixture.parents = [baseSha];
    fixture.live.base.repo.full_name = repository.toLowerCase();
    fixture.live.head.repo.full_name = fixture.live.head.repo.full_name.toUpperCase();
    const result = runWorkflow(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PR conventions OK");
  });

  it.each([
    ["moved live head", (f: Fixture) => { f.live.head.sha = "d".repeat(40); }],
    ["missing merge parents", (f: Fixture) => { f.parents = []; }],
    ["wrong current base repository", (f: Fixture) => { f.live.base.repo.full_name = "other/repo"; }],
    ["wrong merge head parent", (f: Fixture) => { f.parents[1] = "d".repeat(40); }],
    ["wrong merge base parent", (f: Fixture) => { f.parents[0] = "d".repeat(40); }],
    ["wrong source identity", (f: Fixture) => { f.live.head.repo.full_name = "other/repo"; }],
    ["wrong snapshot base repo", (f: Fixture) => { f.event.pull_request!.base.repo.full_name = "other/repo"; }],
    ["wrong event PR number", (f: Fixture) => { f.event.pull_request!.number = 29; }],
    ["closed current PR", (f: Fixture) => { f.live.state = "closed"; }],
  ] as const)("rejects normal PR %s", (_name, modify) => {
    const fixture = pullRequest(true);
    modify(fixture);
    expectRejected(fixture);
  });

  it("preserves push convention checking without an API read", () => {
    const fixture = dispatch();
    fixture.eventName = "push";
    const result = runWorkflow(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toBe("");
    expect(result.output).toContain("event=push");
    expect(result.stdout).toContain("PR conventions OK");
  });
});
