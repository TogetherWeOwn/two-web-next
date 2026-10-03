import postgres from "postgres";
import { createMemberDataFixture, testDatabaseUrl } from "./member-data-db";

/** Canonical, schema-owned migrations with an unmodified raw-SQL job pool. */
export async function createJobsFixture(raw: string, opts: { max?: number } = {}) {
  const url = testDatabaseUrl(raw); // Refuse before any driver construction.
  const fixture = await createMemberDataFixture(url.href);
  let client: postgres.Sql | undefined;
  try {
    // Drizzle installs transparent date serializers on its client. Jobs use
    // native postgres.js Date parameters, so they need their own raw pool.
    client = postgres(url.href, {
      max: opts.max ?? 1,
      port: 5432,
      connect_timeout: 5,
      password: () => url.password,
      connection: { search_path: fixture.schemaName },
      onnotice: () => {},
    });
    const rawClient = client;
    return {
      client: rawClient,
      schemaName: fixture.schemaName,
      async dispose() {
        try {
          await rawClient.end({ timeout: 1 });
        } finally {
          await fixture.dispose();
        }
      },
    };
  } catch (error) {
    try {
      await client?.end({ timeout: 1 });
    } finally {
      await fixture.dispose();
    }
    throw error;
  }
}

export type JobsFixture = Awaited<ReturnType<typeof createJobsFixture>>;
