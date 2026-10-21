import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as queueCli from "../bin/queue-authwall-probe.mjs";

// Review-fix regressions for the shared probe CLI contract (PR review on
// cd8cddf6). Owned by the Builder: the acceptance file stays untouched.
// Every case runs offline in a subprocess or with fixture transports.

const repoRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const syntheticToken = "review-fix-qa-token-6d1f";
const syntheticCookie = "review-fix-session-4a09";

function scratch() {
  return mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "probe-review-fix-"));
}

function fetchTrap(directory, receipt) {
  const setup = join(directory, "fetch-trap.mjs");
  writeFileSync(
    setup,
    `import { appendFileSync } from "node:fs";
globalThis.fetch = async (input) => {
  appendFileSync(${JSON.stringify(receipt)}, "fetch " + String(input?.url ?? input) + "\\n");
  throw new Error("network disabled in review-fix fixture");
};
`,
  );
  return setup;
}

function run(script, args, { env = {}, cwd = undefined, setup = null } = {}) {
  const entry = join(repoRoot, script);
  const nodeArgs = setup ? ["--import", setup, entry, ...args] : [entry, ...args];
  return spawnSync(process.execPath, nodeArgs, { env, cwd, encoding: "utf8", timeout: 15000 });
}

function runAsync(script, args, { env = {}, cwd = undefined, setup = null } = {}) {
  const entry = join(repoRoot, script);
  const nodeArgs = setup ? ["--import", setup, entry, ...args] : [entry, ...args];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, nodeArgs, { env, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr, error: undefined }));
    child.on("error", (error) => resolve({ status: null, stdout, stderr, error }));
  });
}

function receiptOf(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function withServer(body, runFn) {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(request.url === "/up" ? JSON.stringify(body) : "{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await runFn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("alert flag-like receipt operand refused", () => {
  it.each([{ argv: ["--receipt-file", "--unknown-flag"] }, { argv: ["--receipt-file", "-x"] }])(
    "exits 2 with static usage for $argv before any fetch",
    ({ argv }) => {
      const directory = scratch();
      try {
        const receipt = join(directory, "receipt");
        const setup = fetchTrap(directory, receipt);
        const result = run("bin/alert-probe.mjs", argv, {
          env: { QA_AUTH_TOKEN: syntheticToken, RECEIPT: receipt },
          cwd: directory,
          setup,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Usage:");
        expect(result.stderr).toContain("bin/alert-probe.mjs");
        expect(receiptOf(receipt)).toBe("");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("still accepts a plain filename operand (probe failure, not usage)", () => {
    const directory = scratch();
    try {
      // No token: a plain operand passes argv validation and reaches the probe,
      // which fails closed with exit 1 (never usage exit 2).
      const result = run("bin/alert-probe.mjs", ["--receipt-file", "tail.json"], {
        env: {},
        cwd: directory,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Alert probe failed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("revision loopback allowlist is IP-only", () => {
  it.each([
    { name: "127 hostname", origin: "https://127.attacker.example" },
    { name: "127 nip.io", origin: "https://127.0.0.1.nip.io" },
    { name: "non-http loopback", origin: "ftp://127.0.0.1/" },
  ])("refuses $name with exit 2 and no fetch", ({ origin }) => {
    const directory = scratch();
    try {
      const receipt = join(directory, "receipt");
      const setup = fetchTrap(directory, receipt);
      const result = run("bin/revision-check.mjs", [origin], {
        env: {},
        cwd: directory,
        setup,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Usage:");
      expect(result.stderr).not.toContain(origin);
      expect(receiptOf(receipt)).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "staging origin", origin: "https://next.togetherweown.com" },
    { name: "127.0.0.2 loopback IP", origin: "http://127.0.0.2:9" },
    { name: "127.0.0.1 loopback IP", origin: "http://127.0.0.1:9" },
  ])("allows $name (fetch attempted, never usage)", ({ origin }) => {
    const directory = scratch();
    try {
      const receipt = join(directory, "receipt");
      const setup = fetchTrap(directory, receipt);
      const result = run("bin/revision-check.mjs", [origin], {
        env: {},
        cwd: directory,
        setup,
      });
      // Fetch-trapped: the CLI attempts the fetch, the trap throws, and record
      // mode reports unreadable with exit 0. Refusal would be exit 2, no fetch.
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Live before deploy");
      expect(receiptOf(receipt)).toContain("fetch ");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("revision JSON record unreadable is distinguishable", () => {
  it("reports ok:false with a distinct code, unlike the no-marker verdict", async () => {
    await withServer({ status: "healthy" }, async (origin) => {
      const directory = scratch();
      try {
        const clean = await runAsync("bin/revision-check.mjs", ["--json", origin], {
          env: {},
          cwd: directory,
        });
        expect(clean.error).toBeUndefined();
        expect(clean.status).toBe(0);
        const cleanDoc = JSON.parse(clean.stdout);
        expect(cleanDoc.ok).toBe(true);
        expect(cleanDoc.code).toBe("REVISION_CHECK_OK");
        expect(cleanDoc.checks).toHaveLength(1);
        expect(cleanDoc.checks[0]).toMatchObject({ id: "up-revision-read", ok: true });

        // Port 1 never listens without root: deterministic unreachable loopback.
        const down = await runAsync("bin/revision-check.mjs", ["--json", "http://127.0.0.1:1"], {
          env: {},
          cwd: directory,
        });
        expect(down.error).toBeUndefined();
        expect(down.status).toBe(0);
        expect(down.stderr).toBe("");
        const downDoc = JSON.parse(down.stdout);
        expect(downDoc.ok).toBe(false);
        expect(downDoc.code).toBe("REVISION_CHECK_UNREADABLE");
        expect(downDoc.code).not.toMatch(/OK$/);
        expect(downDoc.checks).toHaveLength(1);
        expect(downDoc.checks[0]).toMatchObject({ id: "up-revision-read", ok: false });
        expect(downDoc.revision).toBeNull();
        expect(downDoc.next.length).toBeGreaterThan(0);
        // Field-for-field distinct from the no-marker verdict.
        expect(JSON.stringify(downDoc)).not.toBe(JSON.stringify(cleanDoc));
        expect(down.stdout).not.toContain("}\n{");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
});

function headers(init = {}, cookies = []) {
  const h = new Headers(init);
  for (const c of cookies) h.append("set-cookie", c);
  return h;
}

function response(status, init = {}, cookies = []) {
  return new Response(null, { status, headers: headers(init, cookies) });
}

function greenFetch(admission = { preview: true, redispatch: true, evidence: true }) {
  return vi.fn(async (url, init) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    const origin = init?.headers?.origin ?? init?.headers?.Origin;
    const cookie = init?.headers?.Cookie ?? init?.headers?.cookie ?? "";
    const presented = init?.headers?.[queueCli.QA_HEADER] ?? "";
    if (path.startsWith("/auth/qa/")) {
      if (presented !== syntheticToken) return response(404);
      return response(204, {}, [`__Host-two_session=${syntheticCookie}; Path=/; Secure`]);
    }
    if (method === "POST" && origin !== queueCli.STAGING_URL) return response(403);
    if (path === queueCli.PREVIEW_PATH) {
      if (!admission.preview) return response(404);
      if (method !== "GET") return response(405, { allow: "GET" });
      if (origin !== queueCli.STAGING_URL) return response(403);
      if (!cookie) return response(302, { location: "/auth/discord" });
      return response(403);
    }
    if (path === queueCli.REDISPATCH_PATH) {
      if (!admission.redispatch) return response(404);
      if (method !== "POST") return response(405, { allow: "POST" });
      if (!cookie)
        return response(303, { location: `/auth/recover?next=${encodeURIComponent(path)}` });
      return response(403);
    }
    if (path === queueCli.SOURCE_EVIDENCE_PATH) {
      if (method !== "GET") return response(405, { allow: "GET" });
      if (!admission.evidence) return response(404);
      return response(403);
    }
    return response(404);
  });
}

describe("queue redispatch check ID is stable across admission", () => {
  it("emits identical ID sequences for enabled and disabled runs", async () => {
    const enabled = await queueCli.runProbe({ token: syntheticToken, fetch: greenFetch() });
    const disabled = await queueCli.runProbe({
      token: syntheticToken,
      fetch: greenFetch({ preview: false, redispatch: false, evidence: false }),
    });
    expect(enabled.checks).toHaveLength(18);
    expect(disabled.checks).toHaveLength(18);
    expect(disabled.checks.map((c) => c.id)).toEqual(enabled.checks.map((c) => c.id));
    // Labels stay distinct while the ID is shared.
    const enabledRedispatch = enabled.checks[3];
    const disabledRedispatch = disabled.checks[3];
    expect(enabledRedispatch.id).toBe("guest-post-redispatch-location");
    expect(disabledRedispatch.id).toBe("guest-post-redispatch-location");
    expect(enabledRedispatch.label).toBe("guest POST redispatch recovery target");
    expect(disabledRedispatch.label).toBe("guest POST redispatch location");
  });
});

describe("revision JSON verify failure is pinned", () => {
  it("exits 1 with ok:false, mismatch code and a failing check (fast)", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const other = "fedcba9876543210fedcba9876543210fedcba98";
    const version = "81da0f67-1e2c-4b6e-9a53-0c7c1d2e3f40";
    await withServer({ revision: { version_id: version, commit } }, async (origin) => {
      const directory = scratch();
      try {
        // Accelerate the 6x10s retry sleep without touching production timing:
        // collapse every setTimeout to 0ms. AbortSignal.timeout is native and
        // unaffected, so fetches still run with their 10s bound.
        const preload = join(directory, "fast-sleep.mjs");
        writeFileSync(
          preload,
          `const orig = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => orig(fn, 0, ...args);
`,
        );
        const summary = join(directory, "summary.md");
        const result = await runAsync("bin/revision-check.mjs", ["--json", origin, other], {
          env: { GITHUB_STEP_SUMMARY: summary },
          cwd: directory,
          setup: preload,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toBe("");
        const doc = JSON.parse(result.stdout);
        expect(doc.version).toBe(1);
        expect(doc.tool).toBe("revision-check");
        expect(doc.mode).toBe("report");
        expect(doc.ok).toBe(false);
        expect(doc.code).toBe("REVISION_CHECK_MISMATCH");
        expect(doc.revision).toBeNull();
        expect(doc.checks).toHaveLength(1);
        expect(doc.checks[0]).toMatchObject({ id: "revision-commit-verified", ok: false });
        expect(doc.next.length).toBeGreaterThan(0);
        // Exactly one JSON document, no attempt logs, no summary write.
        expect(result.stdout).not.toContain("revision attempt");
        expect(result.stdout).not.toContain("Deployed revision verified");
        expect(result.stdout).not.toContain("}\n{");
        expect(receiptOf(summary)).toBe("");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
});
