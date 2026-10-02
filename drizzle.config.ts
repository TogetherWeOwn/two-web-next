import { defineConfig } from "drizzle-kit";

// Not typechecked by `npm run typecheck` (tsconfig covers src/ + test/); this
// is only read by the drizzle-kit CLI for `db:generate` / `db:migrate`.
export default defineConfig({
  schema: ["./src/db/schema.ts", "./src/db/admin-schema.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Local/CI: disposable Postgres only (see README). Live web migrations
    // use the separately gated db-migrate workflow, never Hyperdrive.
    url: process.env.DATABASE_URL!,
  },
});
