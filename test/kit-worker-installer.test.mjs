// Inactive Kit Worker facade installer. Hermetic: a stub adapter in a
// temporary directory, no build, no Wrangler.
// Design credit: Rick7C2, draft #2092 at eb1ba5d47e6d5a35a0a6deb2b7532b4c045865f3.
import * as fsReal from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { securityHeadersFor } from "../src/headers";
import {
  COMPANION_NAME,
  ENTRY_NAME,
  FACADE_MARKER,
  installWorkerFacade,
} from "../web/scripts/install-worker-facade.mjs";

// Exercise the real lock state machine with fixture admission, not XFS admission.
// Filesystem admission is independently qualified on real XFS in CI.
vi.mock("../web/scripts/kit-lock.mjs", async (importOriginal) => {
  const { createKitLock } = await importOriginal();
  const fs = await import("node:fs");
  return {
    withKitLock: createKitLock({
      admit: (path) => ({ path, recheck() {}, close() {} }),
      mkdir: fs.mkdirSync,
      lstat: (path) => fs.lstatSync(path, { bigint: true }),
      rmdir: fs.rmdirSync,
    }),
  };
});

const { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } = fsReal;
const dirs = [];
const env = { APP_URL: "https://togetherweown.com" };
const IGNORE = ".assetsignore";
const STAGED = `${ENTRY_NAME}.facade.tmp`;
const ADAPTER = `export const other = 7;
export default {
  calls: [],
  tag: "raw",
  async fetch(request, env, ctx) {
    this.calls.push([request, env, ctx, this]);
    return globalThis.__adapterResult(request, env, ctx);
  },
  scheduled() { return this.tag; },
};
`;

function scratch(adapter) {
  const dir = mkdtempSync(join(tmpdir(), "kit-worker-installer-"));
  dirs.push(dir);
  if (adapter !== undefined) writeFileSync(join(dir, ENTRY_NAME), adapter);
  return dir;
}
const read = (dir, name) => readFileSync(join(dir, name), "utf8");
const names = (dir) => readdirSync(dir).sort();
const load = (dir) => {
  const generated = mkdtempSync(join(tmpdir(), "kit-worker-import-"));
  dirs.push(generated);
  for (const name of [ENTRY_NAME, COMPANION_NAME]) {
    fsReal.copyFileSync(join(dir, name), join(generated, name));
  }
  const outfile = join(generated, "_worker.js");
  return import(/* @vite-ignore */ pathToFileURL(outfile).href);
};
const snapshot = (dir) => Object.fromEntries(names(dir).map((name) => [name, read(dir, name)]));
// Rejects with `pattern` and proves the directory is unchanged.
async function rejectsUnchanged(dir, pattern, options = {}) {
  const before = snapshot(dir);
  await expect(installWorkerFacade({ dir, ...options })).rejects.toThrow(pattern);
  expect(snapshot(dir)).toEqual(before);
}
// A real fs call that throws `message` when its target path ends with `suffix`.
const failing =
  (name, suffix, message) =>
  (...args) => {
    const target = String(name === "renameSync" ? args[1] : args[0]);
    if (target.endsWith(suffix)) throw new Error(message);
    return name === "renameSync" ? fsReal.renameSync(...args) : fsReal.writeFileSync(...args);
  };
// Writes only a prefix of non-empty data to `suffix`, then throws.
const partial =
  (suffix) =>
  (path, data, ...rest) => {
    if (!path.endsWith(suffix) || data.length === 0) {
      return fsReal.writeFileSync(path, data, ...rest);
    }
    fsReal.writeFileSync(path, Buffer.from(data).subarray(0, 3), ...rest);
    throw new Error("injected partial");
  };

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("installWorkerFacade", () => {
  it("moves the adapter to the companion and writes a marked facade", async () => {
    const dir = scratch(ADAPTER);
    const result = await installWorkerFacade({ dir });
    expect(read(dir, COMPANION_NAME)).toBe(ADAPTER);
    const facade = read(dir, ENTRY_NAME);
    expect(facade.startsWith(FACADE_MARKER)).toBe(true);
    expect(facade).toContain(`sha256=${result.adapterSha256}`);
    expect(read(dir, IGNORE)).toBe(`${ENTRY_NAME}\n${COMPANION_NAME}\n`);
    expect(names(dir)).toEqual([IGNORE, COMPANION_NAME, ENTRY_NAME].sort());
  });

  it("preserves existing .assetsignore entries and ensures a final companion exclusion", async () => {
    for (const [before, after] of [
      ["_routes.json", `_routes.json\n${COMPANION_NAME}\n`],
      [`_routes.json\n${COMPANION_NAME}`, `_routes.json\n${COMPANION_NAME}`],
      [
        `${COMPANION_NAME}\n!${COMPANION_NAME}\n`,
        `${COMPANION_NAME}\n!${COMPANION_NAME}\n${COMPANION_NAME}\n`,
      ],
    ]) {
      const dir = scratch(ADAPTER);
      writeFileSync(join(dir, IGNORE), before);
      await installWorkerFacade({ dir });
      expect(read(dir, IGNORE)).toBe(after);
    }
  });

  it("fails closed on malformed, disguised or absent inputs without mutating", async () => {
    await expect(installWorkerFacade({ dir: scratch() })).rejects.toThrow(/missing generated/);
    for (const [source, pattern] of [
      ["  \n", /empty/],
      ["export const x = 1;\n", /export default/],
      [`${FACADE_MARKER}\n${ADAPTER}`, /already a facade/],
      ["// export default {};\nexport const x = 1;\n", /export default/],
      ['const s = "export default 1";\nexport const x = 1;\n', /export default/],
      ["/* export default {} */\n", /export default/],
      ["export default {;\n", /invalid adapter JavaScript/],
      ["// export default 1\nexport default (;\n", /invalid adapter JavaScript/],
      ["export default /[/;\n", /invalid adapter JavaScript/],
    ]) {
      const dir = scratch(source);
      await rejectsUnchanged(dir, pattern);
      expect(snapshot(dir)).toEqual({ [ENTRY_NAME]: source });
    }
    const dir = scratch(ADAPTER);
    writeFileSync(join(dir, COMPANION_NAME), "preserve stale companion");
    await rejectsUnchanged(dir, /duplicate/);
    expect(read(dir, COMPANION_NAME)).toBe("preserve stale companion");
  });

  it("undoes a partial staged write and a partial .assetsignore write exactly", async () => {
    const original = Buffer.from([0x5f, 0xff, 0xfe, 0x0a, 0xc3, 0x28, 0x0a]);
    for (const [suffix, ignore] of [
      [".facade.tmp", original],
      [IGNORE, original],
      [IGNORE, null],
    ]) {
      const dir = scratch(ADAPTER);
      if (ignore) writeFileSync(join(dir, IGNORE), ignore);
      const io = { writeFileSync: partial(suffix) };
      await expect(installWorkerFacade({ dir, io })).rejects.toThrow(/injected partial/);
      expect(names(dir)).toEqual(ignore ? [IGNORE, ENTRY_NAME] : [ENTRY_NAME]);
      if (ignore) expect(readFileSync(join(dir, IGNORE)).equals(ignore)).toBe(true);
      expect(read(dir, ENTRY_NAME)).toBe(ADAPTER);
    }
  });

  it("never removes a staged file another actor created before exclusive creation", async () => {
    const dir = scratch(ADAPTER);
    const io = {
      openSync: (path, flags) => {
        if (String(path).endsWith(STAGED)) fsReal.writeFileSync(path, "theirs");
        return fsReal.openSync(path, flags);
      },
    };
    await expect(installWorkerFacade({ dir, io })).rejects.toThrow(/EEXIST/);
    expect(names(dir)).toEqual([ENTRY_NAME, STAGED]);
    expect(read(dir, STAGED)).toBe("theirs");
    expect(read(dir, ENTRY_NAME)).toBe(ADAPTER);
  });

  it("reports a rollback failure together with the original error", async () => {
    const dir = scratch(ADAPTER);
    const io = {
      writeFileSync: failing("writeFileSync", IGNORE, "injected ignore"),
      undo: { renameSync: failing("renameSync", "", "injected undo rename") },
    };
    const error = await installWorkerFacade({ dir, io }).catch((caught) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toMatch(/rollback failed.*injected ignore.*injected undo rename/);
    expect(error.errors.map((item) => item.message)).toContain("injected ignore");
    // Remaining undo steps still ran: the staged file is gone.
    expect(existsSync(join(dir, STAGED))).toBe(false);
  });

  it("refuses a duplicate installation, a stale companion and a stale staged file", async () => {
    const dir = scratch(ADAPTER);
    await installWorkerFacade({ dir });
    await rejectsUnchanged(dir, /duplicate/);
    const staged = scratch(ADAPTER);
    writeFileSync(join(staged, STAGED), "keep");
    await expect(installWorkerFacade({ dir: staged })).rejects.toThrow(/duplicate/);
    expect(read(staged, STAGED)).toBe("keep");
  });

  it("rejects overlapping installations without replacing the adapter", async () => {
    const dir = scratch(ADAPTER);
    const results = await Promise.allSettled([
      installWorkerFacade({ dir }),
      installWorkerFacade({ dir }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(read(dir, COMPANION_NAME)).toBe(ADAPTER);
    expect(read(dir, ENTRY_NAME).startsWith(FACADE_MARKER)).toBe(true);
  });

  it("retains exclusive ownership while a failed install rolls back", async () => {
    const dir = scratch(ADAPTER);
    let competing;
    const io = {
      writeFileSync: (path, data, options) => {
        if (String(path).endsWith(IGNORE)) {
          competing = installWorkerFacade({ dir }).catch((error) => error);
          throw new Error("injected ignore");
        }
        return fsReal.writeFileSync(path, data, options);
      },
    };
    await expect(installWorkerFacade({ dir, io })).rejects.toThrow(/injected ignore/);
    expect((await competing).code).toBe("EEXIST");
    expect(snapshot(dir)).toEqual({ [ENTRY_NAME]: ADAPTER });
  });

  it("rolls every completed step back when a later step fails", async () => {
    const cases = [
      { renameSync: failing("renameSync", COMPANION_NAME, "injected one") },
      { renameSync: failing("renameSync", ENTRY_NAME, "injected two") },
      { writeFileSync: failing("writeFileSync", IGNORE, "injected ignore") },
    ];
    for (const io of cases) {
      for (const ignore of [undefined, "_routes.json\n"]) {
        const dir = scratch(ADAPTER);
        if (ignore !== undefined) writeFileSync(join(dir, IGNORE), ignore);
        await rejectsUnchanged(dir, /injected/, { io });
      }
    }
  });
});

describe("installed facade", () => {
  async function installed(adapter = ADAPTER) {
    const dir = scratch(adapter);
    await installWorkerFacade({ dir });
    return load(dir);
  }
  const request = () => new Request("https://togetherweown.com/about");

  it("keeps named exports and runs other handlers on the real adapter", async () => {
    const mod = await installed();
    expect(mod.other).toBe(7);
    expect(mod.default.scheduled.call({ tag: "facade" })).toBe("raw");
  });

  it("delegates fetch once with unchanged arguments and returns a complete response as is", async () => {
    const mod = await installed();
    const ctx = { waitUntil() {} };
    const req = new Request("https://togetherweown.com/events");
    const complete = new Response("ok", {
      headers: securityHeadersFor({ path: "/events", method: "GET" }, ""),
    });
    globalThis.__adapterResult = () => complete;
    expect(await mod.default.fetch(req, env, ctx)).toBe(complete);
    expect(mod.default.calls).toHaveLength(1);
    const [seenRequest, seenEnv, seenCtx, seenThis] = mod.default.calls[0];
    expect([seenRequest, seenEnv, seenCtx]).toEqual([req, env, ctx]);
    expect(seenThis).not.toBe(mod.default);
    expect(seenThis.fetch).not.toBe(mod.default.fetch);
  });

  it("completes a bare returned fatal without reading it twice", async () => {
    const mod = await installed();
    globalThis.__adapterResult = () => new Response("boom", { status: 500 });
    const response = await mod.default.fetch(request(), env, {});
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("boom");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mod.default.calls).toHaveLength(1);
  });

  it("propagates an adapter rejection without replay", async () => {
    const mod = await installed();
    const failure = new Error("adapter down");
    globalThis.__adapterResult = () => Promise.reject(failure);
    await expect(mod.default.fetch(request(), env, {})).rejects.toBe(failure);
    expect(mod.default.calls).toHaveLength(1);
  });

  it("fails closed on malformed request, env and adapter result", async () => {
    const mod = await installed();
    globalThis.__adapterResult = () => new Response("x", { status: 500 });
    await expect(mod.default.fetch("https://x", env, {})).rejects.toThrow(/Request/);
    expect(mod.default.calls).toHaveLength(0);
    globalThis.__adapterResult = () => ({ status: 200 });
    await expect(mod.default.fetch(request(), env, {})).rejects.toThrow(/Response/);
  });

  it("refuses an adapter default export that cannot serve fetch", async () => {
    const dir = scratch("export default { scheduled() {} };\n");
    await installWorkerFacade({ dir });
    await expect(load(dir)).rejects.toThrow(/fetch/);
    expect(existsSync(join(dir, COMPANION_NAME))).toBe(true);
  });
});
