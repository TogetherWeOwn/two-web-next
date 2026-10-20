import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { expectedLhrs } from "../ci/lighthouse-quality-run.mjs";

const ORIGIN = "https://next.togetherweown.com";
const workflowPath = fileURLToPath(
  new URL("../.github/workflows/web-quality-origin.yml", import.meta.url),
);
const summaryScript = fileURLToPath(new URL("../ci/lighthouse-summary.mjs", import.meta.url));

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
    for (const url of collect.url) {
      const lhr = {
        requestedUrl: url,
        finalUrl: url,
        finalDisplayedUrl: url,
        categories: Object.fromEntries(
          collect.settings.onlyCategories.map((category) => [
            category,
            { score: 1, auditRefs: [] },
          ]),
        ),
        audits: {},
      };
      for (let run = 0; run < collect.numberOfRuns; run++) {
        writeFileSync(join(lighthouseDir, `lhr-${index}.json`), JSON.stringify(lhr));
        index++;
      }
      writeFileSync(join(qualityDir, `lhr-${index}.json`), JSON.stringify(lhr));
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
