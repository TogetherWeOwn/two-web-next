import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import YAML from "yaml";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const base = YAML.parse(read(".github/workflows/ci.yml"), { uniqueKeys: true });
const proposal = YAML.parse(read("ci/candidate-staging-attestor-ci.yml.txt"), { uniqueKeys: true });
const mode = "staging-principal-attest";
const exclusion = `!(github.event_name == 'workflow_dispatch' && inputs.mode == '${mode}')`;
const wrap = (expression) =>
  expression?.startsWith("${{") ? expression.slice(3, -2).trim() : expression;

// Only evaluate the fixed proposed guard (not arbitrary Actions expressions).
function selected(event, input) {
  return !(event === "workflow_dispatch" && input === mode);
}

for (const [name, job] of Object.entries(base.jobs)) {
  test(`review proposal preserves ${name} except its explicit attestation exclusion`, () => {
    const changed = structuredClone(proposal.jobs[name]);
    const expected = job.if ? `(${exclusion}) && (${wrap(job.if)})` : exclusion;
    assert.equal(wrap(changed.if), expected);
    if (name === "ci-ok") {
      assert.equal(
        changed.name,
        "${{ (github.event_name == 'workflow_dispatch' && inputs.mode == 'staging-principal-attest' && 'staging-attestation-excluded-ci-ok') || 'ci-ok' }}",
      );
      changed.name = job.name;
    }
    if (job.if === undefined) delete changed.if;
    else changed.if = job.if;
    // Only copied historical tracking labels in shell/YAML comments are redacted.
    const publicSafe = JSON.parse(
      JSON.stringify(job).replace(/\b(?:TOG|TWO|PAP)-[0-9]+\b/g, "historical change"),
    );
    assert.deepEqual(changed, publicSafe);
    assert.equal(selected("workflow_dispatch", mode), false);
    for (const event of ["pull_request", "push", "schedule", "merge_group"]) {
      assert.equal(selected(event, mode), true);
    }
    assert.equal(selected("workflow_dispatch", "normal"), true);
    assert.equal(selected("workflow_dispatch", undefined), true);
  });
}

test("only the inert proposal adds the prospective manual mode and secret consumer", () => {
  assert.equal(base.jobs[mode], undefined);
  assert.equal(base.on.workflow_dispatch, null);
  const modified = structuredClone(proposal.on);
  assert.deepEqual(modified.workflow_dispatch.inputs.mode, {
    description: "Normal CI or separately admitted staging attestation",
    type: "choice",
    options: ["normal", mode],
    default: "normal",
  });
  modified.workflow_dispatch = null;
  assert.deepEqual(modified, base.on);
  assert.deepEqual(proposal.permissions, base.permissions);
  assert.deepEqual(Object.keys(proposal.jobs), [...Object.keys(base.jobs), mode]);
  const active = readdirSync(new URL("../.github/workflows/", import.meta.url));
  assert.equal(
    active.some((name) => name.includes("attestor")),
    false,
  );
  const job = proposal.jobs[mode];
  assert.equal(
    job.if,
    `github.event_name == 'workflow_dispatch' && inputs.mode == '${mode}' && github.repository == 'TogetherWeOwn/two-web-next' && github.ref != 'refs/heads/main'`,
  );
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job["timeout-minutes"], 5);
  assert.equal(job.environment, "staging");
  assert.deepEqual(job.permissions, { contents: "read" });
  const [checkout, node, observe] = job.steps;
  assert.equal(job.steps.length, 3);
  assert.equal(checkout.uses, "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
  assert.deepEqual(checkout.with, {
    ref: "${{ github.workflow_sha }}",
    "persist-credentials": false,
    "sparse-checkout-cone-mode": false,
    "sparse-checkout": "ci/candidate-staging-attestor.mjs\n",
  });
  assert.equal(node.uses, "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1");
  assert.deepEqual(node.with, { "node-version": 24 });
  assert.equal(observe.env.CLOUDFLARE_API_TOKEN, "${{ secrets.CLOUDFLARE_API_TOKEN }}");
  assert.deepEqual(Object.keys(observe.env), [
    "ATTESTOR_ENVELOPE",
    "ATTESTOR_CONTEXT",
    "CLOUDFLARE_API_TOKEN",
  ]);
  assert.match(observe.run, /operationalAdmission: false/);
  assert.match(observe.run, /requiresIndependentResolutionAcceptance: true/);
  assert.match(observe.run, /requiresSeparateSameIdPolicy: true/);
  assert.doesNotMatch(
    observe.run,
    /npm|wrangler|curl|upload|deploy|process\.env\.(?:GH_TOKEN|GITHUB_TOKEN)/i,
  );
});

const inlineImport =
  "import { prepareAttestation, observeAttestationSubject } from './ci/candidate-staging-attestor.mjs';";

function inlineAttestor() {
  const run = proposal.jobs[mode].steps.at(-1).run;
  const match = /^node --input-type=module <<'JS'\n([\s\S]+)\nJS\n$/.exec(run);
  assert.ok(match, "only the Node heredoc may execute in the subject-bearing step");
  assert.deepEqual(match[1].match(/^import .+;$/gm), [inlineImport]);
  assert.doesNotMatch(
    match[1],
    /child_process|execFile|spawn|require\s*\(|import\s*\(|getBuiltinModule|process\.(?:binding|dlopen)/,
  );
  const helper = read("ci/candidate-staging-attestor.mjs");
  assert.deepEqual(helper.match(/^import .+;$/gm), ['import { createHash } from "node:crypto";']);
  assert.doesNotMatch(
    helper,
    /child_process|require\s*\(|import\s*\(|process\.|eval\s*\(|new Function/,
  );
  return match[1].replace(inlineImport, "");
}

test("subject-bearing closure has no Git, shell or other child-process consumer", () => {
  inlineAttestor();
});

// Run only the inert inline body with mocked helper functions and no real env or
// network. Poisoned Git/credential inputs must never be read or forwarded. The
// separate helper suite owns actual preflight/transport/refusal semantics.
for (const failure of ["none", "prepare", "observe", "context"]) {
  test(`inert inline ${failure} path does not consume inherited Git or alternate credentials`, async () => {
    const body = inlineAttestor();
    const context = { checkoutSha: "b".repeat(40), runId: "777" };
    const values = {
      ATTESTOR_CONTEXT: failure === "context" ? "{" : JSON.stringify(context),
      ATTESTOR_ENVELOPE: "synthetic-envelope",
      CLOUDFLARE_API_TOKEN: "synthetic-subject-only",
      GH_TOKEN: "synthetic-alternate-gh",
      GITHUB_TOKEN: "synthetic-alternate-github",
      CLOUDFLARE_API_KEY: "synthetic-alternate-provider",
      GIT_CONFIG_GLOBAL: "/synthetic/credential-helper-config",
      GIT_CONFIG_SYSTEM: "/synthetic/system-config",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "!synthetic-helper-must-not-execute",
      GIT_EXEC_PATH: "/synthetic/git-executables",
      GIT_ASKPASS: "/synthetic/askpass",
      SSH_ASKPASS: "/synthetic/ssh-askpass",
      NODE_OPTIONS: "--import=/synthetic/must-not-load.mjs",
      PATH: "/synthetic/git-and-shell-traps",
    };
    const reads = [];
    const messages = [];
    const failures = [];
    const calls = [];
    const prepared = Object.freeze({ fixture: true });
    const observation = Object.freeze({ subjectId: "5".repeat(32) });
    const transport = () => assert.fail("fixtures never call a provider");
    const process = {
      env: new Proxy(values, {
        get(target, key) {
          reads.push(key);
          assert.ok(
            ["ATTESTOR_CONTEXT", "ATTESTOR_ENVELOPE", "CLOUDFLARE_API_TOKEN"].includes(key),
            `unexpected environment read: ${String(key)}`,
          );
          return target[key];
        },
        ownKeys() {
          assert.fail("environment enumeration could expose alternate credentials");
        },
      }),
      exitCode: undefined,
    };
    const sandbox = createContext(
      {
        process: new Proxy(process, {
          get(target, key) {
            assert.ok(["env", "exitCode"].includes(key));
            return target[key];
          },
        }),
        console: {
          log: (value) => messages.push(value),
          error: (value) => failures.push(value),
        },
        fetch: transport,
        AbortSignal: { timeout: (ms) => ({ timeout: ms }) },
        prepareAttestation: (envelope, actualContext) => {
          calls.push("prepare");
          assert.equal(envelope, values.ATTESTOR_ENVELOPE);
          assert.deepEqual(JSON.parse(actualContext), context);
          if (failure === "prepare") throw new Error(values.CLOUDFLARE_API_TOKEN);
          return prepared;
        },
        observeAttestationSubject: async (handle, options) => {
          calls.push("observe");
          assert.equal(handle, prepared);
          assert.deepEqual(Object.keys(options), ["subject", "transport", "signal"]);
          assert.equal(options.subject, values.CLOUDFLARE_API_TOKEN);
          assert.equal(options.transport, transport);
          assert.equal(options.signal.timeout, 120000);
          if (failure === "observe") throw new Error(values.CLOUDFLARE_API_TOKEN);
          return observation;
        },
      },
      { codeGeneration: { strings: false, wasm: false } },
    );
    await new Script(`(async () => {${body}})()`).runInContext(sandbox, { timeout: 1000 });
    assert.deepEqual(
      calls,
      failure === "context" ? [] : failure === "prepare" ? ["prepare"] : ["prepare", "observe"],
    );
    assert.deepEqual(
      reads,
      failure === "context"
        ? ["ATTESTOR_CONTEXT"]
        : failure === "prepare"
          ? ["ATTESTOR_CONTEXT", "ATTESTOR_ENVELOPE"]
          : ["ATTESTOR_CONTEXT", "ATTESTOR_ENVELOPE", "CLOUDFLARE_API_TOKEN"],
    );
    if (failure === "none") {
      assert.equal(process.exitCode, undefined);
      assert.deepEqual(failures, []);
      assert.equal(messages.length, 1);
      const receipt = JSON.parse(messages[0]);
      assert.deepEqual(receipt.context, context);
      assert.deepEqual(receipt.observation, observation);
      assert.equal(receipt.operationalAdmission, false);
      assert.equal(receipt.qualification, false);
      assert.equal(receipt.promotable, false);
    } else {
      assert.equal(process.exitCode, 1);
      assert.deepEqual(messages, []);
      assert.deepEqual(failures, ["Staging attestation refused"]);
    }
    const output = JSON.stringify({ messages, failures });
    for (const [key, value] of Object.entries(values)) {
      // The count "1" also occurs in legitimate schema v1; exact read assertions
      // above cover that scalar. Credential and helper-path markers stay screened.
      if (!["ATTESTOR_CONTEXT", "ATTESTOR_ENVELOPE", "GIT_CONFIG_COUNT"].includes(key)) {
        assert.ok(!output.includes(value), key);
      }
    }
  });
}

test("proposal concurrency separates attestation but retains ordinary CI groups and cancellation", () => {
  const format = (value, ...args) => value.replace(/\{([0-9]+)\}/g, (_, i) => args[Number(i)]);
  const evaluate = (source, github, inputs) => {
    const expression = (text) =>
      new Function("github", "inputs", "format", `return ${text}`)(github, inputs, format);
    const parts = [...source.matchAll(/\$\{\{([\s\S]*?)\}\}/g)];
    if (parts.length === 1 && parts[0][0] === source) return expression(parts[0][1]);
    return source.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, text) => String(expression(text)));
  };
  for (const event of ["pull_request", "push", "schedule", "merge_group", "workflow_dispatch"]) {
    for (const ref of ["refs/heads/main", "refs/heads/feat/control"]) {
      const github = {
        event_name: event,
        ref,
        workflow: "ci",
        run_id: "800",
        event: { pull_request: { number: 2061 } },
      };
      for (const input of [undefined, "normal", mode]) {
        const inputs = { mode: input };
        const checkName = evaluate(proposal.jobs["ci-ok"].name, github, inputs);
        assert.equal(
          checkName,
          event === "workflow_dispatch" && input === mode
            ? "staging-attestation-excluded-ci-ok"
            : "ci-ok",
        );
        if (event === "workflow_dispatch" && input === mode) {
          assert.equal(
            evaluate(proposal.concurrency.group, github, inputs),
            "staging-attestor-800",
          );
          assert.equal(evaluate(proposal.concurrency["cancel-in-progress"], github, inputs), false);
        } else {
          assert.equal(
            evaluate(proposal.concurrency.group, github, inputs),
            evaluate(base.concurrency.group, github, inputs),
          );
          assert.equal(
            evaluate(proposal.concurrency["cancel-in-progress"], github, inputs),
            evaluate(base.concurrency["cancel-in-progress"], github, inputs),
          );
        }
      }
    }
  }
});

test("every installed CI workflow_run consumer rejects manual attestation before deploying", () => {
  const root = new URL("../.github/workflows/", import.meta.url);
  const consumers = readdirSync(root)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => ({
      name,
      workflow: YAML.parse(readFileSync(new URL(name, root), "utf8"), { uniqueKeys: true }),
    }))
    .filter(({ workflow }) => workflow.on?.workflow_run?.workflows?.includes("ci"));
  assert.deepEqual(
    consumers.map(({ name }) => name),
    ["deploy.yml"],
  );
  for (const { workflow } of consumers) {
    const source = wrap(workflow.jobs["deploy-staging"].if);
    assert.match(source, /github\.event\.workflow_run\.event == 'push'/);
    const evaluate = (github) => new Function("github", `return ${source}`)(github);
    for (const branch of ["main", "feat/control"]) {
      assert.equal(
        evaluate({
          event_name: "workflow_run",
          event: {
            workflow_run: {
              event: "workflow_dispatch",
              head_branch: branch,
              conclusion: "success",
              head_repository: { full_name: "TogetherWeOwn/two-web-next" },
            },
          },
        }),
        false,
      );
    }
  }
});

test("review manifest rehashes exact helper/workflow and installed production-path inputs", () => {
  const manifest = JSON.parse(read("ci/candidate-staging-attestor-closure.json"));
  assert.equal(manifest.executable, false);
  assert.equal(manifest.operationalAdmission, false);
  assert.equal(manifest.schema, "two.staging-attestor-closure.v1");
  assert.deepEqual(Object.keys(manifest.files), [
    "ci/candidate-staging-attestor.mjs",
    "ci/candidate-staging-attestor-ci.yml.txt",
    ".github/workflows/ci.yml",
    ".github/workflows/deploy.yml",
    ".github/workflows/e2e-staging.yml",
    ".github/workflows/deploy-production.yml",
  ]);
  for (const [path, hash] of Object.entries(manifest.files)) {
    assert.equal(createHash("sha256").update(read(path)).digest("hex"), hash, path);
  }
  assert.deepEqual(manifest.actions, {
    "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/setup-node": "949feb2413d6458794dcd2491c4babbbce0c15c1",
  });
  const helper = read("ci/candidate-staging-attestor.mjs");
  assert.doesNotMatch(helper, /process\.env|fetch\(|from ["'](?!node:)/);
});
