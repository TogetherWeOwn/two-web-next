import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { installFacadeFiles as installDomainFacade } from "../web/scripts/kit-facade-transaction.mjs";

const dirs = [];
const installFacadeFiles = ({ entry, prepare, io }) =>
  installDomainFacade({
    root: join(entry, ".."),
    prepare: async (source) => ({ output: await prepare(source) }),
    io,
  });
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
  return { ...paths, prepare: async () => "facade" };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it("installs both files and appends the ignore entry without changing prior bytes", async () => {
  const previous = Buffer.from([0xff, 0xfe, 10]);
  const args = fixture(previous);
  const result = await installFacadeFiles(args);
  expect(result.companion).toBe(args.companion);
  expect(fs.readFileSync(args.entry, "utf8")).toContain("\nfacade\n");
  expect(fs.readFileSync(args.companion, "utf8")).toBe("adapter");
  expect(fs.readFileSync(args.ignoreFile)).toEqual(
    Buffer.concat([previous, Buffer.from("kit-adapter.js\n")]),
  );
});

it("hashes the original adapter bytes and the installed envelope", async () => {
  const args = fixture();
  const original = Buffer.from([0xff, 0x61]);
  fs.writeFileSync(args.entry, original);
  let source;
  const result = await installDomainFacade({
    root: join(args.entry, ".."),
    prepare: async (text) => {
      source = text;
      return { output: "compiled" };
    },
  });
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const installed = fs.readFileSync(args.entry);
  expect(source).toBe(original.toString("utf8"));
  expect(result.adapterSha256).toBe(digest(original));
  expect(result.facadeSha256).toBe(digest(installed));
  expect(installed.toString()).toContain(`sha256=${digest(original)}\ncompiled\n`);
  expect(fs.readFileSync(args.companion)).toEqual(original);
});

it.each([
  ["missing", (path) => fs.rmSync(path), "missing generated adapter"],
  [
    "directory",
    (path) => {
      fs.rmSync(path);
      fs.mkdirSync(path);
    },
    "not a regular file",
  ],
  ["empty", (path) => fs.writeFileSync(path, "  \n"), "entry is empty"],
  ["facade", (path) => fs.writeFileSync(path, "two-web-kit-worker-facade"), "already a facade"],
])("rejects a %s adapter before preparation", async (_label, setup, message) => {
  const args = fixture();
  setup(args.entry);
  let prepared = false;
  args.prepare = async () => {
    prepared = true;
    return "facade";
  };
  await expect(installFacadeFiles(args)).rejects.toThrow(message);
  expect(prepared).toBe(false);
  expect(fs.existsSync(args.staged)).toBe(false);
  expect(fs.existsSync(args.companion)).toBe(false);
  expect(fs.existsSync(args.ignoreFile)).toBe(false);
});

it("rejects an adapter changed during preparation without overwriting it", async () => {
  const args = fixture();
  args.prepare = async () => {
    fs.writeFileSync(args.entry, "changed");
    return "facade";
  };
  await expect(installFacadeFiles(args)).rejects.toThrow("adapter changed or companion exists");
  expect(fs.readFileSync(args.entry, "utf8")).toBe("changed");
  expect(fs.existsSync(args.companion)).toBe(false);
  expect(fs.existsSync(args.staged)).toBe(false);
});

it("preserves a companion created during preparation", async () => {
  const args = fixture();
  args.prepare = async () => {
    fs.writeFileSync(args.companion, "theirs");
    return "facade";
  };
  await expect(installFacadeFiles(args)).rejects.toThrow("adapter changed or companion exists");
  expect(fs.readFileSync(args.entry, "utf8")).toBe("adapter");
  expect(fs.readFileSync(args.companion, "utf8")).toBe("theirs");
  expect(fs.existsSync(args.staged)).toBe(false);
});

it("distinguishes an absent ignore file from an empty one", async () => {
  const absent = fixture();
  await installFacadeFiles(absent);
  expect(fs.readFileSync(absent.ignoreFile, "utf8")).toBe("_worker.js\nkit-adapter.js\n");

  const empty = fixture(Buffer.alloc(0));
  await installFacadeFiles(empty);
  expect(fs.readFileSync(empty.ignoreFile, "utf8")).toBe("\nkit-adapter.js\n");
});

it("leaves an existing companion ignore entry unchanged", async () => {
  const previous = Buffer.from("_worker.js\r\nkit-adapter.js\r\n");
  const args = fixture(previous);
  await installFacadeFiles(args);
  expect(fs.readFileSync(args.ignoreFile)).toEqual(previous);
});

it("places the companion exclusion after a later negation", async () => {
  const args = fixture(Buffer.from("kit-adapter.js\n!*.js\n"));
  await installFacadeFiles(args);
  expect(fs.readFileSync(args.ignoreFile, "utf8")).toBe("kit-adapter.js\n!*.js\nkit-adapter.js\n");
});

it("rejects an ignore file hardlinked to the adapter without changing bytes", async () => {
  const args = fixture();
  fs.linkSync(args.entry, args.ignoreFile);
  const original = fs.readFileSync(args.entry);
  await expect(installFacadeFiles(args)).rejects.toThrow(".assetsignore aliases the adapter");
  expect(fs.readFileSync(args.entry)).toEqual(original);
  expect(fs.readFileSync(args.ignoreFile)).toEqual(original);
  expect(fs.existsSync(args.companion)).toBe(false);
  expect(fs.existsSync(args.staged)).toBe(false);
});

it("rejects a non-regular ignore file before changing anything", async () => {
  const args = fixture();
  fs.mkdirSync(args.ignoreFile);
  await expect(installFacadeFiles(args)).rejects.toThrow(".assetsignore is not a regular file");
  expect(fs.readFileSync(args.entry, "utf8")).toBe("adapter");
  expect(fs.statSync(args.ignoreFile).isDirectory()).toBe(true);
  expect(fs.existsSync(args.staged)).toBe(false);
  expect(fs.existsSync(args.companion)).toBe(false);
});

it("rejects a symlink ignore file without touching its target", async () => {
  const args = fixture();
  const target = join(args.entry, "..", "ignore-target");
  fs.writeFileSync(target, "original");
  fs.symlinkSync(target, args.ignoreFile);
  await expect(installFacadeFiles(args)).rejects.toThrow(".assetsignore is not a regular file");
  expect(fs.readFileSync(target, "utf8")).toBe("original");
  expect(fs.lstatSync(args.ignoreFile).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(args.entry, "utf8")).toBe("adapter");
  expect(fs.existsSync(args.staged)).toBe(false);
  expect(fs.existsSync(args.companion)).toBe(false);
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

it("removes the owned staged file when closing it fails", async () => {
  const args = fixture();
  const io = {
    closeSync(fd) {
      fs.closeSync(fd);
      throw new Error("close failed");
    },
  };
  await expect(installFacadeFiles({ ...args, io })).rejects.toThrow("close failed");
  expect(fs.existsSync(args.staged)).toBe(false);
  expect(fs.readFileSync(args.entry, "utf8")).toBe("adapter");
  expect(fs.existsSync(args.companion)).toBe(false);
  expect(fs.existsSync(args.ignoreFile)).toBe(false);
});

it("does not touch a staged file owned by another actor", async () => {
  const args = fixture();
  fs.writeFileSync(args.staged, "theirs");
  await expect(installFacadeFiles(args)).rejects.toThrow("companion or staged file exists");
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

it("restores the adapter if installing the staged facade fails", async () => {
  const previous = Buffer.from([0xff, 0, 10]);
  const args = fixture(previous);
  const io = {
    renameSync(from, to) {
      if (from === args.staged) throw new Error("facade rename failed");
      fs.renameSync(from, to);
    },
  };
  await expect(installFacadeFiles({ ...args, io })).rejects.toThrow("facade rename failed");
  expect(fs.readFileSync(args.entry, "utf8")).toBe("adapter");
  expect(fs.readFileSync(args.ignoreFile)).toEqual(previous);
  expect(fs.existsSync(args.staged)).toBe(false);
  expect(fs.existsSync(args.companion)).toBe(false);
});

it("rolls back partial staged and ignore writes, restoring exact bytes or absence", async () => {
  for (const target of ["staged", "ignoreFile"]) {
    for (const previous of [null, Buffer.alloc(0), Buffer.from([0xff, 0, 10, 0xc3])]) {
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
