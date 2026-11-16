import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as projection from "../web/scripts/projection-filesystem.mjs";

const { containsPath, inspectProjectionPaths } = projection;
const fixtures: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "projection-paths-"));
  fixtures.push(root);
  mkdirSync(join(root, "source"));
  writeFileSync(join(root, "source", "style.css"), "keep");
  return root;
}
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("projection pathname inspection", () => {
  it("compares roots and path component boundaries", () => {
    expect(containsPath(parse(process.cwd()).root, process.cwd())).toBe(true);
    expect(containsPath("/source", "/source-other")).toBe(false);
    expect(containsPath("/source", "/source/file")).toBe(true);
  });

  it("reports pathname facts even for overlapping paths, not permission to mutate", () => {
    const root = fixture();
    const source = realpathSync(join(root, "source"));
    const style = join(source, "style.css");
    expect(inspectProjectionPaths(join(root, "source", "new"), [source, style])).toEqual({
      output: join(source, "new"),
      protectedPaths: [source, style],
    });
    expect(() => inspectProjectionPaths(parse(root).root, [source])).toThrow("root output refused");
    expect(() => inspectProjectionPaths(join(root, "output"), [])).toThrow();
    expect(readFileSync(style, "utf8")).toBe("keep");
    expect("assertSafeProjectionOutput" in projection).toBe(false);
  });

  it("resolves symlinks and refuses dangling paths", () => {
    const root = fixture();
    const source = join(root, "source");
    symlinkSync(source, join(root, "alias"));
    symlinkSync(join(root, "missing"), join(root, "dangling"));
    expect(inspectProjectionPaths(join(root, "alias", "new"), [source]).output).toBe(
      join(realpathSync(source), "new"),
    );
    expect(() => inspectProjectionPaths(join(root, "output"), [join(root, "dangling")])).toThrow();
    expect(() => inspectProjectionPaths(join(root, "dangling"), [source])).toThrow();
  });

  it("rejects parent components before normalizing symlink paths", () => {
    const root = fixture();
    const source = join(root, "source");
    mkdirSync(join(source, "nested"));
    symlinkSync(join(source, "nested"), join(root, "alias"));
    const ambiguous = `${root}/alias/../style.css`;
    expect(() => inspectProjectionPaths(ambiguous, [source])).toThrow(
      "parent path component refused",
    );
    expect(() => inspectProjectionPaths(join(root, "output"), [ambiguous])).toThrow(
      "parent path component refused",
    );
    expect(readFileSync(join(source, "style.css"), "utf8")).toBe("keep");
  });

  it("preserves missing POSIX components including backslashes", () => {
    const root = fixture();
    const source = join(root, "source");
    expect(inspectProjectionPaths(join(source, "\\..", "generated"), [source]).output).toBe(
      join(realpathSync(source), "\\..", "generated"),
    );
    expect(readFileSync(join(source, "style.css"), "utf8")).toBe("keep");
  });
});
