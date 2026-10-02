import assert from "node:assert/strict";
import { test } from "node:test";
import { requireGithubRunner, requireTestDatabase } from "./ci-only.mjs";

const runner = { GITHUB_ACTIONS: "true", RUNNER_OS: "Linux", RUNNER_ENVIRONMENT: "self-hosted" };

test("browser runner runs in GitHub Actions on Linux and refuses the controller", () => {
  // RUNNER_ENVIRONMENT is not a default GitHub variable; any value (or none)
  // is accepted. The invariant is Actions-on-Linux; the controller never sets
  // GITHUB_ACTIONS.
  assert.doesNotThrow(() => requireGithubRunner(runner));
  assert.doesNotThrow(() => requireGithubRunner({ GITHUB_ACTIONS: "true", RUNNER_OS: "Linux" }));
  for (const env of [
    {},
    { ...runner, GITHUB_ACTIONS: "false" },
    { ...runner, RUNNER_OS: "Windows" },
    { ...runner, RUNNER_OS: "macOS" },
  ]) {
    assert.throws(() => requireGithubRunner(env), /only in GitHub Actions on Linux/);
  }
});

test("database guard permits only the disposable CI target", () => {
  assert.equal(
    requireTestDatabase("postgres://agent_test@127.0.0.1:5432/two_web_next"),
    "postgres://agent_test@127.0.0.1:5432/two_web_next",
  );
  for (const url of [
    undefined,
    "postgres://agent_test@staging.example:5432/two_web_next",
    "postgres://agent_test@127.0.0.1:5432/production",
    "postgres://postgres@127.0.0.1:5432/two_web_next",
    "postgres://agent_test:secret@127.0.0.1:5432/two_web_next",
    "postgres://agent_test@127.0.0.1:5432/two_web_next?host=staging.example",
  ]) {
    assert.throws(() => requireTestDatabase(url));
  }
});
