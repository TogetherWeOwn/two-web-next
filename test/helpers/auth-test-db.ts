// Auth persistence fixtures may delete only an isolated test-container database.
export function authTestDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  const target = new URL(url);
  const local = target.hostname === "agent-testdb" && target.username === "agent_test" && target.password === "";
  const ci = process.env.CI === "true" && ["localhost", "127.0.0.1", "postgres"].includes(target.hostname)
    && target.username === "postgres" && target.password === "ci";
  if (!local && !ci) throw new Error("OAuth persistence tests require agent-testdb or the CI service container");
  return url;
}
