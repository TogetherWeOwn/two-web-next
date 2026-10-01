// Test-only entry: never referenced by the deployment config.
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { auditDatabaseOptions, auditDatabaseUrl } from "./a11y-policy.mjs";
import { auditFixtureState, auditReadDatabase } from "./a11y-read-models";
import app from "../src/index";
import { maintenanceHandler, notFoundHandler, rateLimitExceeded } from "../src/errors";
import { adminSchema, schema } from "../src/db/index";
import type { Env } from "../src/env";
import { createPostgresSessionStore, type Sql } from "../src/sessions";

app.get("/__a11y/404", notFoundHandler);
app.get("/__a11y/429", (c) => rateLimitExceeded(c));
app.get("/__a11y/500", () => { throw new Error("Synthetic audit error"); });
app.get("/__a11y/503", maintenanceHandler("/discord"));
export const routes = app.routes.map(({ method, path }) => ({ method, path }));
export { coverage } from "./a11y-cases.mjs";

export default {
  async fetch(request: Request, env: Env & { A11Y_DATABASE_URL: string; A11Y_SCHEMA: string; A11Y_CI: string }, ctx: ExecutionContext) {
    globalThis.fetch = async () => { throw new Error("Outbound HTTP is disabled in the local audit worker"); };
    if (!/^w15_[a-f0-9]{32}$/.test(env.A11Y_SCHEMA)) throw new Error("Invalid isolated fixture schema");
    const readState = auditFixtureState(request.headers.get("x-a11y-read-state"));
    const url = auditDatabaseUrl(env.A11Y_DATABASE_URL, env.A11Y_CI === "true");
    const options = auditDatabaseOptions(url, env.A11Y_SCHEMA);
    const client = postgres(url.href, options);
    const sessionClient = postgres(url.href, options);
    try {
      const bindings = {
        ...env,
        A11Y_READ_STATE: readState,
        ADMIN_DB: auditReadDatabase(drizzle(client, { schema: { ...schema, ...adminSchema } }), readState),
        SESSION_STORE: createPostgresSessionStore(sessionClient as unknown as Sql),
        DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
      };
      return await app.fetch(request, bindings, ctx);
    } finally { await Promise.all([client.end(), sessionClient.end()]); }
  },
};
