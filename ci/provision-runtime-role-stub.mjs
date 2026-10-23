// Ensures the NOLOGIN two_web_app stub exists so in-migration GRANTs (first:
// 1033 member_links) apply on fresh disposable databases. CI migrate steps
// and local `npm run db:migrate` runs call this first; live staging and
// production roles are operator-provisioned instead (docs/db-migrations.md
// "Runtime role bootstrap"). Refuses every non-disposable endpoint.
import postgres from "postgres";

const raw = process.env.DATABASE_URL ?? "";
let url = null;
try {
  url = new URL(raw);
} catch {
  url = null;
}
const disposableShape =
  url &&
  ["postgres:", "postgresql:"].includes(url.protocol) &&
  !url.search &&
  !url.hash &&
  (!url.port || url.port === "5432");
const agentTest =
  disposableShape &&
  url.hostname === "agent-testdb" &&
  url.username === "agent_test" &&
  url.password === "";
// ci.yml migrates as postgres/ci over the socat listener; e2e.yml migrates as
// the trust-auth agent_test superuser on 127.0.0.1. Both are CI-only shapes.
const ciService =
  disposableShape &&
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.CI === "true" &&
  ["localhost", "127.0.0.1"].includes(url.hostname) &&
  ((url.username === "postgres" && url.password === "ci") ||
    (url.username === "agent_test" && url.password === ""));
if (!url || (!agentTest && !ciService)) {
  console.error("Refusing: DATABASE_URL is not a disposable test database; value withheld.");
  process.exitCode = 1;
} else {
  const client = postgres(url.href, {
    port: 5432,
    max: 1,
    connect_timeout: 10,
    password: () => url.password,
    onnotice: () => {},
  });
  try {
    try {
      await client.unsafe(
        'CREATE ROLE "two_web_app" NOLOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION',
      );
      console.log("Runtime role stub created: two_web_app (NOLOGIN).");
    } catch (error) {
      if (error?.code !== "42710") throw error;
      console.log("Runtime role stub already present: two_web_app.");
    }
  } catch {
    // Never log driver errors: they can contain URLs, credentials, or SQL.
    console.error("Runtime role stub provisioning failed; details withheld.");
    process.exitCode = 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}
