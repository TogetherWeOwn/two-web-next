import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertProductionIdentity,
  migrationClient,
  migrationConnectionConfig,
} from "./db-migrate.mjs";

export async function checkProductionIdentity(env, connect = migrationClient) {
  try {
    const config = migrationConnectionConfig(env, "production", env.PRODUCTION_DB_IDENTITY_SHA256);
    const client = connect(config, { readOnly: true });
    try {
      await client.begin("read only", (transaction) =>
        assertProductionIdentity(transaction, config),
      );
    } finally {
      await client.end({ timeout: 5 });
    }
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = (await checkProductionIdentity(process.env)) ? 0 : 1;
}
