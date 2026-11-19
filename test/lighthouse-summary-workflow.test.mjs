import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";
import originLib from "../ci/lighthouse-origin-lib.cjs";
import { expectedLhrs } from "../ci/lighthouse-quality-run.mjs";
import { navigationMetadata } from "./lighthouse-navigation-fixtures.mjs";

const ORIGIN = "https://next.togetherweown.com";
const workflowPath = fileURLToPath(
  new URL("../.github/workflows/web-quality-origin.yml", import.meta.url),
);
const summaryScript = fileURLToPath(new URL("../ci/lighthouse-summary.mjs", import.meta.url));

it("queues same-origin calls and standalone runs without taking the caller's lock", () => {
  const workflow = parse(readFileSync(workflowPath, "utf8"));
  const caller = parse(readFileSync(".github/workflows/e2e-staging.yml", "utf8"));
  const originExpression = "${{ inputs.origin || 'https://next.togetherweown.com' }}";

  expect(workflow.concurrency).toEqual({
    group: "web-quality-origin-all",
    "cancel-in-progress": false,
    queue: "max",
  });
  expect(caller.concurrency.group).not.toContain("web-quality-origin-");
  expect(caller.jobs["staging-quality"].uses).toBe(
    "TogetherWeOwn/two-web-next/.github/workflows/web-quality-origin.yml@38581ef492f5c972969f5dfada396a9f0e2ee989",
  );
  expect(caller.jobs["staging-quality"].with.origin).toBe(ORIGIN);
  expect(caller.jobs["zap-baseline"].uses).toBe(
    "TogetherWeOwn/two-web-next/.github/workflows/zap-staging.yml@38581ef492f5c972969f5dfada396a9f0e2ee989",
  );
  expect(caller.jobs["zap-baseline"].with.candidate_sha).toBe("${{ needs.scope.outputs.sha }}");
  expect(workflow.on.workflow_call.inputs.origin).toEqual({ type: "string", required: true });
  expect(workflow.on.workflow_dispatch.inputs.origin.default).toBe(ORIGIN);
  expect(workflow.on.workflow_dispatch.inputs.origin.options).toEqual([ORIGIN]);
  expect(workflow.on.schedule).toBeDefined();
  expect(workflow.jobs.quality.env.ORIGIN).toBe(originExpression);
});

it("shares the queue across accepted aliases and the scheduled default", () => {
  const workflow = parse(readFileSync(workflowPath, "utf8"));
  const { requireAllowedOrigin } = originLib;
  const scheduledOrigin = workflow.on.workflow_dispatch.inputs.origin.default;

  for (const origin of [ORIGIN, `${ORIGIN}/`, scheduledOrigin]) {
    expect(requireAllowedOrigin(origin)).toBe(ORIGIN);
    // A literal group cannot vary with workflow_call, dispatch, or schedule inputs.
    expect(workflow.concurrency.group).toBe("web-quality-origin-all");
  }
  expect(() => requireAllowedOrigin(`${ORIGIN}/unexpected`)).toThrow();
});

it("runs the deployed summary with the origin configured by its workflow step", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const lines = workflow.split("\n");
  const start = lines.indexOf("      - name: Quality summary (what to fix)");
  const end = lines.findIndex(
    (line, index) => index > start && /^      - (?:name|uses):/.test(line),
  );
  const summaryStep = lines.slice(start, end < 0 ? undefined : end).join("\n");
  const root = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || tmpdir(),
      "lh-summary-workflow-",
    ),
  );

  try {
    const { collect } = expectedLhrs({ env: { QUALITY_ORIGIN: ORIGIN } });
    const lighthouseDir = join(root, ".lighthouseci");
    const qualityDir = join(lighthouseDir, "quality");
    mkdirSync(qualityDir, { recursive: true });
    let index = 0;
    const makeLhr = (url) => ({
      ...navigationMetadata("desktop", { deployed: true }),
      requestedUrl: url,
      finalUrl: url,
      finalDisplayedUrl: url,
      categories: Object.fromEntries(
        collect.settings.onlyCategories.map((category) => [category, { score: 1, auditRefs: [] }]),
      ),
      audits: {},
    });
    for (const url of collect.url) {
      for (let run = 0; run < collect.numberOfRuns; run++) {
        writeFileSync(join(lighthouseDir, `lhr-${index}.json`), JSON.stringify(makeLhr(url)));
        index++;
      }
      writeFileSync(join(qualityDir, `lhr-${index}.json`), JSON.stringify(makeLhr(url)));
      index++;
    }

    const env = { ...process.env, ORIGIN };
    delete env.QUALITY_ORIGIN;
    if (/^          QUALITY_ORIGIN: \$\{\{ env\.ORIGIN \}\}$/m.test(summaryStep)) {
      env.QUALITY_ORIGIN = env.ORIGIN;
    }
    const result = spawnSync(process.execPath, [summaryScript], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 10000,
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(summaryStep).toMatch(/^          QUALITY_ORIGIN: \$\{\{ env\.ORIGIN \}\}$/m);
    for (const url of collect.url) {
      expect(result.stdout).toContain(
        `- ${url}: ${collect.numberOfRuns}/${collect.numberOfRuns} runs`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
