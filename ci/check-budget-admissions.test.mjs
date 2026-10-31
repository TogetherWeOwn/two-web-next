import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { checkBudgetAdmissions, githubRequest } from "./check-budget-admissions.mjs";

const UNIT = "kit-client-js-gzip";
const path = `ci/budgets/decisions/${UNIT}/2000-01-01-feature.md`;
const NOW = "2026-10-28T12:00:00Z";
const repo = "TogetherWeOwn/example";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "budget-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_COMMITTER_DATE: NOW, GIT_AUTHOR_DATE: NOW },
    }).trim();
  const put = (name, contents) => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), contents);
  };
  const commit = (message) => {
    git("add", ".");
    git("commit", "--allow-empty", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  put(
    "ci/budgets/kit/client.json",
    JSON.stringify({
      client: {
        js: { maxRawBytes: 200_000, maxGzipBytes: 100_000, maxFiles: 5 },
      },
    }),
  );
  put(
    "ci/budgets/bundle/a.json",
    JSON.stringify({
      budgets: {
        "public/islands/a.js": { maxRawBytes: 100, maxGzipBytes: 50 },
      },
    }),
  );
  put("ci/budgets/decisions/kit-perf/0000-history.md", "Frozen history.");
  const base = commit("initial allocation");
  const add = (name = path, delta = 500, pr = 42) =>
    put(
      name,
      `---\n${JSON.stringify({
        unit: UNIT,
        delta_bytes: delta,
        before_bytes: 99_900,
        after_bytes: 100_400,
        cause: "New feature; no duplicate or accidental imports.",
        pr,
      })}\n---\n`,
    );
  const request = async (endpoint) => {
    if (endpoint.startsWith("pulls/") && endpoint.endsWith("/files")) {
      return [
        {
          filename: path,
          status: "added",
          sha: git("rev-parse", `HEAD:${path}`),
        },
      ];
    }
    if (endpoint === "pulls/42") return { base: { ref: "main", repo: { full_name: repo } } };
    throw new Error(`unexpected API: ${endpoint}`);
  };
  const check = (eventName, event, extra = {}) =>
    checkBudgetAdmissions({
      root,
      repo,
      eventName,
      event,
      now: NOW,
      request,
      ...extra,
    });
  return { root, git, put, commit, add, base, check, request };
}
const prEvent = (base, head, number = 42) => ({
  number,
  pull_request: { base: { sha: base }, head: { sha: head } },
});
const groupEvent = (base, head) => ({
  merge_group: { base_sha: base, head_sha: head, base_ref: "refs/heads/main" },
});

test("PR validates admission policy hard even though size may later warn", async (t) => {
  const fx = fixture(t);
  fx.add();
  const head = fx.commit("feature");
  const result = await fx.check("pull_request", prEvent(fx.base, head));
  assert.equal(result.proposed.length, 1);
  fx.add(path, 501);
  const over = fx.commit("over cap");
  await assert.rejects(fx.check("pull_request", prEvent(fx.base, over)), /0.5%/);
});

test("PR numbers in decision files cannot evade attribution", async (t) => {
  const fx = fixture(t);
  fx.add(path, 500, 43);
  const head = fx.commit("wrong PR");
  await assert.rejects(fx.check("pull_request", prEvent(fx.base, head)), /attribution/);
});

test("PR rejects frozen fragment edits and decision deletion", async (t) => {
  const fx = fixture(t);
  fx.put("ci/budgets/kit/client.json", "{}");
  const head = fx.commit("edit frozen base");
  await assert.rejects(fx.check("pull_request", prEvent(fx.base, head)), /frozen/);
});

test("merge group attributes each squash contribution to its real PR files", async (t) => {
  const fx = fixture(t);
  fx.add();
  const head = fx.commit("feat: view (#42)");
  const result = await fx.check("merge_group", groupEvent(fx.base, head));
  assert.equal(result.proposed[0].pr, 42);
  assert.equal(result.authoritative, true);
});

test("unsupported queue graphs and missing API evidence fail closed", async (t) => {
  const fx = fixture(t);
  fx.add();
  const head = fx.commit("not a GitHub squash contribution");
  await assert.rejects(fx.check("merge_group", groupEvent(fx.base, head)), /queue attribution/);
  fx.add(path.replace("feature", "another"), 100);
  const next = fx.commit("feat: view (#42)");
  await assert.rejects(
    fx.check("merge_group", groupEvent(head, next), {
      request: async () => {
        throw new Error("API unavailable");
      },
    }),
    /API unavailable|empty/,
  );
});

test("a queue decision must be byte-identical to an addition on the attributed PR", async (t) => {
  const fx = fixture(t);
  fx.add();
  const head = fx.commit("feat: view (#42)");
  await assert.rejects(
    fx.check("merge_group", groupEvent(fx.base, head), {
      request: async (endpoint) =>
        endpoint.endsWith("/files")
          ? [{ filename: path, status: "added", sha: "0".repeat(40) }]
          : fx.request(endpoint),
    }),
    /attribution/,
  );
});

test("backdated history counts using GitHub merged_at, not commit or filename dates", async (t) => {
  const fx = fixture(t);
  fx.add(path, 1_600, 1);
  const main = fx.commit("historical merge (#1)");
  const second = path.replace("feature", "second");
  fx.add(second, 500);
  const head = fx.commit("new feature");
  await assert.rejects(
    fx.check("pull_request", prEvent(main, head), {
      request: async (endpoint) => {
        assert.equal(endpoint, `commits/${main}/pulls`);
        return [
          {
            number: 1,
            merge_commit_sha: main,
            merged_at: "2026-10-27T12:00:00Z",
            base: { ref: "main", repo: { full_name: repo } },
          },
        ];
      },
    }),
    /2%/,
  );
});

test("unverified main-merge history and wrong historical PR numbers fail closed", async (t) => {
  const fx = fixture(t);
  fx.add();
  const main = fx.commit("history (#42)");
  fx.add(path.replace("feature", "new"));
  const head = fx.commit("new allowance");
  await assert.rejects(
    fx.check("pull_request", prEvent(main, head), { request: async () => [] }),
    /main merge provenance/,
  );
  await assert.rejects(
    fx.check("pull_request", prEvent(main, head), {
      request: async () => [
        {
          number: 43,
          merge_commit_sha: main,
          merged_at: NOW,
          base: { ref: "main", repo: { full_name: repo } },
        },
      ],
    }),
    /attribution/,
  );
});

test("wrong checkout or missing event context never defaults to advisory", async (t) => {
  const fx = fixture(t);
  fx.add();
  fx.commit("head");
  await assert.rejects(fx.check("merge_group", groupEvent(fx.base, fx.base)), /checkout/);
  await assert.rejects(fx.check("pull_request", {}), /event/);
  await assert.rejects(fx.check("unexpected", {}), /event/);
});

test("five independently attributable queue PRs cannot exceed the shared weekly cap", async (t) => {
  const fx = fixture(t);
  const filesByPr = new Map();
  for (let index = 0; index < 5; index += 1) {
    const file = path.replace("feature", `feature-${index}`);
    const number = 42 + index;
    fx.add(file, 500, number);
    fx.commit(`feat: contribution (#${number})`);
    filesByPr.set(number, [
      {
        filename: file,
        status: "added",
        sha: fx.git("rev-parse", `HEAD:${file}`),
      },
    ]);
  }
  const head = fx.git("rev-parse", "HEAD");
  const request = async (endpoint) => {
    const number = Number(endpoint.split("/")[1]);
    if (endpoint.endsWith("/files")) return filesByPr.get(number);
    return { base: { ref: "main", repo: { full_name: repo } } };
  };
  await assert.rejects(fx.check("merge_group", groupEvent(fx.base, head), { request }), /2%/);
});

test("a sibling cannot rewrite a prior queued decision even when final totals fit", async (t) => {
  const fx = fixture(t);
  fx.add(path, 200);
  fx.commit("feat: first (#42)");
  const firstBlob = fx.git("rev-parse", `HEAD:${path}`);
  fx.add(path, 100);
  const second = path.replace("feature", "second");
  fx.add(second, 200, 43);
  const head = fx.commit("feat: sibling (#43)");
  await assert.rejects(
    fx.check("merge_group", groupEvent(fx.base, head), {
      request: async (endpoint) =>
        endpoint.endsWith("/files")
          ? [{ filename: path, status: "added", sha: firstBlob }]
          : fx.request(endpoint),
    }),
    /frozen/,
  );
});

test("dirty/untracked budget evidence cannot shadow the checked git snapshot", async (t) => {
  const fx = fixture(t);
  fx.add();
  await assert.rejects(fx.check("pull_request", prEvent(fx.base, fx.base)), /checkout/);
});

test("queue record PR must match the proven squash PR even if its blob matches", async (t) => {
  const fx = fixture(t);
  fx.add(path, 500, 43);
  const head = fx.commit("feature (#42)");
  await assert.rejects(fx.check("merge_group", groupEvent(fx.base, head)), /queue PR attribution/);
});

for (const mismatch of ["sha", "branch", "repository"]) {
  test(`merged history rejects a mismatched ${mismatch}`, async (t) => {
    const fx = fixture(t);
    fx.add();
    const main = fx.commit("history (#42)");
    fx.add(path.replace("feature", "new"));
    const head = fx.commit("new allowance");
    const pull = {
      number: 42,
      merge_commit_sha: main,
      merged_at: NOW,
      base: { ref: "main", repo: { full_name: repo } },
    };
    if (mismatch === "sha") pull.merge_commit_sha = fx.base;
    if (mismatch === "branch") pull.base.ref = "other";
    if (mismatch === "repository") pull.base.repo.full_name = "other/repo";
    await assert.rejects(
      fx.check("pull_request", prEvent(main, head), {
        request: async () => [pull],
      }),
      /main merge provenance/,
    );
  });
}

test("two-parent queue merges are rejected even with valid added-file proof", async (t) => {
  const fx = fixture(t);
  fx.git("checkout", "-qb", "side");
  fx.put("feature.txt", "feature");
  const side = fx.commit("side");
  fx.git("checkout", "-q", "--detach", fx.base);
  fx.add();
  fx.commit("first (#42)");
  fx.git("merge", "--no-ff", "-qm", "merge (#42)", side);
  const head = fx.git("rev-parse", "HEAD");
  await assert.rejects(fx.check("merge_group", groupEvent(fx.base, head)), /unsupported queue/);
});

function lifecycle(fx, action, fragment, budget, measured = {}) {
  const file = `ci/budgets/decisions/allocations/2026-10-28-${action}.md`;
  fx.put(
    file,
    `---\n${JSON.stringify({
      action,
      fragment,
      budget,
      measured,
      cause: "New measured island; imports checked for duplication.",
      pr: 42,
    })}\n---\n`,
  );
  return file;
}
function installed(fx) {
  fx.put("ci/check-budget-admissions.mjs", "// installed checker\n");
  return fx.commit("install policy");
}
function newIsland(fx, overrides = {}) {
  const asset = "public/islands/new.js";
  const body = "export const feature = 42;\n";
  fx.put(asset, body);
  const measured = {
    "bundle-public-islands-new-js-raw": Buffer.byteLength(body),
    "bundle-public-islands-new-js-gzip": gzipSync(body).length,
  };
  const budget = {
    budgets: { [asset]: { maxRawBytes: 27, maxGzipBytes: 47, ...overrides } },
  };
  const fragment = "ci/budgets/bundle/new.json";
  fx.put(fragment, JSON.stringify(budget));
  lifecycle(fx, "initial", fragment, budget, measured);
  return { fragment, budget, measured };
}

test("installed checker admits a measured new island with its own initial decision", async (t) => {
  const fx = fixture(t);
  const base = installed(fx);
  newIsland(fx);
  const head = fx.commit("new island");
  const result = await fx.check("pull_request", prEvent(base, head));
  assert.equal(result.proposed.length, 1);
});

test("initial allocation evidence is compared structurally, not by key order", async (t) => {
  // The README requires the same complete JSON mapping, not the same member
  // order: the asset's ceilings may be serialized as {maxGzipBytes,maxRawBytes}
  // in the fragment and {maxRawBytes,maxGzipBytes} in the decision (or vice
  // versa) and still describe one identical budget. Serializing both sides and
  // comparing text would make byte order part of the lifecycle contract.
  const fx = fixture(t);
  const base = installed(fx);
  const { fragment, budget, measured } = newIsland(fx, {});
  const ceilings = budget.budgets["public/islands/new.js"];
  // Same mapping, deliberately reversed member order in the committed fragment.
  const fragmentOrder = { maxGzipBytes: ceilings.maxGzipBytes, maxRawBytes: ceilings.maxRawBytes };
  fx.put(fragment, JSON.stringify({ budgets: { "public/islands/new.js": fragmentOrder } }));
  // The decision keeps the opposite serialization of the very same mapping.
  const decisionOrder = { maxRawBytes: ceilings.maxRawBytes, maxGzipBytes: ceilings.maxGzipBytes };
  lifecycle(
    fx,
    "initial",
    fragment,
    { budgets: { "public/islands/new.js": decisionOrder } },
    measured,
  );
  const head = fx.commit("reordered island budget");
  const result = await fx.check("pull_request", prEvent(base, head));
  assert.equal(result.proposed.length, 1);
  assert.equal(result.proposed[0].action, "initial");
  assert.deepEqual(Object.keys(result.proposed[0].budget.budgets), ["public/islands/new.js"]);
});

for (const invalid of ["margin", "measurement", "missing decision", "existing unit"]) {
  test(`initial allocation rejects ${invalid}`, async (t) => {
    const fx = fixture(t);
    const base = installed(fx);
    const { fragment, budget, measured } = newIsland(
      fx,
      invalid === "margin" ? { maxRawBytes: 28 } : {},
    );
    if (invalid === "measurement") {
      measured["bundle-public-islands-new-js-raw"] = 25;
      lifecycle(fx, "initial", fragment, budget, measured);
    }
    if (invalid === "missing decision")
      rmSync(join(fx.root, "ci/budgets/decisions/allocations/2026-10-28-initial.md"));
    if (invalid === "existing unit") {
      budget.budgets = {
        "public/islands/a.js": { maxRawBytes: 27, maxGzipBytes: 47 },
      };
      fx.put(fragment, JSON.stringify(budget));
      lifecycle(fx, "initial", fragment, budget, measured);
    }
    const head = fx.commit("invalid allocation");
    await assert.rejects(
      fx.check("pull_request", prEvent(base, head)),
      /allocation|measurement|duplicate/,
    );
  });
}

for (const remains of [true, false]) {
  test(`retirement ${remains ? "rejects a still-served asset" : "admits an asset gone from inventory"}`, async (t) => {
    const fx = fixture(t);
    fx.put("public/islands/a.js", "export {};\n");
    fx.put(
      "ci/budgets/bundle/b.json",
      JSON.stringify({
        budgets: {
          "public/islands/b.js": { maxRawBytes: 100, maxGzipBytes: 50 },
        },
      }),
    );
    const base = installed(fx);
    const fragment = "ci/budgets/bundle/a.json";
    const budget = {
      budgets: {
        "public/islands/a.js": { maxRawBytes: 100, maxGzipBytes: 50 },
      },
    };
    rmSync(join(fx.root, fragment));
    if (!remains) rmSync(join(fx.root, "public/islands/a.js"));
    lifecycle(fx, "retire", fragment, budget);
    const head = fx.commit("retire asset");
    if (remains) await assert.rejects(fx.check("pull_request", prEvent(base, head)), /inventory/);
    else assert.equal((await fx.check("pull_request", prEvent(base, head))).proposed.length, 1);
  });
}

test("install-only deploy allocation cannot be reused after checker reaches main", async (t) => {
  const fx = fixture(t);
  const base = installed(fx);
  fx.put(
    "ci/budgets/deploy/worker.json",
    JSON.stringify({
      worker: { maxRawBytes: 1020 },
      measuredMain: {
        sha: base,
        rawBytesUpperBound: 1000,
        evidence: "https://github.com/TogetherWeOwn/two-web-next/actions/runs/123/job/456",
      },
    }),
  );
  const head = fx.commit("attempt second install");
  await assert.rejects(fx.check("pull_request", prEvent(base, head)), /initial allocation/);
});

test("old protected-main GitHub squash dates bound lookups, recent records still use merged_at", async (t) => {
  const fx = fixture(t);
  fx.add(path, 1_000, 1);
  fx.git("add", ".");
  execFileSync("git", ["-C", fx.root, "commit", "-qm", "old feature (#1)"], {
    env: {
      ...process.env,
      GIT_COMMITTER_NAME: "GitHub",
      GIT_COMMITTER_EMAIL: "noreply@github.com",
      GIT_COMMITTER_DATE: "2026-10-01T12:00:00Z",
      GIT_AUTHOR_DATE: "2026-10-01T12:00:00Z",
    },
  });
  const main = fx.git("rev-parse", "HEAD");
  fx.add(path.replace("feature", "new"));
  const newFile = join(fx.root, path.replace("feature", "new"));
  writeFileSync(
    newFile,
    readFileSync(newFile, "utf8").replace("99900", "100900").replace("100400", "101400"),
  );
  const head = fx.commit("new feature");
  const result = await fx.check("pull_request", prEvent(main, head), {
    request: async (endpoint) => {
      throw new Error(`old commit should not need API: ${endpoint}`);
    },
  });
  assert.equal(result.totals.get(UNIT).weekBase, 101_000);
  assert.equal(result.totals.get(UNIT).added, 500);
});

test("GitHub provenance retries transient responses and network errors with bounded backoff", async () => {
  for (const failure of [429, 503, "network"]) {
    let calls = 0;
    const waits = [];
    const request = githubRequest(
      repo,
      "fake-test-token",
      async () => {
        calls += 1;
        if (calls < 3) {
          if (failure === "network") throw new TypeError("fetch failed");
          return { ok: false, status: failure };
        }
        return { ok: true, json: async () => [{ number: 42 }] };
      },
      { sleep: async (ms) => waits.push(ms), random: () => 0 },
    );
    assert.deepEqual(await request("commits/example/pulls"), [{ number: 42 }]);
    assert.equal(calls, 3);
    assert.deepEqual(waits, [1000, 2000]);
  }
});

test("GitHub provenance retries a body stream that fails after the response", async () => {
  // A response that resolves and then refuses to yield its body is a transport
  // fault, not a verdict: the retry loop must cover the body read too.
  let calls = 0;
  const request = githubRequest(
    repo,
    "fake-test-token",
    async () => {
      calls += 1;
      if (calls < 3)
        return {
          ok: true,
          json: async () => {
            throw new TypeError("terminated");
          },
        };
      return { ok: true, json: async () => [{ number: 42 }] };
    },
    { sleep: async () => {}, random: () => 0 },
  );
  assert.deepEqual(await request("commits/example/pulls"), [{ number: 42 }]);
  assert.equal(calls, 3);
});

test("GitHub provenance honors both Retry-After forms and the quota reset", async () => {
  // GitHub sends either delta-seconds or an HTTP-date in retry-after, and a
  // rate-limit reset timestamp in x-ratelimit-reset. All three are honored; an
  // excessive delay still fails closed rather than holding the job forever.
  const start = Date.now();
  const cases = [
    ["retry-after seconds", { "retry-after": "7" }, 7000],
    // Relative to the real clock: an HTTP-date and a UNIX reset both name a
    // wall-clock instant, so the delay is that instant minus now.
    ["retry-after http-date", { "retry-after": new Date(start + 45_000).toUTCString() }, 45_000],
    [
      "ratelimit reset",
      { "x-ratelimit-reset": String(Math.trunc((start + 30_000) / 1000)) },
      30_000,
    ],
  ];
  for (const [label, headers, expected] of cases) {
    let calls = 0;
    const waits = [];
    const request = githubRequest(
      repo,
      "fake-test-token",
      async () => {
        calls += 1;
        if (calls < 2) return { ok: false, status: 429, headers };
        return { ok: true, json: async () => [{ number: 42 }] };
      },
      { sleep: async (ms) => waits.push(ms), random: () => 0 },
    );
    assert.deepEqual(await request("commits/example/pulls"), [{ number: 42 }], label);
    assert.equal(calls, 2, label);
    // The requested delay wins over exponential backoff, up to the 120s bound.
    assert.ok(
      waits[0] >= expected - 1000,
      `${label}: waited ${waits[0]}ms, expected >= ${expected - 1000}ms`,
    );
  }
  // An excessive requested delay fails closed instead of sleeping for it.
  await assert.rejects(
    githubRequest(
      repo,
      "fake-test-token",
      async () => ({ ok: false, status: 429, headers: { "retry-after": "600" } }),
      { sleep: async () => {}, random: () => 0 },
    )("commits/example/pulls"),
    /retry delay exceeds bound/,
  );
});

test("GitHub provenance caches complete paginated responses per endpoint", async () => {
  const calls = [];
  const request = githubRequest(repo, "fake-test-token", async (url) => {
    calls.push(url);
    const page = new URL(url).searchParams.get("page");
    return {
      ok: true,
      json: async () =>
        page === "1" ? Array.from({ length: 100 }, (_, number) => ({ number })) : [{ number: 100 }],
    };
  });
  const first = await request("pulls/42/files");
  assert.equal(first.length, 101);
  assert.deepEqual(await request("pulls/42/files"), first);
  assert.equal(calls.length, 2);
  await request("pulls/43/files");
  assert.equal(calls.length, 4);
});

test("permanent API errors are not retried and transient exhaustion fails closed after three attempts", async () => {
  for (const status of [404, 503]) {
    let calls = 0;
    const request = githubRequest(
      repo,
      "fake-test-token",
      async () => {
        calls += 1;
        return { ok: false, status };
      },
      { sleep: async () => {}, random: () => 0 },
    );
    await assert.rejects(request("pulls/42"), /GitHub provenance/);
    assert.equal(calls, status === 404 ? 1 : 3);
  }
});

test("an unrelated PR needs no GitHub history API when no byte allowance changes", async (t) => {
  const fx = fixture(t);
  fx.add();
  const main = fx.commit("recent feature (#42)");
  fx.put("unrelated.txt", "no budget changes");
  const head = fx.commit("unrelated");
  const result = await fx.check("pull_request", prEvent(main, head), {
    request: async () => {
      throw new Error("unnecessary provenance API");
    },
  });
  assert.equal(result.totals.get(UNIT).current, 100_500);
});

test("retirement keeps prior deltas readable without dropping their immutable evidence", async (t) => {
  const fx = fixture(t);
  const unit = "bundle-public-islands-a-js-gzip";
  const file = `ci/budgets/decisions/${unit}/2026-10-28-old.md`;
  fx.put(
    file,
    `---\n${JSON.stringify({
      unit,
      delta_bytes: 1,
      before_bytes: 49,
      after_bytes: 51,
      cause: "Measured prior feature; checked duplicate imports.",
      pr: 41,
    })}\n---\n`,
  );
  fx.put(
    "ci/budgets/bundle/b.json",
    JSON.stringify({
      budgets: {
        "public/islands/b.js": { maxRawBytes: 100, maxGzipBytes: 50 },
      },
    }),
  );
  const base = installed(fx);
  const fragment = "ci/budgets/bundle/a.json";
  rmSync(join(fx.root, fragment));
  lifecycle(fx, "retire", fragment, {
    budgets: {
      "public/islands/a.js": { maxRawBytes: 100, maxGzipBytes: 50 },
    },
  });
  const head = fx.commit("retire asset, preserve history");
  const result = await fx.check("pull_request", prEvent(base, head), {
    request: async () => {
      throw new Error("no allowance change");
    },
  });
  assert.equal(result.totals.get(unit).current, 51);
});

test("a new allocation cannot also consume a byte delta in the same feature", async (t) => {
  const fx = fixture(t);
  const base = installed(fx);
  newIsland(fx);
  const unit = "bundle-public-islands-new-js-raw";
  fx.put(
    `ci/budgets/decisions/${unit}/2026-10-28-extra.md`,
    `---\n${JSON.stringify({
      unit,
      delta_bytes: 1,
      before_bytes: 27,
      after_bytes: 28,
      cause: "Feature growth; checked for duplicate imports.",
      pr: 42,
    })}\n---\n`,
  );
  const head = fx.commit("initial plus delta");
  await assert.rejects(
    fx.check("pull_request", prEvent(base, head)),
    /cannot also receive a delta/,
  );
});

test("retired units cannot consume new delta allowance", async (t) => {
  const fx = fixture(t);
  fx.put(
    "ci/budgets/bundle/a.json",
    JSON.stringify({
      budgets: {
        "public/islands/a.js": { maxRawBytes: 1_000, maxGzipBytes: 50 },
      },
    }),
  );
  const base = installed(fx);
  const fragment = "ci/budgets/bundle/a.json";
  rmSync(join(fx.root, fragment));
  fx.put(
    "ci/budgets/bundle/b.json",
    JSON.stringify({
      budgets: {
        "public/islands/b.js": { maxRawBytes: 100, maxGzipBytes: 50 },
      },
    }),
  );
  fx.put("public/islands/b.js", "export {};\n");
  lifecycle(fx, "retire", fragment, {
    budgets: {
      "public/islands/a.js": { maxRawBytes: 1_000, maxGzipBytes: 50 },
    },
  });
  lifecycle(
    fx,
    "initial",
    "ci/budgets/bundle/b.json",
    {
      budgets: {
        "public/islands/b.js": { maxRawBytes: 11, maxGzipBytes: 31 },
      },
    },
    {
      "bundle-public-islands-b-js-raw": 11,
      "bundle-public-islands-b-js-gzip": 31,
    },
  );
  fx.put(
    "ci/budgets/bundle/b.json",
    JSON.stringify({
      budgets: {
        "public/islands/b.js": { maxRawBytes: 11, maxGzipBytes: 31 },
      },
    }),
  );
  const unit = "bundle-public-islands-a-js-raw";
  fx.put(
    `ci/budgets/decisions/${unit}/2026-10-28-extra.md`,
    `---\n${JSON.stringify({
      unit,
      delta_bytes: 1,
      before_bytes: 1_000,
      after_bytes: 1_001,
      cause: "Feature growth; checked for duplicate imports.",
      pr: 42,
    })}\n---\n`,
  );
  const head = fx.commit("retire plus delta");
  await assert.rejects(fx.check("pull_request", prEvent(base, head)), /retired unit/);
});

for (const variant of ["wrong-name", "wrong-email", "wrong-subject", "six-days-old", "recent"]) {
  test(`historical squash ${variant} requires API provenance`, async (t) => {
    const fx = fixture(t);
    fx.add(path, 1_600, 1);
    fx.git("add", ".");
    execFileSync(
      "git",
      [
        "-C",
        fx.root,
        "commit",
        "-qm",
        variant === "wrong-subject" ? "feature (#2)" : "feature (#1)",
      ],
      {
        env: {
          ...process.env,
          GIT_COMMITTER_NAME: variant === "wrong-name" ? "Other" : "GitHub",
          GIT_COMMITTER_EMAIL:
            variant === "wrong-email" ? "other@example.invalid" : "noreply@github.com",
          GIT_COMMITTER_DATE:
            variant === "recent"
              ? NOW
              : variant === "six-days-old"
                ? "2026-10-22T11:59:59Z"
                : "2026-10-01T12:00:00Z",
          GIT_AUTHOR_DATE: NOW,
        },
      },
    );
    const main = fx.git("rev-parse", "HEAD");
    fx.add(path.replace("feature", "new"), 500);
    const head = fx.commit("new feature");
    let lookups = 0;
    await assert.rejects(
      fx.check("pull_request", prEvent(main, head), {
        request: async (endpoint) => {
          lookups += 1;
          assert.equal(endpoint, `commits/${main}/pulls`);
          return [
            {
              number: 1,
              merge_commit_sha: main,
              merged_at: NOW,
              base: { ref: "main", repo: { full_name: repo } },
            },
          ];
        },
      }),
      /2%/,
    );
    assert.equal(lookups, 1, "recent or nonstandard history must use GitHub provenance");
  });
}

test("unmerged history does not establish provenance", async (t) => {
  const fx = fixture(t);
  fx.add();
  const main = fx.commit("history (#42)");
  fx.add(path.replace("feature", "new"));
  const head = fx.commit("new");
  await assert.rejects(
    fx.check("pull_request", prEvent(main, head), {
      request: async () => [
        {
          number: 42,
          merge_commit_sha: main,
          merged_at: null,
          base: { ref: "main", repo: { full_name: repo } },
        },
      ],
    }),
    /main merge provenance/,
  );
});

for (const mismatch of ["branch", "repository"]) {
  test(`queue rejects attributed PR with wrong ${mismatch}`, async (t) => {
    const fx = fixture(t);
    fx.add();
    const head = fx.commit("feature (#42)");
    await assert.rejects(
      fx.check("merge_group", groupEvent(fx.base, head), {
        request: async (endpoint) =>
          endpoint === "pulls/42"
            ? {
                base: {
                  ref: mismatch === "branch" ? "other" : "main",
                  repo: {
                    full_name: mismatch === "repository" ? "other/repo" : repo,
                  },
                },
              }
            : fx.request(endpoint),
      }),
      /different base\/repository/,
    );
  });
}

test("budget evidence must not be a symlink", async (t) => {
  const fx = fixture(t);
  fx.git("rm", "-q", "ci/budgets/kit/client.json");
  mkdirSync(join(fx.root, "ci/budgets/kit"), { recursive: true });
  symlinkSync("missing", join(fx.root, "ci/budgets/kit/client.json"));
  fx.git("add", "ci/budgets/kit/client.json");
  fx.git("commit", "-qm", "replace budget with symlink");
  const head = fx.git("rev-parse", "HEAD");
  await assert.rejects(fx.check("pull_request", prEvent(fx.base, head)), /regular git files/);
});

test("initial allocation permits exactly 2% but rejects more", async (t) => {
  const fx = fixture(t);
  const base = installed(fx);
  const asset = "public/islands/new.js";
  const body = "x".repeat(100);
  fx.put(asset, body);
  const measured = {
    "bundle-public-islands-new-js-raw": 100,
    "bundle-public-islands-new-js-gzip": gzipSync(body).length,
  };
  const fragment = "ci/budgets/bundle/new.json";
  const budget = {
    budgets: {
      [asset]: {
        maxRawBytes: 102,
        maxGzipBytes: measured["bundle-public-islands-new-js-gzip"],
      },
    },
  };
  fx.put(fragment, JSON.stringify(budget));
  lifecycle(fx, "initial", fragment, budget, measured);
  const head = fx.commit("allocation at boundary");
  assert.equal((await fx.check("pull_request", prEvent(base, head))).proposed.length, 1);
  budget.budgets[asset].maxRawBytes = 103;
  fx.put(fragment, JSON.stringify(budget));
  lifecycle(fx, "initial", fragment, budget, measured);
  const over = fx.commit("allocation over boundary");
  await assert.rejects(fx.check("pull_request", prEvent(base, over)), /at most 2%/);
});

test("a retired unit cannot be reintroduced as a fresh base", async (t) => {
  const fx = fixture(t);
  const fragment = "ci/budgets/bundle/a.json";
  const budget = {
    budgets: { "public/islands/a.js": { maxRawBytes: 100, maxGzipBytes: 50 } },
  };
  fx.put(
    "ci/budgets/bundle/b.json",
    JSON.stringify({
      budgets: {
        "public/islands/b.js": { maxRawBytes: 100, maxGzipBytes: 50 },
      },
    }),
  );
  installed(fx);
  rmSync(join(fx.root, fragment));
  lifecycle(fx, "retire", fragment, budget);
  const base = fx.commit("retirement");
  const body = "export {};\n";
  fx.put("public/islands/a.js", body);
  const replacement = {
    budgets: {
      "public/islands/a.js": {
        maxRawBytes: Buffer.byteLength(body),
        maxGzipBytes: gzipSync(body).length,
      },
    },
  };
  fx.put(fragment, JSON.stringify(replacement));
  lifecycle(fx, "initial", fragment, replacement, {
    "bundle-public-islands-a-js-raw": Buffer.byteLength(body),
    "bundle-public-islands-a-js-gzip": gzipSync(body).length,
  });
  const head = fx.commit("reuse retired identity");
  await assert.rejects(
    fx.check("pull_request", prEvent(base, head)),
    /duplicate initial allocation/,
  );
});

test("deploy install rejects measurement from outside base ancestry", async (t) => {
  const fx = fixture(t);
  fx.git("checkout", "-qb", "side");
  const side = fx.commit("unrelated measurement");
  fx.git("checkout", "-q", "--detach", fx.base);
  fx.put(
    "ci/budgets/deploy/worker.json",
    JSON.stringify({
      worker: { maxRawBytes: 1020 },
      measuredMain: {
        sha: side,
        rawBytesUpperBound: 1000,
        evidence: "https://github.com/TogetherWeOwn/two-web-next/actions/runs/123/job/456",
      },
    }),
  );
  const head = fx.commit("install deploy base");
  await assert.rejects(fx.check("pull_request", prEvent(fx.base, head)), /merge-base/);
});

test("GitHub rate-limit retry honors Retry-After seconds", async () => {
  let calls = 0;
  const waits = [];
  const request = githubRequest(
    repo,
    "fake-test-token",
    async () => {
      calls += 1;
      return calls === 1
        ? {
            ok: false,
            status: 403,
            headers: new Headers({ "retry-after": "60" }),
          }
        : { ok: true, json: async () => ({ number: 42 }) };
    },
    { sleep: async (ms) => waits.push(ms), random: () => 0 },
  );
  assert.deepEqual(await request("pulls/42"), { number: 42 });
  assert.deepEqual(waits, [60_000]);
});

test("excessive Retry-After fails closed without retrying early", async () => {
  let calls = 0;
  const request = githubRequest(
    repo,
    "fake-test-token",
    async () => {
      calls += 1;
      return {
        ok: false,
        status: 429,
        headers: new Headers({ "retry-after": "121" }),
      };
    },
    { sleep: async () => assert.fail("must not retry early"), random: () => 0 },
  );
  await assert.rejects(request("pulls/42"), /retry delay exceeds bound/);
  assert.equal(calls, 1);
});

test("shipping fragment retirement accepts the exact current filename and metadata", async (t) => {
  const fx = fixture(t);
  const fragment = "ci/budgets/bundle/copy-link.js.json";
  const budget = JSON.parse(
    readFileSync(new URL("./budgets/bundle/copy-link.js.json", import.meta.url), "utf8"),
  );
  fx.put(fragment, JSON.stringify(budget));
  fx.put("public/islands/copy-link.js", "export {};\n");
  const base = installed(fx);
  rmSync(join(fx.root, fragment));
  rmSync(join(fx.root, "public/islands/copy-link.js"));
  lifecycle(fx, "retire", fragment, budget);
  const head = fx.commit("retire shipping island");
  assert.equal((await fx.check("pull_request", prEvent(base, head))).proposed.length, 1);
});

test("queue attributes an actual fragment rename only with matching retirement evidence", async (t) => {
  const fx = fixture(t);
  const old = "ci/budgets/bundle/copy-link.js.json";
  const replacement = "ci/budgets/bundle/share-link.js.json";
  const original = JSON.parse(
    readFileSync(new URL("./budgets/bundle/copy-link.js.json", import.meta.url), "utf8"),
  );
  fx.put(old, JSON.stringify(original));
  fx.put("public/islands/copy-link.js", "export {};\n");
  const base = installed(fx);
  rmSync(join(fx.root, old));
  rmSync(join(fx.root, "public/islands/copy-link.js"));
  lifecycle(fx, "retire", old, original);
  const body = "export {};\n";
  fx.put("public/islands/share-link.js", body);
  const budget = {
    budgets: {
      "public/islands/share-link.js": {
        maxRawBytes: Buffer.byteLength(body),
        maxGzipBytes: gzipSync(body).length,
      },
    },
  };
  fx.put(replacement, JSON.stringify(budget));
  lifecycle(fx, "initial", replacement, budget, {
    "bundle-public-islands-share-link-js-raw": Buffer.byteLength(body),
    "bundle-public-islands-share-link-js-gzip": gzipSync(body).length,
  });
  const head = fx.commit("rename island (#42)");
  assert.equal((await fx.check("pull_request", prEvent(base, head))).proposed.length, 2);
  const request = async (endpoint) => {
    if (!endpoint.endsWith("/files")) return fx.request(endpoint);
    return [
      {
        filename: replacement,
        previous_filename: old,
        status: "renamed",
        sha: fx.git("rev-parse", `HEAD:${replacement}`),
      },
      ...["initial", "retire"].map((action) => {
        const file = `ci/budgets/decisions/allocations/2026-10-28-${action}.md`;
        return {
          filename: file,
          status: "added",
          sha: fx.git("rev-parse", `HEAD:${file}`),
        };
      }),
    ];
  };
  assert.equal(
    (await fx.check("merge_group", groupEvent(base, head), { request })).proposed.length,
    2,
  );
  for (const previous of ["ci/budgets/bundle/unrelated.js.json", undefined]) {
    await assert.rejects(
      fx.check("merge_group", groupEvent(base, head), {
        request: async (endpoint) => {
          const result = await request(endpoint);
          return Array.isArray(result)
            ? result.map((entry) =>
                entry.filename === replacement ? { ...entry, previous_filename: previous } : entry,
              )
            : result;
        },
      }),
      /attribution/,
    );
  }
});

test("initial lifecycle decision must match the actual committed fragment", async (t) => {
  const fx = fixture(t);
  const base = installed(fx);
  const { fragment, budget } = newIsland(fx);
  budget.budgets["public/islands/new.js"].maxRawBytes = 1000;
  fx.put(fragment, JSON.stringify(budget));
  const head = fx.commit("mismatched allocation");
  await assert.rejects(fx.check("pull_request", prEvent(base, head)), /evidence mismatch/);
});

test("a renamed asset cannot exceed the retired ceiling it inherits", async (t) => {
  // Same served bytes under a new path: the renamed unit inherits the retired
  // ceilings. A larger fresh ceiling for the identical asset is refused, because
  // that growth would otherwise owe the 0.5%/2% admission guard.
  const fx = fixture(t);
  const old = "ci/budgets/bundle/copy-link.js.json";
  const replacement = "ci/budgets/bundle/share-link.js.json";
  const original = JSON.parse(
    readFileSync(new URL("./budgets/bundle/copy-link.js.json", import.meta.url), "utf8"),
  );
  fx.put(old, JSON.stringify(original));
  fx.put("public/islands/copy-link.js", "export {};\n");
  const base = installed(fx);
  rmSync(join(fx.root, old));
  rmSync(join(fx.root, "public/islands/copy-link.js"));
  lifecycle(fx, "retire", old, original);
  const ceilings = original.budgets["public/islands/copy-link.js"];
  // The asset genuinely grows across the rename, so the new ceiling fits its own
  // measurement (the 2% allowance passes) yet exceeds the retired ceiling it
  // inherits. That growth must be admitted, not silently reset.
  const body = `${"export const kept = true;\n".repeat(90)}`;
  const budget = {
    budgets: {
      "public/islands/share-link.js": {
        maxRawBytes: Math.max(Buffer.byteLength(body), ceilings.maxRawBytes + 256),
        maxGzipBytes: gzipSync(body).length,
      },
    },
  };
  fx.put("public/islands/share-link.js", body);
  fx.put(replacement, JSON.stringify(budget));
  lifecycle(fx, "initial", replacement, budget, {
    "bundle-public-islands-share-link-js-raw": Buffer.byteLength(body),
    "bundle-public-islands-share-link-js-gzip": gzipSync(body).length,
  });
  const head = fx.commit("rename and grow (#42)");
  // GitHub reports the rename: the old served asset continues as the new one.
  await assert.rejects(
    fx.check("pull_request", prEvent(base, head), {
      pullRequestRenames: () => ({ "public/islands/share-link.js": "public/islands/copy-link.js" }),
    }),
    /rename ceiling exceeds the retired ceiling/,
  );
});

test("PR cannot raise a ceiling when its measured result fits existing headroom", async (t) => {
  const fx = fixture(t);
  fx.add();
  const file = join(fx.root, path);
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace("99900", "99000").replace("100400", "99500"),
  );
  const head = fx.commit("unnecessary admission");
  await assert.rejects(fx.check("pull_request", prEvent(fx.base, head)), /headroom/);
});

test("PR permits only byte-ceiling decreases in existing budget fragments", async (t) => {
  const fx = fixture(t);
  const file = "ci/budgets/kit/client.json";
  const original = JSON.parse(readFileSync(join(fx.root, file), "utf8"));
  original.client.js.maxGzipBytes = 99_000;
  fx.put(file, JSON.stringify(original));
  const head = fx.commit("tighten ceiling");
  await assert.doesNotReject(fx.check("pull_request", prEvent(fx.base, head)));
});

test("tightening cannot alter file counts, other fields, or increase byte ceilings", async (t) => {
  for (const change of [
    (p) => {
      p.client.js.maxFiles = 6;
    },
    (p) => {
      p.client.js.maxRawBytes++;
    },
    (p) => {
      p.client.js.extra = 1;
    },
    (p) => {
      p.client.js.maxGzipBytes = 0;
    },
  ]) {
    const fx = fixture(t);
    const file = "ci/budgets/kit/client.json";
    const data = JSON.parse(readFileSync(join(fx.root, file), "utf8"));
    data.client.js.maxGzipBytes = 99_000;
    change(data);
    fx.put(file, JSON.stringify(data));
    const head = fx.commit("invalid edit");
    await assert.rejects(fx.check("pull_request", prEvent(fx.base, head)), /frozen/);
  }
});

test("queue cannot undo a sibling's tightening even when final base equals main", async (t) => {
  const fx = fixture(t);
  const file = "ci/budgets/kit/client.json";
  const original = readFileSync(join(fx.root, file), "utf8");
  const data = JSON.parse(original);
  data.client.js.maxGzipBytes = 99_000;
  fx.put(file, JSON.stringify(data));
  fx.commit("tighten (#41)");
  fx.put(file, original);
  const head = fx.commit("undo (#42)");
  await assert.rejects(fx.check("merge_group", groupEvent(fx.base, head)), /frozen/);
});

test("a PR cannot create artificial headroom pressure by tightening and raising the same unit", async (t) => {
  const fx = fixture(t);
  const file = "ci/budgets/kit/client.json";
  const data = JSON.parse(readFileSync(join(fx.root, file), "utf8"));
  data.client.js.maxGzipBytes = 99_900;
  fx.put(file, JSON.stringify(data));
  fx.add(path, 499);
  const decisionFile = join(fx.root, path);
  writeFileSync(decisionFile, readFileSync(decisionFile, "utf8").replace("100400", "99950"));
  const head = fx.commit("tighten and admit");
  await assert.rejects(fx.check("pull_request", prEvent(fx.base, head)), /tighten.*admission/);
});

test("top-level fragment metadata can change without altering the budget", async (t) => {
  const fx = fixture(t);
  const file = "ci/budgets/kit/client.json";
  const data = JSON.parse(readFileSync(join(fx.root, file), "utf8"));
  data.$comment = "Current admission instructions";
  fx.put(file, JSON.stringify(data));
  const head = fx.commit("correct metadata");
  await assert.doesNotReject(fx.check("pull_request", prEvent(fx.base, head)));
});

test("metadata edits cannot conceal changes to ceilings or nested fields", async (t) => {
  for (const change of [
    (data) => {
      data.client.js.maxGzipBytes++;
    },
    (data) => {
      data.client.js.$comment = "nested";
    },
    (data) => {
      data.client.js.maxFiles++;
    },
  ]) {
    const fx = fixture(t);
    const file = "ci/budgets/kit/client.json";
    const data = JSON.parse(readFileSync(join(fx.root, file), "utf8"));
    data.$comment = "Current admission instructions";
    change(data);
    fx.put(file, JSON.stringify(data));
    const head = fx.commit("invalid metadata edit");
    await assert.rejects(fx.check("pull_request", prEvent(fx.base, head)), /frozen/);
  }
});

test("fragment comments never point authors at the frozen archives", () => {
  // Top-level $ metadata is optional and its wording is not a contract (the
  // documented initial-allocation example in ci/budgets/README.md carries no
  // $comment at all). When a fragment does carry one it must not send the next
  // author to ci/budgets/decisions/kit-perf/ or .../bundle/, which are frozen
  // history, never new capacity — that is how main's operator-overrides-theme
  // fragment landed with an obsolete pointer and had to be corrected.
  for (const dir of ["kit", "bundle"]) {
    const root = new URL(`./budgets/${dir}/`, import.meta.url);
    for (const name of readdirSync(root).filter((file) => file.endsWith(".json"))) {
      const data = JSON.parse(readFileSync(new URL(name, root), "utf8"));
      if (typeof data.$comment !== "string") continue;
      assert.doesNotMatch(data.$comment, /decisions\/(kit-perf|bundle)\//, name);
    }
  }
});
