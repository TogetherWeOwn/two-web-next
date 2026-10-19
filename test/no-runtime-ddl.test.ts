// The runtime database role holds read/write only: no schema CREATE, so no
// production code path may run DDL. The helpers below exist as fixture-only
// bootstrap for disposable test schemas; the canonical DDL lives in
// drizzle/ and is applied by the migrate workflow. This scan keeps it that
// way: after removing comments, no src/ module outside the definition sites
// may name a bootstrap helper or carry a DDL statement.
//
// Scope is src/ because that is what ships in the Worker bundle. Test,
// fixture, e2e and ci code may call the helpers against disposable schemas.
// Only full-line `//` comments and `/* */` blocks are removed: an inline
// trailing comment that names a helper fails the scan on purpose, so the
// author rewords it instead of the scan learning to skip code.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const SRC = "src";

// Module that defines each bootstrap helper, plus the one barrel that
// re-exports a helper. Every other src/ module must not name them.
const DEFINITION_SITES: Record<string, string[]> = {
  "src/sessions.ts": ["migrate", "migrateOAuthJourneys"],
  "src/oauth-journeys.ts": ["migrateOAuthJourneys"],
  "src/join/service.ts": ["migrateJoin"],
  "src/db/roster.ts": ["migrateRoster"],
  "src/admin/store-access.ts": ["ensureAccessLogGin"],
  "src/admin/store.ts": ["ensureAccessLogGin"],
};

// Files allowed to carry DDL text: the fixture-only bootstrap definitions.
const DDL_SITES = new Set([
  "src/sessions.ts",
  "src/oauth-journeys.ts",
  "src/join/service.ts",
  "src/db/roster.ts",
  "src/admin/store-access.ts",
]);

const HELPER_PATTERN =
  /\b(migrate|migrateJoin|migrateRoster|migrateOAuthJourneys|ensureAccessLogGin)\b/;
const DDL_PATTERN = /\b(create\s+table|alter\s+table|create\s+(unique\s+)?index)\b/i;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(new URL(dir, root), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(`${rel}/`));
    else if (entry.name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

function codeOnly(text: string): string {
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlocks
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

describe("no runtime DDL in the Worker bundle", () => {
  it("no src/ module outside the definition sites names a bootstrap helper", () => {
    const violations: string[] = [];
    for (const file of walk(`${SRC}/`)) {
      const expected = DEFINITION_SITES[file] ?? [];
      const lines = codeOnly(readFileSync(new URL(file, root), "utf8")).split("\n");
      lines.forEach((line, index) => {
        const match = HELPER_PATTERN.exec(line);
        const name = match?.[1];
        if (name && !expected.includes(name)) {
          violations.push(`${file}:${index + 1}: ${name} (${line.trim().slice(0, 100)})`);
        }
      });
    }
    expect(violations, "production modules must not call DDL bootstrap helpers").toEqual([]);
  });

  it("no src/ module outside the bootstrap definitions carries DDL text", () => {
    const violations: string[] = [];
    for (const file of walk(`${SRC}/`)) {
      if (DDL_SITES.has(file)) continue;
      const lines = codeOnly(readFileSync(new URL(file, root), "utf8")).split("\n");
      lines.forEach((line, index) => {
        if (DDL_PATTERN.test(line)) {
          violations.push(`${file}:${index + 1} (${line.trim().slice(0, 100)})`);
        }
      });
    }
    expect(violations, "DDL statements live in drizzle/ migrations, not in src/").toEqual([]);
  });

  it("each definition site still defines its helper (allowlist cannot drift silent)", () => {
    for (const [file, helpers] of Object.entries(DEFINITION_SITES)) {
      const code = codeOnly(readFileSync(new URL(file, root), "utf8"));
      for (const helper of helpers) {
        const defined =
          helper === "migrate"
            ? /export async function migrate\(/.test(code)
            : code.includes(`export async function ${helper}(`) ||
              code.includes(`export { ${helper},`) ||
              code.includes(`${helper},`);
        expect(defined, `${file} must still define ${helper}`).toBe(true);
      }
    }
  });
});
