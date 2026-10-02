import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The repo is public and the org's self-hosted runner group refuses public
// repos, so any job pinned to a self-hosted label queues forever (TOG-12340).
// Every job must default to GitHub-hosted Linux; the CI_OVERFLOW_* repo vars
// may still route a switch-enabled job elsewhere without a PR.
const dir = ".github/workflows";
const workflows = readdirSync(dir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));

const hosted = "ubuntu-latest";
const overflowSwitch = (job: string) =>
  `\${{ fromJSON((contains(fromJSON(vars.CI_OVERFLOW_JOBS || '[]'), '${job}') && contains(fromJSON(vars.CI_OVERFLOW_EVENTS || '[]'), github.event_name) && vars.CI_OVERFLOW_RUNNER) || '["${hosted}"]') }}`;

function jobs(text: string) {
  const body = text.slice(text.search(/^jobs:\n/m));
  const found: { id: string; runsOn: string | undefined }[] = [];
  for (const block of body.split(/^(?=  [A-Za-z0-9_-]+:\n)/m).slice(1)) {
    const id = block.match(/^  ([A-Za-z0-9_-]+):\n/)?.[1] ?? "";
    found.push({ id, runsOn: block.match(/^    runs-on: (.*)$/m)?.[1] });
  }
  return found;
}

describe("workflow runner labels", () => {
  it("finds every workflow job", () => {
    expect(workflows.length).toBeGreaterThan(0);
    for (const { name, text } of workflows) expect(jobs(text).length, name).toBeGreaterThan(0);
  });

  it("defaults every job to GitHub-hosted Linux", () => {
    for (const { name, text } of workflows) {
      for (const { id, runsOn } of jobs(text)) {
        expect([hosted, overflowSwitch(id)], `${name} job ${id}`).toContain(runsOn);
      }
    }
  });

  it("keeps self-hosted labels out of every workflow", () => {
    for (const { name, text } of workflows) {
      const code = text.split("\n").filter((line) => !/^\s*#/.test(line));
      expect(code.filter((line) => /self-hosted|two-selfhosted/.test(line)), name).toEqual([]);
    }
  });
});
