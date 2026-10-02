export function requireGithubRunner(env = process.env) {
  // Private repo: self-hosted Linux runners (job container). RUNNER_ENVIRONMENT
  // is not a default GitHub variable, so it cannot gate anything. The invariant
  // is GitHub Actions on Linux; the controller never sets GITHUB_ACTIONS.
  if (env.GITHUB_ACTIONS !== "true" || env.RUNNER_OS !== "Linux") {
    throw new Error(
      "Browser smoke runs only in GitHub Actions on Linux; never run on the controller.",
    );
  }
}

export function requireTestDatabase(raw) {
  const url = new URL(raw ?? "");
  if (
    url.protocol !== "postgres:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "5432" ||
    url.pathname !== "/two_web_next" ||
    url.username !== "agent_test" ||
    url.password !== "" ||
    url.search !== ""
  ) {
    throw new Error("E2E requires the disposable CI Postgres service, not staging or production.");
  }
  return url.toString();
}
