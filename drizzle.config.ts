import { defineConfig } from "drizzle-kit";

// Not typechecked by `npm run typecheck` (tsconfig covers src/ + test/); this
// is only read by the drizzle-kit CLI for `db:generate` / `db:migrate`.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Local/dev: agent-testdb (see README). CI never migrates; staging/prod
    // get their connection strings at deploy time (Neon via Hyperdrive).
    url: process.env.DATABASE_URL!,
  },
});
