import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { requireGithubRunner, requireTestDatabase } from "./ci-only.mjs";
import { requireStagingOrigin } from "./staging-guard.mjs";

const runner = { GITHUB_ACTIONS: "true", RUNNER_OS: "Linux", RUNNER_ENVIRONMENT: "github-hosted" };

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

test("staging guard permits only the exact staging origin", () => {
  assert.equal(
    requireStagingOrigin("https://next.togetherweown.com"),
    "https://next.togetherweown.com",
  );
  assert.equal(
    requireStagingOrigin("https://next.togetherweown.com/"),
    "https://next.togetherweown.com",
  );
  for (const raw of [
    undefined,
    "",
    "https://togetherweown.com",
    "https://togetherweown.com/",
    "http://next.togetherweown.com/",
    "https://next.togetherweown.com:8443/",
    "https://user:pass@next.togetherweown.com/",
    "https://next.togetherweown.com/e/seed-calendar-01",
    "https://next.togetherweown.com/?q=x",
    "https://next.togetherweown.com/#main",
    "https://evil-next.togetherweown.com/",
    "https://next.togetherweown.com.example/",
    "https://localhost:8787",
    "https://two-web-next.example.workers.dev/",
  ]) {
    assert.throws(() => requireStagingOrigin(raw), /only against/);
  }
});

test("default Playwright project ignores staging specs and wires a local-only teardown", () => {
  // Staging specs need the deployed Worker (QA seam + Hyperdrive/queues) and
  // fail under wrangler dev + CI Postgres. Only e2e-staging.yml may run them.
  const config = readFileSync(new URL("../playwright.config.ts", import.meta.url), "utf8");
  assert.match(config, /testIgnore:\s*"[^"]*staging[^"]*"/);
  assert.match(config, /globalTeardown:\s*"\.\/e2e\/local-global-teardown\.ts"/);

  const teardown = readFileSync(new URL("./local-global-teardown.ts", import.meta.url), "utf8");
  assert.match(teardown, /requireGithubRunner\(\)/);
  assert.match(teardown, /baseURL:\s*LOCAL_FIXTURE_ORIGIN/);
  assert.match(teardown, /ignoreHTTPSErrors:\s*true/);
  assert.doesNotMatch(teardown, /stagingOrigin|playwright\.staging\.config/);
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
