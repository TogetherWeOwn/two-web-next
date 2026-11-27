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
  const check = () =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../sg-rules/check-new-raw-html.mjs", import.meta.url))],
      { cwd, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "false" } },
    );

  for (const dir of ["bin", "ci", "e2e/parity", "sg-rules", "sg-tests", "test"])
    mkdirSync(join(cwd, dir), { recursive: true });
  for (const path of ["sgconfig.yml", "sg-rules/no-raw-html-assertion.yml"])
    copyFileSync(new URL(`../${path}`, import.meta.url), join(cwd, path));

  const raw = 'expect(body).toContain("<h1>Welcome</h1>");\n';
  const helper = 'expect(renderedText(heading)).toBe("Welcome");\n';
  const baseline = `${raw}expect(response.status).toBe(200);\n`;
  write("test/site-smoke.test.ts", baseline);
  git("init", "-q", "-b", "main");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "Baseline",
  );
  git("update-ref", "refs/remotes/origin/main", "HEAD");

  write("test/site-smoke.test.ts", helper + baseline);
  write("ci/probe-sizes.mjs", "assert.match(body, /^text\\/html$/);\n");
  write("test/parityish.test.ts", raw);
  const clean = check();
  assert.equal(clean.status, 0, clean.stderr);

  write("test/site-smoke.test.ts", helper + baseline + raw);
  write("bin/new-probe.mjs", "assert.match(body, /<main\\b/);\n");
  write("ci/new-parity.mjs", 'if (!body.includes("<p>")) throw new Error("missing copy");\n');
  write("e2e/parity/check.spec.ts", raw);
  git("add", "bin/new-probe.mjs", "ci/new-parity.mjs");
  const rejected = check();
  assert.equal(rejected.status, 1, rejected.stderr);
  for (const location of [
    "test/site-smoke.test.ts:4",
    "bin/new-probe.mjs:1",
    "ci/new-parity.mjs:1",
    "e2e/parity/check.spec.ts:1",
  ])
    assert.ok(rejected.stderr.includes(location), rejected.stderr);
  assert.doesNotMatch(rejected.stderr, /site-smoke\.test\.ts:2|parityish\.test|probe-sizes/);
});
