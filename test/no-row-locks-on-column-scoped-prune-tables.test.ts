import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const tables = [
  "agent_event_idempotency_keys",
  "agent_event_audits",
  "agent_event_hits",
  "member_data_access_logs",
  "event_search_logs",
  "board_view_logs",
];
const schemaSymbols = [
  "agentEventIdempotencyKeys",
  "agentEventAudits",
  "agentEventHits",
  "memberDataAccessLogs",
  "eventSearchLogs",
  "boardViewLogs",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

describe("column-scoped prune tables", () => {
  it("never applies explicit row locks to tables pruned with SELECT and DELETE rights", () => {
    const offenders: string[] = [];
    const lockClause = /\bFOR\s+(?:UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/gi;
    for (const file of sourceFiles(join(root, "src"))) {
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ");
      for (const match of source.matchAll(lockClause)) {
        const beforeLock = source.slice(Math.max(0, match.index! - 600), match.index);
        const statement = beforeLock.slice(
          Math.max(beforeLock.lastIndexOf(";"), beforeLock.lastIndexOf("`")) + 1,
        );
        if (
          tables.some((table) =>
            new RegExp(`(?:\\bFROM\\s+|\\.from\\(\\s*)\\"?${table}\\"?\\b`, "i").test(statement),
          )
        ) {
          offenders.push(`${file}: ${match[0]}`);
        }
      }
      const drizzleLock = /\.for\(\s*["'](?:update|no key update|share|key share)["']\s*\)/gi;
      for (const match of source.matchAll(drizzleLock)) {
        const beforeLock = source.slice(0, match.index);
        const statement = beforeLock.slice(beforeLock.lastIndexOf(";") + 1);
        if (
          schemaSymbols.some((symbol) =>
            new RegExp(`\\.(?:from|(?:inner|left|right|full|cross)?Join)\\(\\s*${symbol}\\b`).test(
              statement,
            ),
          )
        ) {
          offenders.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(offenders, `row-lock clauses on prune-only tables: ${offenders.join(", ")}`).toEqual([]);
  });
});
