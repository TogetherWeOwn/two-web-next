import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import YAML from "yaml";

const ROOT = new URL("../.github/workflows/", import.meta.url);
const EXCLUSIVE = "staging-application-exclusive";
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const NODE = "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1";
const GUARD = "./.github/workflows/staging-occupancy-clear.yml";
const CLOSURE = [
  "ci/candidate-staging-clear.mjs",
  "ci/candidate-staging-occupancy.mjs",
  "ci/candidate-staging-admission.mjs",
];

function workflow(name) {
  return YAML.parse(readFileSync(new URL(`${name}.yml`, ROOT), "utf8"), { uniqueKeys: true });
}

// Evaluate only expressions from these reviewed workflow fixtures, never API or
// dispatch text. Fixtures use canonical-case strings: JavaScript equality is
// case-sensitive, unlike Actions. This is not a general Actions evaluator.
// format is the sole Actions function in these group expressions.
function evaluate(expression, github, inputs = {}) {
  const source = expression.startsWith("${{") ? expression.slice(3, -2) : expression;
  return new Function("github", "inputs", "format", `return ${source}`)(
    github,
    inputs,
    (template, value) => template.replace("{0}", value),
  );
}

function eventContext(event = "workflow_dispatch") {
  return {
    event_name: event,
    ref: "refs/heads/main",
    repository: "TogetherWeOwn/two-web-next",
    run_id: "900",
    event: {
      workflow_run: {
        event: "push",
        conclusion: "success",
        head_branch: "main",
        head_repository: { full_name: "TogetherWeOwn/two-web-next" },
      },
    },
  };
}

function holdsGlobal(w) {
  assert.equal(w.concurrency["cancel-in-progress"], false);
  for (const event of ["workflow_run", "workflow_dispatch"]) {
    assert.equal(evaluate(w.concurrency.group, eventContext(event)), EXCLUSIVE);
  }
}

function trustedCheckout(step) {
  assert.equal(step.uses, CHECKOUT);
  assert.equal(step.with.ref, "${{ github.workflow_sha }}");
  assert.equal(step.with["persist-credentials"], false);
  assert.equal(step.with["sparse-checkout-cone-mode"], false);
  assert.deepEqual(step.with["sparse-checkout"].trim().split("\n"), CLOSURE);
}

function guardJob(job) {
  assert.equal(job.uses, GUARD);
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(job.secrets, undefined);
  assert.doesNotMatch(job.if ?? "", /always\(|cancelled\(|failure\(/);
}

function needs(job, id) {
  assert.ok((Array.isArray(job.needs) ? job.needs : [job.needs]).includes(id));
  assert.equal(job["continue-on-error"], undefined);
  // No explicit status function may override the implicit success() dependency.
  assert.doesNotMatch(job.if ?? "", /always\(|cancelled\(|failure\(/);
}

test("normal guard workflow is read-only, reusable only, and inherits rather than reacquiring exclusion", () => {
  const w = workflow("staging-occupancy-clear");
  assert.deepEqual(Object.keys(w.on), ["workflow_call"]);
  assert.deepEqual(w.permissions, { contents: "read", deployments: "read" });
  assert.equal(w.concurrency, undefined);
  assert.deepEqual(Object.keys(w.jobs), ["staging-occupancy-clear"]);
  const job = w.jobs["staging-occupancy-clear"];
  assert.equal(job.environment, undefined);
  assert.equal(job.concurrency, undefined);
  assert.equal(job["timeout-minutes"], 3);
  assert.equal(job.steps.length, 3);
  trustedCheckout(job.steps[0]);
  assert.equal(job.steps[1].uses, NODE);
  assert.equal(job.steps[1].with["node-version"], 24);
  assert.equal(job.steps[2].run, "node ci/candidate-staging-clear.mjs");
  assert.deepEqual(job.steps[2].env, { GITHUB_TOKEN: "${{ github.token }}" });
  for (const step of job.steps) {
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
  }
});

test("deploy holds the global key across all mutations and checks occupancy before dependencies or probes", () => {
  const w = workflow("deploy");
  holdsGlobal(w);
  assert.equal(w.permissions.deployments, "read");
  const job = w.jobs["deploy-staging"];
  // Keep staging rollback's existing mutual exclusion during partial migration.
  assert.deepEqual(job.concurrency, { group: "deploy-staging", "cancel-in-progress": false });
  assert.match(job.if, /head_repository.full_name == github.repository/);
  assert.match(job.if, /github.ref == 'refs\/heads\/main'/);
  const index = job.steps.findIndex(
    (step) => step.name === "Refuse unresolved candidate occupancy",
  );
  assert.ok(index > 0);
  trustedCheckout(job.steps[index - 1]);
  assert.equal(job.steps[index - 1].with.path, ".staging-occupancy-control");
  assert.equal(
    job.steps[index].run,
    "node .staging-occupancy-control/ci/candidate-staging-clear.mjs",
  );
  assert.deepEqual(job.steps[index].env, { GITHUB_TOKEN: "${{ github.token }}" });
  for (const step of job.steps.slice(0, index + 1)) {
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
    assert.doesNotMatch(step.run ?? "", /npm |wrangler|https?:\/\//);
  }
  assert.ok(job.steps.findIndex((step) => step.run === "npm ci") > index);
  assert.ok(
    job.steps.findIndex((step) => step.name === "Capture pre-deploy dead-letter baseline") > index,
  );
  // Only the admission tooling comes from workflow_sha. The original deployed
  // source selection and exact-SHA full-CI gate remain separate and unchanged.
  assert.equal(job.steps[0].uses, CHECKOUT);
  assert.equal(
    job.steps[0].with.ref,
    "${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}",
  );
  assert.equal(
    job.steps.find((step) => step.name === "Require successful exact-SHA full CI").run,
    "node ci/staging-deploy-gate.mjs",
  );
});

test("staging e2e holds one continuous lock through its unchanged suite and reusable children", () => {
  const w = workflow("e2e-staging");
  holdsGlobal(w);
  assert.equal(w.permissions.deployments, "read");
  guardJob(w.jobs["staging-occupancy"]);
  needs(w.jobs.scope, "staging-occupancy");
  needs(w.jobs["zap-baseline"], "staging-occupancy");
  for (const name of ["staging-passive", "staging-journeys", "staging-quality"]) {
    needs(w.jobs[name], "scope");
    assert.equal(w.jobs[name].concurrency, undefined);
  }
  const journeys = w.jobs["staging-journeys"].steps.find(
    (step) => step.name === "Staging critical journeys",
  );
  assert.equal(journeys.run, "npm run e2e:staging");
  assert.deepEqual(journeys.env, { QA_AUTH_TOKEN: "${{ secrets.QA_AUTH_TOKEN }}" });
  assert.equal(w.jobs["staging-journeys"]["timeout-minutes"], 25);
  assert.equal(w.jobs["zap-baseline"].with.staging_lock_inherited, true);
  assert.equal(w.jobs["staging-quality"].with.staging_lock_inherited, true);
  assert.equal(w.jobs["staging-quality"].with.origin, "https://next.togetherweown.com");
});

for (const [name, leaf, suffix] of [
  ["zap-staging", "zap-baseline", "zap"],
  ["web-quality-origin", "quality", "quality"],
]) {
  test(`${name} acquires global exclusion standalone and a distinct nonblocking group when inherited`, () => {
    const w = workflow(name);
    assert.deepEqual(w.on.workflow_call.inputs.staging_lock_inherited, {
      description: "The trusted caller holds staging-application-exclusive for this entire call",
      type: "boolean",
      default: false,
    });
    assert.equal(w.on.workflow_dispatch?.inputs?.staging_lock_inherited, undefined);
    assert.equal(w.concurrency["cancel-in-progress"], false);
    assert.equal(evaluate(w.concurrency.group, eventContext()), EXCLUSIVE);
    assert.equal(
      evaluate(w.concurrency.group, eventContext(), { staging_lock_inherited: true }),
      `staging-inherited-${suffix}-900`,
    );
    const rejected = { ...eventContext(), ref: "refs/heads/topic" };
    for (const inherited of [false, true]) {
      assert.equal(
        evaluate(w.concurrency.group, rejected, { staging_lock_inherited: inherited }),
        `staging-rejected-${suffix}-900`,
      );
      assert.equal(evaluate(w.jobs["staging-occupancy"].if, rejected), false);
    }
    assert.equal(w.permissions.deployments, "read");
    guardJob(w.jobs["staging-occupancy"]);
    needs(w.jobs[leaf], "staging-occupancy");
    assert.equal(w.jobs[leaf].concurrency, undefined);
    assert.deepEqual(Object.keys(w.jobs), ["staging-occupancy", leaf]);
  });
}

test("every in-repository inherited child call has a parent holding global exclusion", () => {
  const found = [];
  for (const filename of readdirSync(ROOT).filter((name) => name.endsWith(".yml"))) {
    const w = YAML.parse(readFileSync(new URL(filename, ROOT), "utf8"));
    for (const [name, job] of Object.entries(w.jobs ?? {})) {
      if (
        ![
          "./.github/workflows/zap-staging.yml",
          "./.github/workflows/web-quality-origin.yml",
        ].includes(job.uses)
      )
        continue;
      found.push(`${filename}:${name}`);
      holdsGlobal(w);
      assert.equal(job.with.staging_lock_inherited, true);
      assert.equal(job.concurrency, undefined);
    }
  }
  assert.deepEqual(found, ["e2e-staging.yml:zap-baseline", "e2e-staging.yml:staging-quality"]);
});

for (const name of ["deploy", "e2e-staging"]) {
  for (const [label, mutate] of [
    [
      "failed deploy",
      (g) => {
        g.event.workflow_run.conclusion = "failure";
      },
    ],
    [
      "cancelled deploy",
      (g) => {
        g.event.workflow_run.conclusion = "cancelled";
      },
    ],
    [
      "skipped deploy",
      (g) => {
        g.event.workflow_run.conclusion = "skipped";
      },
    ],
    [
      "missing conclusion",
      (g) => {
        g.event.workflow_run.conclusion = null;
      },
    ],
    [
      "non-main completion",
      (g) => {
        g.event.workflow_run.head_branch = "topic";
      },
    ],
    [
      "foreign completion",
      (g) => {
        g.event.workflow_run.head_repository.full_name = "attacker/two-web-next";
      },
    ],
    [
      "non-main dispatch",
      (g) => {
        g.event_name = "workflow_dispatch";
        g.ref = "refs/heads/topic";
      },
    ],
    [
      "PR event",
      (g) => {
        g.event_name = "pull_request";
      },
    ],
  ]) {
    test(`${name}: ${label} cannot displace an eligible pending member of the global group`, () => {
      const w = workflow(name);
      const github = eventContext("workflow_run");
      mutate(github);
      const group = evaluate(w.concurrency.group, github);
      assert.equal(group, `staging-rejected-${name === "deploy" ? "deploy" : "e2e"}-900`);
      assert.notEqual(group, EXCLUSIVE);
      const admission =
        name === "deploy" ? w.jobs["deploy-staging"].if : w.jobs["staging-occupancy"].if;
      assert.equal(evaluate(admission, github), false);
    });
  }
}

test("non-push CI completions never acquire deploy's shared group", () => {
  const w = workflow("deploy");
  for (const event of ["pull_request", "workflow_dispatch", "schedule"]) {
    const github = eventContext("workflow_run");
    github.event.workflow_run.event = event;
    assert.equal(evaluate(w.concurrency.group, github), "staging-rejected-deploy-900");
    assert.equal(evaluate(w.jobs["deploy-staging"].if, github), false);
  }
});

// These pins preserve every pre-existing leaf job (including its command,
// secret, scope, timeout, runner and reporting conditions). Only the new root
// prerequisite is removed before comparison; census keeps its scope dependency.
const AUXILIARY = [
  [
    "staging-smoke",
    "internal-action-smoke",
    "928d7b9f72d0eadd459c70056baba5b36be0ed62e7cd660dc612ddf0fd1e6b9a",
  ],
  [
    "staging-role-bootstrap",
    "bootstrap",
    "ee19b564541bf62cee2f2f4851a334139ce6918adff480a25880c5eec6ac7501",
  ],
  [
    "staging-importer-dryrun",
    "dryrun",
    "3eda652b2790897dab2efe4e83ddb3f8cd9a3cd68fd06b5b2232e7d28e40e075",
  ],
  [
    "staging-catalog-preflight",
    "preflight",
    "f7b7cfcb81d303358d57f4d58767e3f102953d62fe3694f968d5eba868f05bb3",
  ],
  ["staging-census", "scope", "75b7ffca980c596626d1bf3aef29653f0d5179f7cfab7b5bd808a71cb355cd7d"],
  [
    "explore-staging",
    "explore",
    "ebcc55d7ac61e977204eaa15295ea85f2f901b30e6ffa004ae8f07d36afd13cd",
  ],
  [
    "error-rate-gate-rehearsal",
    "rehearsal",
    "b0268f57eb97ad9d807059f1705d6b67916d3572248ebbf727dae1e6c4d290c4",
  ],
];

for (const [name, root, baseline] of AUXILIARY) {
  test(`${name}: continuous exclusion and read-only guard precede the unchanged job graph`, () => {
    const w = workflow(name);
    assert.deepEqual(w.permissions, { contents: "read", deployments: "read" });
    assert.equal(w.concurrency["cancel-in-progress"], false);
    assert.ok(
      Object.keys(w.on).every((event) => ["workflow_dispatch", "schedule"].includes(event)),
    );
    assert.ok(Object.hasOwn(w.on, "workflow_dispatch"));
    guardJob(w.jobs["staging-occupancy"]);
    assert.equal(w.jobs["staging-occupancy"].concurrency, undefined);
    assert.equal(w.jobs["staging-occupancy"].needs, undefined);
    assert.equal(w.jobs["staging-occupancy"].with, undefined);
    needs(w.jobs[root], "staging-occupancy");
    const originalJobs = structuredClone(w.jobs);
    delete originalJobs["staging-occupancy"];
    delete originalJobs[root].needs;
    for (const job of Object.values(originalJobs)) assert.equal(job.concurrency, undefined);
    assert.equal(createHash("sha256").update(JSON.stringify(originalJobs)).digest("hex"), baseline);
    if (name === "staging-census") {
      needs(w.jobs.census, "scope");
      assert.equal(w.jobs.census.if, "needs.scope.outputs.relevant == 'true'");
    }
  });

  for (const event of ["workflow_dispatch", "schedule"]) {
    test(`${name}: main ${event} holds the shared group throughout the guard and leaves`, () => {
      const w = workflow(name);
      const github = eventContext(event);
      assert.equal(evaluate(w.concurrency.group, github), EXCLUSIVE);
      assert.equal(evaluate(w.jobs["staging-occupancy"].if, github), true);
    });
  }

  for (const [label, mutate] of [
    [
      "topic dispatch",
      (g) => {
        g.ref = "refs/heads/topic";
      },
    ],
    [
      "tag dispatch",
      (g) => {
        g.ref = "refs/tags/main";
      },
    ],
    [
      "non-main schedule",
      (g) => {
        g.event_name = "schedule";
        g.ref = "refs/heads/topic";
      },
    ],
    [
      "PR event",
      (g) => {
        g.event_name = "pull_request";
      },
    ],
    [
      "privileged PR event",
      (g) => {
        g.event_name = "pull_request_target";
      },
    ],
    [
      "push event",
      (g) => {
        g.event_name = "push";
      },
    ],
    [
      "workflow completion",
      (g) => {
        g.event_name = "workflow_run";
      },
    ],
  ]) {
    test(`${name}: ${label} cannot displace eligible work or reach the guard's dependent jobs`, () => {
      const w = workflow(name);
      const github = eventContext();
      mutate(github);
      assert.equal(evaluate(w.concurrency.group, github), `staging-rejected-${name}-900`);
      assert.equal(evaluate(w.jobs["staging-occupancy"].if, github), false);
    });
  }
}

const DATABASE_ACTORS = [
  ["db-migrate", "migrate", "c9b939ed2f60e16b8d6e8277e8f3e7a8ed144b42b838dd290ff3912e89804a7f"],
  ["db-backup", "backup", "a3aeaab7f2cbbc30f13ca5f3fcc61cac329feef10a7888d26d305ce245ea955a"],
];

for (const [name, leaf, baseline] of DATABASE_ACTORS) {
  const start = name === "db-migrate" ? 1 : 0;
  test(`${name}: full-job staging exclusion precedes every original database operation`, () => {
    const w = workflow(name);
    const job = w.jobs[leaf];
    assert.equal(w.permissions.deployments, "read");
    assert.equal(job.concurrency["cancel-in-progress"], false);
    const steps = job.steps.slice(start, start + 3);
    assert.equal(steps[0].name, "Read installed staging occupancy tooling");
    trustedCheckout(steps[0]);
    assert.equal(steps[0].with.path, ".staging-occupancy-control");
    assert.equal(steps[1].uses, NODE);
    assert.deepEqual(steps[1].with, { "node-version": 24 });
    assert.equal(steps[2].name, "Refuse unresolved candidate occupancy");
    assert.equal(steps[2].run, "node .staging-occupancy-control/ci/candidate-staging-clear.mjs");
    assert.deepEqual(steps[2].env, { GITHUB_TOKEN: "${{ github.token }}" });
    for (const step of steps) {
      assert.equal(step["continue-on-error"], undefined);
      assert.doesNotMatch(step.if, /always\(|cancelled\(|failure\(/);
      assert.equal(evaluate(step.if, eventContext(), { target: "staging" }), true);
      assert.equal(evaluate(step.if, eventContext(), { target: "production" }), false);
    }
    // Remove only the new fence: the entire original parsed workflow, including
    // trigger set, legacy lock, production gates and every leaf step, is pinned.
    const original = structuredClone(w);
    delete original.permissions.deployments;
    delete original.jobs[leaf].if;
    delete original.jobs[leaf].concurrency;
    original.jobs[leaf].steps.splice(start, 3);
    assert.equal(createHash("sha256").update(JSON.stringify(original)).digest("hex"), baseline);
    if (name === "db-migrate") {
      assert.match(job.steps[0].name, /^Ref and production enable gate/);
      assert.doesNotMatch(job.steps[0].run, /node |npm |wrangler|https?:\/\//);
    }
    for (const step of original.jobs[leaf].steps) {
      assert.doesNotMatch(step.if ?? "", /always\(|cancelled\(|failure\(/);
    }
  });

  for (const event of ["workflow_dispatch", ...(name === "db-backup" ? ["schedule"] : [])]) {
    test(`${name}: main ${event} stages under one shared lock, with no nested legacy key`, () => {
      const w = workflow(name);
      const job = w.jobs[leaf];
      const github = eventContext(event);
      for (const target of ["staging", ...(name === "db-backup" ? ["", undefined] : [])]) {
        const inputs = { target };
        assert.equal(evaluate(job.if, github, inputs), true);
        assert.equal(evaluate(job.concurrency.group, github, inputs), EXCLUSIVE);
        for (const step of job.steps.slice(start, start + 3))
          assert.equal(evaluate(step.if, github, inputs), true);
      }
      assert.notEqual(w.concurrency.group, EXCLUSIVE);
      assert.equal(w.concurrency["cancel-in-progress"], false);
    });
  }

  for (const ref of ["refs/heads/main", "refs/heads/topic", "refs/tags/main"]) {
    test(`${name}: production on ${ref} keeps its existing path outside staging admission`, () => {
      const w = workflow(name);
      const job = w.jobs[leaf];
      const github = { ...eventContext(), ref };
      const inputs = { target: "production" };
      assert.equal(evaluate(job.if, github, inputs), true);
      assert.equal(evaluate(job.concurrency.group, github, inputs), `staging-unlocked-${name}-900`);
      for (const step of job.steps.slice(start, start + 3))
        assert.equal(evaluate(step.if, github, inputs), false);
    });
  }

  for (const [label, ref, target] of [
    ["topic staging", "refs/heads/topic", "staging"],
    ["tag staging", "refs/tags/main", "staging"],
    ["unknown target", "refs/heads/main", "preview"],
    ["unknown target with spaces", "refs/heads/main", " staging "],
  ]) {
    test(`${name}: ${label} cannot displace the shared group or run database steps`, () => {
      const job = workflow(name).jobs[leaf];
      const github = { ...eventContext(), ref };
      const inputs = { target };
      assert.equal(evaluate(job.if, github, inputs), false);
      assert.equal(evaluate(job.concurrency.group, github, inputs), `staging-unlocked-${name}-900`);
    });
  }
}

test("database actors have no staging reusable callers that could reacquire their parent's shared lock", () => {
  const calls = [];
  for (const filename of readdirSync(ROOT).filter((name) => name.endsWith(".yml"))) {
    for (const [id, job] of Object.entries(workflow(filename.slice(0, -4)).jobs ?? {})) {
      if (
        ["./.github/workflows/db-migrate.yml", "./.github/workflows/db-backup.yml"].includes(
          job.uses,
        )
      ) {
        calls.push(`${filename}:${id}`);
      }
    }
  }
  assert.deepEqual(calls, []);
});

test("occupancy source closure resolves only Node builtins and its three explicitly checked out files", () => {
  for (const path of CLOSURE) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    assert.ok(imports.length > 0);
    for (const specifier of imports) {
      assert.ok(specifier.startsWith("node:") || CLOSURE.includes(`ci/${specifier.slice(2)}`));
    }
    assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(/);
  }
});
