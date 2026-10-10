import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

// DB-free documentation checks for the first-responder index.
// GitHub slug rules: lowercase, strip everything except a-z0-9, space,
// hyphen and underscore, then replace each space with a hyphen.
function githubSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 \-_]/g, "")
    .replace(/ /g, "-");
}

const runbook = readFileSync(new URL("../docs/runbook.md", import.meta.url), "utf8");

const h2Headings = [...runbook.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim());
const seen = new Map<string, number>();
const h2Slugs = h2Headings.map((heading) => {
  const base = githubSlug(heading);
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
});

const indexStart = runbook.indexOf("First responder index");
const noteStart = runbook.indexOf("Not an incident entry");
const firstH2 = runbook.indexOf("## Safety and escalation");
const indexBlock = runbook.slice(indexStart, runbook.indexOf("## Safety and escalation"));
const noteBlock = runbook.slice(noteStart, runbook.indexOf("## Safety and escalation"));

function indexAnchors(block: string): string[] {
  return [...block.matchAll(/\]\((?:runbook\.md)?#(.*?)\)/g)].map((m) => m[1]!);
}

function indexRows(block: string): string[][] {
  return block
    .split("\n")
    .filter((line) => line.startsWith("| "))
    .slice(2)
    .map((line) => line.split("|").map((cell) => cell.trim()));
}

describe("runbook first-responder index", () => {
  it("sits directly under the intro, before the first section", () => {
    expect(indexStart).toBeGreaterThan(-1);
    expect(noteStart).toBeGreaterThan(indexStart);
    expect(firstH2).toBeGreaterThan(noteStart);
    expect(runbook.slice(0, indexStart)).toContain(
      "staging rollback and DNS flip-back rehearsal is covered here.",
    );
  });

  it("resolves every index anchor to an existing heading with GitHub slug rules", () => {
    const anchors = indexAnchors(indexBlock);
    expect(anchors.length).toBeGreaterThan(0);
    // Spot-check the punctuation-heavy slugs the table relies on.
    expect(h2Slugs).toContain("read-up-without-mistaking-liveness-for-readiness");
    expect(h2Slugs).toContain("neon--hyperdrive-outage-behavior");
    expect(h2Slugs).toContain("secret-rotation-pointer-procedure-only");
    for (const anchor of anchors) {
      expect(h2Slugs, `anchor #${anchor} has no matching ## heading`).toContain(anchor);
    }
  });

  it("reaches every ## section from the index or the not-an-incident note", () => {
    const covered = new Set(indexAnchors(indexBlock));
    expect(covered.size).toBeGreaterThan(0);
    const noteAnchors = indexAnchors(noteBlock);
    expect(noteBlock).toMatch(/not an incident entr/i);
    for (const slug of h2Slugs) {
      const inTable = covered.has(slug);
      const inNote = noteAnchors.includes(slug);
      expect(inTable || inNote, `## section #${slug} is neither linked nor noted`).toBe(true);
    }
  });

  it("covers every required symptom row", () => {
    const lower = indexBlock.toLowerCase();
    for (const phrase of [
      "/up",
      "degraded",
      "error.alert",
      "queue.failing",
      "join",
      "events",
      "rollback",
      "hyperdrive",
      "backup",
    ]) {
      expect(lower, `index misses required symptom: ${phrase}`).toContain(phrase);
    }
  });

  it("gives every row a first read-only diagnostic step", () => {
    const rows = indexRows(indexBlock);
    expect(rows.length).toBeGreaterThanOrEqual(9);
    for (const cells of rows) {
      expect(
        cells.length,
        `row has fewer than 4 columns: ${cells.join(" | ")}`,
      ).toBeGreaterThanOrEqual(6);
      const firstStep = cells[3] ?? "";
      expect(firstStep.length, `empty first-step cell in row: ${cells[1]}`).toBeGreaterThan(10);
      expect(firstStep).toMatch(
        /GET|PUT|curl|wrangler|tail|Observability|revision|readiness|envelope|robots\.txt|backup|selftest|re-read|transport|read\b/i,
      );
    }
  });

  it("scopes staging targets and keeps guarded diagnostics honest", () => {
    // Staging bindings must not triage production: the scope note names the
    // production path, and the backup row must not claim existence-only
    // (check re-downloads every manifest archive locally).
    expect(indexBlock).toContain("cutover-rollback.md");
    expect(indexBlock).toMatch(/staging \(pre-cutover\)/i);
    expect(indexBlock).not.toMatch(/existence only/i);
    const backupLine = indexBlock.split("\n").find((line) => line.includes("Backup and restore"))!;
    expect(backupLine).toMatch(/separate approval/);
    expect(backupLine).toMatch(/EU custody/);
    // rate_limited is a bot sync refusal under backoff, not a DB outage.
    const rateLimitLine = indexBlock.split("\n").find((line) => line.includes("rate_limited"))!;
    expect(rateLimitLine).toContain("queue-containment-drain-and-failed-job-replay");
    expect(rateLimitLine).not.toContain("neon--hyperdrive-outage-behavior");
  });

  it("stays docs-only and public-safe", () => {
    expect(indexBlock).not.toMatch(/TOG-\d+/i);
    expect(indexBlock).not.toMatch(/PAP-\d+/i);
    expect(indexBlock).not.toMatch(/discord\.com\/api\/webhooks/);
    expect(indexBlock).not.toMatch(/agent-testdb|localhost|127\.0\.0\.1/);
  });
});
