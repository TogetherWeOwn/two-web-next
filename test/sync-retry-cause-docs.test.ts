// The sync retry-cause contract lives in docs/runbook-logs.md. A new cause
// added to SyncRetryCode must be documented there: this test derives the
// emitted set from the source union and fails until the runbook lists it.
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { refusalRetryCode } from "../src/jobs/sync-retry-diagnostic";

const source = readFileSync(
  new URL("../src/jobs/sync-retry-diagnostic.ts", import.meta.url),
  "utf8",
);
const runbook = readFileSync(new URL("../docs/runbook-logs.md", import.meta.url), "utf8");

function emittedCodes(): string[] {
  const block = source.match(/export type SyncRetryCode\s*=\s*([^;]+);/)?.[1];
  expect(block, "SyncRetryCode union in src/jobs/sync-retry-diagnostic.ts").toBeDefined();
  const codes = [...block!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  expect(new Set(codes).size, "SyncRetryCode union has no duplicates").toBe(codes.length);
  return [...codes].sort();
}

function section(): string {
  const parts = runbook.split("## Sync-event retry-cause diagnostics");
  expect(parts.length, "runbook-logs.md has the retry-cause section").toBe(2);
  return parts[1]!.split("\n## ")[0]!;
}

function documentedCauseSet(body: string): string[] {
  const line = body.split("\n").find((l) => l.startsWith("Documented cause set:"));
  expect(line, "runbook lists a 'Documented cause set:' line").toBeDefined();
  return [...line!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).sort();
}

const FIELDS = [
  "sync_retry_class",
  "sync_retry_code",
  "queue_carrier_attempts",
  "sync_request_attempts",
  "sync_snapshot_age_at_claim_seconds",
];

describe("sync retry-cause runbook contract", () => {
  it("documents exactly the cause set the code emits", () => {
    const emitted = emittedCodes();
    // Guard the extraction itself: every emitted code round-trips at runtime.
    for (const code of emitted) expect(refusalRetryCode({ code })).toBe(code);
    expect(refusalRetryCode({ code: "not-a-real-code" })).toBe("unknown");
    expect(documentedCauseSet(section())).toEqual(emitted);
  });

  it("documents every cause value with a meaning row", () => {
    const body = section();
    for (const code of emittedCodes()) {
      expect(body).toContain(`\`${code}\``);
      expect(
        body.split("\n").some((l) => l.includes(`\`${code}\``) && l.startsWith("|")),
        `cause table row for ${code}`,
      ).toBe(true);
    }
  });

  it("documents the field table, the no-payload guarantee and the tally recipe", () => {
    const body = section();
    for (const field of FIELDS) expect(body).toContain(`\`${field}\``);
    expect(body).toMatch(/no event payload/i);
    expect(body).toMatch(/key material/i);
    expect(body).toContain("sync retry classified");
    expect(body).toContain("npx wrangler tail two-web-next");
  });
});
