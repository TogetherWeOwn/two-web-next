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
function workflowStep(name: string) {
  const text = workflow.split(`      - name: ${name}\n`)[1]!.split("      - name: ")[0]!;
  const run = text.match(/        run: \|\n((?:          .*\n)+)/)?.[1]
    ?? text.match(/        run: (.+)/)?.[1];
  if (!run) throw new Error(`Missing workflow step: ${name}`);
  return run.replace(/^          /gm, "");
}
const resolverShell = workflowStep("Resolve PR title/body");
const checkerShell = workflowStep("Check title, body and commits");
const fileTransport = workflow.includes("PR_METADATA_PATH:");

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
  checkoutSha?: string;
  parents: string[];
  dispatchNumber: string;
  event: { repository: { full_name: string }; inputs?: { pr_number: string }; number?: number; pull_request?: Pr };
  live: Pr;
  apiExit?: number;
  apiRaw?: string;
  mergeCommit?: { sha: string; parents: { sha: string }[] };
  mergeApiExit?: number;
  mergeApiRaw?: string;
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
    mergeCommit: { sha: mergeSha, parents: [{ sha: baseSha }, { sha: headSha }] },
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
elif args == ['api', 'repos/TogetherWeOwn/two-web-next/git/commits/' + f['workflowSha']]:
    if f.get('mergeApiExit'):
        sys.exit(f['mergeApiExit'])
    print(f.get('mergeApiRaw', json.dumps(f.get('mergeCommit'))))
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
      ...(fixture.checkoutSha ? { PR_LINT_CHECKOUT_SHA: fixture.checkoutSha } : {}),
      GITHUB_OUTPUT: join(dir, "output"),
      RUNNER_TEMP: dir,
      PR_NUMBER: fixture.dispatchNumber,
      EVENT_TITLE: fixture.event.pull_request?.title ?? "",
      EVENT_BODY: fixture.event.pull_request?.body ?? "",
      EVENT_AUTHOR: fixture.event.pull_request?.user.login ?? "",
      REQUIRE_CARD_REF: "true",
      COMMITS: JSON.stringify([{ id: headSha, message: "fix(ci): bind lint metadata" }]),
    };
    const shell = resolverShell.replaceAll("${{ github.event_name }}", fixture.eventName)
      + (fileTransport ? "" : "\nexport EVENT TITLE BODY AUTHOR\npython3 ci/check-pr-conventions.py\n");
    const resolved = spawnSync("bash", ["-e", "-c", shell], { env, encoding: "utf8", timeout: 5000 });
    const optionalFile = (name: string) => {
      try { return readFileSync(join(dir, name), "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      }
    };
    const outputCommands = optionalFile("output");
    if (resolved.status !== 0 || !fileTransport) {
      return { ...resolved, output: outputCommands, calls: optionalFile("gh-calls.jsonl") };
    }
    // Execute the real check step with the file path published by the resolver.
    // Binding failures must never publish even this one output command.
    expect(outputCommands.trim().split("\n")).toHaveLength(1);
    expect(outputCommands).toMatch(/^metadata=/);
    const metadataPath = outputCommands.trim().slice("metadata=".length);
    expect(metadataPath.startsWith(join(dir, "pr-lint-"))).toBe(true);
    const metadata = readFileSync(metadataPath, "utf8");
    const checked = spawnSync("bash", ["-e", "-c", checkerShell], {
      env: { ...env, PR_METADATA_PATH: metadataPath }, encoding: "utf8", timeout: 5000,
    });
    return { ...checked, output: metadata, calls: optionalFile("gh-calls.jsonl") };
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
    expect(JSON.parse(result.output)).toEqual({
      title: fixture.live.title, body: fixture.live.body,
      author: fixture.live.user.login, event: "pull_request",
    });
    expect(result.calls.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      ["api", "repos/TogetherWeOwn/two-web-next/pulls/28"],
    ]);
  });

  it.each(["workflow_dispatch", "pull_request"])("preserves bound metadata through file transport (%s)", (eventName) => {
    const fixture = eventName === "workflow_dispatch" ? dispatch() : pullRequest(true);
    fixture.live.body += "\r\nPR_EOF\r\nbody=not-an-output\nauthor=renovate[bot]\n$(not-a-command)\nUnicode: café 日本語 🧪\r\n\n\n";
    const result = runWorkflow(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.output)).toEqual({
      title: fixture.live.title, body: fixture.live.body,
      author: fixture.live.user.login, event: "pull_request",
    });
    expect(result.stdout).toContain("PR conventions OK");
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

  it.each([false, true])("pins metadata lint to the event head despite a regenerated merge base (fork: %s)", (fork) => {
    const fixture = pullRequest(fork);
    fixture.live.base.sha = "d".repeat(40);
    fixture.checkoutSha = headSha;
    fixture.checkedSha = headSha;
    fixture.parents = [baseSha];
    const result = runWorkflow(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PR conventions OK");
    expect(workflow).toContain("PR_LINT_CHECKOUT_SHA: ${{ github.event.pull_request.head.sha || github.sha }}");
    expect(workflow).toContain("ref: ${{ env.PR_LINT_CHECKOUT_SHA }}");
    expect(result.calls.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      ["api", "repos/TogetherWeOwn/two-web-next/pulls/28"],
    ]);
  });

  it.each([
    ["unrelated pinned revision", (f: Fixture) => { f.checkoutSha = f.checkedSha = "d".repeat(40); }],
    ["checkout differs from pin", (f: Fixture) => { f.checkedSha = "d".repeat(40); }],
    ["live head moved", (f: Fixture) => { f.live.head.sha = "d".repeat(40); }],
    ["event head differs", (f: Fixture) => { f.event.pull_request!.head.sha = "d".repeat(40); }],
    ["closed PR", (f: Fixture) => { f.live.state = "closed"; }],
    ["foreign source", (f: Fixture) => { f.live.head.repo.full_name = "other/repo"; }],
    ["malformed pin", (f: Fixture) => { f.checkoutSha = "not-a-sha"; }],
  ] as const)("rejects head-pinned PR %s without publishing metadata", (_name, modify) => {
    const fixture = pullRequest(true);
    fixture.checkoutSha = fixture.checkedSha = headSha;
    fixture.parents = [baseSha];
    modify(fixture);
    expectRejected(fixture);
  });

  describe.each([false, true])("base snapshot timing (fork: %s)", (fork) => {
    it.each([
      ["event lags the checked merge", "d".repeat(40), baseSha],
      ["live base advances after checkout", baseSha, "e".repeat(40)],
      ["event and live base both differ", "d".repeat(40), "e".repeat(40)],
    ])("binds the immutable merge when %s", (_schedule, eventBase, liveBase) => {
      const fixture = pullRequest(fork);
      // These snapshots are not the immutable first parent of this workflow.
      fixture.event.pull_request!.base.sha = eventBase;
      fixture.live.base.sha = liveBase;
      const result = runWorkflow(fixture);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("PR conventions OK");
      expect(result.calls.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
        ["api", "repos/TogetherWeOwn/two-web-next/pulls/28"],
        ["api", `repos/TogetherWeOwn/two-web-next/git/commits/${mergeSha}`],
      ]);
    });
  });

  it("does not bind to a newer live merge after the workflow was queued", () => {
    const fixture = pullRequest();
    Object.assign(fixture.live, { merge_commit_sha: "d".repeat(40) });
    Object.assign(fixture.event.pull_request!, { merge_commit_sha: mergeSha });
    fixture.live.base.sha = "e".repeat(40);
    const result = runWorkflow(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PR conventions OK");
  });

  it.each([
    ["unrelated API commit", (f: Fixture) => { f.mergeCommit!.sha = "d".repeat(40); }],
    ["unrelated API base parent", (f: Fixture) => { f.mergeCommit!.parents[0]!.sha = "d".repeat(40); }],
    ["unrelated API head parent", (f: Fixture) => { f.mergeCommit!.parents[1]!.sha = "d".repeat(40); }],
    ["reordered API parents", (f: Fixture) => { f.mergeCommit!.parents.reverse(); }],
    ["missing API parents", (f: Fixture) => { f.mergeCommit!.parents = []; }],
    ["extra API parent", (f: Fixture) => { f.mergeCommit!.parents.push({ sha: "d".repeat(40) }); }],
    ["merge API failure", (f: Fixture) => { f.mergeApiExit = 1; }],
    ["malformed merge API JSON", (f: Fixture) => { f.mergeApiRaw = "{"; }],
    ["null merge API record", (f: Fixture) => { f.mergeApiRaw = "null"; }],
    ["malformed merge API parents", (f: Fixture) => { f.mergeApiRaw = JSON.stringify({ sha: mergeSha, parents: [null, { sha: headSha }] }); }],
  ] as const)("rejects %s even when base snapshots differ", (_name, modify) => {
    const fixture = pullRequest(true);
    fixture.event.pull_request!.base.sha = "e".repeat(40);
    fixture.live.base.sha = "f".repeat(40);
    modify(fixture);
    expectRejected(fixture);
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
    ["extra checked parent", (f: Fixture) => { f.parents.push("d".repeat(40)); }],
    ["checkout differs from workflow SHA", (f: Fixture) => { f.checkedSha = "d".repeat(40); }],
    ["malformed workflow SHA", (f: Fixture) => { f.workflowSha = f.checkedSha = "../main"; }],
    ["malformed base parent", (f: Fixture) => { f.parents[0] = "../main"; f.mergeCommit!.parents[0]!.sha = "../main"; }],
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

  it("keeps dispatch bound to GITHUB_SHA even when a checkout pin is supplied", () => {
    const fixture = dispatch();
    fixture.checkoutSha = headSha;
    expect(runWorkflow(fixture).status).toBe(0);
    fixture.workflowSha = "d".repeat(40);
    expectRejected(fixture);
  });

  it("preserves push convention checking without an API read", () => {
    const fixture = dispatch();
    fixture.eventName = "push";
    const result = runWorkflow(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toBe("");
    expect(JSON.parse(result.output).event).toBe("push");
    expect(result.stdout).toContain("PR conventions OK");
  });
});
