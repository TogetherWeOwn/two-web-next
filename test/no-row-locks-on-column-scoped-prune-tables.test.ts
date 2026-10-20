import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "@babel/parser";
import { traverseFast, type Node } from "@babel/types";

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
    return entry.isFile() && /\.(?:[cm]?[jt]sx?|sql)$/.test(path) ? [path] : [];
  });
}

function sqlRowLocks(sql: string): string[] {
  // Mask data and comments before statement splitting. Quoted identifiers
  // remain visible; a semicolon in a SQL string is not a query boundary.
  const code = sql.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
  return code.split(";").flatMap((statement) => {
    const readsScopedTable = tables.some((table) =>
      new RegExp(
        `\\b(?:from|join)\\s+(?:(?:"[^"]+"|[a-z_][\\w$]*)\\s*\\.\\s*)?"?${table}"?(?![\\w$])`,
        "i",
      ).test(statement),
    );
    return readsScopedTable
      ? Array.from(
          statement.matchAll(/\bfor\s+(?:update|no\s+key\s+update|share|key\s+share)\b/gi),
          (m) => m[0],
        )
      : [];
  });
}

function findRowLocks(source: string, filename = "fixture.ts"): string[] {
  if (filename.endsWith(".sql")) return sqlRowLocks(source);
  // Babel is already in the locked dev toolchain; TS 7 no longer ships the
  // old compiler parser API. Parsing also avoids treating JS comments as SQL.
  const tree = parse(source, {
    sourceType: "unambiguous",
    plugins: /\.[jt]sx$/.test(filename) ? ["typescript", "jsx"] : ["typescript"],
  });
  const offenders: string[] = [];
  const names = new Map(schemaSymbols.map((name, i) => [name, tables[i]!]));
  const bindings = new Map<string, Node>();
  traverseFast(tree, (node) => {
    if (node.type === "ImportSpecifier") {
      const original =
        node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
      if (names.has(original)) names.set(node.local.name, names.get(original)!);
    }
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init) {
      bindings.set(node.id.name, node.init);
    }
  });
  const property = (node: Node): string | undefined => {
    if (node.type === "Identifier") return node.name;
    if (node.type === "StringLiteral") return node.value;
    return undefined;
  };
  const tableName = (node: Node | undefined): string | undefined => {
    if (!node) return undefined;
    if (node.type === "Identifier") return names.get(node.name);
    if (node.type === "MemberExpression") return names.get(property(node.property) ?? "");
    return undefined;
  };
  const readsScopedTable = (node: Node, seen = new Set<Node>()): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    if (node.type === "Identifier") {
      const bound = bindings.get(node.name);
      return bound ? readsScopedTable(bound, seen) : false;
    }
    if (node.type === "AwaitExpression") return readsScopedTable(node.argument, seen);
    if (node.type === "TSAsExpression" || node.type === "ParenthesizedExpression") {
      return readsScopedTable(node.expression, seen);
    }
    if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return false;
    const method = property(node.callee.property) ?? "";
    if (
      /^(?:from|(?:inner|left|right|full|cross)?Join)$/.test(method) &&
      tableName(node.arguments[0])
    )
      return true;
    return readsScopedTable(node.callee.object, seen);
  };
  traverseFast(tree, (node) => {
    if (node.type === "StringLiteral") {
      offenders.push(...sqlRowLocks(node.value));
    } else if (node.type === "TemplateLiteral") {
      const sql = node.quasis
        .map(
          (part, i) =>
            `${part.value.cooked ?? part.value.raw} ${tableName(node.expressions[i]) ?? "__parameter__"} `,
        )
        .join("");
      offenders.push(...sqlRowLocks(sql));
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      property(node.callee.property) === "for" &&
      readsScopedTable(node.callee.object)
    ) {
      offenders.push(source.slice(node.start!, node.end!));
    }
  });
  return offenders;
}

// Planted regressions test the guard itself, not just today's green tree.
// In particular no fixed character window may hide a long/multiline query.
describe("scoped row-lock guard sensitivity", () => {
  it("includes TSX routes as well as TS modules in the real source inventory", () => {
    const paths = sourceFiles(join(root, "src"));
    expect(paths).toContain(join(root, "src", "pages.tsx"));
    expect(paths).toContain(join(root, "src", "jobs", "postgres.ts"));
  });
  for (const table of tables) {
    for (const clause of ["FOR UPDATE", "FOR NO KEY UPDATE", "FOR SHARE", "FOR KEY SHARE"]) {
      it(`catches ${clause} on ${table} beyond the old SQL window`, () => {
        const query = `select id from "fixture"."${table}"\nwhere ${"true and ".repeat(150)} true\n${clause} skip locked`;
        expect(findRowLocks(`const rows = await sql\`${query}\`;`)).toHaveLength(1);
      });
    }
  }
  it("catches scoped JOINs, SQL comments between keywords and interpolated predicates", () => {
    expect(
      findRowLocks(
        "sql`select h.id from web_sessions s join agent_event_hits h on true where h.id = ${id} for /* row */ no key update`",
      ),
    ).toHaveLength(1);
  });
  it("catches multiline SQL passed as a normal string to unsafe", () => {
    expect(findRowLocks('sql.unsafe("SELECT id FROM agent_event_hits\\nFOR SHARE")')).toHaveLength(
      1,
    );
  });
  for (const symbol of schemaSymbols) {
    it(`catches Drizzle options and whitespace on ${symbol}`, () => {
      expect(
        findRowLocks(
          `db.select().from ( ${symbol} ).where(pred).for ("update", { skipLocked: true });`,
        ),
      ).toHaveLength(1);
    });
  }
  it("catches a scoped Drizzle join without overmatching the neighboring query", () => {
    expect(
      findRowLocks(
        'const scoped = db.select().from(agentEventHits); const allowed = db.select().from(webSessions).for("update");',
      ),
    ).toEqual([]);
    expect(
      findRowLocks(
        'db.select().from(webSessions).innerJoin(agentEventHits, pred).for("key share", { noWait: true });',
      ),
    ).toHaveLength(1);
  });
  it("catches scoped SQL and aliased/bound Drizzle regressions inside a TSX route", () => {
    expect(
      findRowLocks(
        `
      import { agentEventHits as hits } from './schema';
      const q = db.select().from(hits);
      q.for('share', { skipLocked: true });
      const page = <p>Fixture</p>;
      await sql\`select id from agent_event_hits where id = \${id} for\nkey\nshare\`;
    `,
        "src/fixture.tsx",
      ),
    ).toHaveLength(2);
    expect(findRowLocks("sql`select id from ${schema.agentEventHits} for update`")).toHaveLength(1);
  });
  it("allows non-scope locks and ignores comments and string data", () => {
    expect(
      findRowLocks(`
      // SELECT id FROM agent_event_hits FOR UPDATE
      const url = "https://example.test";
      sql\`select id from agent_event_hits where bucket = 'FOR SHARE'\`;
      sql\`select id from agent_event_hits /* FOR UPDATE */\`;
      sql\`select id from agent_event_hits; select id from join_attempts for update skip locked\`;
      db.select().from(webSessions).for("update");
      sql\`select key from job_unique_locks for no key update skip locked\`;
    `),
    ).toEqual([]);
  });
});

describe("column-scoped prune tables", () => {
  it("never applies explicit row locks to any of the six scoped tables under src", () => {
    const offenders = sourceFiles(join(root, "src")).flatMap((file) =>
      findRowLocks(readFileSync(file, "utf8"), file).map((lock) => `${file}: ${lock}`),
    );
    expect(offenders, `row-lock clauses on scoped tables: ${offenders.join(", ")}`).toEqual([]);
  });
});
