import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPromotionPath } from "./promotion-path.mjs";

const repo = "TogetherWeOwn/two-web-next";
const root = new URL("..", import.meta.url);
const classifierFiles = ["ci/promotion-path-local.mjs", "ci/promotion-path.mjs"];
const isSha = (value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

export function classifyLocalPromotionPath(
  number,
  expectedHead,
  { read, git, readSource = (path) => readFileSync(new URL(path, root)) },
) {
  assert.ok(
    Number.isSafeInteger(number) && number > 0 && isSha(expectedHead),
    "Expected a PR number and full head SHA",
  );
  const gitText = (...args) =>
    git(...args)
      .toString("utf8")
      .trim();
  const readBranch = (name) => {
    const branchRef = `refs/heads/${name}`;
    git("check-ref-format", branchRef);
    const refPath = name.split("/").map(encodeURIComponent).join("/");
    const ref = read(`/git/ref/heads/${refPath}`);
    assert.ok(
      ref?.ref === branchRef && ref.object?.type === "commit" && isSha(ref.object.sha),
      "Missing exact-case branch ref or full tip SHA",
    );
    return { ref: branchRef, tip: ref.object.sha };
  };
  const readIdentity = () => {
    const pr = read(`/pulls/${number}`);
    assert.ok(
      pr?.number === number &&
        pr.state === "open" &&
        pr.head?.sha === expectedHead &&
        isSha(pr.base?.sha) &&
        typeof pr.base.ref === "string" &&
        typeof pr.base.repo?.full_name === "string" &&
        typeof pr.base.repo.default_branch === "string" &&
        pr.base.repo.full_name.toLowerCase() === repo.toLowerCase(),
      "Open PR identity does not match the requested repository and head",
    );
    const target = readBranch(pr.base.ref);
    const defaultName = pr.base.repo.default_branch;
    const upstream = defaultName === pr.base.ref ? target : readBranch(defaultName);
    return {
      number,
      head: expectedHead,
      targetRef: target.ref,
      targetTip: target.tip,
      reportedBase: pr.base.sha,
      defaultRef: upstream.ref,
      classifierHead: upstream.tip,
    };
  };
  const verifyClassifier = (classifierHead) => {
    assert.equal(
      gitText("rev-parse", "HEAD"),
      classifierHead,
      "Classifier checkout must match the live upstream default branch",
    );
    for (const path of classifierFiles) {
      assert.ok(
        readSource(path).equals(git("show", `${classifierHead}:${path}`)),
        `Classifier source differs from the upstream default branch: ${path}`,
      );
    }
  };

  const before = readIdentity();
  assert.equal(
    gitText("rev-parse", "--is-shallow-repository"),
    "false",
    "Classification needs full Git history",
  );
  verifyClassifier(before.classifierHead);
  const mergeBase = gitText("merge-base", "--all", before.targetTip, before.head);
  assert.ok(isSha(mergeBase), "Classification needs exactly one full three-dot merge base");
  // As additions and deletions, both names of a rename are present in the path list.
  const names = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    git(
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--no-relative",
      "--ignore-submodules=none",
      "--no-ext-diff",
      "--no-textconv",
      mergeBase,
      before.head,
      "--",
    ),
  );
  assert.ok(!names || names.endsWith("\0"), "Incomplete changed-path list");
  const matches = names.slice(0, -1).split("\0").filter(isPromotionPath);
  assert.deepEqual(readIdentity(), before, "PR or live branch changed during classification");
  verifyClassifier(before.classifierHead);
  return { ...before, mergeBase, verdict: matches.length ? "yes" : "no", matches };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [number, head, ...extra] = process.argv.slice(2);
    assert.ok(
      /^[1-9][0-9]*$/.test(number) && !extra.length,
      "Usage: node ci/promotion-path-local.mjs <pr-number> <full-head-sha>",
    );
    const gitEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
    );
    const execute = (command, args, env = process.env) =>
      execFileSync(command, args, {
        cwd: fileURLToPath(root),
        env,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 30_000,
      });
    const result = classifyLocalPromotionPath(Number(number), head, {
      read: (resource) =>
        JSON.parse(
          execute("gh", [
            "api",
            "--hostname",
            "github.com",
            "--method",
            "GET",
            `repos/${repo}${resource}`,
          ]),
        ),
      git: (...args) =>
        execute("git", ["--no-replace-objects", ...args], {
          ...gitEnv,
          GIT_GRAFT_FILE: "",
          GIT_NO_LAZY_FETCH: "1",
        }),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Promotion-path classification unavailable: ${error.message}`);
    process.exitCode = 1;
  }
}
