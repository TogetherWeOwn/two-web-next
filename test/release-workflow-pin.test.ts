import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, type TestContext } from "vitest";

const VERIFIER = fileURLToPath(new URL("../ci/verify-release-workflow-pin.mjs", import.meta.url));
const REPO = "TogetherWeOwn/two-web-next";
const TAG = "v2099.101.0";
const REF = `refs/tags/${TAG}`;
const ROLLBACK = ".github/workflows/rollback-production.yml";
const RELEASE = ".github/workflows/release.yml";
const CALLEES = {
  [ROLLBACK]: "name: fixture rollback\non: workflow_call\n",
  [RELEASE]: "name: fixture release\non: workflow_call\n",
};

function fixture({ onTestFinished }: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "release-workflow-pin-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        GIT_ALLOW_PROTOCOL: "",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
  const write = (path: string, text: string) => writeFileSync(join(root, path), text);
  const commit = (message: string) => {
    git("add", "--all");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "--object-format=sha1", "-b", "main");
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  for (const [path, content] of Object.entries(CALLEES)) write(path, content);
  const reviewed = commit("review workflows");
  write("unrelated.txt", "release tree can have unrelated changes\n");
  const pin = commit("release commit");
  git("tag", "-a", TAG, "-m", "synthetic release", pin);

  const api = `https://api.github.com/repos/${REPO}`;
  const evidence = {
    release: {
      id: 123,
      url: `${api}/releases/123`,
      html_url: `https://github.com/${REPO}/releases/tag/${TAG}`,
      tag_name: TAG,
      target_commitish: "main",
      published_at: "2099-01-01T12:34:56Z",
      draft: false,
      prerelease: false,
      immutable: true,
    },
    ref: {
      ref: REF,
      url: `${api}/git/${REF}`,
      object: { type: "tag", sha: git("rev-parse", REF) },
    },
  };
  const verify = (input = JSON.stringify(evidence), proposedPin = pin, review = reviewed) =>
    spawnSync(process.execPath, [VERIFIER, TAG, proposedPin, review], {
      cwd: root,
      env: { PATH: process.env.PATH },
      input,
      encoding: "utf8",
      timeout: 15_000,
    });
  return { root, git, write, commit, pin, reviewed, evidence, verify };
}

function expectRefusal(result: ReturnType<ReturnType<typeof fixture>["verify"]>, reason: string) {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(reason);
}

it("binds the published tag to the pin and reports the exact reviewed workflow blobs", (t) => {
  const f = fixture(t);
  // A working-tree change cannot contaminate an object-level comparison.
  f.write(ROLLBACK, "uncommitted change\n");
  const result = f.verify();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    repository: REPO,
    releaseId: f.evidence.release.id,
    tag: TAG,
    tagObject: f.evidence.ref.object.sha,
    pin: f.pin,
    reviewed: f.reviewed,
    workflows: Object.entries(CALLEES).map(([path, bytes]) => ({
      path,
      blob: f.git("rev-parse", `${f.reviewed}:${path}`),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  });
});

it("refuses a different proposed pin even when both workflow blobs match", (t) => {
  const f = fixture(t);
  expectRefusal(f.verify(undefined, f.reviewed), "peeled commit does not match the proposed pin");
});

it("refuses a moved tag even when it still peels to the proposed pin", (t) => {
  const f = fixture(t);
  f.git("tag", "-fa", TAG, "-m", "a different tag object", f.pin);
  expect(f.git("rev-parse", `${REF}^{commit}`)).toBe(f.pin);
  expectRefusal(f.verify(), "local release tag differs from captured tag ref");
});

it.for([ROLLBACK, RELEASE])("refuses a byte change in %s", (path, t) => {
  const f = fixture(t);
  f.write(path, CALLEES[path].replaceAll("\n", "\r\n"));
  const different = f.commit("change workflow line endings");
  // A local replacement cannot hide the committed difference.
  f.git("replace", different, f.reviewed);
  expectRefusal(f.verify(undefined, f.pin, different), `workflow bytes differ at ${path}`);
});

it("refuses a symlink at a reviewed workflow path", (t) => {
  const f = fixture(t);
  rmSync(join(f.root, RELEASE));
  symlinkSync("rollback-production.yml", join(f.root, RELEASE));
  const different = f.commit("symlink release workflow");
  expectRefusal(
    f.verify(undefined, f.pin, different),
    "reviewed revision lacks a readable regular workflow blob",
  );
});

it("refuses absent and incomplete release evidence", (t) => {
  const f = fixture(t);
  expectRefusal(f.verify(""), "release evidence is absent");
  expectRefusal(
    f.verify(JSON.stringify({ ref: f.evidence.ref })),
    "selected immutable published stable release",
  );
  expectRefusal(
    f.verify(JSON.stringify({ release: f.evidence.release })),
    "selected release tag ref",
  );
  expectRefusal(f.verify("{malformed"), "release evidence must be UTF-8 JSON");
});

it("refuses evidence for a draft, prerelease, mutable release, different tag or foreign repository", (t) => {
  const f = fixture(t);
  for (const invalid of [
    { draft: true },
    { prerelease: true },
    { immutable: false },
    { tag_name: "v2099.101.1" },
    { url: f.evidence.release.url.replace(REPO, "other/repository") },
  ]) {
    const evidence = { ...f.evidence, release: { ...f.evidence.release, ...invalid } };
    expectRefusal(
      f.verify(JSON.stringify(evidence)),
      "selected immutable published stable release",
    );
  }
});
