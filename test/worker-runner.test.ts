import { describe, expect, it } from "vitest";

// These regressions are offline: they pin the local runner's real boundaries
// (the checked-in config file, Miniflare's live validators, and the runner's
// own startup plumbing) without starting a Worker, touching a database, or
// using credentials.

async function readProbeConfig(): Promise<{ bindingKind: string; bindingValue: string; raw: string }> {
  const fs = await import("node:fs");
  const raw = fs.readFileSync("spike/hyperdrive-semantics/wrangler.probe.jsonc", "utf8");
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as {
    hyperdrive?: Array<{ binding: string; localConnectionString: string }>;
    vars?: Record<string, string>;
  };
  if (config.hyperdrive?.length) {
    const [first] = config.hyperdrive;
    return { bindingKind: "hyperdrive", bindingValue: first!.localConnectionString, raw };
  }
  const value = config.vars?.TEST_DB_CONNECTION_STRING;
  if (value) return { bindingKind: "vars", bindingValue: value, raw };
  throw new Error("probe config has no hyperdrive or vars binding");
}

describe("probe config binding (TOG-9680 P1)", () => {
  it("does not use a Hyperdrive binding for the passwordless test container", async () => {
    const { bindingKind, raw } = await readProbeConfig();
    expect(bindingKind).toBe("vars");
    expect(raw).not.toContain('"hyperdrive"');
  });

  it("pins the test-container target with no password and no substitute credential", async () => {
    const { bindingValue } = await readProbeConfig();
    expect(bindingValue).toBe("postgres://agent_test@agent-testdb:5432/agent_test");
    const url = new URL(bindingValue);
    expect(url.username).toBe("agent_test");
    expect(url.password).toBe("");
    expect(url.hostname).toBe("agent-testdb");
    expect(url.port).toBe("5432");
    expect(url.pathname).toBe("/agent_test");
  });

  it("passes the real runner-boundary validators (offline)", async () => {
    // Wrangler's file validator (validateVars in wrangler-dist/cli.js) accepts
    // any non-Date vars value, so the pinned string passes; Miniflare's
    // HyperdriveSchema rejects the same passwordless URL. That asymmetry is
    // exactly the P1 defect: the checked-in config must use the binding kind
    // both validators accept.
    const { bindingKind, bindingValue } = await readProbeConfig();
    expect(bindingKind).toBe("vars");
    expect(typeof bindingValue).toBe("string");
    expect(Object.prototype.toString.call(bindingValue)).toBe("[object String]");
    const { HyperdriveSchema } = await import("miniflare");
    expect(HyperdriveSchema.safeParse(bindingValue).success).toBe(false);
  });

  it("documents the old Hyperdrive shape as invalid for this container (offline)", async () => {
    const { HyperdriveSchema } = await import("miniflare");
    const result = HyperdriveSchema.safeParse("postgres://agent_test@agent-testdb:5432/agent_test");
    expect(result.success).toBe(false);
  });
});

describe("wrapper process-group teardown (TOG-9680 re-review P1)", () => {
  async function shellDeps() {
    const proc = await import("node:child_process");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    return { proc, fs, os, path };
  }

  // SIGKILLed orphans can linger as zombies under a non-reaping init, so a
  // kill(pid, 0) success is not proof of survival: states Z/X mean reaped.
  async function procReaped(pid: number): Promise<boolean> {
    const fs = await import("node:fs");
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
      return state === "Z" || state === "X" || state === "";
    } catch {
      return true;
    }
  }

  async function waitReaped(pid: number, timeoutMs = 5000): Promise<boolean> {
    const started = Date.now();
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      if (await procReaped(pid)) return true;
      if (Date.now() - started > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function makeFakes(scratch: string, runnerBody: string): Promise<{ fakeNode: string; fakeWrangler: string }> {
    const { fs, path } = await shellDeps();
    const fakeWrangler = path.join(scratch, "fake-wrangler.sh");
    fs.writeFileSync(fakeWrangler, '#!/bin/sh\necho "offline fake wrangler 0.0.0"\n');
    const fakeNode = path.join(scratch, "fake-node.sh");
    fs.writeFileSync(fakeNode, runnerBody);
    fs.chmodSync(fakeWrangler, 0o700);
    fs.chmodSync(fakeNode, 0o700);
    return { fakeNode, fakeWrangler };
  }

  function scratchDir(prefix: string): Promise<string> {
    return shellDeps().then(({ fs, os, path }) => {
      const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR
        ?? process.env.PAPERCLIP_SCRATCH_DIR
        ?? os.tmpdir();
      return fs.mkdtempSync(path.join(base, prefix));
    });
  }

  it("reaps group children when the runner exits nonzero (offline)", async () => {
    const { proc } = await shellDeps();
    const { fs, path } = await shellDeps();
    const scratch = await scratchDir("wrapper-exit-");
    const childPidFile = path.join(scratch, "child.pid");
    const { fakeNode, fakeWrangler } = await makeFakes(
      scratch,
      `#!/bin/sh\nsleep 60 &\necho "$!" > "${childPidFile}"\nexit 2\n`,
    );
    const started = Date.now();
    const child = proc.spawn("bash", ["spike/hyperdrive-semantics/worker-checks.sh"], {
      env: { ...process.env, NODE_BIN: fakeNode, WRANGLER_BIN: fakeWrangler },
      stdio: "ignore",
    });
    const exitCode: number = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? -1));
    });
    expect(exitCode).toBe(2);
    expect(Date.now() - started).toBeLessThan(60_000);
    const childPid = parseInt(fs.readFileSync(childPidFile, "utf8").trim(), 10);
    expect(Number.isInteger(childPid)).toBe(true);
    expect(await waitReaped(childPid)).toBe(true);
    fs.rmSync(scratch, { recursive: true, force: true });
  }, 90_000);

  it("reaps the group on external interruption and exits 143 (offline)", async () => {
    const { proc } = await shellDeps();
    const { fs, path } = await shellDeps();
    const scratch = await scratchDir("wrapper-int-");
    const childPidFile = path.join(scratch, "child.pid");
    const runnerPidFile = path.join(scratch, "runner.pid");
    const { fakeNode, fakeWrangler } = await makeFakes(
      scratch,
      `#!/bin/sh\nsleep 60 &\necho "$!" > "${childPidFile}"\necho "$$" > "${runnerPidFile}"\nsleep 120\n`,
    );
    const child = proc.spawn("bash", ["spike/hyperdrive-semantics/worker-checks.sh"], {
      env: { ...process.env, NODE_BIN: fakeNode, WRANGLER_BIN: fakeWrangler },
      stdio: "ignore",
    });
    const exitCodePromise = new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? -1));
    });
    let runnerPid = NaN;
    for (let i = 0; i < 150 && !Number.isInteger(runnerPid); i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        runnerPid = parseInt(fs.readFileSync(runnerPidFile, "utf8").trim(), 10);
      } catch {
        runnerPid = NaN;
      }
    }
    expect(Number.isInteger(runnerPid)).toBe(true);
    const childPid = parseInt(fs.readFileSync(childPidFile, "utf8").trim(), 10);
    expect(Number.isInteger(childPid)).toBe(true);
    child.kill("SIGTERM");
    expect(await exitCodePromise).toBe(143);
    expect(await waitReaped(runnerPid)).toBe(true);
    expect(await waitReaped(childPid)).toBe(true);
    fs.rmSync(scratch, { recursive: true, force: true });
  }, 90_000);
});

describe("runner startup bound (TOG-9680 P2)", () => {
  it("a never-ready startup settles with exit 2 instead of hanging", async () => {
    const started = Date.now();
    const mod = await import("../spike/hyperdrive-semantics/runner");
    const result = await mod.runWithWorker({
      timeoutMs: 50,
      startWorker: () => new Promise<never>(() => {}),
      runChecks: async () => {
        throw new Error("must not reach checks");
      },
    });
    expect(result.exitCode).toBe(2);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(String((result.error as Error).message)).toContain("worker_startup_timeout");
  });

  it("stop() runs on check failure and the runner reports exit 1", async () => {
    const stopped: string[] = [];
    const mod = await import("../spike/hyperdrive-semantics/runner");
    const result = await mod.runWithWorker({
      timeoutMs: 5000,
      startWorker: async () => ({ stop: async () => { stopped.push("stopped"); } }),
      runChecks: async () => { throw new Error("boom"); },
    });
    expect(result.exitCode).toBe(1);
    expect(stopped).toEqual(["stopped"]);
    expect(String((result.error as Error).message)).toBe("boom");
  });

  it("stop() runs on success and the runner reports exit 0", async () => {
    const stopped: string[] = [];
    const mod = await import("../spike/hyperdrive-semantics/runner");
    const result = await mod.runWithWorker({
      timeoutMs: 5000,
      startWorker: async () => ({ stop: async () => { stopped.push("stopped"); } }),
      runChecks: async () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(stopped).toEqual(["stopped"]);
  });
});
