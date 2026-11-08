import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Supply-chain hardening for every workflow (grep-level, no YAML parser):
//  - each `uses:` is pinned to a full commit SHA, so a moved tag cannot swap code
//    into a job that holds secrets;
//  - each `actions/checkout` sets `persist-credentials: false`, so checkout's
//    retained credentials are not available to `npm ci` lifecycle scripts;
//  - no workflow grants a write scope to every job; a job that needs one declares
//    it itself.
const dir = ".github/workflows";
const workflows = readdirSync(dir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, lines: readFileSync(join(dir, name), "utf8").split("\n") }));

type LaneStep = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  shell?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};

const laneSource = readFileSync(join(dir, "db-free-lane.yml"), "utf8");
const lane = parse(laneSource) as {
  on: Record<string, { inputs: Record<string, unknown> }>;
  permissions: Record<string, string>;
  jobs: Record<string, { steps: LaneStep[]; "runs-on": string; "timeout-minutes": number }>;
};
const laneJob = lane.jobs["db-free"];
const laneSteps = laneJob?.steps ?? [];
const laneStep = (id: string) => laneSteps.find((step) => step.id === id);
const vitestCommand =
  "env -u DATABASE_URL -u AUDIT_IMPORT_TEST_DATABASE_URL -u LEGACY_DATABASE_URL -u BOT_DATABASE_URL -u MIGRATION_TEST_DATABASE_URL npx vitest run --reporter=default --reporter=json --outputFile.json=artifacts/db-free/vitest.json";

const indent = (line: string) => line.length - line.trimStart().length;
const isComment = (line: string) => /^\s*#/.test(line);

/** `uses:` values (unquoted, trailing comment dropped) with their 1-based line. */
function usesRefs(lines: string[]) {
  const found: { line: number; ref: string }[] = [];
  lines.forEach((text, i) => {
    if (isComment(text)) return;
    const ref = text.match(/^\s*(?:- )?uses:\s*["']?([^\s"'#]+)/)?.[1];
    if (ref) found.push({ line: i + 1, ref });
  });
  return found;
}

/** Lines of the step that owns the `uses:` line at `usesIndex` (0-based). */
function stepOf(lines: string[], usesIndex: number) {
  const usesLine = lines[usesIndex] ?? "";
  const itemIndent = /^\s*- /.test(usesLine) ? indent(usesLine) : indent(usesLine) - 2;
  let start = usesIndex;
  while (
    start > 0 &&
    !(indent(lines[start] ?? "") === itemIndent && /^\s*- /.test(lines[start] ?? ""))
  )
    start -= 1;
  let end = usesIndex + 1;
  while (
    end < lines.length &&
    ((lines[end] ?? "").trim() === "" || indent(lines[end] ?? "") > itemIndent)
  )
    end += 1;
  return lines.slice(start, end);
}

/** The top-level `permissions:` entry: its inline value plus any indented block. */
function topLevelPermissions(lines: string[]) {
  const at = lines.findIndex((line) => /^permissions:/.test(line));
  if (at === -1) return undefined;
  const body = [lines[at] ?? ""];
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || isComment(line) || indent(line) > 0) body.push(line);
    else break;
  }
  return body.filter((line) => !isComment(line) && line.trim() !== "");
}

describe("workflow supply-chain hardening", () => {
  it("makes the Semgrep sink and secret scan fail closed", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const step = workflow.match(/      - name: Semgrep \(HARD\)([\s\S]*?)(?=      - name:|$)/)?.[1];

    expect(step, "Semgrep HARD step exists in the check workflow").toBeDefined();
    expect(step).not.toMatch(/^\s+continue-on-error:/m);
    expect(step).toContain("semgrep==1.180.0");
    expect(step).toContain("node ci/semgrep-warn-selftest.mjs");
    expect(step).toContain("--strict --error --config ci/semgrep-rules.yml");
  });
  it("finds the workflows and their action refs", () => {
    expect(workflows.length).toBeGreaterThan(0);
    for (const { name, lines } of workflows)
      expect(usesRefs(lines).length, name).toBeGreaterThan(0);
  });

  it("pins every action to a full commit SHA", () => {
    const unpinned: string[] = [];
    for (const { name, lines } of workflows) {
      for (const { line, ref } of usesRefs(lines)) {
        if (ref.startsWith("./")) continue;
        const pinned = ref.startsWith("docker://")
          ? /@sha256:[0-9a-f]{64}$/.test(ref)
          : /@[0-9a-f]{40}$/.test(ref);
        if (!pinned) unpinned.push(`${name}:${line} ${ref}`);
      }
    }
    expect(unpinned).toEqual([]);
  });

  it("never persists the checkout token", () => {
    const persisted: string[] = [];
    let checkouts = 0;
    for (const { name, lines } of workflows) {
      for (const { line, ref } of usesRefs(lines)) {
        if (!ref.startsWith("actions/checkout@")) continue;
        checkouts += 1;
        const step = stepOf(lines, line - 1).filter((text) => !isComment(text));
        if (!step.some((text) => /^\s+persist-credentials:\s*false\s*$/.test(text)))
          persisted.push(`${name}:${line}`);
      }
    }
    expect(checkouts).toBeGreaterThan(0);
    expect(persisted).toEqual([]);
  });

  it("declares workflow-level permissions and grants no write scope there", () => {
    const missing: string[] = [];
    const writable: string[] = [];
    for (const { name, lines } of workflows) {
      const block = topLevelPermissions(lines);
      if (!block) {
        missing.push(name);
        continue;
      }
      for (const text of block) {
        const value = text.replace(/\s+#.*$/, "");
        if (/\bwrite(-all)?\b/.test(value)) writable.push(`${name}: ${value.trim()}`);
      }
    }
    expect(missing).toEqual([]);
    expect(writable).toEqual([]);
  });
});

describe("dispatch-only DB-free lane", () => {
  it("accepts only a required SHA input and no automatic triggers", () => {
    expect(Object.keys(lane.on)).toEqual(["workflow_dispatch"]);
    expect(lane.on.workflow_dispatch?.inputs).toEqual({
      sha: {
        description: "Full lowercase commit SHA to test without database configuration",
        required: true,
        type: "string",
      },
    });
    expect(Object.keys(lane.jobs)).toEqual(["db-free"]);
    expect(readFileSync(join(dir, "ci.yml"), "utf8")).not.toContain("db-free-lane");
  });

  it("uses a bounded hosted runner with read-only contents and no secrets or services", () => {
    expect(Object.keys(lane).sort()).toEqual(["jobs", "name", "on", "permissions"]);
    expect(lane.permissions).toEqual({ contents: "read" });
    expect(Object.keys(laneJob ?? {}).sort()).toEqual(["runs-on", "steps", "timeout-minutes"]);
    expect(laneJob?.["runs-on"]).toBe("ubuntu-latest");
    expect(laneJob?.["timeout-minutes"]).toBe(45);
    expect(laneSource).not.toMatch(/secrets\s*[.[]|github\.token|continue-on-error/);
    expect(laneSteps.filter((step) => step.uses).map((step) => step.uses?.split("@")[0])).toEqual([
      "actions/checkout",
      "actions/setup-node",
      "actions/upload-artifact",
    ]);
    for (const step of laneSteps) expect(step.run ?? "").not.toContain("${{");
  });

  it("rejects malformed SHA values in the actual pre-checkout shell", () => {
    const validation = laneStep("validate");
    expect(validation?.env).toEqual({ TARGET_SHA: "${{ inputs.sha }}" });
    expect(validation?.shell).toBe("bash");
    expect(laneSteps.indexOf(validation as LaneStep)).toBe(0);
    const valid = "0123456789abcdef".repeat(2) + "01234567";
    for (const [sha, status] of [
      [valid, 0],
      ["", 1],
      [valid.slice(1), 1],
      [`${valid}0`, 1],
      [valid.toUpperCase(), 1],
      ["main", 1],
      [`${valid}\n`, 1],
      [` ${valid}`, 1],
      ["a".repeat(39) + "ａ", 1],
      ["$(exit 0)", 1],
    ] as const) {
      const result = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-e", "-c", validation?.run ?? "exit 99"],
        {
          env: { TARGET_SHA: sha, GITHUB_OUTPUT: "/dev/null" },
          encoding: "utf8",
          timeout: 5000,
        },
      );
      expect(result.status, JSON.stringify(sha)).toBe(status);
    }
  });

  it("checks out and prints exactly the requested head before installing", () => {
    const checkout = laneStep("checkout");
    const ciCheckout = usesRefs(readFileSync(join(dir, "ci.yml"), "utf8").split("\n")).find(
      ({ ref }) => ref.startsWith("actions/checkout@"),
    );
    expect(checkout?.uses).toBe(ciCheckout?.ref);
    expect(checkout?.with).toEqual({ ref: "${{ inputs.sha }}", "persist-credentials": false });
    expect(laneSteps.indexOf(checkout as LaneStep)).toBe(1);
    const head = laneStep("head");
    expect(laneSteps.indexOf(head as LaneStep)).toBe(2);
    expect(head?.env).toEqual({ TARGET_SHA: "${{ inputs.sha }}" });
    expect(head?.run).toContain("head=$(git rev-parse HEAD)");
    expect(head?.run).toContain('test "$head" = "$TARGET_SHA"');
    expect(head?.run).toContain("printf 'HEAD=%s\\n'");
    expect(head?.run).toContain('"$head" > artifacts/db-free/head.txt');
    const node = laneSteps.find((step) => step.uses?.startsWith("actions/setup-node@"));
    expect(node?.with).toEqual({ "node-version": 24, "package-manager-cache": false });
    expect(laneStep("install")?.run).toBe("npm ci --include=dev");
  });

  it("refuses even empty database variables without logging values, then runs the full config", () => {
    const script = laneStep("vitest")?.run ?? "";
    expect(script).toContain(vitestCommand);
    expect(script.trim().endsWith(vitestCommand)).toBe(true);
    const guard = script.slice(0, script.indexOf(vitestCommand));
    for (const name of [
      "DATABASE_URL",
      "AUDIT_IMPORT_TEST_DATABASE_URL",
      "OTHER_DATABASE_URL_X",
      "PGHOST",
      "PGPASSWORD",
    ]) {
      for (const value of ["", "private-value-marker"]) {
        const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", guard], {
          env: { [name]: value },
          encoding: "utf8",
          timeout: 5000,
        });
        expect(result.status, name).toBe(1);
        expect(result.stdout + result.stderr).not.toContain("private-value-marker");
      }
    }
    expect(spawnSync("bash", ["-e", "-c", guard], { env: {}, timeout: 5000 }).status).toBe(0);
  });

  it("always retains SHA-named evidence for fourteen days without hiding failures", () => {
    const receipt = laneSteps.find(
      (step) => step.name === "Record workflow outcomes even on failure",
    );
    expect(receipt?.if).toBe("always()");
    expect(receipt?.run).toContain("artifacts/db-free/workflow-status.json");
    expect(receipt?.env?.VITEST_OUTCOME).toBe("${{ steps.vitest.outcome }}");
    const upload = laneSteps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.if).toBe("always()");
    expect(upload?.with).toEqual({
      name: "db-free-${{ steps.validate.outputs.sha || github.run_id }}",
      path: "artifacts/db-free/",
      "if-no-files-found": "error",
      "retention-days": 14,
    });
    expect(laneSteps.at(-1)).toBe(upload);
  });
});
