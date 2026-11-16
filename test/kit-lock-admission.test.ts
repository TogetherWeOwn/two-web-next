import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitKitLockRoot, KitLockAdmissionError } from "../web/scripts/kit-lock-admission.mjs";
import { createKitLockAdmission } from "../web/scripts/kit-lock-admission-core.mjs";

const stat = (mode: bigint, ino = 1n, uid = 1000n) =>
  ({ mode: 0o40000n | mode, uid, dev: 1n, ino }) as const;
const ROOT = "/a/lock";

function setup(over: Record<string, unknown> = {}, env: Record<string, unknown> = {}) {
  const lstats: Record<string, unknown> = {
    "/": stat(0o755n, 10n, 0n),
    "/a": stat(0o755n, 11n),
    [ROOT]: stat(0o700n, 12n),
    "/proc": stat(0o555n, 13n, 0n),
    ...over,
  };
  const calls: string[] = [];
  const fs = {
    lstat: (p: string) => {
      const s = lstats[p];
      if (s instanceof Error) throw s;
      if (!s) throw new Error("ENOENT");
      return s;
    },
    fstat: () => lstats.fd ?? lstats[ROOT],
    stat: () => lstats.procStat ?? lstats[ROOT],
    statfsType: (p: string) => {
      const types = { "/proc": 0x9fa0n, ...(lstats.types as object) } as Record<string, unknown>;
      return p in types ? types[p] : 0x58465342n;
    },
    readlink: (p: string) => (p === "/proc/self" ? "77" : ROOT),
    open: () => {
      calls.push("open");
      if (lstats.openError) throw lstats.openError;
      return 5;
    },
    close: () => {
      calls.push("close");
      if (lstats.closeError) throw lstats.closeError;
    },
  };
  const admit = createKitLockAdmission({
    platform: "linux",
    nodeVersion: "24.0.0",
    pid: 77,
    getEuid: () => 1000,
    fs: { ...fs, ...(over.fs as object) },
    ...env,
  });
  return { admit, calls };
}
const refuses = (over: Record<string, unknown>, pattern: RegExp, env = {}) => {
  const { admit, calls } = setup(over, env);
  expect(() => admit(ROOT)).toThrow(pattern);
  return calls;
};

describe("Kit lock admission with injected environment", () => {
  it("admits with the current effective identity, rechecks and closes idempotently", () => {
    const { admit, calls } = setup();
    const handle = admit(ROOT);
    handle.recheck();
    handle.close();
    handle.close();
    expect(calls).toEqual(["open", "close"]);
    expect(() => handle.recheck()).toThrow(/closed/);
    let uid = 0;
    const dynamic = setup({}, { getEuid: () => uid });
    uid = 1000;
    const retained = dynamic.admit(ROOT);
    uid = 0;
    expect(() => retained.recheck()).toThrow(/effective uid changed/);
    expect(dynamic.calls).toEqual(["open", "close"]);
    let reads = 0;
    const changed = setup({}, { getEuid: () => (++reads === 1 ? 1000 : 0) });
    expect(() => changed.admit(ROOT)).toThrow(/effective uid changed/);
    expect(changed.calls).toEqual(["open", "close"]);
  });

  it("validates pathname before opening", () => {
    expect(refuses({ [ROOT]: stat(0o755n, 12n) }, /exactly 0700/)).toEqual([]);
    expect(refuses({ "/a": stat(0o755n, 11n, 5n) }, /untrusted owner/)).toEqual([]);
    expect(refuses({ "/a": new Error("EIO") }, /lstat \/a failed/)).toEqual([]);
  });

  it("refuses every writable ancestor including sticky and every inexact root mode", () => {
    for (const mode of [0o775n, 0o757n, 0o1777n, 0o1755n | 0o002n]) {
      refuses({ "/a": stat(mode, 11n) }, /writable/);
    }
    for (const mode of [0o1700n, 0o2700n, 0o4700n, 0o600n, 0o710n, 0o770n]) {
      refuses({ [ROOT]: stat(mode, 12n) }, /exactly 0700/);
    }
    refuses({ [ROOT]: stat(0o700n, 12n, 0n) }, /not owned/);
    refuses({ [ROOT]: { ...stat(0o700n, 12n), mode: 0o100700n } }, /not a directory/);
  });

  it("closes on failures and keeps the primary error when close fails", () => {
    const drifted = { procStat: stat(0o700n, 99n) };
    expect(refuses(drifted, /identity changed/)).toEqual(["open", "close"]);
    const closeError = new Error("EBADF");
    const { admit } = setup({ ...drifted, closeError });
    try {
      admit(ROOT);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(KitLockAdmissionError);
      expect((error as { cleanupError?: unknown }).cleanupError).toBe(closeError);
    }
    expect(() => setup({ openError: new Error("EACCES") }).admit(ROOT)).toThrow(/open root/);
  });

  it("refuses a root replaced between validation and open", () => {
    const swapped = refuses({ fs: { fstat: () => stat(0o700n, 99n) } }, /identity changed/);
    expect(swapped).toEqual(["open", "close"]);
  });

  it("refuses descriptor permission or identity drift after statfs", () => {
    let calls = 0;
    const drift = (mode: bigint, ino: bigint) => () =>
      ++calls > 1 ? stat(mode, ino) : stat(0o700n, 12n);
    refuses({ fs: { fstat: drift(0o770n, 12n) } }, /exactly 0700/);
    calls = 0;
    refuses({ fs: { fstat: drift(0o700n, 13n) } }, /identity changed/);
  });

  it("refuses non-XFS, malformed magic and statfs errors", () => {
    const rejected = [
      0xef53n, // ext2/3/4
      0x01021994n, // tmpfs
      0x6969n, // NFS
      0xff534d42n, // CIFS
      0xfe534d42n, // SMB2
      0x65735546n, // FUSE
      0x794c7630n, // overlayfs
      0x9123683en, // btrfs
      0n,
      0x58465342, // number, not bigint
      "0x58465342", // coercible strings
      "1481003842",
      undefined,
      null,
    ];
    for (const type of rejected) {
      for (const target of [ROOT, "/proc/self/fd/5"]) {
        refuses({ types: { [target]: type } }, /not on XFS/);
      }
    }
    refuses({ types: { "/proc": 0x9fa0 } }, /not procfs/);
    const fail = () => {
      throw new Error("EIO");
    };
    refuses({ fs: { statfsType: fail } }, /statfs \/proc failed/);
  });

  it("refuses a non-genuine procfs link, platform, Node version and bad paths", () => {
    refuses({ fs: { readlink: () => "1" } }, /not this process/);
    const other = (p: string) => (p === "/proc/self" ? "77" : "/other");
    refuses({ fs: { readlink: other } }, /name the root/);
    refuses({}, /Linux/, { platform: "darwin" });
    for (const nodeVersion of ["22.22.9", "23.9.0", "20.0.0"]) {
      refuses({}, /Node/, { nodeVersion });
    }
    const { admit } = setup({}, { nodeVersion: "22.23.0" });
    admit(ROOT).close();
    for (const path of ["relative", "/", `${ROOT}/..`, 42]) {
      expect(() => admit(path as string)).toThrow(KitLockAdmissionError);
    }
  });
});
const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Kit lock admission against the real filesystem", () => {
  it("refuses unusable roots before any XFS classification", () => {
    const base = mkdtempSync(join(userInfo().homedir, ".kit-lock-admission-"));
    homes.push(base);
    mkdirSync(join(base, "open"), { mode: 0o755 });
    chmodSync(join(base, "open"), 0o755);
    symlinkSync(base, join(base, "link"));
    const reason = process.platform === "linux" ? /mode is not exactly 0700/ : /Linux is required/;
    expect(() => admitKitLockRoot(join(base, "open"))).toThrow(reason);
    expect(() => admitKitLockRoot(join(base, "link"))).toThrow(KitLockAdmissionError);
  });
});
