// No console.* call under src/ logs a `user` or `userId` key: the published
// privacy text says logs hold no Discord IDs, so warning lines carry request_id
// instead. Raw-text scan: typescript@7 exposes only typescript/unstable/*, so
// there is no stable compiler API to parse with.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

function srcFiles(dir = "src/"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${dir}${entry.name}`;
    if (entry.isDirectory()) out.push(...srcFiles(`${rel}/`));
    else if (entry.isFile() && (rel.endsWith(".ts") || rel.endsWith(".tsx"))) out.push(rel);
  }
  return out.sort();
}

const CONSOLE_CALL = /console\.(?:log|info|warn|error|debug|trace)\s*\(/g;
const LOGGED_USER_KEY = /[{,]\s*["']?(?:user|userId)["']?\s*(?::|(?=[,}]))/;

/** Text from the opening paren through its matching close, skipping strings and comments. */
function argumentText(source: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const eol = source.indexOf("\n", i);
      if (eol < 0) break;
      i = eol;
    } else if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 1;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

function consoleCalls(source: string): { line: number; args: string }[] {
  return [...source.matchAll(CONSOLE_CALL)].map((m) => ({
    line: source.slice(0, m.index).split("\n").length,
    args: argumentText(source, m.index + m[0].length - 1),
  }));
}

describe("console calls under src/ never log a user key", () => {
  it("scans the console calls the guard is meant to cover", () => {
    const total = srcFiles().reduce((n, file) => n + consoleCalls(read(file)).length, 0);
    expect(total).toBeGreaterThan(40);
  });

  it("no console call logs a user or userId key", () => {
    const hits = srcFiles().flatMap((file) =>
      consoleCalls(read(file))
        .filter((call) => LOGGED_USER_KEY.test(call.args))
        .map((call) => `${file}:${call.line}`),
    );
    expect(hits).toEqual([]);
  });

  it("the key matcher flags the shapes it guards and passes request_id", () => {
    expect(LOGGED_USER_KEY.test(`("x", { user: row.userId })`)).toBe(true);
    expect(LOGGED_USER_KEY.test(`("x", {\n  userId: id,\n})`)).toBe(true);
    expect(LOGGED_USER_KEY.test(`("x", { user })`)).toBe(true);
    expect(LOGGED_USER_KEY.test(`("x", { request_id: id, member: user.id })`)).toBe(false);
  });
});
