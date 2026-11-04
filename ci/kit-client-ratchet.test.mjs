import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { ROUTE_BUDGET, ROUTE_SCOPE } from "./check-kit-route-perf.mjs";
import {
  assertLowerOnly,
  BRANCH,
  CLIENT_FILES,
  prBody,
  propose,
  publish,
  TITLE,
} from "./kit-client-ratchet.mjs";

const sha = "a".repeat(40);
const head = "b".repeat(40);
const next = "c".repeat(40);
const repository = "TogetherWeOwn/two-web-next";
function fixture() {
  const ceiling = () => ({ maxRawBytes: 4096, maxGzipBytes: 2048, maxFiles: 5 });
  const measured = (kind) => ({
    rawBytes: 1024,
    gzipBytes: 512,
    files: 1,
    assets: [`_app/immutable/test.${kind}`],
  });
  const route = () => ({ js: measured("js"), css: measured("css") });
  const files = {
    [CLIENT_FILES[0]]: { $comment: "keep", client: { js: ceiling() } },
    [CLIENT_FILES[1]]: { $comment: "keep", client: { css: ceiling() } },
    [ROUTE_BUDGET]: {
      version: 1,
      scope: ROUTE_SCOPE,
      routes: { "/": { js: ceiling(), css: ceiling() } },
    },
  };
  const report = {
    version: 1,
    sha,
    measurement: {
      version: 1,
      scope: ROUTE_SCOPE,
      exitCode: 0,
      breaches: [],
      aggregate: route(),
      routes: { "/": route() },
    },
  };
  return { files, report };
}

test("only raw/gzip client ceilings lower with measured headroom and strict step hysteresis", () => {
  const { files, report } = fixture();
  const p = propose(report, files);
  assert.equal(p.changes.length, 8);
  assert.equal(p.files[CLIENT_FILES[0]].client.js.maxRawBytes, 1536);
  assert.equal(p.files[CLIENT_FILES[0]].client.js.maxGzipBytes, 768);
  assertLowerOnly(files, p.files);
  assert.equal(p.files[CLIENT_FILES[0]].client.js.maxFiles, 5);
  assert.equal(files[CLIENT_FILES[0]].client.js.maxRawBytes, 4096);
  files[CLIENT_FILES[0]].client.js.maxRawBytes = 2048; // exactly one 512 step above 1536
  files[CLIENT_FILES[0]].client.js.maxGzipBytes = 1024; // exactly one 256 step above 768
  let x = propose(report, files).files[CLIENT_FILES[0]].client.js;
  assert.equal(x.maxRawBytes, 2048);
  assert.equal(x.maxGzipBytes, 1024);
  files[CLIENT_FILES[0]].client.js.maxRawBytes += 1;
  files[CLIENT_FILES[0]].client.js.maxGzipBytes += 1;
  x = propose(report, files).files[CLIENT_FILES[0]].client.js;
  assert.equal(x.maxRawBytes, 1536);
  assert.equal(x.maxGzipBytes, 768);
});

test("a later larger build never re-raises a lowered ceiling or adds missing headroom", () => {
  const { files, report } = fixture();
  const first = propose(report, files).files;
  report.measurement.aggregate.js.rawBytes = 3000;
  report.measurement.aggregate.js.gzipBytes = 1500;
  const p = propose(report, files, first);
  assert.equal(p.files[CLIENT_FILES[0]].client.js.maxRawBytes, 1536);
  assert.equal(p.files[CLIENT_FILES[0]].client.js.maxGzipBytes, 768);
  assert.ok(p.shortfalls.length > 0);
  assertLowerOnly(first, p.files);
});

for (const [name, mutate] of Object.entries({
  "missing SHA": (f) => {
    delete f.report.sha;
  },
  "failed gate": (f) => {
    f.report.measurement.exitCode = 1;
  },
  "missing evidence": (f) => {
    delete f.report.measurement.aggregate;
  },
  "missing assets": (f) => {
    delete f.report.measurement.routes["/"].js.assets;
  },
  "new route": (f) => {
    f.report.measurement.routes["/new"] = f.report.measurement.routes["/"];
  },
  "negative measurement": (f) => {
    f.report.measurement.aggregate.js.rawBytes = -1;
  },
  "fractional measurement": (f) => {
    f.report.measurement.aggregate.js.gzipBytes = 1.5;
  },
  "missing raw": (f) => {
    delete f.report.measurement.aggregate.js.rawBytes;
  },
  "file count breach": (f) => {
    f.report.measurement.aggregate.js.files = 6;
    f.report.measurement.aggregate.js.assets = Array(6).fill("_app/immutable/test.js");
  },
  "server substitution": (f) => {
    f.files[CLIENT_FILES[0]].server = { js: {} };
  },
}))
  test(`${name} refuses a proposal`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => propose(f.report, f.files));
  });

for (const [name, mutate] of Object.entries({
  "raw increase": (f) => {
    f[CLIENT_FILES[0]].client.js.maxRawBytes += 1;
  },
  "count reduction": (f) => {
    f[CLIENT_FILES[0]].client.js.maxFiles -= 1;
  },
  "comment change": (f) => {
    f[CLIENT_FILES[0]].$comment = "human";
  },
  "route deletion": (f) => {
    delete f[ROUTE_BUDGET].routes["/"];
  },
  "new file": (f) => {
    f["ci/budgets/kit/server-js.json"] = {};
  },
}))
  test(`lower-only validation rejects ${name}`, () => {
    const { files } = fixture();
    const modified = structuredClone(files);
    mutate(modified);
    assert.throws(() => assertLowerOnly(files, modified));
  });

function server(options = {}) {
  const { files, report } = fixture();
  const previous = propose(report, files).files;
  // A second run can lower further while preserving earlier decreases.
  if (options.existing)
    for (const r of [report.measurement.aggregate, report.measurement.routes["/"]])
      for (const kind of ["js", "css"]) {
        r[kind].rawBytes = 128;
        r[kind].gzipBytes = 32;
      }
  const pr = {
    number: 12,
    title: TITLE,
    draft: true,
    body: prBody(sha),
    user: { login: "github-actions[bot]" },
    head: { sha: head, ref: BRANCH, repo: { full_name: repository } },
  };
  const comparison = {
    status: "ahead",
    total_commits: 1,
    commits: [
      {
        author: { login: "github-actions[bot]" },
        committer: { login: "github-actions[bot]" },
        commit: { verification: { verified: true } },
      },
    ],
    files: CLIENT_FILES.map((filename) => ({ filename, status: "modified" })),
  };
  const calls = [];
  let mainReads = 0;
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (options.failPermission && method !== "GET") throw Error("GitHub failed (403)");
    if (path.endsWith("/git/ref/heads/main")) {
      mainReads += 1;
      return { object: { sha: options.stale || (options.raceMain && mainReads > 1) ? next : sha } };
    }
    if (path.includes("/contents/")) {
      const p = path.split("/contents/")[1].split("?")[0];
      const value = path.endsWith(`ref=${head}`) ? previous[p] : files[p];
      const loaded = structuredClone(value);
      if (options.mainBudgetRevision && path.endsWith(`ref=${sha}`))
        loaded.$comment = "new human revision";
      return {
        size: 100,
        encoding: "base64",
        content: Buffer.from(JSON.stringify(loaded)).toString("base64"),
      };
    }
    if (path.includes("/pulls?")) return options.existing ? [pr] : [];
    if (path.includes("/compare/")) return comparison;
    if (path.endsWith("/git/refs")) {
      if (options.orphan) throw Error("ref already exists");
      return {};
    }
    if (path === "/graphql") {
      assert.equal(body.variables.input.expectedHeadOid, options.existing ? head : sha);
      if (options.humanRace) return { errors: [{ message: "expectedHeadOid mismatch" }] };
      return { data: { createCommitOnBranch: { commit: { oid: next } } } };
    }
    if (path.endsWith(`/git/ref/heads/${BRANCH}`)) return { object: { sha: next } };
    if (path.endsWith("/pulls") && method === "POST") return { number: 12 };
    throw Error(`unexpected API call ${method} ${path}`);
  };
  return { api, report, repository, calls, pr, comparison, previous };
}

test("full fixture path creates one stable draft, allowlisted files and measured decision with Undo", async () => {
  const s = server();
  assert.equal((await publish(s)).status, "created");
  const writes = s.calls.filter((c) => c.method !== "GET");
  assert.equal(writes.length, 3);
  assert.equal(writes[0].body.ref, `refs/heads/${BRANCH}`);
  const additions = writes[1].body.variables.input.fileChanges.additions;
  assert.ok(
    additions.every(
      (a) =>
        CLIENT_FILES.includes(a.path) ||
        /^ci\/budgets\/decisions\/kit-perf\/auto-client-ratchet-[a-f0-9]{12}\.md$/.test(a.path),
    ),
  );
  assert.match(Buffer.from(additions.at(-1).contents, "base64").toString(), /Undo: revert/);
  assert.equal(writes[2].body.draft, true);
  assert.equal(writes[2].body.base, "main");
  assert.ok(!JSON.stringify(writes).includes('"force"'));
  assert.ok(!writes.some((c) => c.path.includes("/merge")));
});

test("an existing unchanged bot draft updates atomically, without duplicate PRs or body replacement", async () => {
  const s = server({ existing: true });
  assert.equal((await publish(s)).status, "updated");
  const writes = s.calls.filter((c) => c.method !== "GET");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/graphql");
  const additions = writes[0].body.variables.input.fileChanges.additions;
  for (const addition of additions.filter((a) => CLIENT_FILES.includes(a.path))) {
    const nextFiles = structuredClone(s.previous);
    nextFiles[addition.path] = JSON.parse(Buffer.from(addition.contents, "base64").toString());
    assertLowerOnly(s.previous, nextFiles);
  }
});

for (const options of [{ stale: true }, { raceMain: true }])
  test(`stale main skips without any writes (${JSON.stringify(options)})`, async () => {
    const s = server(options);
    assert.equal((await publish(s)).status, "stale-main");
    assert.equal(s.calls.filter((c) => c.method !== "GET").length, 0);
  });
for (const [name, mutate] of Object.entries({
  "human commit": (s) => {
    s.comparison.commits[0].author.login = "human";
  },
  "ready PR": (s) => {
    s.pr.draft = false;
  },
  "human body revision": (s) => {
    s.pr.body += "\nHuman note";
  },
  "foreign repository": (s) => {
    s.pr.head.repo.full_name = "elsewhere/project";
  },
  "incomplete history": (s) => {
    s.comparison.total_commits = 101;
  },
  "server file": (s) => {
    s.comparison.files.push({ filename: "ci/budgets/kit/server-js.json", status: "modified" });
  },
  "human ceiling revision": (s) => {
    s.previous[CLIENT_FILES[0]].client.js.maxRawBytes += 10000;
  },
}))
  test(`existing draft with ${name} is never overwritten`, async () => {
    const s = server({ existing: true });
    mutate(s);
    await assert.rejects(publish(s));
    assert.equal(s.calls.filter((c) => c.method !== "GET").length, 0);
  });

test("expected-head refusal protects a human commit racing the last read; never retries or falls back", async () => {
  const s = server({ existing: true, humanRace: true });
  await assert.rejects(publish(s), /compare-and-swap/);
  assert.equal(s.calls.filter((c) => c.method !== "GET").length, 1);
});
for (const options of [{ orphan: true }, { failPermission: true }])
  test(`orphan ref or missing permission stops without credential fallback (${JSON.stringify(options)})`, async () => {
    const s = server(options);
    await assert.rejects(publish(s));
    assert.equal(s.calls.filter((c) => c.method !== "GET").length, 1);
  });

test("ratchet workflow is trusted-main-only with credential-free measurement and a separate bounded writer", () => {
  const workflow = parse(
    readFileSync(
      new URL("../.github/workflows/client-budget-ratchet.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(workflow.on, { push: { branches: ["main"] } });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(workflow.jobs.measure.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.propose.permissions, {
    contents: "write",
    "pull-requests": "write",
  });
  assert.equal(workflow.jobs.propose.needs, "measure");
  const measurement = workflow.jobs.measure.steps.find((s) => s.run);
  assert.equal(measurement.env, undefined);
  assert.ok(measurement.run.includes("node ci/check-kit-perf.mjs"));
  assert.ok(measurement.run.includes("npm run budget"));
  assert.ok(!JSON.stringify(workflow.jobs.measure.steps).includes("github.token"));
  for (const job of Object.values(workflow.jobs))
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
      if (step.uses?.startsWith("actions/checkout")) {
        assert.equal(step.with["persist-credentials"], false);
        assert.equal(step.with.ref, "${{ github.sha }}");
      }
    }
  const writer = workflow.jobs.propose.steps.filter((s) => s.run);
  assert.equal(writer.length, 1);
  assert.equal(writer[0].env.GH_TOKEN, "${{ github.token }}");
  assert.ok(!writer[0].run.includes("npm"));
  assert.ok(!writer[0].run.includes("client-ratchet-data/kit-client-ratchet"));
});
