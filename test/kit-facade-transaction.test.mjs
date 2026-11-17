import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { installFacadeFiles } from "../web/scripts/kit-facade-transaction.mjs";

const dirs = [];
function fixture(previous = null) {
  const dir = fs.mkdtempSync(join(tmpdir(), "facade-transaction-"));
  dirs.push(dir);
  const paths = {
    entry: join(dir, "_worker.js"),
    companion: join(dir, "kit-adapter.js"),
    staged: join(dir, "_worker.js.facade.tmp"),
    ignoreFile: join(dir, ".assetsignore"),
  };
  fs.writeFileSync(paths.entry, "adapter");
  if (previous !== null) fs.writeFileSync(paths.ignoreFile, previous);
  return { ...paths, previous, prepare: async () => "facade" };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it("installs both files and appends the ignore entry without changing prior bytes", async () => {
  const previous = Buffer.from([0xff, 0xfe, 10]);
  const args = fixture(previous);
  expect(await installFacadeFiles(args)).toBe("facade");
  expect(fs.readFileSync(args.entry, "utf8")).toBe("facade");
  expect(fs.readFileSync(args.companion, "utf8")).toBe("adapter");
  expect(fs.readFileSync(args.ignoreFile)).toEqual(
    Buffer.concat([previous, Buffer.from("kit-adapter.js\n")]),
  );
});

it("leaves an existing companion ignore entry unchanged", async () => {
  const previous = Buffer.from("_worker.js\r\nkit-adapter.js\r\n");
  const args = fixture(previous);
  await installFacadeFiles(args);
  expect(fs.readFileSync(args.ignoreFile)).toEqual(previous);
});

it("removes the owned staged file when preparation fails", async () => {
  const args = fixture();
  args.prepare = async () => {
    throw new Error("preparation failed");
  };
  await expect(installFacadeFiles(args)).rejects.toThrow("preparation failed");
  expect(fs.existsSync(args.staged)).toBe(false);
  expect(fs.readFileSync(args.entry, "utf8")).toBe("adapter");
  expect(fs.existsSync(args.companion)).toBe(false);
  expect(fs.existsSync(args.ignoreFile)).toBe(false);
});

it("does not touch a staged file owned by another actor", async () => {
  const args = fixture();
  fs.writeFileSync(args.staged, "theirs");
  await expect(installFacadeFiles(args)).rejects.toMatchObject({ code: "EEXIST" });
  expect(fs.readFileSync(args.staged, "utf8")).toBe("theirs");
  expect(fs.readFileSync(args.entry, "utf8")).toBe("adapter");
});

it("preserves a staged file created immediately before exclusive open", async () => {
  const args = fixture();
  const io = {
    openSync(path, flags) {
      fs.writeFileSync(path, "theirs");
      return fs.openSync(path, flags);
    },
  };
  await expect(installFacadeFiles({ ...args, io })).rejects.toMatchObject({ code: "EEXIST" });
  expect(fs.readFileSync(args.staged, "utf8")).toBe("theirs");
  expect(fs.readFileSync(args.entry, "utf8")).toBe("adapter");
});

it("rolls back partial staged and ignore writes, restoring exact bytes or absence", async () => {
  for (const target of ["staged", "ignoreFile"]) {
    for (const previous of [null, Buffer.from([0xff, 0, 10, 0xc3])]) {
      const args = fixture(previous);
      const io = {
        writeFileSync(path, data, ...rest) {
          if (path === args[target]) {
            fs.writeFileSync(path, Buffer.from(data).subarray(0, 2), ...rest);
            throw new Error("partial write");
          }
          return fs.writeFileSync(path, data, ...rest);
        },
      };
      await expect(installFacadeFiles({ ...args, io })).rejects.toThrow("partial write");
      expect(fs.readFileSync(args.entry, "utf8")).toBe("adapter");
      expect(fs.existsSync(args.staged)).toBe(false);
      expect(fs.existsSync(args.companion)).toBe(false);
      if (previous === null) expect(fs.existsSync(args.ignoreFile)).toBe(false);
      else expect(fs.readFileSync(args.ignoreFile)).toEqual(previous);
    }
  }
});

it("runs every rollback in reverse order and aggregates failures", async () => {
  const args = fixture(Buffer.from("original"));
  const calls = [];
  const io = {
    writeFileSync(path, data) {
      if (path === args.ignoreFile) throw new Error("write failed");
      fs.writeFileSync(path, data);
    },
    undo: {
      writeFileSync() {
        calls.push("ignore");
        throw new Error("restore failed");
      },
      renameSync(from, to) {
        calls.push(from === args.entry ? "facade" : "adapter");
        fs.renameSync(from, to);
        if (from === args.entry) throw new Error("rename failed");
      },
      rmSync(path, options) {
        calls.push("staged");
        fs.rmSync(path, options);
      },
    },
  };
  const error = await installFacadeFiles({ ...args, io }).catch((failure) => failure);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors.map((failure) => failure.message)).toEqual([
    "write failed",
    "restore failed",
    "rename failed",
  ]);
  expect(calls).toEqual(["ignore", "facade", "adapter", "staged"]);
  expect(fs.readFileSync(args.entry, "utf8")).toBe("adapter");
});
