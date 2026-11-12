import { existsSync } from "node:fs";

export const baseCiOkNeeds = [
  "a11y",
  "lighthouse",
  "bundle-budget",
  "docs-links",
  "check",
  "node22-compat",
  "scope",
  "bot-contract-drift",
];

export const evidenceJobs = [
  {
    file: "ci/join-state-evidence-source.test.mjs",
    job: "join-evidence-source",
    variable: "JOIN_SOURCE_RESULT",
  },
  {
    file: "ci/join-state-fixtures.test.mjs",
    job: "join-evidence-fixtures",
    variable: "JOIN_FIXTURES_RESULT",
  },
];

export function ciOkNeeds(block: string): string[] {
  const list = block.match(/\n    needs:\s*\[([^\]]*)\]/)?.[1];
  if (list === undefined) throw new Error("ci-ok needs must be a flow list");
  const entries = list.split(",").map((entry) => entry.trim());
  if (entries.at(-1) === "") entries.pop();
  if (entries.some((entry) => !/^[a-zA-Z0-9_-]+$/.test(entry))) {
    throw new Error("invalid ci-ok dependency list");
  }
  return entries;
}

export function expectedCiOkNeeds(): string[] {
  return [
    ...baseCiOkNeeds,
    ...evidenceJobs.filter(({ file }) => existsSync(file)).map(({ job }) => job),
  ];
}
