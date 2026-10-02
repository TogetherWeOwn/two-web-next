import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// TOG-11811: runners are the throughput ceiling, so a superseded PR push must
// cancel its own runs. Deploy and release runs must never be cancelled midway.
const dir = ".github/workflows";
const workflows = readdirSync(dir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
const triggers = (text: string) => text.split(/\non:\n/)[1]?.split(/\n\S/)[0] ?? "";
const cancels = (text: string) =>
  /\nconcurrency:\n  group: [^\n]+\n  cancel-in-progress: true\n/.test(text);

describe("workflow concurrency", () => {
  it("cancels superseded runs of every pull_request workflow", () => {
    const pr = workflows.filter(({ text }) => /(^|\n)  pull_request:/.test(triggers(text)));
    expect(pr.length).toBeGreaterThan(2);
    expect(pr.filter(({ text }) => !cancels(text)).map(({ name }) => name)).toEqual([]);
  });

  it("never cancels deploy or release runs", () => {
    const protectedRuns = workflows.filter(({ name }) => /^(deploy|release)/.test(name));
    expect(protectedRuns.length).toBeGreaterThan(1);
    expect(
      protectedRuns
        .filter(({ text }) => /cancel-in-progress: true/.test(text))
        .map(({ name }) => name),
    ).toEqual([]);
  });
});
