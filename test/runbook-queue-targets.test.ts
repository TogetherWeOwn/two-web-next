import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone CI tooling has no declaration file.
import { readWranglerConfig } from "../ci/wrangler-config.mjs";

// Offline documentation contract for environment-correct queue containment.
// Execute the documented Bash, not a mirror. Its only external commands resolve
// to inert stubs on an isolated PATH, with no inherited credentials or network calls.
const runbook = readFileSync(new URL("../docs/runbook.md", import.meta.url), "utf8");
const queueSection = runbook
  .split("## Queue containment, drain and failed-job replay")[1]!
  .split("## Backups and restore drill")[0]!;

const main = readWranglerConfig(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);
const jobs = readWranglerConfig(
  readFileSync(new URL("../wrangler.jobs.jsonc", import.meta.url), "utf8"),
);

const queueNames = (config: {
  queues?: { producers?: { queue: string }[]; consumers?: { queue: string }[] };
}) => (config.queues?.consumers ?? []).map((entry) => entry.queue);

// Checked-in expectations, derived from configs (not hardcoded names).
const stagingQueues = queueNames(jobs);
const stagingOwner = jobs.name as string;
const stagingTail = jobs.tail_consumers?.[0]?.service as string;
const stagingOrigin = jobs.vars?.APP_URL as string;
const production = main.env?.production;
const productionQueues = queueNames(production ?? {});
const productionOwner = production?.name as string;
const productionTail = production?.tail_consumers?.[0]?.service as string;
const productionOrigin = production?.vars?.APP_URL as string;

const environments = [
  {
    environment: "staging",
    queues: stagingQueues,
    owner: stagingOwner,
    tail: stagingTail,
    origin: stagingOrigin,
  },
  {
    environment: "production",
    queues: productionQueues,
    owner: productionOwner,
    tail: productionTail,
    origin: productionOrigin,
  },
];
const gatedBlocks = [
  { marker: "# GATED CONTAINMENT:", action: "pause-delivery" },
  { marker: "# GATED RESUME:", action: "resume-delivery" },
];

function documentedShell(marker: string): string {
  const blocks = [...queueSection.matchAll(/```bash\n([\s\S]*?)\n```/g)]
    .map((match) => match[1]!)
    .filter((block) => block.includes(marker));
  expect(blocks).toHaveLength(1);
  return blocks[0]!;
}

function withSelectionProbe(script: string): string {
  // Emit the fence's selected values from inside the executed subshell, just
  // before it closes. QUEUES is already asserted via recorded npx commands;
  // UP_URL and OWNER never reach a command (readback comment only), so without
  // this probe a cross-environment swap of those two assignments stays green.
  const probe = `  printf 'RUNBOOK_SELECTION\\t%s\\t%s\\t%s\\n' "\${QUEUES[*]}" "\${UP_URL:-}" "\${OWNER:-}"\n)`;
  expect(script.endsWith("\n)")).toBe(true);
  return script.replace(/\n\)$/, `\n${probe}`);
}

function runDocumentedShell(script: string, environment: string | undefined) {
  const directory = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "queue-doc-shell-",
    ),
  );
  try {
    const log = join(directory, "commands");
    writeFileSync(log, "");
    for (const command of ["npx", "curl"]) {
      writeFileSync(
        join(directory, command),
        `#!/bin/bash\n{ printf '${command}'; printf '\\t%s' "$@"; printf '\\n'; } >> "$RUNBOOK_COMMAND_LOG"\n`,
        { mode: 0o700 },
      );
    }
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", script], {
      cwd: directory,
      env: {
        PATH: directory,
        HOME: directory,
        RUNBOOK_COMMAND_LOG: log,
        ...(environment === undefined ? {} : { ENVIRONMENT: environment }),
      },
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    const commands = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"));
    return { status: result.status, stderr: result.stderr, stdout: result.stdout, commands };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function tableCells(row: string): string[] {
  return row
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function inlineCode(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
}

describe("runbook queue incident targets by environment", () => {
  it("derives the staging/production matrix from checked-in configs", () => {
    // Pin the exact checked-in split so a config move fails here first.
    expect(stagingQueues).toEqual(["two-sync-event", "two-internal-action"]);
    expect(stagingOwner).toBe("two-web-jobs");
    expect(stagingTail).toBe("two-web-next-alerts");
    expect(stagingOrigin).toBe("https://next.togetherweown.com");
    expect(productionQueues).toEqual([
      "two-web-next-production-sync-event",
      "two-web-next-production-internal-action",
    ]);
    expect(productionOwner).toBe("two-web-next-production");
    expect(productionTail).toBe("two-web-next-alerts-production");
    expect(productionOrigin).toBe("https://togetherweown.com");
    // The planned jobs transfer is not deployed: jobs has no production env.
    expect(jobs.env ?? {}).not.toHaveProperty("production");
    expect(main.triggers?.crons).toEqual([]);
    expect(production?.triggers?.crons).toContain("*/10 * * * *");

    expect(queueSection).toContain("Queue incident targets by environment");
    const matrix = queueSection.split("#### Staging (read-only metadata)")[0]!;
    const rows = matrix.split("\n").filter((line) => /^\| (staging|production) \|/.test(line));
    expect(rows.map(tableCells)).toEqual(
      environments.map(({ environment, queues, owner, tail, origin }) => [
        environment,
        queues.map((queue) => `\`${queue}\``).join(", "),
        `\`${owner}\``,
        `\`${tail}\``,
        `\`${origin}\``,
      ]),
    );
  });

  it("associates each first-responder diagnostic with that environment's queues", () => {
    const rows = runbook.split("\n").filter((line) => line.startsWith("| `queue.failing`"));
    expect(rows).toHaveLength(1);
    const diagnostic = tableCells(rows[0]!)[2]!;
    expect(diagnostic).toContain("Choose environment first (no silent default): staging ");
    const staging = diagnostic.split(": staging ")[1]!.split(", production ")[0]!;
    const production = diagnostic
      .split(", production ")[1]!
      .split(" (transport metadata only)")[0]!;
    expect(inlineCode(staging)).toEqual([
      `npx wrangler queues info ${stagingQueues[0]}`,
      ...stagingQueues.slice(1),
    ]);
    expect(inlineCode(production)).toEqual(productionQueues);
    expect(diagnostic).toContain("do not purge or replay");
  });

  it("labels checked-in expectations versus required authorized live readback", () => {
    expect(queueSection).toMatch(/checked-in expectations/i);
    expect(queueSection).toMatch(/live readback/i);
    expect(queueSection).toMatch(/wrangler\.jsonc/);
    expect(queueSection).toMatch(/wrangler\.jobs\.jsonc/);
    expect(queueSection).toMatch(/queues info/);
    expect(queueSection).toMatch(/consumer list/);
    expect(queueSection).toMatch(/deployments status/);
    // Never assume the planned jobs transfer is already deployed.
    expect(queueSection).toMatch(/never assume.*planned jobs transfer/i);
    expect(queueSection).toMatch(/has no production env/);
    expect(queueSection).toContain(`\`${productionOwner}\``);
  });

  it("supplies separately labelled read-only and gated examples with no silent default", () => {
    expect(queueSection).toMatch(/Staging \(read-only metadata\)/);
    expect(queueSection).toMatch(/Production \(read-only metadata\)/);
    expect(queueSection).toMatch(/Gated containment and resume/);
    expect(queueSection).toMatch(/no silent default/i);
    expect(queueSection).toMatch(/ENVIRONMENT.*required.*no default/i);
    // Fail closed on an unknown/mismatched target before mutation.
    expect(queueSection).toContain(': "${ENVIRONMENT:?set ENVIRONMENT to staging or production}"');
    expect(queueSection).toMatch(/unknown ENVIRONMENT=.*refusing to mutate/);
    expect(queueSection).toMatch(/exit 1/);
    expect(queueSection).toMatch(/On any mismatch, stop/);
    // No silent-default shell patterns in the documented selection.
    expect(queueSection).not.toMatch(/ENVIRONMENT:-[^?]/);
    expect(queueSection).not.toMatch(/ENVIRONMENT:=/);
    expect(queueSection).not.toMatch(/ENVIRONMENT-\}/);
    expect(queueSection).not.toMatch(/\|\| "staging"/);
  });

  it("keeps staging and production targets disjoint across examples", () => {
    const stagingReadonly = queueSection
      .split("Staging (read-only metadata)")[1]!
      .split("Production (read-only metadata)")[0]!;
    const productionReadonly = queueSection
      .split("Production (read-only metadata)")[1]!
      .split("Gated containment and resume")[0]!;
    for (const queue of stagingQueues) {
      expect(stagingReadonly).toContain(queue);
      expect(productionReadonly).not.toContain(queue);
    }
    for (const queue of productionQueues) {
      expect(productionReadonly).toContain(queue);
      expect(stagingReadonly).not.toContain(queue);
    }
    expect(stagingReadonly).toContain(stagingOrigin);
    expect(stagingReadonly).not.toContain(productionOrigin);
    expect(productionReadonly).toContain(productionOrigin);
    expect(productionReadonly).not.toContain(stagingOrigin);
    expect(stagingReadonly).toContain(stagingOwner);
    expect(productionReadonly).toContain(productionOwner);
  });

  it.each(environments)(
    "pins every read-only command and Tail comment for $environment",
    ({ environment, queues, owner, tail, origin }) => {
      const script = documentedShell(`# READ-ONLY: ${environment} transport metadata`);
      const result = runDocumentedShell(script, undefined);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      // Queue names can contain the owner, so presence alone cannot pin --name.
      expect(result.commands).toEqual([
        ...queues.map((queue) => ["npx", "--no-install", "wrangler", "queues", "info", queue]),
        ...queues.map((queue) => [
          "npx",
          "--no-install",
          "wrangler",
          "queues",
          "consumer",
          "list",
          queue,
        ]),
        ["npx", "--no-install", "wrangler", "deployments", "status", "--name", owner, "--json"],
        ["curl", "-sS", "--max-time", "10", `${origin}/up`],
      ]);
      expect(script.split("\n").map((line) => line.trim())).toContain(
        `# Tail paging source for ${environment}: ${tail}.`,
      );
    },
  );

  it("explains pause limits, per-environment gates and owned-pause resume evidence", () => {
    expect(queueSection).toMatch(/does not stop producers/i);
    expect(queueSection).toMatch(/cron.*continue|scheduled handler/i);
    expect(queueSection).toMatch(/in-flight work may remain/i);
    expect(queueSection).toMatch(/retention/i);
    expect(queueSection).toMatch(/downstream.*readiness|readiness.*downstream/i);
    expect(queueSection).toContain(stagingOrigin);
    expect(queueSection).toContain(productionOrigin);
    expect(queueSection).toMatch(/owned[ -]pause/i);
    expect(queueSection).toMatch(/existing.*transport/i);
    // Falling ledger depth is not proof of successful bot delivery.
    expect(queueSection).toMatch(/falling ledger depth is not proof/i);
    expect(queueSection).toMatch(/not proof of successful bot delivery/i);
    expect(queueSection).toMatch(/transport.*ledger.*separate|ledger.*transport.*separate/i);
  });

  it("keeps preview/redispatch staging-only and bounds production containment", () => {
    expect(queueSection).toMatch(/staging-only/i);
    expect(queueSection).toMatch(/default-off/i);
    expect(queueSection).toMatch(/separately authorized/i);
    expect(queueSection).toMatch(/queue-redrive-runbook\.md/);
    expect(queueSection).toMatch(/production containment does not authorize/i);
    expect(queueSection).toMatch(/replay/);
    expect(queueSection).toMatch(/SQL inspection\/probes/);
    expect(queueSection).toMatch(/credentials/);
    expect(queueSection).toMatch(/migration/);
    expect(queueSection).toMatch(/ownership changes/);
    // Preserve all no-purge/no-delete and existing explicit holds.
    expect(queueSection).toMatch(/do not purge/i);
    expect(queueSection).toMatch(/delete\/recreate\s+queues/);
    expect(queueSection).toMatch(/remove\s+consumers/);
    expect(queueSection).toMatch(/holds/i);
  });

  describe.each(gatedBlocks)("documented $action Bash fence", ({ marker, action }) => {
    it.each(environments)(
      "uses only $environment targets with inert command stubs",
      ({ environment, queues }) => {
        const result = runDocumentedShell(documentedShell(marker), environment);
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        const expected = queues.map((queue) => [
          "npx",
          "--no-install",
          "wrangler",
          "queues",
          action,
          queue,
        ]);
        if (action === "pause-delivery") {
          expected.push(
            ...queues.map((queue) => ["npx", "--no-install", "wrangler", "queues", "info", queue]),
          );
        }
        expect(result.commands).toEqual(expected);
      },
    );

    it.each([undefined, "", "unknown", "prod", "Staging", "Production"])(
      "refuses ENVIRONMENT=%s before any external command",
      (environment) => {
        const result = runDocumentedShell(documentedShell(marker), environment);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(
          /set ENVIRONMENT to staging or production|refusing to mutate/,
        );
        expect(result.commands).toEqual([]);
      },
    );
  });

  it.each(environments)(
    "pins the gated containment UP_URL and OWNER selections for $environment",
    ({ environment, queues, owner, origin }) => {
      const result = runDocumentedShell(
        withSelectionProbe(documentedShell("# GATED CONTAINMENT:")),
        environment,
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const selection = result.stdout
        .split("\n")
        .find((line) => line.startsWith("RUNBOOK_SELECTION\t"));
      expect(selection).toBeDefined();
      const [, queuesSelected, upUrl, ownerSelected] = selection!.split("\t");
      expect(queuesSelected).toBe(queues.join(" "));
      expect(upUrl).toBe(`${origin}/up`);
      expect(ownerSelected).toBe(owner);
    },
  );
});
