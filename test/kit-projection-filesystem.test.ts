import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeProjectionOutput, containsPath } from "../web/scripts/projection-filesystem.mjs";

const fixtures: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "projection-safety-"));
  fixtures.push(root);
  mkdirSync(join(root, "source"));
  writeFileSync(join(root, "source", "style.css"), "keep");
  return root;
}
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("projection filesystem safety", () => {
  it("handles root containment and path component boundaries", () => {
    const root = parse(process.cwd()).root;
    expect(containsPath(root, process.cwd())).toBe(true);
    expect(containsPath("/source", "/source-other")).toBe(false);
    expect(containsPath("/source", "/source/file")).toBe(true);
  });

  it("refuses root and overlap in both directions without modifying sources", () => {
    const root = fixture();
    const source = join(root, "source");
    const style = join(source, "style.css");
    for (const output of [parse(root).root, root, source, join(source, "new")]) {
      expect(() => assertSafeProjectionOutput(output, [source, style])).toThrow();
    }
    expect(readFileSync(style, "utf8")).toBe("keep");
    expect(() => assertSafeProjectionOutput(join(root, "output"), [source, style])).not.toThrow();
    expect(() => assertSafeProjectionOutput(join(root, "output"), [])).toThrow();
  });

  it("resolves aliases physically and fails closed on dangling protected links", () => {
    const root = fixture();
    const source = join(root, "source");
    symlinkSync(source, join(root, "alias"));
    symlinkSync(join(root, "missing"), join(root, "dangling"));
    expect(() => assertSafeProjectionOutput(join(root, "alias", "new"), [source])).toThrow();
    expect(() =>
      assertSafeProjectionOutput(join(root, "output"), [join(root, "dangling")]),
    ).toThrow();
    expect(() => assertSafeProjectionOutput(join(root, "dangling"), [source])).toThrow();
  });

  it("rejects parent components before normalizing symlink paths", () => {
    const root = fixture();
    const source = join(root, "source");
    const nested = join(source, "nested");
    mkdirSync(nested);
    symlinkSync(nested, join(root, "alias"));
    const ambiguous = `${root}/alias/../style.css`;
    expect(() => assertSafeProjectionOutput(ambiguous, [source])).toThrow(
      "parent path component refused",
    );
    expect(() => assertSafeProjectionOutput(join(root, "output"), [ambiguous])).toThrow(
      "parent path component refused",
    );
    expect(readFileSync(join(source, "style.css"), "utf8")).toBe("keep");
  });

  it("preserves backslashes in missing POSIX path components", () => {
    const root = fixture();
    const source = join(root, "source");
    const output = join(source, "\\..", "generated");
    expect(() => assertSafeProjectionOutput(output, [source])).toThrow(
      "output overlaps protected path",
    );
    expect(readFileSync(join(source, "style.css"), "utf8")).toBe("keep");
  });

  it("permits fixture cleanup only after a successful safety check", () => {
    const root = fixture();
    const source = join(root, "source");
    const output = join(root, "output");
    mkdirSync(output);
    const clean = (target: string) => {
      assertSafeProjectionOutput(target, [source]);
      rmSync(target, { recursive: true });
    };
    expect(() => clean(root)).toThrow();
    expect(readFileSync(join(source, "style.css"), "utf8")).toBe("keep");
    expect(() => clean(output)).not.toThrow();
  });

  it("rejects unsafe output entries without opening them or cleaning up", () => {
    const root = fixture();
    const source = join(root, "source");
    const output = join(root, "output");
    mkdirSync(output);
    writeFileSync(join(output, "keep"), "sentinel");
    mkdirSync(join(output, "nested"));
    expect(() => assertSafeProjectionOutput(output, [source])).not.toThrow();
    symlinkSync(source, join(output, "nested", "link"));
    expect(() => assertSafeProjectionOutput(output, [source])).toThrow();
    rmSync(join(output, "nested", "link"));
    linkSync(join(source, "style.css"), join(output, "nested", "hardlink"));
    expect(() => assertSafeProjectionOutput(output, [source])).toThrow();
    rmSync(join(output, "nested", "hardlink"));
    execFileSync("mkfifo", [join(output, "nested", "pipe")]);
    expect(() => assertSafeProjectionOutput(output, [source])).toThrow();
    expect(readFileSync(join(output, "keep"), "utf8")).toBe("sentinel");
  });
});
