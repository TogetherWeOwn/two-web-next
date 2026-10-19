import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

// These regressions are offline: they pin the local runner's real boundaries
// (the checked-in config file, Miniflare's live validators, and the runner's
// own startup plumbing) without starting a Worker, touching a database, or
// using credentials.

async function readProbeConfig(): Promise<{
  bindingKind: string;
  bindingValue: string;
  raw: string;
}> {
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
    // A non-integer PID is never "reaped": returning true here would let a
    // reaping assertion pass vacuously on a PID that was never published.
    if (!Number.isInteger(pid)) return false;
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

  interface OwnedChild {
    child: ChildProcess;
    closed: Promise<void>;
    settled: () => boolean;
  }

  // Owned-process tracking: every wrapper/sentinel the harness spawns is
  // registered synchronously at spawn time, so settleOwned can terminate and
  // await exactly those processes on every path (readiness, PID-read, spawn,
  // and assertion failures included). Cleanup signals direct PIDs only: never
  // pkill/pgrep/killall, process-group scans, or broad matching, so unrelated
  // processes always survive. Descendant PIDs already observed reaped are
  // skipped rather than signalled, so a recycled number can never turn
  // cleanup against an unrelated process.
  function trackOwned(child: ChildProcess): OwnedChild {
    let done = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = () => {
        done = true;
        resolve();
      };
    });
    child.once("close", () => resolveClosed());
    child.once("error", () => resolveClosed());
    return {
      child,
      closed,
      settled: () => done || child.exitCode !== null || child.signalCode !== null,
    };
  }

  async function isLiveProcess(pid: number): Promise<boolean> {
    if (!Number.isInteger(pid)) return false;
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    return !(await procReaped(pid));
  }

  // SIGTERM the owned wrapper, escalate to SIGKILL after 15s, then await its
  // close; afterwards TERM each still-live recorded owned descendant PID (then
  // KILL the survivors). PIDs already observed reaped are never signalled: on
  // the happy paths the test proved them dead before finally, and a reaped
  // number may already belong to an unrelated process. Every step tolerates
  // already-reaped processes, so this is safe in finally on both the happy
  // and failure paths. Scratch removal (withScratchDir) only runs after this
  // settles because callers await it inside the scratch callback.
  async function settleOwned(
    owned: OwnedChild | undefined,
    ownedDescendants: number[],
  ): Promise<void> {
    if (owned && !owned.settled()) {
      try {
        owned.child.kill("SIGTERM");
      } catch {
        // Already gone; the close wait below still settles.
      }
      await Promise.race([
        owned.closed,
        new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
      ]);
      if (!owned.settled()) {
        try {
          owned.child.kill("SIGKILL");
        } catch {
          // Exited concurrently; the close wait below still settles.
        }
      }
      await owned.closed;
    }
    const liveDescendants: number[] = [];
    for (const pid of ownedDescendants) {
      if (await isLiveProcess(pid)) liveDescendants.push(pid);
    }
    for (const pid of liveDescendants) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Reaped between the liveness check and the signal.
      }
    }
    for (const pid of liveDescendants) {
      if (await waitReaped(pid)) continue;
      if (!(await isLiveProcess(pid))) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Reaped between the wait and the signal.
      }
      await waitReaped(pid);
    }
  }

  async function stopSentinel(sentinel: OwnedChild): Promise<void> {
    try {
      sentinel.child.kill("SIGKILL");
    } catch {
      // Sentinel already gone; close below still settles.
    }
    await sentinel.closed;
  }

  async function makeFakes(
    scratch: string,
    runnerBody: string,
  ): Promise<{ fakeNode: string; fakeWrangler: string }> {
    const { fs, path } = await shellDeps();
    const fakeWrangler = path.join(scratch, "fake-wrangler.sh");
    fs.writeFileSync(fakeWrangler, '#!/bin/sh\necho "offline fake wrangler 0.0.0"\n');
    const fakeNode = path.join(scratch, "fake-node.sh");
    fs.writeFileSync(fakeNode, runnerBody);
    fs.chmodSync(fakeWrangler, 0o700);
    fs.chmodSync(fakeNode, 0o700);
    return { fakeNode, fakeWrangler };
  }

  async function withScratchDir(
    prefix: string,
    run: (scratch: string) => void | Promise<void>,
  ): Promise<void> {
    const { fs, os, path } = await shellDeps();
    const base =
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? os.tmpdir();
    const scratch = fs.mkdtempSync(path.join(base, prefix));
    const errors: unknown[] = [];
    try {
      await run(scratch);
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        fs.rmSync(scratch, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 1)
      throw new AggregateError(errors, "Wrapper test and scratch cleanup failed");
    if (errors.length) throw errors[0];
  }

  it("removes only its owned scratch directory after success", async () => {
    const { fs, path } = await shellDeps();
    let owned = "";
    await withScratchDir("wrapper-sibling-", async (sibling) => {
      await withScratchDir("wrapper-success-", (scratch) => {
        owned = scratch;
        fs.writeFileSync(path.join(scratch, "fixture"), "offline");
      });
      expect(fs.existsSync(owned)).toBe(false);
      expect(fs.existsSync(sibling)).toBe(true);
    });
  });

  it.each(["assertion", "fixture", "spawn", "read"] as const)(
    "removes scratch after a %s failure",
    async (failure) => {
      const { fs, path, proc } = await shellDeps();
      let owned = "";
      let original: unknown;
      const reported = await withScratchDir("wrapper-failure-", async (scratch) => {
        owned = scratch;
        try {
          if (failure === "assertion") expect("actual").toBe("expected");
          if (failure === "fixture")
            fs.writeFileSync(path.join(scratch, "missing", "fixture"), "offline");
          if (failure === "read") fs.readFileSync(path.join(scratch, "missing.pid"), "utf8");
          if (failure === "spawn") {
            await new Promise<void>((resolve, reject) => {
              const child = proc.spawn(path.join(scratch, "missing-executable"));
              child.on("error", reject);
              child.on("close", () => resolve());
            });
          }
        } catch (error) {
          original = error;
          throw error;
        }
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(original).toBeDefined();
      expect(reported).toBe(original);
      expect(fs.existsSync(owned)).toBe(false);
    },
  );

  it("reaps group children when the runner exits nonzero (offline)", async () => {
    const { proc, fs, path } = await shellDeps();
    const sentinel = trackOwned(proc.spawn("sleep", ["60"], { stdio: "ignore" }));
    const sentinelPid = sentinel.child.pid ?? NaN;
    try {
      await withScratchDir("wrapper-exit-sibling-", async (sibling) => {
        await withScratchDir("wrapper-exit-", async (scratch) => {
          const childPidFile = path.join(scratch, "child.pid");
          const { fakeNode, fakeWrangler } = await makeFakes(
            scratch,
            `#!/bin/sh\nsleep 60 &\necho "$!" > "${childPidFile}"\nexit 2\n`,
          );
          const ownedDescendants: number[] = [];
          let owned: OwnedChild | undefined;
          const started = Date.now();
          try {
            owned = trackOwned(
              proc.spawn("bash", ["spike/hyperdrive-semantics/worker-checks.sh"], {
                env: { ...process.env, NODE_BIN: fakeNode, WRANGLER_BIN: fakeWrangler },
                stdio: "ignore",
              }),
            );
            const exitCode: number = await new Promise((resolve, reject) => {
              owned!.child.on("error", reject);
              owned!.child.on("close", (code) => resolve(code ?? -1));
            });
            expect(exitCode).toBe(2);
            expect(Date.now() - started).toBeLessThan(60_000);
            const childPid = parseInt(fs.readFileSync(childPidFile, "utf8").trim(), 10);
            if (Number.isInteger(childPid)) ownedDescendants.push(childPid);
            expect(Number.isInteger(childPid)).toBe(true);
            expect(await waitReaped(childPid)).toBe(true);
          } finally {
            await settleOwned(owned, ownedDescendants);
          }
        });
        expect(fs.existsSync(sibling)).toBe(true);
      });
      expect(await isLiveProcess(sentinelPid)).toBe(true);
    } finally {
      await stopSentinel(sentinel);
    }
  }, 90_000);

  it("reaps the group on external interruption and exits 143 (offline)", async () => {
    const { proc, fs, path } = await shellDeps();
    const sentinel = trackOwned(proc.spawn("sleep", ["60"], { stdio: "ignore" }));
    const sentinelPid = sentinel.child.pid ?? NaN;
    try {
      await withScratchDir("wrapper-int-sibling-", async (sibling) => {
        await withScratchDir("wrapper-int-", async (scratch) => {
          const childPidFile = path.join(scratch, "child.pid");
          const runnerPidFile = path.join(scratch, "runner.pid");
          const { fakeNode, fakeWrangler } = await makeFakes(
            scratch,
            `#!/bin/sh\nsleep 60 &\necho "$!" > "${childPidFile}"\necho "$$" > "${runnerPidFile}"\nsleep 120\n`,
          );
          const ownedDescendants: number[] = [];
          let owned: OwnedChild | undefined;
          try {
            owned = trackOwned(
              proc.spawn("bash", ["spike/hyperdrive-semantics/worker-checks.sh"], {
                env: { ...process.env, NODE_BIN: fakeNode, WRANGLER_BIN: fakeWrangler },
                stdio: "ignore",
              }),
            );
            const wrapper = owned.child;
            const exitCodePromise = new Promise<number>((resolve, reject) => {
              wrapper.on("error", reject);
              wrapper.on("close", (code) => resolve(code ?? -1));
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
            if (Number.isInteger(runnerPid)) ownedDescendants.push(runnerPid);
            expect(Number.isInteger(runnerPid)).toBe(true);
            const childPid = parseInt(fs.readFileSync(childPidFile, "utf8").trim(), 10);
            if (Number.isInteger(childPid)) ownedDescendants.push(childPid);
            expect(Number.isInteger(childPid)).toBe(true);
            wrapper.kill("SIGTERM");
            expect(await exitCodePromise).toBe(143);
            expect(await waitReaped(runnerPid)).toBe(true);
            expect(await waitReaped(childPid)).toBe(true);
          } finally {
            await settleOwned(owned, ownedDescendants);
          }
        });
        expect(fs.existsSync(sibling)).toBe(true);
      });
      expect(await isLiveProcess(sentinelPid)).toBe(true);
    } finally {
      await stopSentinel(sentinel);
    }
  }, 90_000);

  it("reaps owned descendants when readiness is never published (offline)", async () => {
    // Fault injection: the fake runner backgrounds a descendant but never
    // publishes runner.pid, so the bounded readiness poll observes nothing
    // and the readiness assertion fails. finally must still terminate the
    // owned wrapper and reap the descendant.
    const { proc, fs, path } = await shellDeps();
    const sentinel = trackOwned(proc.spawn("sleep", ["60"], { stdio: "ignore" }));
    const sentinelPid = sentinel.child.pid ?? NaN;
    try {
      await withScratchDir("wrapper-noready-sibling-", async (sibling) => {
        await withScratchDir("wrapper-noready-", async (scratch) => {
          const childPidFile = path.join(scratch, "child.pid");
          const runnerPidFile = path.join(scratch, "runner.pid");
          const { fakeNode, fakeWrangler } = await makeFakes(
            scratch,
            `#!/bin/sh\nsleep 60 &\necho "$!" > "${childPidFile}"\nsleep 120\n`,
          );
          let owned: OwnedChild | undefined;
          let wrapperCode: number | undefined;
          let childPid = NaN;
          let runnerPid = NaN;
          let reachedFault = false;
          let injected: unknown;
          try {
            owned = trackOwned(
              proc.spawn("bash", ["spike/hyperdrive-semantics/worker-checks.sh"], {
                env: { ...process.env, NODE_BIN: fakeNode, WRANGLER_BIN: fakeWrangler },
                stdio: "ignore",
              }),
            );
            owned.child.on("close", (code) => {
              wrapperCode = code ?? -1;
            });
            for (let i = 0; i < 30 && !Number.isInteger(runnerPid); i++) {
              await new Promise((r) => setTimeout(r, 100));
              try {
                runnerPid = parseInt(fs.readFileSync(runnerPidFile, "utf8").trim(), 10);
              } catch {
                runnerPid = NaN;
              }
            }
            childPid = parseInt(fs.readFileSync(childPidFile, "utf8").trim(), 10);
            expect(Number.isInteger(childPid)).toBe(true);
            expect(await isLiveProcess(childPid)).toBe(true);
            reachedFault = true;
            expect(Number.isInteger(runnerPid)).toBe(true);
          } catch (error) {
            injected = error;
          } finally {
            await settleOwned(owned, Number.isInteger(childPid) ? [childPid] : []);
          }
          expect(injected).toBeDefined();
          expect(reachedFault).toBe(true);
          expect(Number.isInteger(childPid)).toBe(true);
          expect(Number.isNaN(runnerPid)).toBe(true);
          expect(String(injected)).toMatch(/expected false to be true/);
          expect(wrapperCode).toBe(143);
          expect(owned?.settled()).toBe(true);
          expect(await waitReaped(childPid)).toBe(true);
        });
        expect(fs.existsSync(sibling)).toBe(true);
      });
      expect(await isLiveProcess(sentinelPid)).toBe(true);
    } finally {
      await stopSentinel(sentinel);
    }
  }, 90_000);

  it("reaps owned processes when PID publication is missing (offline)", async () => {
    // Fault injection: the fake runner publishes runner.pid but never
    // child.pid, so the PID read throws. finally must still terminate the
    // owned wrapper (whose group cleanup reaps the descendant) and settle
    // before scratch removal.
    const { proc, fs, path } = await shellDeps();
    const sentinel = trackOwned(proc.spawn("sleep", ["60"], { stdio: "ignore" }));
    const sentinelPid = sentinel.child.pid ?? NaN;
    try {
      await withScratchDir("wrapper-nopid-sibling-", async (sibling) => {
        await withScratchDir("wrapper-nopid-", async (scratch) => {
          const childPidFile = path.join(scratch, "child.pid");
          const runnerPidFile = path.join(scratch, "runner.pid");
          const { fakeNode, fakeWrangler } = await makeFakes(
            scratch,
            `#!/bin/sh\necho "$$" > "${runnerPidFile}"\nsleep 60 &\nsleep 120\n`,
          );
          const ownedDescendants: number[] = [];
          let owned: OwnedChild | undefined;
          let wrapperCode: number | undefined;
          let runnerPid = NaN;
          let reachedFault = false;
          let injected: unknown;
          try {
            owned = trackOwned(
              proc.spawn("bash", ["spike/hyperdrive-semantics/worker-checks.sh"], {
                env: { ...process.env, NODE_BIN: fakeNode, WRANGLER_BIN: fakeWrangler },
                stdio: "ignore",
              }),
            );
            owned.child.on("close", (code) => {
              wrapperCode = code ?? -1;
            });
            for (let i = 0; i < 150 && !Number.isInteger(runnerPid); i++) {
              await new Promise((r) => setTimeout(r, 100));
              try {
                runnerPid = parseInt(fs.readFileSync(runnerPidFile, "utf8").trim(), 10);
              } catch {
                runnerPid = NaN;
              }
            }
            if (Number.isInteger(runnerPid)) ownedDescendants.push(runnerPid);
            expect(Number.isInteger(runnerPid)).toBe(true);
            expect(await isLiveProcess(runnerPid)).toBe(true);
            reachedFault = true;
            const childPid = parseInt(fs.readFileSync(childPidFile, "utf8").trim(), 10);
            if (Number.isInteger(childPid)) ownedDescendants.push(childPid);
            expect(Number.isInteger(childPid)).toBe(true);
          } catch (error) {
            injected = error;
          } finally {
            await settleOwned(owned, ownedDescendants);
          }
          expect(injected).toBeDefined();
          expect(reachedFault).toBe(true);
          expect(Number.isInteger(runnerPid)).toBe(true);
          expect((injected as { code?: string }).code).toBe("ENOENT");
          expect(wrapperCode).toBe(143);
          expect(owned?.settled()).toBe(true);
          expect(await waitReaped(runnerPid)).toBe(true);
        });
        expect(fs.existsSync(sibling)).toBe(true);
      });
      expect(await isLiveProcess(sentinelPid)).toBe(true);
    } finally {
      await stopSentinel(sentinel);
    }
  }, 90_000);

  it("reaps owned descendants when an assertion fails mid-test (offline)", async () => {
    // Fault injection: setup succeeds (both PIDs publish, descendant is
    // observably live) and then an assertion fails before the test sends its
    // own SIGTERM. finally must still terminate the owned wrapper and reap
    // every owned descendant.
    const { proc, fs, path } = await shellDeps();
    const sentinel = trackOwned(proc.spawn("sleep", ["60"], { stdio: "ignore" }));
    const sentinelPid = sentinel.child.pid ?? NaN;
    try {
      await withScratchDir("wrapper-assert-sibling-", async (sibling) => {
        await withScratchDir("wrapper-assert-", async (scratch) => {
          const childPidFile = path.join(scratch, "child.pid");
          const runnerPidFile = path.join(scratch, "runner.pid");
          const { fakeNode, fakeWrangler } = await makeFakes(
            scratch,
            `#!/bin/sh\nsleep 60 &\necho "$!" > "${childPidFile}"\necho "$$" > "${runnerPidFile}"\nsleep 120\n`,
          );
          const ownedDescendants: number[] = [];
          let owned: OwnedChild | undefined;
          let wrapperCode: number | undefined;
          let runnerPid = NaN;
          let childPid = NaN;
          let reachedFault = false;
          let injected: unknown;
          try {
            owned = trackOwned(
              proc.spawn("bash", ["spike/hyperdrive-semantics/worker-checks.sh"], {
                env: { ...process.env, NODE_BIN: fakeNode, WRANGLER_BIN: fakeWrangler },
                stdio: "ignore",
              }),
            );
            owned.child.on("close", (code) => {
              wrapperCode = code ?? -1;
            });
            for (let i = 0; i < 150 && !Number.isInteger(runnerPid); i++) {
              await new Promise((r) => setTimeout(r, 100));
              try {
                runnerPid = parseInt(fs.readFileSync(runnerPidFile, "utf8").trim(), 10);
              } catch {
                runnerPid = NaN;
              }
            }
            if (Number.isInteger(runnerPid)) ownedDescendants.push(runnerPid);
            expect(Number.isInteger(runnerPid)).toBe(true);
            childPid = parseInt(fs.readFileSync(childPidFile, "utf8").trim(), 10);
            if (Number.isInteger(childPid)) ownedDescendants.push(childPid);
            expect(Number.isInteger(childPid)).toBe(true);
            expect(await isLiveProcess(childPid)).toBe(true);
            reachedFault = true;
            expect("actual").toBe("expected");
          } catch (error) {
            injected = error;
          } finally {
            await settleOwned(owned, ownedDescendants);
          }
          expect(injected).toBeDefined();
          expect(reachedFault).toBe(true);
          expect(Number.isInteger(runnerPid)).toBe(true);
          expect(Number.isInteger(childPid)).toBe(true);
          expect(String(injected)).toMatch(/expected 'actual' to be 'expected'/);
          expect(wrapperCode).toBe(143);
          expect(owned?.settled()).toBe(true);
          expect(await waitReaped(runnerPid)).toBe(true);
          expect(await waitReaped(childPid)).toBe(true);
        });
        expect(fs.existsSync(sibling)).toBe(true);
      });
      expect(await isLiveProcess(sentinelPid)).toBe(true);
    } finally {
      await stopSentinel(sentinel);
    }
  }, 90_000);

  it("reaps orphaned descendants when the wrapper ignores SIGTERM (offline)", async () => {
    // Fixture: a fake wrapper that backgrounds one descendant, then ignores
    // SIGTERM and execs into sleep (SIG_IGN survives exec, so the wrapper is
    // immune to settleOwned's SIGTERM). The descendant is a subshell that
    // also ignores SIGTERM before execing sleep, so it survives the wrapper's
    // SIGKILL (which runs no trap) and settleOwned's descendant SIGTERM loop:
    // only the descendant SIGKILL after the 5s waitReaped timeout can reap
    // it. child.pid is published after the wrapper's trap is installed, so
    // cleanup can never signal the wrapper before it ignores TERM. A
    // call-through process.kill spy records the SIGTERM and the SIGKILL sent
    // to the orphan, pinning both descendant loops; deleting either loop (or
    // the wrapper escalation) keeps every other case green because the real
    // wrapper's trap cleans its own process group.
    const { proc, fs, path } = await shellDeps();
    const sentinel = trackOwned(proc.spawn("sleep", ["60"], { stdio: "ignore" }));
    const sentinelPid = sentinel.child.pid ?? NaN;
    try {
      await withScratchDir("wrapper-notrap-sibling-", async (sibling) => {
        await withScratchDir("wrapper-notrap-", async (scratch) => {
          const childPidFile = path.join(scratch, "child.pid");
          const fakeWrapper = path.join(scratch, "fake-wrapper.sh");
          fs.writeFileSync(
            fakeWrapper,
            `#!/bin/sh\n(trap '' TERM; exec sleep 60) &\nchild=$!\ntrap '' TERM\necho "$child" > "${childPidFile}"\nexec sleep 120\n`,
          );
          fs.chmodSync(fakeWrapper, 0o700);
          let owned: OwnedChild | undefined;
          let childPid = NaN;
          const killSpy = vi.spyOn(process, "kill");
          try {
            try {
              owned = trackOwned(proc.spawn("bash", [fakeWrapper], { stdio: "ignore" }));
              for (let i = 0; i < 150 && !Number.isInteger(childPid); i++) {
                await new Promise((r) => setTimeout(r, 100));
                try {
                  childPid = parseInt(fs.readFileSync(childPidFile, "utf8").trim(), 10);
                } catch {
                  childPid = NaN;
                }
              }
              expect(Number.isInteger(childPid)).toBe(true);
              expect(await isLiveProcess(childPid)).toBe(true);
            } finally {
              await settleOwned(owned, Number.isInteger(childPid) ? [childPid] : []);
            }
            expect(Number.isInteger(childPid)).toBe(true);
            expect(owned?.settled()).toBe(true);
            expect(owned?.child.signalCode).toBe("SIGKILL");
            const signalsToChild = killSpy.mock.calls
              .filter(([pid]) => pid === childPid)
              .map(([, signal]) => signal);
            // The orphan ignores SIGTERM by construction, so a recorded
            // SIGTERM proves the descendant TERM loop ran, a recorded SIGKILL
            // proves the KILL loop ran after the 5s waitReaped timeout, and
            // the reaped check below proves the KILL is what reaped it.
            expect(signalsToChild).toContain("SIGTERM");
            expect(signalsToChild).toContain("SIGKILL");
            expect(await waitReaped(childPid)).toBe(true);
          } finally {
            killSpy.mockRestore();
          }
        });
        expect(fs.existsSync(sibling)).toBe(true);
      });
      expect(await isLiveProcess(sentinelPid)).toBe(true);
    } finally {
      await stopSentinel(sentinel);
    }
  }, 90_000);

  it("never signals descendant PIDs already proven reaped (offline)", async () => {
    // Pins the isLiveProcess filter in settleOwned: a PID already observed
    // reaped must never receive SIGTERM/SIGKILL, because the number may
    // already belong to an unrelated process. Signalling a dead PID throws
    // ESRCH into settleOwned's bare catches, so without the spy this mutant
    // is silent: reverting the filter to signal every integer PID keeps every
    // other assertion green.
    const { proc } = await shellDeps();
    const short = proc.spawn("sleep", ["0"], { stdio: "ignore" });
    const deadPid = short.pid ?? NaN;
    expect(Number.isInteger(deadPid)).toBe(true);
    await new Promise<void>((resolve) => {
      short.on("close", () => resolve());
      short.on("error", () => resolve());
    });
    expect(await waitReaped(deadPid)).toBe(true);
    const killSpy = vi.spyOn(process, "kill");
    try {
      await settleOwned(undefined, [deadPid]);
      const fatalSignals = killSpy.mock.calls.filter(
        ([pid, signal]) => pid === deadPid && (signal === "SIGTERM" || signal === "SIGKILL"),
      );
      expect(fatalSignals).toEqual([]);
    } finally {
      killSpy.mockRestore();
    }
  });
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
      startWorker: async () => ({
        stop: async () => {
          stopped.push("stopped");
        },
      }),
      runChecks: async () => {
        throw new Error("boom");
      },
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
      startWorker: async () => ({
        stop: async () => {
          stopped.push("stopped");
        },
      }),
      runChecks: async () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(stopped).toEqual(["stopped"]);
  });
});
