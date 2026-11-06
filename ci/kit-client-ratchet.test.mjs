import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { parse } from "yaml";
import { ROUTE_BUDGET, ROUTE_SCOPE } from "./check-kit-route-perf.mjs";
import {
  approvedClientBudget,
  approvedRouteBudget,
  initialRouteBudget,
  INITIAL_CLIENT_BUDGET,
  INITIAL_ROUTE_DECISION,
} from "./client-ratchet-approval.mjs";
import {
  assertLowerOnly,
  BRANCH,
  CLIENT_FILES,
  measuredDecision,
  parseDecision,
  replayDecision,
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
  "non-immutable route asset": (f) => {
    f.report.measurement.routes["/"].js.assets = ["_app/env.js"];
  },
  "aggregate asset outside _app": (f) => {
    f.report.measurement.aggregate.js.assets = ["public/island.js"];
  },
  "aggregate path traversal": (f) => {
    f.report.measurement.aggregate.js.assets = ["_app/../outside.js"];
  },
  "aggregate backslash": (f) => {
    f.report.measurement.aggregate.js.assets = ["_app/runtime\\\\outside.js"];
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
  const { files, report } = options.fixture ?? fixture();
  const initial = propose(report, files);
  const previous = initial.files;
  const savedDecision = measuredDecision(structuredClone(report), files, initial);
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
    state: "open",
    base: { ref: "main", repo: { full_name: repository } },
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
  let branchHead = head;
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (options.failPermission && method !== "GET") throw Error("GitHub failed (403)");
    if (path.endsWith("/git/ref/heads/main")) {
      mainReads += 1;
      return { object: { sha: options.stale || (options.raceMain && mainReads > 1) ? next : sha } };
    }
    if (path.includes("/contents/")) {
      const p = path.split("/contents/")[1].split("?")[0];
      if (p.startsWith("ci/budgets/decisions/"))
        return {
          size: savedDecision.length,
          encoding: "base64",
          content: Buffer.from(savedDecision).toString("base64"),
        };
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
    if (path.includes("/pulls?")) return options.existing ? [structuredClone(pr)] : [];
    if (path.endsWith("/pulls/12")) return structuredClone(pr);
    if (path.includes("/compare/")) {
      options.afterSnapshot?.(pr);
      return comparison;
    }
    if (path.endsWith("/git/refs")) {
      if (options.orphan) throw Error("ref already exists");
      return {};
    }
    if (path === "/graphql") {
      assert.equal(body.variables.input.expectedHeadOid, options.existing ? head : sha);
      if (options.humanRace) return { errors: [{ message: "expectedHeadOid mismatch" }] };
      branchHead = options.branchAfterCommit ?? next;
      if (!options.laggingPrHead) pr.head.sha = next;
      options.duringCommit?.(pr);
      return { data: { createCommitOnBranch: { commit: { oid: next } } } };
    }
    if (path.endsWith(`/git/ref/heads/${BRANCH}`)) return { object: { sha: branchHead } };
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

test("deterministic metadata distinguishes runtime execution from tooling authorship", async () => {
  const s = server();
  await publish(s);
  const message = s.calls.find((call) => call.path === "/graphql").body.variables.input.message;
  assert.match(message.body, /No model is invoked at runtime/);
  assert.match(message.body, /tooling authorship/);
  assert.ok(message.body.endsWith("Co-Authored-By: Claude Code <noreply@anthropic.com>"));
  assert.match(prBody(sha), /No model is invoked at runtime/);
  assert.match(prBody(sha), /tooling was authored with Claude Code assistance/);
  assert.match(prBody(sha), /Generated with \[Claude Code\]/);
});

test("an existing unchanged bot draft updates atomically, without duplicate PRs or body replacement", async () => {
  const s = server({ existing: true });
  assert.equal((await publish(s)).status, "updated");
  const writes = s.calls.filter((c) => c.method !== "GET");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/graphql");
  const additions = writes[0].body.variables.input.fileChanges.additions;
  const updated = parseDecision(Buffer.from(additions.at(-1).contents, "base64").toString());
  assert.equal(updated.history.length, 2);
  const replayed = replayDecision(updated);
  assertLowerOnly(s.previous, replayed.files);
  for (const addition of additions.filter((a) => CLIENT_FILES.includes(a.path))) {
    const nextFiles = structuredClone(s.previous);
    nextFiles[addition.path] = JSON.parse(Buffer.from(addition.contents, "base64").toString());
    assertLowerOnly(s.previous, nextFiles);
  }
});

test("an update accepts a lagging PR head only when the authoritative branch matches the created commit", async () => {
  const s = server({ existing: true, laggingPrHead: true });
  assert.deepEqual(await publish(s), { status: "updated", sha: next, number: 12 });
  assert.equal(s.pr.head.sha, head);
  assert.equal(s.calls.filter((c) => c.method !== "GET").length, 1);
  assert.equal(s.calls.filter((c) => c.path.endsWith("/pulls/12")).length, 2);
  assert.equal(s.calls.at(-1).path, `/repos/${repository}/git/ref/heads/${BRANCH}`);
});

for (const laggingPrHead of [false, true])
  test(`a changed authoritative branch after commit refuses success without retry (PR lag: ${laggingPrHead})`, async () => {
    const s = server({ existing: true, laggingPrHead, branchAfterCommit: sha });
    await assert.rejects(publish(s), /branch changed during commit/);
    assert.equal(s.calls.filter((c) => c.method !== "GET").length, 1);
  });

for (const [name, mutate] of Object.entries({
  promotion: (pr) => {
    pr.draft = false;
  },
  closure: (pr) => {
    pr.state = "closed";
  },
  "promotion hold": (pr) => {
    pr.body += "\nPromotion hold";
  },
}))
  test(`a lagging PR head does not bypass post-commit metadata checks (${name})`, async () => {
    const s = server({ existing: true, laggingPrHead: true, duringCommit: mutate });
    await assert.rejects(publish(s), /ready PR|human PR revision/);
    assert.equal(s.calls.filter((c) => c.method !== "GET").length, 1);
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
  "unproven earlier decrease": (s) => {
    s.previous[CLIENT_FILES[0]].client.js.maxRawBytes -= 1;
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

for (const [name, mutate] of Object.entries({
  promotion: (pr) => {
    pr.draft = false;
  },
  closure: (pr) => {
    pr.state = "closed";
  },
  "human body change": (pr) => {
    pr.body += "\nPromotion hold";
  },
  "human title change": (pr) => {
    pr.title += " (held)";
  },
  "base change": (pr) => {
    pr.base.ref = "other";
  },
  "head change": (pr) => {
    pr.head.sha = next;
  },
}))
  test(`late ${name} after a detached draft snapshot prevents a commit`, async () => {
    const s = server({ existing: true, afterSnapshot: mutate });
    await assert.rejects(publish(s));
    assert.equal(s.calls.filter((c) => c.method !== "GET").length, 0);
  });

test("metadata changed after the final read is reported after the commit, never retried", async () => {
  const s = server({
    existing: true,
    duringCommit: (pr) => {
      pr.draft = false;
    },
  });
  await assert.rejects(publish(s), /ready PR/);
  assert.equal(s.calls.filter((c) => c.method !== "GET").length, 1);
  assert.equal(s.pr.head.sha, next); // Post-write detection is not an atomic metadata lock.
});

test("promotion hold is durable: in-flight commit settles and later writers refuse the edited body", async () => {
  const s = server({
    existing: true,
    duringCommit: (pr) => {
      pr.body += "\nPromotion hold";
    },
  });
  await assert.rejects(publish(s), /human PR revision/);
  assert.equal(s.pr.draft, true);
  assert.equal(s.pr.head.sha, next);
  const before = s.calls.filter((c) => c.method !== "GET").length;
  await assert.rejects(publish(s), /human PR revision/);
  assert.equal(s.calls.filter((c) => c.method !== "GET").length, before);
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

function shippingFixture(smallCss = false) {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const files = Object.fromEntries(
    CLIENT_FILES.map((path) => [path, JSON.parse(readFileSync(join(repo, path), "utf8"))]),
  );
  // Pin the pre-ratchet anchor even when this test runs in a generated PR.
  files[CLIENT_FILES[0]].client.js = structuredClone(INITIAL_CLIENT_BUDGET.js);
  files[CLIENT_FILES[1]].client.css = structuredClone(INITIAL_CLIENT_BUDGET.css);
  files[ROUTE_BUDGET] = initialRouteBudget(repo);
  const measured = (ceiling, kind) => ({
    rawBytes: Math.floor(ceiling.maxRawBytes / 2),
    gzipBytes: Math.floor(ceiling.maxGzipBytes / 2),
    files: ceiling.maxFiles ? 1 : 0,
    assets: ceiling.maxFiles ? [`_app/immutable/test.${kind}`] : [],
  });
  const route = (r) => Object.fromEntries(["js", "css"].map((k) => [k, measured(r[k], k)]));
  const report = {
    version: 1,
    sha,
    measurement: {
      version: 1,
      scope: ROUTE_SCOPE,
      exitCode: 0,
      breaches: [],
      aggregate: route(INITIAL_CLIENT_BUDGET),
      routes: Object.fromEntries(
        Object.entries(files[ROUTE_BUDGET].routes).map(([id, r]) => [id, route(r)]),
      ),
    },
  };
  report.measurement.aggregate.js.rawBytes = smallCss ? 256 : 200000;
  report.measurement.aggregate.js.gzipBytes = smallCss ? 64 : 80000;
  report.measurement.aggregate.css.rawBytes = smallCss ? 256 : 1024;
  report.measurement.aggregate.css.gzipBytes = smallCss ? 64 : 512;
  return { files, report };
}

function decisionRoot(t) {
  const root = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "ratchet-chain-"),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "ci/budgets/decisions/kit-perf"), { recursive: true });
  cpSync(
    new URL(`../${INITIAL_ROUTE_DECISION}`, import.meta.url),
    join(root, INITIAL_ROUTE_DECISION),
  );
  return root;
}
function saveDecision(root, f, previous = f.files, result = propose(f.report, f.files, previous)) {
  const path = join(
    root,
    `ci/budgets/decisions/kit-perf/auto-client-ratchet-${f.report.sha.slice(0, 12)}.md`,
  );
  writeFileSync(path, measuredDecision(f.report, f.files, result));
  return path;
}

for (const smallCss of [false, true])
  test(`generated draft bytes pass legacy and current boundary cases (small client: ${smallCss})`, async (t) => {
    const repo = fileURLToPath(new URL("../", import.meta.url));
    const root = decisionRoot(t);
    cpSync(join(repo, "ci"), join(root, "ci"), {
      recursive: true,
      filter: (source) => !/\/auto-client-ratchet-[a-f0-9]{12}\.md$/.test(source),
    });
    cpSync(join(repo, "package.json"), join(root, "package.json"));
    symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
    const s = server({ fixture: shippingFixture(smallCss) });
    assert.equal((await publish(s)).status, "created");
    const additions = s.calls.find((c) => c.path === "/graphql").body.variables.input.fileChanges
      .additions;
    for (const { path, contents } of additions) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), Buffer.from(contents, "base64"));
    }
    const client = approvedClientBudget(root);
    assert.equal(client.js.maxRawBytes, smallCss ? 512 : 250368);
    assert.equal(client.js.maxGzipBytes, smallCss ? 256 : 100096);
    assert.equal(client.css.maxRawBytes, smallCss ? 512 : 1536);
    assert.equal(client.css.maxGzipBytes, smallCss ? 256 : 768);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-reporter=tap",
        "ci/budget-fragments.test.mjs",
        "ci/check-kit-perf.test.mjs",
      ],
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 60000,
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /# fail 0/);
  });

test("successive asymmetric generated CSS ratchets pass the unchanged shipping gates", (t) => {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const root = decisionRoot(t);
  cpSync(join(repo, "ci"), join(root, "ci"), {
    recursive: true,
    filter: (source) => !/\/auto-client-ratchet-[a-f0-9]{12}\.md$/.test(source),
  });
  cpSync(join(repo, "package.json"), join(root, "package.json"));
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
  const f = shippingFixture();
  for (const [id, r] of [
    ["aggregate", f.report.measurement.aggregate],
    ...Object.entries(f.report.measurement.routes),
  ])
    for (const kind of ["js", "css"]) {
      const ceiling =
        id === "aggregate" ? INITIAL_CLIENT_BUDGET[kind] : f.files[ROUTE_BUDGET].routes[id][kind];
      r[kind].rawBytes = ceiling.maxRawBytes;
      r[kind].gzipBytes = ceiling.maxGzipBytes;
    }
  for (const [length, entropy, gzip, rawCap, reportSha] of [
    [1000, 500, 552, 1536, sha],
    [300, 240, 276, 512, head],
  ]) {
    const bytes = Buffer.alloc(length);
    let state = 0x12345678;
    for (let i = 0; i < entropy; i += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      bytes[i] = state & 255;
    }
    assert.equal(gzipSync(bytes).length, gzip);
    f.report.sha = reportSha;
    Object.assign(f.report.measurement.aggregate.css, { rawBytes: bytes.length, gzipBytes: gzip });
    const result = propose(f.report, f.files);
    assert.deepEqual(result.files[CLIENT_FILES[1]].client.css, {
      maxRawBytes: rawCap,
      maxGzipBytes: 768,
      maxFiles: 4,
    });
    assert.ok(result.changes.every((c) => c.id === "aggregate" && c.kind === "css"));
    saveDecision(root, f, f.files, result);
    for (const path of CLIENT_FILES)
      writeFileSync(join(root, path), `${JSON.stringify(result.files[path], null, 2)}\n`);
    assert.deepEqual(approvedClientBudget(root).css, result.files[CLIENT_FILES[1]].client.css);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const checked = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-reporter=tap",
        "ci/budget-fragments.test.mjs",
        "ci/check-kit-perf.test.mjs",
      ],
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 60000,
      },
    );
    assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
    assert.match(checked.stdout, /# fail 0/);
    f.files = result.files;
  }
});

test("initial measured route admission remains pinned independently of the live budget", () => {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const initial = initialRouteBudget(repo);
  assert.equal(Object.keys(initial.routes).length, 26);
  assert.equal(initial.routes["/admin"].js.maxRawBytes, 145920);
  assert.equal(
    createHash("sha256").update(JSON.stringify(initial)).digest("hex"),
    "38eb8669ed3145d33b86658d1923845029782dff1441fafed27a611d2a7e8207",
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(repo, ROUTE_BUDGET), "utf8")),
    approvedRouteBudget(repo),
  );
});

test("decision oracle replays successive lowerings and refuses a re-raise or missing evidence", (t) => {
  const root = decisionRoot(t);
  const f = shippingFixture();
  const first = propose(f.report, f.files);
  saveDecision(root, f);
  assert.deepEqual(approvedClientBudget(root).js, first.files[CLIENT_FILES[0]].client.js);
  const second = structuredClone(f);
  second.files = first.files;
  second.report.sha = head;
  second.report.measurement.aggregate.js.rawBytes = 150000;
  saveDecision(root, second);
  const expected = propose(second.report, second.files).files[CLIENT_FILES[0]].client.js;
  assert.deepEqual(approvedClientBudget(root).js, expected);
  // Fork from the old anchor, including one axis above an already lowered cap.
  const reraised = structuredClone(f);
  reraised.report.sha = next;
  reraised.report.measurement.aggregate.js.rawBytes = 190000;
  const path = saveDecision(root, reraised);
  assert.throws(() => approvedClientBudget(root), /approved ceiling chain/);
  writeFileSync(path, "# No measured evidence\n");
  assert.throws(() => approvedClientBudget(root), /missing or ambiguous/);
});

test("route-only then mixed decisions replay full state independent of SHA filename order", (t) => {
  const root = decisionRoot(t);
  const routeOnly = shippingFixture();
  routeOnly.report.sha = next;
  for (const kind of ["js", "css"]) {
    routeOnly.report.measurement.aggregate[kind].rawBytes = INITIAL_CLIENT_BUDGET[kind].maxRawBytes;
    routeOnly.report.measurement.aggregate[kind].gzipBytes =
      INITIAL_CLIENT_BUDGET[kind].maxGzipBytes;
  }
  const first = propose(routeOnly.report, routeOnly.files);
  saveDecision(root, routeOnly);
  assert.deepEqual(approvedClientBudget(root), INITIAL_CLIENT_BUDGET);
  assert.deepEqual(approvedRouteBudget(root), first.files[ROUTE_BUDGET]);
  const f = shippingFixture();
  f.files = first.files;
  for (const route of Object.values(f.report.measurement.routes))
    for (const kind of ["js", "css"]) {
      route[kind].rawBytes = Math.floor(route[kind].rawBytes / 2);
      route[kind].gzipBytes = Math.floor(route[kind].gzipBytes / 2);
    }
  const mixed = propose(f.report, f.files);
  assert.ok(mixed.changes.some((change) => change.id === "aggregate"));
  assert.ok(mixed.changes.some((change) => change.id !== "aggregate"));
  saveDecision(root, f);
  assert.equal(approvedClientBudget(root).js.maxRawBytes, 250368);
  assert.deepEqual(approvedRouteBudget(root), mixed.files[ROUTE_BUDGET]);
});

for (const metric of ["maxRawBytes", "maxGzipBytes", "maxFiles"])
  test(`a decision cannot reset an approved route ${metric} through its base`, (t) => {
    const root = decisionRoot(t);
    const f = shippingFixture();
    f.files[ROUTE_BUDGET].routes["/admin"].js[metric] += 1;
    saveDecision(root, f);
    assert.throws(() => approvedClientBudget(root), /approved ceiling chain/);
    assert.throws(() => approvedRouteBudget(root), /approved ceiling chain/);
  });

test("two route-only forks cannot be flattened into an unchanged aggregate chain", (t) => {
  const root = decisionRoot(t);
  const f = shippingFixture();
  for (const kind of ["js", "css"]) {
    f.report.measurement.aggregate[kind].rawBytes = INITIAL_CLIENT_BUDGET[kind].maxRawBytes;
    f.report.measurement.aggregate[kind].gzipBytes = INITIAL_CLIENT_BUDGET[kind].maxGzipBytes;
  }
  saveDecision(root, f);
  f.report.sha = next;
  f.report.measurement.routes["/admin"].js.rawBytes -= 1024;
  saveDecision(root, f);
  assert.throws(() => approvedClientBudget(root), /approved ceiling chain/);
});

test("decision oracle rejects an unproven earlier draft decrease", (t) => {
  const root = decisionRoot(t);
  const f = shippingFixture();
  const previous = structuredClone(f.files);
  previous[CLIENT_FILES[0]].client.js.maxRawBytes = 250000;
  saveDecision(root, f, previous);
  assert.throws(() => approvedClientBudget(root), /invalid proposal/);
});

test("decision oracle rejects tampered result bytes even when they remain below the initial ceiling", (t) => {
  const root = decisionRoot(t);
  const f = shippingFixture();
  const result = propose(f.report, f.files);
  result.files[CLIENT_FILES[0]].client.js.maxRawBytes += 512;
  saveDecision(root, f, f.files, result);
  assert.throws(() => approvedClientBudget(root), /invalid proposal/);
});

test("generated drafts require independent ready promotion and all normal workflow subscriptions", () => {
  for (const file of ["ci.yml", "e2e.yml", "pr-gates.yml"]) {
    const workflow = parse(
      readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"),
    );
    assert.ok(workflow.on.pull_request.types.includes("ready_for_review"), file);
  }
  const body = prBody(sha);
  assert.match(body, /Repository-token create\/update events do not trigger PR checks/);
  assert.match(body, /independently authenticated maintainer/);
  assert.match(body, /never this workflow's repository token/);
  assert.match(body, /exact generated head/);
  assert.match(body, /If they are absent, stop/);
  assert.match(body, /writer refuses further updates once it is ready/);
  assert.match(body, /persistent "Promotion hold"/);
  assert.match(body, /including queued\/waiting jobs/);
  assert.match(body, /pin the final PR head only after those jobs settle/);
  assert.match(body, /not an atomic PR-state lock/);
  assert.match(body, /return to draft, keep the hold, drain writers/);
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
