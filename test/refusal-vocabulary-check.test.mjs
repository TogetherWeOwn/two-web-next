// Offline refusal-vocabulary check: the real repo passes, and drift in either
// direction (code list vs documented table, capitalized error) fails by name.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { documentedCodes, evaluate } from "../ci/check-refusal-vocabulary.mjs";

const DOC = `# x\n\n## Write refusals\n\n| Code | Status |\n|---|---|\n| \`forbidden\` | 403 |\n| \`invalid\` | 422 |\n\n## Next\n\n| \`other\` | 1 |\n`;

describe("evaluate", () => {
  it("reads only the Write refusals table", () => {
    expect(documentedCodes(DOC)).toEqual(["forbidden", "invalid"]);
  });

  it("passes when code list and table agree", () => {
    expect(evaluate({ codes: ["forbidden", "invalid"], doc: DOC, sources: {} })).toEqual({
      ok: true,
      codes: ["forbidden", "invalid"],
      failures: [],
    });
  });

  it("fails an undocumented code and a documented-only code", () => {
    const r = evaluate({ codes: ["forbidden", "not_found"], doc: DOC, sources: {} });
    expect(r.ok).toBe(false);
    expect(r.failures).toContain("undocumented code: not_found");
    expect(r.failures).toContain("documented but not in REFUSAL_CODES: invalid");
  });

  it("fails a capitalized or spaced error literal with its location", () => {
    const sources = {
      "src/a.ts": 'x\nreturn c.json({ error: "Unauthorized", recovery }, 401);',
      "src/b.ts": 'return c.json({ error: "bad thing" });',
      "src/ok.ts": 'return c.json({ error: "forbidden" }, 403);',
    };
    const r = evaluate({ codes: ["forbidden", "invalid"], doc: DOC, sources });
    expect(r.failures).toEqual([
      'non-vocabulary error "Unauthorized" at src/a.ts:2',
      'non-vocabulary error "bad thing" at src/b.ts:1',
    ]);
  });

  it("fails capitalized errors in single-quote and template-literal form", () => {
    // Biome normalizes the single-quote spelling to double quotes but leaves
    // a template literal untouched, so the checker must catch all three.
    const sources = {
      "src/single.ts": "return c.json({ error: 'Unauthorized' }, 401);",
      "src/template.ts": "return c.json({ error: `Unauthorized` }, 401);",
      "src/ok.ts": "return c.json({ error: `forbidden` }, 403);",
    };
    const r = evaluate({ codes: ["forbidden", "invalid"], doc: DOC, sources });
    expect(r.failures).toEqual([
      'non-vocabulary error "Unauthorized" at src/single.ts:1',
      'non-vocabulary error "Unauthorized" at src/template.ts:1',
    ]);
  });

  it("fails a non-snake_case code", () => {
    const r = evaluate({ codes: ["Forbidden"], doc: DOC, sources: {} });
    expect(r.failures).toContain("code not snake_case: Forbidden");
  });

  it("the repo docs and sources pass (npm run check:refusals runs the same check)", async () => {
    const { REFUSAL_CODES } = await import("../src/json-refusal");
    const doc = readFileSync(new URL("../docs/machine-errors.md", import.meta.url), "utf8");
    const root = new URL("../src/", import.meta.url);
    const sources = {};
    for (const entry of readdirSync(root, { recursive: true })) {
      if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry)) {
        sources[`src/${entry}`] = readFileSync(new URL(entry, root), "utf8");
      }
    }
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(evaluate({ codes: REFUSAL_CODES, doc, sources }).failures).toEqual([]);
  });
});
