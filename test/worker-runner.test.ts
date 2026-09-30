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
