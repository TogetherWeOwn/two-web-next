import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "schedule-css-test-"));
  scratch.push(dir);
  for (const sub of ["ci", "public", "src"]) mkdirSync(join(dir, sub));
  const generator = join(dir, "ci/build-leaf-css.mjs");
  writeFileSync(generator, readFileSync(join(root, "ci/build-leaf-css.mjs")));
  const sources = ["styles.css", "theme-tokens.css", "theme.css", "schedule-theme.css"];
  const css = [
    "body{color:black}",
    ":root{--brand:orange}",
    ".hero{display:grid}",
    '.schedule-theme::before{content:"é 🧡"}\n',
  ];
  sources.forEach((name, index) => writeFileSync(join(dir, "public", name), css[index]!));
  const output = join(dir, "src/leaf-critical-css.ts");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [generator, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
      timeout: 10000,
    });
  return { dir, generator, sources, css, output, run };
}

function literal(module: string, name: string): string {
  const match = new RegExp(`export const ${name}: string =\\s*("(?:[^"\\\\]|\\\\.)*");`).exec(
    module,
  );
  if (!match) throw new Error(`missing literal ${name}`);
  return JSON.parse(match[1]!);
}

const hash = (css: string) => createHash("sha256").update(css, "utf8").digest("base64");

describe("schedule CSS generated-byte lifecycle", () => {
  it("emits exact L and S once with independent hashes and deterministic output", () => {
    const { css, output, run } = fixture();
    expect(run().status).toBe(0);
    const module = readFileSync(output, "utf8");
    const l = css.slice(0, 3).join("\n");
    expect(literal(module, "LEAF_CRITICAL_CSS")).toBe(l);
    expect(literal(module, "SCHEDULE_CRITICAL_CSS")).toBe(css[3]);
    expect(literal(module, "LEAF_CRITICAL_CSS_SHA256")).toBe(hash(l));
    expect(literal(module, "SCHEDULE_CRITICAL_CSS_SHA256")).toBe(hash(css[3]!));
    expect(module.split(JSON.stringify(l))).toHaveLength(2);
    expect(run().status).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(module);
    expect(run("--check").status).toBe(0);
  });

  it.each([
    "LEAF_CRITICAL_CSS",
    "LEAF_CRITICAL_CSS_SHA256",
    "SCHEDULE_CRITICAL_CSS",
    "SCHEDULE_CRITICAL_CSS_SHA256",
  ])("rejects stale %s without repairing the artifact", (name) => {
    const { output, run } = fixture();
    expect(run().status).toBe(0);
    const module = readFileSync(output, "utf8");
    const stale = module.replace(JSON.stringify(literal(module, name)), JSON.stringify("stale"));
    writeFileSync(output, stale);
    expect(run("--check").status).not.toBe(0);
    expect(readFileSync(output, "utf8")).toBe(stale);
  });

  it.each([
    Buffer.from("</StYlE><script>breakout</script>"),
    Buffer.from("body{color:red}\0"),
    Buffer.from([0xc3, 0x28]),
    Buffer.from("body{color:red}\r\n"),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("body{color:red}")]),
  ])("refuses unsafe input before replacing either literal or hash: %j", (bytes) => {
    const { dir, sources, output, run } = fixture();
    expect(run().status).toBe(0);
    const original = readFileSync(output);
    for (const source of sources) {
      const path = join(dir, "public", source);
      const previous = readFileSync(path);
      writeFileSync(path, bytes);
      expect(run().status).not.toBe(0);
      expect(run("--check").status).not.toBe(0);
      expect(readFileSync(output).equals(original)).toBe(true);
      expect(readdirSync(join(dir, "src"))).toEqual(["leaf-critical-css.ts"]);
      writeFileSync(path, previous);
    }
  });

  it("does not generate on import and fails check for missing output", () => {
    const { dir, generator, output, run } = fixture();
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", "await import(process.argv[2])", "import-only", generator],
      {
        cwd: dir,
        encoding: "utf8",
        env: { PATH: process.env.PATH },
        timeout: 10000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(join(dir, "src"))).toEqual([]);
    expect(run("--check").status).not.toBe(0);
    expect(run().status).toBe(0);
    expect(readFileSync(output, "utf8")).toContain("SCHEDULE_CRITICAL_CSS");
  });
});
