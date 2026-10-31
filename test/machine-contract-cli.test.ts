// The advertised CLI must not certify a missing or empty guide. Execute the
// real scanner/SDK in an isolated repository fixture, never truncate the guide.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../", import.meta.url).href);

describe("standalone machine-contract CLI", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(
      join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "machine-contract-"),
    );
    mkdirSync(join(root, "ci"));
    mkdirSync(join(root, "docs"));
    copyFileSync(
      join(repo, "ci/check-machine-contract.mjs"),
      join(root, "ci/check-machine-contract.mjs"),
    );
    copyFileSync(
      join(repo, "ci/machine-guide-prose.mjs"),
      join(root, "ci/machine-guide-prose.mjs"),
    );
    copyFileSync(join(repo, "package.json"), join(root, "package.json"));
    copyFileSync(join(repo, "tsconfig.json"), join(root, "tsconfig.json"));
    cpSync(join(repo, "src"), join(root, "src"), { recursive: true });
    symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const run = (guide: string | null) => {
    const path = join(root, "docs/machine-interface.md");
    if (guide === null) rmSync(path, { force: true });
    else writeFileSync(path, guide);
    return spawnSync(process.execPath, ["--import", "tsx", "ci/check-machine-contract.mjs"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
    });
  };

  const checkedGuide = () => readFileSync(join(repo, "docs/machine-interface.md"), "utf8");
  const checkerPath = () => join(root, "ci/check-machine-contract.mjs");
  const withInjectedFailures = (expression: string, action: () => void) => {
    const original = readFileSync(checkerPath(), "utf8");
    const marker = "const MAX_RECEIPT_FAILURES = 50;";
    expect(original).toContain(marker);
    writeFileSync(
      checkerPath(),
      original.replace(marker, `failures.push(...(${expression}));\n${marker}`),
    );
    try {
      action();
    } finally {
      writeFileSync(checkerPath(), original);
    }
  };
  const jsonRun = (timeout = 15_000) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "ci/check-machine-contract.mjs", "--format", "json"],
      {
        cwd: root,
        timeout,
      },
    );
  const receipt = (bytes: Buffer) => {
    expect(bytes.length).toBeLessThanOrEqual(32768);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text);
    for (const failure of parsed.failures as string[]) {
      expect(failure).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
      );
    }
    return parsed;
  };

  it("accepts the checked-in guide with the real schemas and SDK", () => {
    const result = run(readFileSync(join(repo, "docs/machine-interface.md"), "utf8"));
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("machine-contract check passed:");
  });

  it("emits only a passing JSON receipt for the checked-in guide", () => {
    writeFileSync(join(root, "docs/machine-interface.md"), checkedGuide());
    const result = jsonRun();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(receipt(result.stdout).verdict).toBe("pass");
  });

  it("returns a structured mismatch for a directory in place of the guide", () => {
    const path = join(root, "docs/machine-interface.md");
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path);
    try {
      const result = jsonRun();
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr.toString()).toBe(1);
      expect(result.stderr.toString()).toBe("");
      const parsed = receipt(result.stdout);
      expect(parsed.error_code).toBe("machine_contract_mismatch");
      expect(parsed.failures).toContain("guide docs/machine-interface.md is readable");
      expect(JSON.stringify(parsed)).not.toMatch(/EISDIR|errno|Error:/);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("rejects a FIFO guide without waiting for a writer", () => {
    const path = join(root, "docs/machine-interface.md");
    rmSync(path, { recursive: true, force: true });
    const created = spawnSync("mkfifo", [path], { timeout: 3_000 });
    expect(created.error).toBeUndefined();
    expect(created.status, created.stderr.toString()).toBe(0);
    try {
      const result = jsonRun(3_000);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr.toString()).toBe(1);
      expect(result.stderr.toString()).toBe("");
      const parsed = receipt(result.stdout);
      expect(parsed.error_code).toBe("machine_contract_mismatch");
      expect(parsed.failures).toContain("guide docs/machine-interface.md is readable");
      expect(JSON.stringify(parsed)).not.toMatch(/errno|Error:/);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("preserves whole Unicode scalars when cutting guide source", () => {
    writeFileSync(
      join(root, "docs/machine-interface.md"),
      `${checkedGuide()}\n\n${"x".repeat(79)}😀 50 bytes.\n`,
    );
    const result = jsonRun();
    expect(result.status, result.stderr.toString()).toBe(1);
    const parsed = receipt(result.stdout);
    const diagnostic = (parsed.failures as string[]).find((f) =>
      f.includes("outside the canonical Limits"),
    );
    expect(diagnostic).toContain(`${"x".repeat(79)}😀`);
  });

  it("preserves whole Unicode scalars when cutting visible HTML context", () => {
    writeFileSync(
      join(root, "docs/machine-interface.md"),
      `${checkedGuide()}\n\n<div>${"x".repeat(79)}😀 50 bytes.</div>\n`,
    );
    const result = jsonRun();
    expect(result.status, result.stderr.toString()).toBe(1);
    const parsed = receipt(result.stdout);
    const diagnostic = (parsed.failures as string[]).find((f) =>
      f.includes("outside the canonical Limits"),
    );
    expect(diagnostic).toContain(`visible: "${"x".repeat(79)}😀"`);
  });

  it("preserves whole Unicode scalars and sanitizes unpaired surrogates at the final cap", () => {
    writeFileSync(join(root, "docs/machine-interface.md"), checkedGuide());
    withInjectedFailures(
      '["x".repeat(299) + "😀z", "unpaired:" + String.fromCharCode(0xd800)]',
      () => {
        const result = jsonRun();
        expect(result.status, result.stderr.toString()).toBe(1);
        const parsed = receipt(result.stdout);
        expect(parsed.failures).toContain(`${"x".repeat(299)}😀`);
        expect(parsed.failures).toContain("unpaired:�");
      },
    );
  });

  it("bounds the complete Unicode-heavy receipt including its newline", () => {
    writeFileSync(join(root, "docs/machine-interface.md"), checkedGuide());
    withInjectedFailures('Array.from({length: 50}, () => "😀".repeat(300))', () => {
      const result = jsonRun();
      expect(result.status, result.stderr.toString()).toBe(1);
      const parsed = receipt(result.stdout);
      expect(parsed.failure_count).toBe(50);
      expect(parsed.failures.length).toBeGreaterThan(0);
      expect(parsed.failures.length).toBeLessThan(50);
      expect(parsed.failures[0]).toBe("😀".repeat(300));
    });
  });

  it.each([false, true])(
    "drains a failing JSON receipt through a pipe (remove resize capability: %s)",
    (removeResize) => {
      writeFileSync(join(root, "docs/machine-interface.md"), checkedGuide());
      withInjectedFailures(
        'Array.from({length: 50}, (_, i) => String(i).padStart(2, "0") + "x".repeat(280))',
        () => {
          const python = `import fcntl, os, select, subprocess, sys, time\nif sys.argv[2] == "missing":\n    if hasattr(fcntl, "F_SETPIPE_SZ"):\n        delattr(fcntl, "F_SETPIPE_SZ")\n    assert not hasattr(fcntl, "F_SETPIPE_SZ")\nr, w = os.pipe()\nif hasattr(fcntl, "F_SETPIPE_SZ"):\n    assert fcntl.fcntl(w, fcntl.F_SETPIPE_SZ, 4096) == 4096\np = subprocess.Popen([sys.argv[1], '--import', 'tsx', 'ci/check-machine-contract.mjs', '--format', 'json'], stdout=w, stderr=subprocess.PIPE)\nos.close(w)\ntry:\n    time.sleep(1)\n    deadline = time.monotonic() + 10\n    chunks = []\n    while True:\n        ready, _, _ = select.select([r], [], [], max(0, deadline - time.monotonic()))\n        if not ready:\n            raise TimeoutError('checker did not close stdout')\n        chunk = os.read(r, 65536)\n        if not chunk:\n            break\n        chunks.append(chunk)\n    _, err = p.communicate(timeout=max(0.1, deadline - time.monotonic()))\n    sys.stdout.buffer.write(b''.join(chunks))\n    sys.stderr.buffer.write(err)\n    sys.exit(p.returncode)\nfinally:\n    os.close(r)\n    if p.poll() is None:\n        p.kill()\n        p.wait()\n`;
          const result = spawnSync(
            "python3",
            ["-c", python, process.execPath, removeResize ? "missing" : "native"],
            {
              cwd: root,
              timeout: 15_000,
            },
          );
          expect(result.error).toBeUndefined();
          expect(result.status, result.stderr.toString()).toBe(1);
          expect(result.stderr.toString()).toBe("");
          expect(result.stdout.length).toBeGreaterThan(4096);
          const parsed = receipt(result.stdout);
          expect(parsed.failures).toHaveLength(50);
          expect(parsed.failure_count).toBe(50);
        },
      );
    },
  );

  it("drains a delayed stdout write independently of pipe capacity", () => {
    writeFileSync(join(root, "docs/machine-interface.md"), checkedGuide());
    const preload = join(root, "delay-stdout.cjs");
    const marker = join(root, "stdout-intercepted");
    writeFileSync(
      preload,
      `const fs = require("node:fs");
const original = process.stdout.write.bind(process.stdout);
process.stdout.write = function (...args) {
  fs.writeFileSync(process.env.STDOUT_MARKER, "intercepted");
  setTimeout(() => original(...args), 100);
  return false;
};
`,
    );
    withInjectedFailures(
      'Array.from({length: 50}, (_, i) => String(i).padStart(2, "0") + "x".repeat(280))',
      () => {
        const result = spawnSync(
          process.execPath,
          [
            "--require",
            preload,
            "--import",
            "tsx",
            "ci/check-machine-contract.mjs",
            "--format",
            "json",
          ],
          { cwd: root, env: { ...process.env, STDOUT_MARKER: marker }, timeout: 15_000 },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr.toString()).toBe(1);
        expect(result.stderr.toString()).toBe("");
        expect(readFileSync(marker, "utf8")).toBe("intercepted");
        expect(result.stdout.length).toBeGreaterThan(4096);
        const parsed = receipt(result.stdout);
        expect(parsed.failures).toHaveLength(50);
        expect(parsed.failure_count).toBe(50);
      },
    );
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", " \n\t\n"],
    ["missing", null],
  ] as const)("rejects a %s guide with a failing CLI verdict", (_label, guide) => {
    const result = run(guide);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("machine-contract check FAILED:");
    expect(result.stdout).toContain("guide");
    expect(result.stdout).not.toContain("machine-contract check passed:");
    const json = jsonRun();
    expect(json.error).toBeUndefined();
    expect(json.status, json.stderr.toString()).toBe(1);
    expect(receipt(json.stdout).error_code).toBe("machine_contract_mismatch");
  });
});
