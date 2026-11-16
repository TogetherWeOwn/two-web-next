import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as projection from "../web/scripts/projection-filesystem.mjs";

const io = vi.hoisted(() => ({
  lstat: vi.fn(),
  realpath: vi.fn(),
  mutate: vi.fn(() => {
    throw new Error("unexpected mutation");
  }),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  lstatSync: io.lstat,
  realpathSync: io.realpath,
  mkdirSync: io.mutate,
  writeFileSync: io.mutate,
  rmSync: io.mutate,
  renameSync: io.mutate,
  copyFileSync: io.mutate,
  unlinkSync: io.mutate,
}));

describe("pathname inspection capability boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Distinct names can refer to the same object through a mount alias.
    io.lstat.mockReturnValue({ dev: 1, ino: 7, isSymbolicLink: () => false });
    io.realpath.mockImplementation((path: string) => path);
  });

  it("reports distinct names for a modeled mount alias without granting approval", () => {
    expect(
      projection.inspectProjectionPaths("/work/output/mounted-source", ["/repo/source"]),
    ).toEqual({
      output: "/work/output/mounted-source",
      protectedPaths: ["/repo/source"],
    });
    expect(io.mutate).not.toHaveBeenCalled();
  });

  it("never mutates on validation or filesystem failures", () => {
    expect(() => projection.inspectProjectionPaths("/", ["/repo/source"])).toThrow();
    expect(() => projection.inspectProjectionPaths("/work/../output", ["/repo/source"])).toThrow();
    expect(() => projection.inspectProjectionPaths("/work/output", [])).toThrow();
    io.realpath.mockImplementation(() => {
      throw new Error("unreadable");
    });
    expect(() => projection.inspectProjectionPaths("/work/output", ["/repo/source"])).toThrow();
    expect(io.mutate).not.toHaveBeenCalled();
  });

  it("exports no cleanup assertion or mutation imports", () => {
    expect("assertSafeProjectionOutput" in projection).toBe(false);
    const declaration = readFileSync("web/scripts/projection-filesystem.d.mts", "utf8");
    const source = readFileSync("web/scripts/projection-filesystem.mjs", "utf8");
    expect(declaration).not.toContain("assertSafeProjectionOutput");
    expect(source).toMatch(/^import \{ lstatSync, realpathSync \} from "node:fs";/);
    expect(source).not.toMatch(/node:child_process|node:fs\/promises/);
  });
});
