import { readdirSync } from "node:fs";

// Canonical Drizzle declarations live directly in src/db, not nested fixtures.
export function schemaFiles(dbDir) {
  const entries = readdirSync(dbDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /^(?:schema|.+-schema)\.ts$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const required of ["schema.ts", "admin-schema.ts"]) {
    if (!files.includes(required)) throw new Error(`Missing canonical schema: ${required}`);
  }
  return ["schema.ts", ...files.filter((file) => file !== "schema.ts")];
}
