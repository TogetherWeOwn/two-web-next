import postgres from "postgres";
import { testDatabaseUrl } from "./member-data-db";

export function createImportFixtureClients(
  raw: string,
  legacySchema: string,
  targetSchema: string,
) {
  const safe = testDatabaseUrl(raw);
  if (safe.hostname === "agent-testdb" && safe.pathname !== "/two_web_next") {
    throw new Error("Importer fixtures require the two_web_next test database");
  }
  const options = { max: 1, port: 5432, password: () => safe.password, onnotice: () => {} };
  return {
    legacy: postgres(safe.href, {
      ...options,
      connection: { search_path: legacySchema, timezone: "Pacific/Honolulu" },
    }),
    target: postgres(safe.href, {
      ...options,
      connection: { search_path: targetSchema, timezone: "Asia/Tokyo" },
    }),
  };
}
