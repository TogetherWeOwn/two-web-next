import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone CI tooling has no declaration file.
import { readWranglerConfig } from "../ci/wrangler-config.mjs";

// Offline documentation contract for environment-correct queue containment.
// No live commands execute here: target selection is exercised through inert
// stubs that record commands without spawning processes or network calls.
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

// Mirror of the documented ENVIRONMENT case statement: fail closed before any
// mutation. Inert: callers pass a stub exec that records commands.
function selectQueueTargets(env: string): { queues: string[]; owner: string; upUrl: string } {
  if (env === "staging") {
    return {
      queues: [...stagingQueues],
      owner: stagingOwner,
      upUrl: `${stagingOrigin}/up`,
    };
  }
  if (env === "production") {
    return {
      queues: [...productionQueues],
      owner: productionOwner,
      upUrl: `${productionOrigin}/up`,
    };
  }
  throw new Error(`unknown ENVIRONMENT=${env}; refusing to mutate`);
}

function assertTargetMatches(env: string, queue: string): void {
  const expected = selectQueueTargets(env).queues;
  if (!expected.includes(queue)) {
    throw new Error(`queue ${queue} does not belong to ${env}; refusing to mutate`);
  }
}

function pauseQueues(env: string, exec: (command: string) => void): string[] {
  const targets = selectQueueTargets(env);
  const recorded: string[] = [];
  for (const queue of targets.queues) {
    assertTargetMatches(env, queue);
    const command = `wrangler queues pause-delivery ${queue}`;
    exec(command);
    recorded.push(command);
  }
  return recorded;
}

function resumeQueues(env: string, exec: (command: string) => void): string[] {
  const targets = selectQueueTargets(env);
  const recorded: string[] = [];
  for (const queue of targets.queues) {
    assertTargetMatches(env, queue);
    const command = `wrangler queues resume-delivery ${queue}`;
    exec(command);
    recorded.push(command);
  }
  return recorded;
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

    // The matrix names every derived target.
    expect(queueSection).toContain("Queue incident targets by environment");
    for (const queue of [...stagingQueues, ...productionQueues]) {
      expect(queueSection).toContain(`\`${queue}\``);
    }
    expect(queueSection).toContain(`\`${stagingOwner}\``);
    expect(queueSection).toContain(`\`${productionOwner}\``);
    expect(queueSection).toContain(`\`${stagingTail}\``);
    expect(queueSection).toContain(`\`${productionTail}\``);
    expect(queueSection).toContain(stagingOrigin);
    expect(queueSection).toContain(productionOrigin);
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

  it("rejects cross-environment substitutions through inert stubs", () => {
    expect(selectQueueTargets("staging").queues).toEqual(stagingQueues);
    expect(selectQueueTargets("production").queues).toEqual(productionQueues);
    expect(() => selectQueueTargets("")).toThrow(/refusing to mutate/);
    expect(() => selectQueueTargets("Staging")).toThrow(/refusing to mutate/);
    expect(() => selectQueueTargets("prod")).toThrow(/refusing to mutate/);
    for (const queue of stagingQueues) {
      expect(() => assertTargetMatches("production", queue)).toThrow(/does not belong/);
    }
    for (const queue of productionQueues) {
      expect(() => assertTargetMatches("staging", queue)).toThrow(/does not belong/);
    }
  });

  it("exercises pause/resume only after validation with inert command stubs", () => {
    const recorded: string[] = [];
    const stub = (command: string) => {
      recorded.push(command);
    };
    expect(pauseQueues("staging", stub)).toEqual([
      "wrangler queues pause-delivery two-sync-event",
      "wrangler queues pause-delivery two-internal-action",
    ]);
    expect(resumeQueues("production", stub)).toEqual([
      "wrangler queues resume-delivery two-web-next-production-sync-event",
      "wrangler queues resume-delivery two-web-next-production-internal-action",
    ]);
    // Fail closed before mutation: unknown env records nothing.
    const before = recorded.length;
    expect(() => pauseQueues("unknown", stub)).toThrow(/refusing to mutate/);
    expect(() => resumeQueues("", stub)).toThrow(/refusing to mutate/);
    expect(recorded).toHaveLength(before);
    // Stub recorded only inert strings; no child processes or network ran.
    expect(recorded.every((command) => command.startsWith("wrangler queues"))).toBe(true);
  });
});
