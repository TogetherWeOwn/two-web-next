import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkBudgetAdmissions } from "./check-budget-admissions.mjs";

const UNIT = "kit-client-js-gzip";
const path = `ci/budgets/decisions/${UNIT}/2000-01-01-feature.md`;
const NOW = "2026-10-28T12:00:00Z";
const repo = "TogetherWeOwn/example";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "budget-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
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
  await assert.rejects(
    fx.check("pull_request", prEvent(main, main), { request: async () => [] }),
    /main merge provenance/,
  );
  await assert.rejects(
    fx.check("pull_request", prEvent(main, main), {
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
