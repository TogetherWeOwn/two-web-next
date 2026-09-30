export function requireGithubRunner(env = process.env) {
  if (env.GITHUB_ACTIONS !== "true" || env.RUNNER_OS !== "Linux" ||
      env.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error("Browser smoke is restricted to GitHub-hosted Linux CI; never run on the controller.");
  }
}

export function requireTestDatabase(raw) {
  const url = new URL(raw ?? "");
  if (url.protocol !== "postgres:" || url.hostname !== "127.0.0.1" ||
      url.port !== "5432" || url.pathname !== "/two_web_next" ||
      url.username !== "agent_test" || url.password !== "" || url.search !== "") {
    throw new Error("E2E requires the disposable CI Postgres service, not staging or production.");
  }
  return url.toString();
}
