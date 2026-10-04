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
});
