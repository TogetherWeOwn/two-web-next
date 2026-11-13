import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const owned: string[] = [];
const scripts = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts;
const generated = "src/leaf-critical-css.ts";
const eventsGenerated = "src/events-critical-css.ts";

function fixture() {
  const cwd = mkdtempSync(resolve(tmpdir(), "check-bootstrap-"));
  owned.push(cwd);
  for (const dir of ["ci", "src", "public", "test"]) mkdirSync(resolve(cwd, dir));
  for (const file of ["ci/build-leaf-css.mjs", "ci/build-events-css.mjs", "ci/test-unit.mjs"])
    cpSync(resolve(root, file), resolve(cwd, file));
  symlinkSync(resolve(root, "node_modules"), resolve(cwd, "node_modules"), "dir");
  writeFileSync(resolve(cwd, "package.json"), JSON.stringify({ type: "module", scripts }));
  for (const file of ["styles.css", "theme-tokens.css", "theme.css", "schedule-theme.css"])
    writeFileSync(resolve(cwd, "public", file), `/* ${file} */`);
  writeFileSync(
    resolve(cwd, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        types: [],
        module: "esnext",
        target: "es2022",
        moduleResolution: "bundler",
        strict: true,
      },
      include: ["src"],
    }),
  );
  writeFileSync(resolve(cwd, "ci/tsconfig.json"), JSON.stringify({ extends: "../tsconfig.json" }));
  writeFileSync(
    resolve(cwd, "src/consumer.ts"),
    'import { LEAF_CRITICAL_CSS, LEAF_CRITICAL_CSS_SHA256 } from "./leaf-critical-css";\nimport { EVENTS_CRITICAL_CSS, EVENTS_CRITICAL_CSS_SHA256 } from "./events-critical-css";\nexport const css: string = LEAF_CRITICAL_CSS + EVENTS_CRITICAL_CSS;\nexport const hash: string = LEAF_CRITICAL_CSS_SHA256 + EVENTS_CRITICAL_CSS_SHA256;\n',
  );
  writeFileSync(
    resolve(cwd, "vitest.config.ts"),
    'export default { test: { include: ["test/**/*.test.ts"] } };',
  );
  return cwd;
}

function npm(cwd: string, script: string, files: string[] = []) {
  const result = spawnSync("npm", ["--ignore-scripts", "run", script, "--", ...files], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  return { status: result.status, output: result.stdout + result.stderr };
}

afterEach(() => {
  for (const cwd of owned.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("fresh-checkout critical CSS bootstrap", () => {
  it("detects the historical missing-module defect without bootstrap", () => {
    const cwd = fixture();
    writeFileSync(
      resolve(cwd, "package.json"),
      JSON.stringify({
        type: "module",
        scripts: { typecheck: "tsc --noEmit && tsc --noEmit -p ci/tsconfig.json" },
      }),
    );
    const result = npm(cwd, "typecheck");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("TS2307");
    expect(existsSync(resolve(cwd, generated))).toBe(false);
  });

  it("typechecks real generated exports without install hooks, app output or caches", () => {
    const cwd = fixture();
    expect(existsSync(resolve(cwd, generated))).toBe(false);
    expect(existsSync(resolve(cwd, "dist"))).toBe(false);
    expect(npm(cwd, "typecheck")).toMatchObject({ status: 0 });
    expect(readFileSync(resolve(cwd, generated), "utf8")).toContain(
      "export const LEAF_CRITICAL_CSS: string",
    );
    expect(readFileSync(resolve(cwd, eventsGenerated), "utf8")).toContain(
      "export const EVENTS_CRITICAL_CSS: string",
    );
  });

  it("replaces an ignored stale artifact rather than trusting it", () => {
    const cwd = fixture();
    writeFileSync(resolve(cwd, generated), "this is not valid TypeScript");
    expect(npm(cwd, "typecheck").status).toBe(0);
    expect(readFileSync(resolve(cwd, generated), "utf8")).not.toContain("this is not valid");
  });

  it("fails closed on unsafe CSS even if an old generated artifact exists", () => {
    const cwd = fixture();
    expect(npm(cwd, "typecheck").status).toBe(0);
    writeFileSync(resolve(cwd, "public/theme.css"), "</STYLE><script>not allowed</script>");
    const result = npm(cwd, "typecheck");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("refusing to inline CSS");
  });

  it("fails closed on unsafe schedule CSS despite a stale events artifact", () => {
    const cwd = fixture();
    expect(npm(cwd, "typecheck").status).toBe(0);
    writeFileSync(
      resolve(cwd, "public/schedule-theme.css"),
      "</STYLE><script>not allowed</script>",
    );
    const result = npm(cwd, "typecheck");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("refusing to inline CSS");
  });

  it("does not hide invalid generator exports behind a declaration", () => {
    const cwd = fixture();
    const generator = resolve(cwd, "ci/build-leaf-css.mjs");
    writeFileSync(
      generator,
      readFileSync(generator, "utf8").replaceAll("LEAF_CRITICAL_CSS_SHA256", "WRONG_EXPORT"),
    );
    const result = npm(cwd, "typecheck");
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/has no exported member(?: named)? 'LEAF_CRITICAL_CSS_SHA256'/);
  });
});

describe("bounded unit-test selection", () => {
  it.each([
    { files: [] },
    { files: ["test"] },
    { files: ["test/*.test.ts"] },
    { files: ["--passWithNoTests"] },
    { files: ["test/missing.test.ts"] },
    { files: ["test/../src/consumer.test.ts"] },
  ])("rejects absent or invalid selection $files before generating anything", ({ files }) => {
    const cwd = fixture();
    expect(npm(cwd, "test:unit", files).status).not.toBe(0);
    expect(existsSync(resolve(cwd, generated))).toBe(false);
  });

  it("generates CSS and runs only exact selected files, not substring matches", () => {
    const cwd = fixture();
    writeFileSync(
      resolve(cwd, "test/chosen.test.ts"),
      'import { it, expect } from "vitest"; import { LEAF_CRITICAL_CSS } from "../src/leaf-critical-css"; import { EVENTS_CRITICAL_CSS } from "../src/events-critical-css"; it("chosen", () => { expect(LEAF_CRITICAL_CSS).toContain("styles.css"); expect(EVENTS_CRITICAL_CSS).toContain("schedule-theme.css"); });',
    );
    writeFileSync(
      resolve(cwd, "test/chosen.test.ts.extra.test.ts"),
      'throw new Error("unselected file ran");',
    );
    const result = npm(cwd, "test:unit", ["test/chosen.test.ts"]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("1 passed");
    expect(result.output).not.toContain("unselected file ran");
  });

  it("propagates a selected test failure", () => {
    const cwd = fixture();
    writeFileSync(
      resolve(cwd, "test/failing.test.ts"),
      'import { it, expect } from "vitest"; it("failure control", () => expect(1).toBe(2));',
    );
    const result = npm(cwd, "test:unit", ["test/failing.test.ts"]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("failure control");
  });
});
