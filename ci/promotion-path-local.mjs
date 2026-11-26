import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPromotionPath } from "./promotion-path.mjs";

const repo = "TogetherWeOwn/two-web-next";
const isSha = (value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

export function classifyLocalPromotionPath(number, expectedHead, { read, git }) {
  assert.ok(
    Number.isSafeInteger(number) && number > 0 && isSha(expectedHead),
    "Expected a PR number and full head SHA",
  );
  const gitText = (...args) =>
    git(...args)
      .toString("utf8")
      .trim();
  const readIdentity = () => {
    const pr = read(`/pulls/${number}`);
    assert.ok(
      pr?.number === number &&
        pr.state === "open" &&
        pr.head?.sha === expectedHead &&
        isSha(pr.base?.sha) &&
        typeof pr.base.ref === "string" &&
        typeof pr.base.repo?.full_name === "string" &&
        pr.base.repo.full_name.toLowerCase() === repo.toLowerCase(),
      "Open PR identity does not match the requested repository and head",
    );
    const targetRef = `refs/heads/${pr.base.ref}`;
    git("check-ref-format", targetRef);
    const refPath = pr.base.ref.split("/").map(encodeURIComponent).join("/");
    const ref = read(`/git/ref/heads/${refPath}`);
    assert.ok(
      ref?.ref === targetRef && ref.object?.type === "commit" && isSha(ref.object.sha),
      "Missing exact-case target ref or full tip SHA",
    );
    return {
      number,
      head: expectedHead,
      targetRef,
      targetTip: ref.object.sha,
      reportedBase: pr.base.sha,
    };
  };

  const before = readIdentity();
  assert.equal(
    gitText("rev-parse", "--is-shallow-repository"),
    "false",
    "Classification needs full Git history",
  );
  const classifierHead = gitText("rev-parse", "HEAD");
  assert.ok(isSha(classifierHead), "Missing classifier revision");
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
  assert.deepEqual(readIdentity(), before, "PR or live target changed during classification");
  return { ...before, mergeBase, classifierHead, verdict: matches.length ? "yes" : "no", matches };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [number, head, ...extra] = process.argv.slice(2);
    assert.ok(
      /^[1-9][0-9]*$/.test(number) && !extra.length,
      "Usage: node ci/promotion-path-local.mjs <pr-number> <full-head-sha>",
    );
    const execute = (command, args) =>
      execFileSync(command, args, {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
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
      git: (...args) => execute("git", ["--no-replace-objects", ...args]),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Promotion-path classification unavailable: ${error.message}`);
    process.exitCode = 1;
  }
}
