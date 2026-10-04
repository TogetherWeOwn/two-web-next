import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

// Offline documentation safety checks; no recovery command is executed.
const rollback = readFileSync(new URL("../docs/cutover-rollback.md", import.meta.url), "utf8");
const runbook = readFileSync(new URL("../docs/runbook.md", import.meta.url), "utf8");
const map = rollback
  .split("## Production cutover capability ↔ reverse map")[1]!
  .split("## Pre-apply snapshot")[0]!;

function mapRow(id: number) {
  const row = map.split("\n").find((line) => line.startsWith(`| ${id} |`));
  expect(row, `capability row ${id}`).toBeDefined();
  return row!;
}

function reverse(id: number) {
  return mapRow(id).split("|")[3]!;
}

describe("cutover rollback documentation safety", () => {
  it("does not describe traffic-bearing deployment as independent ordered preparation", () => {
    expect(map).toContain("non-chronological capability map");
    expect(map).toMatch(/legacy writes must be paused, the\s+import destination quiescent/);
    expect(mapRow(2)).toContain("apex custom domain, queue consumers and crons");
    expect(map).toMatch(/route-free or consumer-free preparation path[\s\S]*separately reviewed/);
  });

  it("distinguishes production Next-to-legacy recovery from staging restoration", () => {
    expect(reverse(3)).toContain("Remove Next custom-domain attachments");
    expect(reverse(3)).toContain("restore saved legacy apex/www record sets");
    expect(reverse(3)).toContain("Do not re-attach Next");
    expect(reverse(3)).toContain("staging `wrangler triggers deploy` fallback");
    expect(mapRow(3)).toContain("Production DNS reverse not tested");
  });

  it("names production queues and requires holds beyond delivery pause", () => {
    expect(reverse(5)).toContain("`two-web-next-production-sync-event`");
    expect(reverse(5)).toContain("`two-web-next-production-internal-action`");
    expect(reverse(5)).not.toContain("`two-sync-event`");
    expect(reverse(5)).not.toContain("`two-internal-action`");
    expect(reverse(5)).toContain("producers, cron and shared-database writers");
    expect(rollback).toMatch(/Delivery pause does not stop\s+producers or the scheduled handler/);
    expect(reverse(5)).toContain("hold mechanism remain missing prerequisites");
  });

  it("does not advertise idempotent upserts as general import reversal", () => {
    expect(reverse(4)).toContain("Same-key corrections only where importer update rules permit");
    expect(reverse(4)).toContain("Wrong identities/keys, extra rows or lost overwritten state");
    expect(reverse(4)).toContain("separately approved backup/repair recovery");
    expect(reverse(4)).toContain("Idempotent upsert is not an inverse");
    expect(rollback).not.toContain("A bad import is therefore backed out by re-running");
  });

  it("separates plan prerequisites from apply-generated recovery and verification evidence", () => {
    const preApply = rollback
      .split("## Pre-apply snapshot")[1]!
      .split("### Migration completion gate")[0]!;
    const completion = rollback
      .split("### Migration completion gate")[1]!
      .split("## Abort triggers")[0]!;
    expect(preApply).toContain("Pending migrations are expected before apply");
    expect(preApply).toContain("do not require zero pending here");
    expect(completion).toContain("`apply` records the pre-migration PITR timestamp");
    expect(completion).toMatch(/apply\/verify must establish[\s\S]*zero\s+pending web migrations/);
    expect(completion).toContain("not as evidence emitted by `plan`");
  });

  it("maps deployed versions through checkout and the gate rather than environment labels", () => {
    const mapping = runbook.split("Map each version to its commit")[1]!.split("3. Baseline:")[0]!;
    expect(mapping).toContain("checkout");
    expect(mapping).toContain("`ref`/`HEAD`");
    expect(mapping).toContain("`Staging gate passed: <sha>`");
    expect(mapping).toContain("`Current Version ID:`");
    expect(mapping).toMatch(/`GITHUB_SHA` values[\s\S]*not checkout\s+receipts/);
    expect(mapping).not.toContain("read `GITHUB_SHA` in the deploy step");
  });

  it("requires confirmed staging deploy/migration exclusion instead of historical timing", () => {
    const worker = runbook
      .split("**Worker rollback (N+1 to N and back)**")[1]!
      .split("**DNS flip to the legacy target and back**")[0]!;
    const checklist = rollback.split("## Ordered revert steps")[1]!.split("## Staging DNS")[0]!;
    for (const procedure of [worker, checklist]) {
      expect(procedure).toContain("confirmed exclusive staging deploy/migration hold");
      expect(procedure).toContain("DevOps & Reliability Engineer");
      expect(procedure).toContain("authorized migration/import operators");
      expect(procedure).toContain("schema/import writes");
      expect(procedure).toContain("applied schema/journal");
      expect(procedure).not.toContain("does not block the drill");
      expect(procedure).not.toContain("does not block the start");
    }
    expect(worker).toMatch(/acknowledgement, effective hold mechanism[\s\S]*start\/end window/);
    expect(worker).toContain("If the hold cannot be confirmed,");
    expect(worker).toMatch(
      /re-confirm it immediately\s+before each rollback\/roll-forward mutation/,
    );
    expect(worker).toContain("not a lock or a minimum runtime");
    expect(checklist).toContain("No confirmed hold means no drill");
  });

  it("retains the deploy/migration hold across DNS mutations until final restoration checks", () => {
    const rehearsal = runbook
      .split("**Worker rollback (N+1 to N and back)**")[1]!
      .split("Rehearsal record:")[0]!;
    const step = (number: number) =>
      rehearsal.split(new RegExp(`^${number}\\. `, "m"))[1]!.split(/^\d+\. /m)[0]!;
    const acquire = step(1);
    const workerFinal = step(7);
    const dnsSnapshot = step(8);
    const flip = step(10);
    const restore = step(12);
    const verify = step(14);
    const release = step(15);
    expect(acquire).toContain("confirmed exclusive staging deploy/migration hold");
    expect(acquire).toContain("DNS steps 8–14");
    expect(workerFinal).toContain("do not release the hold");
    expect(dnsSnapshot).toContain("Re-confirm the same hold before the DNS snapshot");
    for (const mutation of [flip, restore]) {
      expect(mutation).toContain("Re-confirm the hold");
      expect(mutation).toContain("collision response");
    }
    expect(verify).toContain("N+1 at 100%");
    expect(verify).toContain("serving version");
    expect(verify).toContain("unchanged live schema/bindings");
    expect(release).toContain("Only after step 14");
    const releaseInstructions = [
      ...rehearsal.matchAll(/owners release the hold|hold-release acknowledgements/g),
    ];
    expect(releaseInstructions).toHaveLength(1);
    expect(releaseInstructions[0]!.index).toBeGreaterThan(rehearsal.indexOf("14. Read back"));
    expect(release).toContain(releaseInstructions[0]![0]);
    const checklist = rollback.split("## Ordered revert steps")[1]!.split("## Staging DNS")[0]!;
    expect(checklist).toMatch(/DNS half must retain[\s\S]*through DNS\/custom-domain restoration/);
    expect(checklist).toContain("hold-release acknowledgements only after those checks");
  });

  it("stops on a collision and inspects live compatibility before selecting recovery", () => {
    const collision = rollback
      .split("### Staging collision response")[1]!
      .split("## Who calls rollback")[0]!;
    expect(collision).toContain("Stop further drill mutations");
    expect(collision).toMatch(/do not automatically\s+restore the pre-drill version/);
    expect(collision).toContain("without casually cancelling DDL");
    expect(collision).toContain("current serving Worker version");
    expect(collision).toContain("live schema/applied journal");
    expect(collision).toMatch(/N\/N\+1[\s\S]*do not prove compatibility[\s\S]*N\+2/);
    expect(collision).toContain(
      "Select a compatible recovery target with the staging release owner",
    );
    expect(collision).toContain("keeping a healthy intervening release");
    expect(collision).toMatch(
      /restoration is permitted only with a confirmed\s+hold, no intervening release\/schema change/,
    );
    expect(rollback).not.toContain("Restore the pre-drill version and re-run in a quiet window");
    expect(runbook).toMatch(
      /Re-confirm the hold and unchanged live schema\/bindings before rolling\s+forward/,
    );
  });

  it("compares new deployment IDs and overlapping history while allowing oldest eviction", () => {
    const history = runbook
      .split("Compare `dep-before.json` and `dep-after.json`")[1]!
      .split("**DNS flip")[0]!;
    const checklist = rollback.split("## Ordered revert steps")[1]!.split("## Staging DNS")[0]!;
    expect(history).toMatch(/new\s+IDs must be exactly the two recorded rehearsal deployment IDs/);
    expect(history).toContain("no other new deployment in the drill");
    expect(history).toMatch(
      /Overlapping entries must retain[\s\S]*timestamps and\s+version allocations/,
    );
    expect(history).toMatch(/Allow oldest entries to roll off the ten-entry\s+history window/);
    expect(history).toContain("eight overlapping entries and two");
    expect(history).toContain("whole-list or symmetric-difference comparison");
    expect(history).toMatch(
      /insufficient overlapping history makes the check\s+inconclusive, not pass/,
    );
    expect(checklist).toContain("Compare newly added deployment IDs");
    expect(checklist).toContain("unchanged overlapping entries");
    expect(checklist).toContain("eviction alone is not a collision");
    expect(rollback).toMatch(
      /Oldest entries rolling off\s+the ten-entry history window are not a collision/,
    );
    expect(runbook).not.toContain("must differ from `dep-before.json` by the");
    expect(rollback).not.toContain(
      "deployment list differs by more than the two rehearsal deployments",
    );
  });
});
