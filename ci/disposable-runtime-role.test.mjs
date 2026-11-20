import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("disposable migration workflows prepare the role before migrations", () => {
  for (const [path, expected] of [
    [".github/workflows/ci.yml", 2],
    [".github/workflows/e2e.yml", 1],
    [".github/workflows/kit-edit-regression-proof.yml", 1],
    [".github/workflows/discovery-title-evidence.yml", 1],
    [".github/workflows/xfs-qualification.yml", 1],
  ]) {
    const source = read(path);
    const migrations = [...source.matchAll(/npm run db:migrate\b/g)];
    const allPreparations = [...source.matchAll(/- name: Prepare disposable runtime role/g)];
    if (path === ".github/workflows/ci.yml") {
      assert.ok(
        allPreparations[0].index < source.indexOf("- name: Chromium cancellation regressions"),
      );
    }
    const preparations =
      path === ".github/workflows/ci.yml" ? allPreparations.slice(1) : allPreparations;
    assert.equal(preparations.length, expected, path);
    const apply = migrations.filter(
      (match) => !source.slice(match.index).startsWith("npm run db:migrate:selftest"),
    );
    assert.equal(apply.length, expected, path);
    for (let i = 0; i < expected; i++) {
      assert.ok(preparations[i].index < apply[i].index, path);
      assert.match(
        source.slice(preparations[i].index, apply[i].index),
        /-f ci\/disposable-runtime-role\.sql -f ci\/disposable-runtime-role\.sql/,
      );
    }
  }
  const workflow = read(".github/workflows/ci.yml");
  assert.match(workflow, /catalog-postgres:\n\s+image: postgres:17/);
  assert.match(
    workflow,
    /CATALOG_PREFLIGHT_TEST_DATABASE_URL: postgres:\/\/postgres:ci@catalog-postgres:5432\/postgres/,
  );
  const local = read("bin/local-ci.sh");
  assert.ok(
    local.indexOf("< ci/disposable-runtime-role.sql") <
      local.indexOf("npm run --silent db:migrate"),
  );
});
