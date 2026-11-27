import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the added-line gate grandfathers existing assertions and checks scoped additions", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "raw-html-ratchet-"));
  t.after(() => rmSync(cwd, { force: true, recursive: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const write = (file, code) => writeFileSync(join(cwd, file), code);
  const check = (event) => {
    const eventPath = join(cwd, ".git", "event.json");
    if (event) writeFileSync(eventPath, JSON.stringify(event));
    return spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../sg-rules/check-new-raw-html.mjs", import.meta.url))],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_ACTIONS: String(Boolean(event)),
          GITHUB_EVENT_PATH: eventPath,
        },
      },
    );
  };
  const commit = (message) =>
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      message,
    );

  for (const dir of ["bin", "ci", "e2e/kit-parity", "e2e/parity", "sg-rules", "sg-tests", "test"])
    mkdirSync(join(cwd, dir), { recursive: true });
  for (const path of ["sgconfig.yml", "sg-rules/no-raw-html-assertion.yml"])
    copyFileSync(new URL(`../${path}`, import.meta.url), join(cwd, path));

  const raw = 'expect(body).toContain("<h1>Welcome</h1>");\n';
  const helper = 'expect(renderedText(heading)).toBe("Welcome");\n';
  const baseline = `${raw}expect(response.status).toBe(200);\n`;
  write("test/site-smoke.test.ts", baseline);
  git("init", "-q", "-b", "main");
  git("add", ".");
  commit("Baseline");
  const base = git("rev-parse", "HEAD").trim();
  git("update-ref", "refs/remotes/origin/main", base);

  write("test/site-smoke.test.ts", helper + baseline);
  write("ci/probe-sizes.mjs", "assert.match(body, /^text\\/html$/);\n");
  write("test/parityish.test.ts", raw);
  const clean = check();
  assert.equal(clean.status, 0, clean.stderr);

  write("test/site-smoke.test.ts", helper + baseline + raw);
  write("bin/new-probe.mjs", "assert.match(body, /<main\\b/);\n");
  write("ci/new-parity.mjs", 'if (!body.includes("<p>")) throw new Error("missing copy");\n');
  write("e2e/parity/check.spec.ts", raw);
  write("e2e/kit-parity/auth-boundaries.spec.ts", raw);
  git("add", "bin/new-probe.mjs", "ci/new-parity.mjs");
  const rejected = check();
  assert.equal(rejected.status, 1, rejected.stderr);
  for (const location of [
    "test/site-smoke.test.ts:4",
    "bin/new-probe.mjs:1",
    "ci/new-parity.mjs:1",
    "e2e/parity/check.spec.ts:1",
    "e2e/kit-parity/auth-boundaries.spec.ts:1",
  ])
    assert.ok(rejected.stderr.includes(location), rejected.stderr);
  assert.doesNotMatch(rejected.stderr, /site-smoke\.test\.ts:2|parityish\.test|probe-sizes/);

  // The local fallback would grandfather everything once the remote ref catches up.
  git("add", ".");
  commit("Candidate");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const caughtUp = check();
  assert.equal(caughtUp.status, 0, caughtUp.stderr);
  for (const event of [
    { pull_request: { base: { sha: base } } },
    { merge_group: { base_sha: base } },
    { before: base },
  ]) {
    const hosted = check(event);
    assert.equal(hosted.status, 1, hosted.stderr);
    assert.match(hosted.stderr, /site-smoke\.test\.ts:4:/);
    assert.doesNotMatch(hosted.stderr, /site-smoke\.test\.ts:2:/);
  }
});
