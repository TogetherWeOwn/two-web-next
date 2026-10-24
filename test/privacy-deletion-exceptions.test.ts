// Deletion-exception inventory (DB-free). Pins the public Deletion wording
// against the complete exception inventory: the five deleted row categories
// stay unchanged from v3, while moderator-content authorship marks and
// residual Discord-keyed throttle counters are named without promising
// immediate erasure of either. Also pins the runbook classification
// (creator IDs are identifying data with row-scoped retention; throttle
// cleanup is lazy and admitted-only) and the numbered-version hand-off
// (v6 selected, priors preserved, bundle byte-equal).
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { POLICY_FILE, POLICY_VERSION } from "../src/privacy";
import { POLICY_MARKDOWN } from "../src/privacy-content";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string): string => readFileSync(resolve(root, file), "utf8");
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

const DELETED_CATEGORIES = "your member record, profile, RSVPs, sign-in sessions and join attempts";

function deletionSection(markdown: string): string {
  const start = markdown.indexOf("## Deletion");
  const end = markdown.indexOf("## Changes to this policy");
  expect(start, "policy needs a Deletion section").toBeGreaterThanOrEqual(0);
  expect(end, "policy needs a Changes section after Deletion").toBeGreaterThan(start);
  return markdown.slice(start, end);
}

describe("deletion-exception inventory", () => {
  it("keeps the five deleted row categories unchanged from v3", () => {
    expect(flat(read("content/privacy-policy-v3.md"))).toContain(DELETED_CATEGORIES);
    expect(flat(POLICY_MARKDOWN)).toContain(DELETED_CATEGORIES);
    expect(flat(POLICY_MARKDOWN)).toContain("Signing in again later starts a fresh record.");
  });

  it("names creator marks and residual counters without an exhaustive two-record claim", () => {
    const deletion = deletionSection(POLICY_MARKDOWN);
    expect(deletion).not.toContain("Two records are the exception");
    // Creator identifiers: named as identifying data with a row-scoped end.
    expect(deletion).toMatch(/authorship mark/);
    expect(deletion).toMatch(/identifying data/);
    expect(deletion).toMatch(/lasts as long as the content row does/);
    // Throttle buckets: cross-referenced to the lifecycle above, lazily cleaned.
    expect(deletion).toMatch(/Residual rate-limit counters keyed to\s+your Discord ID/i);
    expect(deletion).toMatch(/\(described above\)/);
    expect(deletion).toMatch(/cleaned up lazily when a later request that runs cleanup arrives/);
  });

  it("promises no immediate erasure of either further trace", () => {
    const deletion = deletionSection(POLICY_MARKDOWN);
    expect(deletion).not.toMatch(/immediat/i);
    expect(deletion).not.toMatch(/at once/);
    expect(deletion).not.toMatch(/within five|exactly five|five-minute.*delet/i);
    expect(deletion).not.toMatch(/guarantee/i);
  });

  it("classifies creator IDs as identifying data with row-scoped retention", () => {
    const docs = read("docs/member-erasure.md");
    const bullet = docs.slice(docs.indexOf("events.created_by"));
    const block = bullet.slice(0, bullet.indexOf("\n- ", 1));
    expect(block).toMatch(/identifying data/);
    expect(block).not.toMatch(/not member data/i);
    expect(block).toMatch(/as long as its content row does/);
    expect(block).not.toMatch(/indefinite|permanent/i);
  });

  it("describes lazy cleanup including the refused-path prune", () => {
    const docs = read("docs/member-erasure.md");
    expect(docs).toMatch(/age cutoff, not a physical\s+deletion deadline/);
    expect(docs).toMatch(/exact-five-minute deletion guarantee/);
    expect(docs).toMatch(/after every verdict, admitted or refused/);
    expect(docs).not.toMatch(/only for admitted\s+requests/);
    expect(docs).not.toMatch(/triggers no cleanup/);
  });

  it("ships as a new numbered version with priors preserved and the bundle regenerated", () => {
    expect(POLICY_VERSION).toBe(6);
    expect(POLICY_FILE).toBe("content/privacy-policy-v6.md");
    for (const prior of [1, 2, 3, 4, 5])
      expect(
        existsSync(resolve(root, `content/privacy-policy-v${prior}.md`)),
        `prior policy version v${prior} must stay in history`,
      ).toBe(true);
    expect(POLICY_MARKDOWN).toBe(read(POLICY_FILE));
  });
});
