import assert from "node:assert/strict";
import { test } from "node:test";
import { requireGithubRunner, requireTestDatabase } from "./ci-only.mjs";

const runner = { GITHUB_ACTIONS: "true", RUNNER_OS: "Linux", RUNNER_ENVIRONMENT: "github-hosted" };

test("browser runner refuses the controller, non-Linux and self-hosted execution", () => {
  assert.doesNotThrow(() => requireGithubRunner(runner));
  for (const env of [{}, { ...runner, GITHUB_ACTIONS: "false" }, { ...runner, RUNNER_OS: "Windows" },
    { ...runner, RUNNER_ENVIRONMENT: "self-hosted" }]) {
    assert.throws(() => requireGithubRunner(env), /restricted to GitHub-hosted Linux/);
  }
});

test("database guard permits only the disposable CI target", () => {
  assert.equal(requireTestDatabase("postgres://agent_test@127.0.0.1:5432/two_web_next"),
    "postgres://agent_test@127.0.0.1:5432/two_web_next");
  for (const url of [undefined, "postgres://agent_test@staging.example:5432/two_web_next",
    "postgres://agent_test@127.0.0.1:5432/production", "postgres://postgres@127.0.0.1:5432/two_web_next",
    "postgres://agent_test:secret@127.0.0.1:5432/two_web_next",
    "postgres://agent_test@127.0.0.1:5432/two_web_next?host=staging.example"]) {
    assert.throws(() => requireTestDatabase(url));
  }
});
