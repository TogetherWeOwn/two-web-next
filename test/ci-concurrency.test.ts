import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// TOG-11811: runners are the throughput ceiling, so a superseded PR push must
// cancel its own runs. Deploy, rollback and release runs must never be cancelled midway.
const dir = ".github/workflows";
const workflows = readdirSync(dir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
const triggers = (text: string) => text.split(/\non:\n/)[1]?.split(/\n\S/)[0] ?? "";
// ci.yml alone exempts main from cancellation (a cancelled main run cannot
// trigger the staging deploy); its concurrency group stays per ref so main runs
// finish in push order and an older SHA never deploys over a newer one.
const cancels = (text: string) =>
  /\nconcurrency:\n  group: [^\n]+\n  cancel-in-progress: (true|\$\{\{ github\.ref != 'refs\/heads\/main' \}\}|\$\{\{ github\.event_name == 'pull_request' \}\})\n/.test(
    text,
  );
// A bare `cancel-in-progress: true` on a workflow that also runs on push to main
// is only safe when its group is per SHA (main pushes then never share a group).
const pushesMain = (text: string) => /(^|\n)  push:\n    branches: \[main\]/.test(triggers(text));
const bareCancel = (text: string) => /\n  cancel-in-progress: true\n/.test(text);
const groupPerSha = (text: string) =>
  /\nconcurrency:\n  group: [^\n]*github\.sha[^\n]*\n/.test(text);

// No workflow currently needs a schedule that shares main's push group.
const SCHEDULE_SHARES_MAIN_GROUP = new Set<string>();

describe("workflow concurrency", () => {
  it("cancels superseded runs of every pull_request workflow", () => {
    const pr = workflows.filter(({ text }) => /(^|\n)  pull_request:/.test(triggers(text)));
    expect(pr.length).toBeGreaterThan(2);
    expect(pr.filter(({ text }) => !cancels(text)).map(({ name }) => name)).toEqual([]);
  });

  it("never cancels a main push run (CI standard rule 9)", () => {
    const offenders = workflows
      .filter(({ text }) => pushesMain(text) && bareCancel(text) && !groupPerSha(text))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("keeps schedule runs out of main's push-run group in every workflow", () => {
    // With the default queue, a newly queued run cancels any PENDING run in its
    // group, so a nightly sharing main's group would replace a waiting push run.
    const offenders = workflows
      .filter(
        ({ name, text }) =>
          pushesMain(text) &&
          /(^|\n)  schedule:\n/.test(triggers(text)) &&
          !SCHEDULE_SHARES_MAIN_GROUP.has(name),
      )
      .filter(({ text }) => !/\n  group: [^\n]*github\.event_name == 'schedule'[^\n]*\n/.test(text))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("keys e2e dispatch runs apart from main push runs", () => {
    const e2e = workflows.find(({ name }) => name === "e2e.yml")?.text ?? "";
    expect(e2e).toMatch(
      /\n  group: [^\n]*github\.event_name == 'workflow_dispatch' && github\.run_id[^\n]*\n/,
    );
  });

  it("keeps the nightly schedule run out of main's push-run group", () => {
    const ci = workflows.find(({ name }) => name === "ci.yml")?.text ?? "";
    // A pending nightly in main's group would cancel a pending push run, and
    // deploy.yml only deploys push-event runs, so staging would miss that SHA.
    expect(triggers(ci)).toMatch(/\n  schedule:\n    - cron: /);
    expect(ci).toMatch(
      /\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| \(github\.event_name == 'schedule' && 'nightly'\) \|\| github\.ref \}\}\n/,
    );
  });

  it("never cancels deploy, rollback or release runs", () => {
    const protectedRuns = workflows.filter(({ name }) => /^(deploy|rollback|release)/.test(name));
    expect(protectedRuns.length).toBeGreaterThan(1);
    expect(
      protectedRuns
        .filter(({ text }) => /cancel-in-progress: true/.test(text))
        .map(({ name }) => name),
    ).toEqual([]);
  });
});
