import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The org's two-selfhosted runner group refuses public repos, so a job pinned to
// a self-hosted label queues forever while this repo is public (TOG-12326). Every
// job must reach the self-hosted fleet only behind a repo-visibility check and
// otherwise run on GitHub-hosted Linux; the CI_OVERFLOW_* repo vars may still
// route a switch-enabled job elsewhere without a PR.
const dir = ".github/workflows";
const workflows = readdirSync(dir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));

const hosted = "ubuntu-latest";
const byVisibility = `\${{ github.event.repository.private && fromJSON('["self-hosted","two-selfhosted"]') || '${hosted}' }}`;
const overflowSwitch = (job: string) =>
  `\${{ fromJSON((contains(fromJSON(vars.CI_OVERFLOW_JOBS || '[]'), '${job}') && contains(fromJSON(vars.CI_OVERFLOW_EVENTS || '[]'), github.event_name) && vars.CI_OVERFLOW_RUNNER) || (github.event.repository.private && '["self-hosted","two-selfhosted"]') || '["${hosted}"]') }}`;

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

  it("runs every job on GitHub-hosted Linux unless the repo is private", () => {
    for (const { name, text } of workflows) {
      for (const { id, runsOn } of jobs(text)) {
        expect([hosted, byVisibility, overflowSwitch(id)], `${name} job ${id}`).toContain(runsOn);
      }
    }
  });

  it("keeps self-hosted labels behind the repo-visibility check", () => {
    for (const { name, text } of workflows) {
      const ungated = text
        .split("\n")
        .filter((line) => !/^\s*#/.test(line) && /self-hosted|two-selfhosted/.test(line))
        .filter((line) => !line.includes("github.event.repository.private && "));
      expect(ungated, name).toEqual([]);
    }
  });
});
