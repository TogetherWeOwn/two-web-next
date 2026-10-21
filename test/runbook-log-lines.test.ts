import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone CI tooling has no declaration file.
import { readWranglerConfig } from "../ci/wrangler-config.mjs";
import { RECONCILE_CRON } from "../src/jobs/constants";

const SRC_DIR = "src";
const DOCS_PATH = "docs/runbook-logs.md";

/** Recursively collect all .ts and .tsx files under a directory. */
function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (st.isFile() && (extname(entry) === ".ts" || extname(entry) === ".tsx")) {
      files.push(full);
    }
  }
  return files;
}

/** Extract the first argument of console.error("...") calls as a literal string. */
function extractConsoleErrorLiterals(
  filePath: string,
): Array<{ literal: string; line: number; index: number }> {
  const content = readFileSync(filePath, "utf8");
  const results: Array<{ literal: string; line: number; index: number }> = [];
  // Match against the whole file text so `\s*` spans the newline Biome emits
  // when it formats a long message with a non-object second argument across
  // multiple lines. The literal itself stays on one line.
  const re = /console\.error\(\s*(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  for (const m of content.matchAll(re)) {
    // m[2] is the literal content (second capture group)
    const g2: string | undefined = m[2];
    if (typeof g2 === "string" && typeof m.index === "number") {
      const line = content.slice(0, m.index).split("\n").length;
      results.push({ literal: g2, line, index: m.index });
    }
  }
  return results;
}

/** Every console.error( call site, literal or not, with its line number. */
function extractAllConsoleErrorCalls(filePath: string): Array<{ line: number; index: number }> {
  const content = readFileSync(filePath, "utf8");
  const results: Array<{ line: number; index: number }> = [];
  const re = /console\.error\s*\(/g;
  for (const m of content.matchAll(re)) {
    if (typeof m.index === "number") {
      results.push({ line: content.slice(0, m.index).split("\n").length, index: m.index });
    }
  }
  return results;
}

/** Extract documented prefixes from the Failure log lines table in docs/runbook-logs.md. */
function extractDocumentedPrefixes(docsPath: string): Set<string> {
  const content = readFileSync(docsPath, "utf8");
  const prefixes = new Set<string>();
  // Find the Failure log lines section and its table
  const sectionMatch = content.match(/## Failure log lines([\s\S]*?)(?=\n## |$)/);
  if (!sectionMatch) return prefixes;
  const section = sectionMatch[1];
  if (typeof section !== "string") return prefixes;
  // Table rows are | prefix | ... |; the prefix cell may contain backticks
  const rowRe = /^\|\s*`?([^`|]+?)`?\s*\|/gm;
  // matchAll yields RegExpStringIterator; each match has capture groups as strings when matched
  for (const m of section.matchAll(rowRe)) {
    // m[1] is the prefix cell content
    const g1: string | undefined = m[1];
    if (typeof g1 === "string") {
      const trimmed = g1.trim();
      if (trimmed && trimmed !== "---" && !trimmed.toLowerCase().startsWith("message")) {
        prefixes.add(trimmed);
      }
    }
  }
  return prefixes;
}

describe("runbook log lines coverage", () => {
  it("every console.error literal first argument has a row in docs/runbook-logs.md", () => {
    const documented = extractDocumentedPrefixes(DOCS_PATH);
    expect(documented.size).toBeGreaterThan(0);
    const sourceFiles = collectSourceFiles(SRC_DIR);
    const missing: Array<{ file: string; line: number; literal: string }> = [];
    const unshaped: Array<{ file: string; line: number }> = [];

    for (const file of sourceFiles) {
      const literals = extractConsoleErrorLiterals(file);
      for (const { literal, line } of literals) {
        if (!documented.has(literal)) {
          missing.push({ file, line, literal });
        }
      }

      // A console.error( call the literal matcher did not cover (template
      // literal, variable, or member first argument) must be explicitly
      // allowlisted, otherwise the catalogue silently stops covering it.
      // Match by call index, not line: two calls can share one line.
      const calls = extractAllConsoleErrorCalls(file);
      const literalIndexes = new Set(literals.map((l) => l.index));
      const uncovered = calls.filter((call) => !literalIndexes.has(call.index));
      // src/alerts.ts is the shared sink that forwards an already-shaped
      // line; it takes no message literal by design. Allow exactly that call
      // (`console.error(line)`): any other uncovered call still fails.
      const content = readFileSync(file, "utf8");
      for (const call of uncovered) {
        const text = content.slice(call.index, call.index + 20);
        if (file === "src/alerts.ts" && text.includes("console.error(line)")) continue;
        unshaped.push({ file, line: call.line });
      }
    }

    if (missing.length > 0) {
      const details = missing.map((m) => `${m.file}:${m.line}  "${m.literal}"`).join("\n  ");
      throw new Error(
        `Found console.error literals without a row in docs/runbook-logs.md Failure log lines table:\n  ${details}\n\nAdd a row for each literal (exact prefix match) or exclude it via the test allowlist if intentionally out of scope.`,
      );
    }

    if (unshaped.length > 0) {
      const details = unshaped.map((m) => `${m.file}:${m.line}`).join("\n  ");
      throw new Error(
        `Found console.error calls with no string-literal first argument and no allowlist entry:\n  ${details}\n\nAdd a catalogue row for the literal or allowlist the call site in test/runbook-log-lines.test.ts if it takes no message literal by design.`,
      );
    }

    expect(missing).toHaveLength(0);
  });
});

describe("missing sync-queue binding warning docs", () => {
  const WARNING = "event write-back due but SYNC_EVENT_QUEUE is not bound";
  const HEADING = "### Missing sync-queue binding warning";

  /** The new runbook subsection, up to (not including) the next heading. */
  function warningSection(): string {
    const docs = readFileSync(DOCS_PATH, "utf8");
    const start = docs.indexOf(HEADING);
    expect(start, `missing ${HEADING} in ${DOCS_PATH}`).toBeGreaterThanOrEqual(0);
    const rest = docs.slice(start + HEADING.length);
    const next = rest.search(/\n#{1,3} /);
    return next === -1 ? rest : rest.slice(0, next);
  }

  it("documents the exact warning at warn severity with its carried fields", () => {
    const section = warningSection();
    expect(section).toContain(WARNING);
    expect(section).toContain("console.warn");
    expect(section).toContain("eventKey");
    expect(section).toContain("request_id");
  });

  it("explains the committed write, the sync gap, and the Operator route", () => {
    const section = warningSection();
    expect(section).toContain("remains committed");
    expect(section).toContain("not evidence of Discord synchronization");
    expect(section).toContain("Operator");
  });

  it("states reconcile recovery, the real request_id gap, and per-env bindings", () => {
    const section = warningSection();
    // Delayed, not lost: reconcile re-dispatches, unless jobs also lacks the binding.
    expect(section).toContain("late, not lost");
    expect(section).toContain("reconcileEvents");
    expect(section).toContain("every 10");
    expect(section).not.toContain("lost its carrier");
    // Read-only per-event sync-state check, mirroring the enqueue-failed row.
    expect(section).toContain(
      "SELECT * FROM event_sync_attempts JOIN events ON events.id = event_sync_attempts.event_id WHERE events.event_key = '<eventKey>'",
    );
    expect(section).toContain("sync_revision, synced_revision");
    // request_id is absent via the agent-events ingress, not scheduled/reconcile.
    expect(section).toContain("POST /api/agent-events");
    expect(section).toContain("agent_event_audits");
    expect(section).not.toContain("absent for scheduled, reconcile");
    // Top-level producers are staging; production declares its own block.
    expect(section).toContain("env.production.queues.producers");
    expect(section).toContain("two-web-next-production-sync-event");
    expect(section).toContain("two-sync-event");
    // Production reconcile runs on the web Worker: a missing binding there is stuck.
    // Pin the ownership claim itself, not just the Worker name (which is a
    // substring of the production queue name asserted above), and tie it to
    // the wrangler configs so a handoff that moves the cron fails here.
    expect(section).toContain(
      "In the production cutover template this self-healing does not apply:",
    );
    expect(section).toContain("Worker `two-web-next-production` owns both");
    expect(section).toContain("`*/10 * * * *` reconcile");
    expect(section).toContain("cron (`env.production.triggers`, `wrangler.jsonc`)");
    expect(section).toContain("stuck, not late");
    expect(section).toContain("same `env.SYNC_EVENT_QUEUE`");
    expect(section).toContain("which has no production env");
    const production = readWranglerConfig(readFileSync("wrangler.jsonc", "utf8")).env?.production;
    expect(production?.name).toBe("two-web-next-production");
    expect(section).toContain(`Worker \`${production.name}\` owns both`);
    expect(production?.triggers?.crons).toContain(RECONCILE_CRON);
    expect(section).toContain(`\`${RECONCILE_CRON}\` reconcile`);
    expect(production?.queues?.producers).toContainEqual({
      queue: "two-web-next-production-sync-event",
      binding: "SYNC_EVENT_QUEUE",
    });
    const jobsConfig = readWranglerConfig(readFileSync("wrangler.jobs.jsonc", "utf8"));
    expect(jobsConfig.env ?? {}).not.toHaveProperty("production");
  });

  it("source still emits the warning with the documented fields", () => {
    const source = readFileSync("src/events/sync.ts", "utf8");
    expect(source).toContain(`console.warn("${WARNING}"`);
    expect(source).toContain("request_id: message.requestId");
  });
});

describe("analytics write-degradation warning docs", () => {
  const SEARCH_WARNING = "Event search unavailable for logging; serving results without recording.";
  const BOARD_WARNING = "Board view unavailable for logging; serving results without recording.";
  const HEADING = "### Analytics write-degradation warnings";

  /** The new runbook subsection, up to (not including) the next heading. */
  function warningSection(): string {
    const docs = readFileSync(DOCS_PATH, "utf8");
    const start = docs.indexOf(HEADING);
    expect(start, `missing ${HEADING} in ${DOCS_PATH}`).toBeGreaterThanOrEqual(0);
    const rest = docs.slice(start + HEADING.length);
    const next = rest.search(/\n#{1,3} /);
    return next === -1 ? rest : rest.slice(0, next);
  }

  it("documents both exact warnings at warn severity with the exception field", () => {
    const section = warningSection();
    expect(section).toContain(SEARCH_WARNING);
    expect(section).toContain(BOARD_WARNING);
    expect(section).toContain("console.warn");
    expect(section).toContain("`exception`");
    expect(section).toContain("LogWriteDeadline");
  });

  it("explains the awaited timing, the deadline race, and the warn-count rule", () => {
    const section = warningSection();
    expect(section).toContain("`recordSearch` is awaited before the page");
    expect(section).toContain("before or after the response");
    expect(section).toContain("delay the response by up to 500 ms");
    expect(section).toContain("race, not a cancellation");
    expect(section).toContain("second warning with the rejection class");
    expect(section).toContain("Never equate warning count with lost requests");
  });

  it("distinguishes fail-open analytics from mandatory member-read auditing", () => {
    const section = warningSection();
    expect(section).toContain("fail-open anonymous analytics");
    expect(section).toContain("fail-closed mandatory auditing");
    expect(section).toContain("member_data_access_logs");
    expect(section).toContain("normalized_query");
    expect(section).toContain("normalized_board_key");
    expect(section).toContain("carry no member identity");
    expect(section).toContain("warning to its `http.request` by ID, not by time window");
    expect(section).toContain("Kit-served lines omit it");
  });

  it("gives a read-only aggregate check on the analytics tables", () => {
    const section = warningSection();
    expect(section).toContain("event_search_logs");
    expect(section).toContain("board_view_logs");
    expect(section).toContain("max(occurred_at)");
    expect(section).toContain("read-only");
  });

  it("sources emit the warnings with the exception field plus the validated request id only", () => {
    const cases = [
      { file: "src/events/search-log.ts", message: SEARCH_WARNING },
      { file: "src/hotzones/board-log.ts", message: BOARD_WARNING },
    ];
    for (const { file, message } of cases) {
      const source = readFileSync(file, "utf8");
      const call = `console.warn("${message}"`;
      const start = source.indexOf(call);
      expect(start, `missing ${call} in ${file}`).toBeGreaterThanOrEqual(0);
      // The warn payload carries the exception class plus the validated
      // request id only: no query, board key, or member identity travels.
      const payload = source.slice(start, source.indexOf("});", start));
      expect(payload).toContain("exception");
      expect(payload).toContain("request_id");
      expect(payload).not.toContain("normalized");
      expect(source).toContain('warn("LogWriteDeadline")');
      expect(source).toContain("err.constructor.name");
    }
  });
});

describe("queue ledger runbook row cites", () => {
  const CONSUMER_PATH = "src/jobs/consumer.ts";
  const HEADING = "### Queue ledger, lock and malformed-carrier warnings";

  /** The queue-ledger table section, up to (not including) the next heading. */
  function ledgerSection(): string {
    const docs = readFileSync(DOCS_PATH, "utf8");
    const start = docs.indexOf(HEADING);
    expect(start, `missing ${HEADING} in ${DOCS_PATH}`).toBeGreaterThanOrEqual(0);
    const rest = docs.slice(start + HEADING.length);
    const next = rest.search(/\n#{1,3} /);
    return next === -1 ? rest : rest.slice(0, next);
  }

  /** The table row whose first cell is exactly the backticked message. */
  function rowFor(message: string): string {
    const row = ledgerSection()
      .split("\n")
      .find((l) => l.startsWith(`| \`${message}\` |`));
    expect(row, `missing row for \`${message}\` in ${HEADING}`).toBeDefined();
    return row as string;
  }

  /** 1-based line number of the console.warn emitting the literal message. */
  function warnLineFor(message: string): number {
    const lines = readFileSync(CONSUMER_PATH, "utf8").split("\n");
    const idx = lines.findIndex((l) => l.includes("console.warn") && l.includes(message));
    expect(idx, `${CONSUMER_PATH} still warns "${message}"`).toBeGreaterThanOrEqual(0);
    return idx + 1;
  }

  /** 1-based line number of the templated `queue ledger ${what} failed` warn. */
  function ledgerWarnLine(): number {
    const lines = readFileSync(CONSUMER_PATH, "utf8").split("\n");
    const idx = lines.findIndex(
      (l) => l.includes("console.warn") && l.includes("queue ledger") && l.includes("failed"),
    );
    expect(idx, `${CONSUMER_PATH} still warns the ledger template`).toBeGreaterThanOrEqual(0);
    return idx + 1;
  }

  /** The single `src/jobs/consumer.ts:N` cite in the row (not a range or list). */
  function singleCite(row: string): number {
    const m = row.match(/src\/jobs\/consumer\.ts:(\d+)(?![\d,-])/);
    expect(m, `row carries a single ${CONSUMER_PATH}:N cite`).not.toBeNull();
    const n = (m as RegExpMatchArray)[1];
    expect(n, `cite has a line number`).toBeDefined();
    return Number(n as string);
  }

  it("pins each warn-line cite to the source line emitting that row's message", () => {
    // Ledger template row: `<op>` documents the `${what}` parameter.
    expect(singleCite(rowFor("queue ledger <op> failed"))).toBe(ledgerWarnLine());
    // Lock pair.
    expect(singleCite(rowFor("queue lock release timed out"))).toBe(
      warnLineFor("queue lock release timed out"),
    );
    expect(singleCite(rowFor("queue lock release failed"))).toBe(
      warnLineFor("queue lock release failed"),
    );
    // Successor pair.
    expect(singleCite(rowFor("sync successor dispatch timed out; reconcile will retry"))).toBe(
      warnLineFor("sync successor dispatch timed out; reconcile will retry"),
    );
    expect(singleCite(rowFor("sync successor dispatch failed; reconcile will retry"))).toBe(
      warnLineFor("sync successor dispatch failed; reconcile will retry"),
    );
    // Terminal-claim reopen failure (single cite).
    expect(singleCite(rowFor("sync terminal claim reopen failed"))).toBe(
      warnLineFor("sync terminal claim reopen failed"),
    );
  });

  it("pins the malformed-discard range around its warn line", () => {
    const row = rowFor("queue malformed message discarded");
    const m = row.match(/dropped at `src\/jobs\/consumer\.ts:(\d+)-(\d+)`/);
    expect(m, `malformed row carries a dropped-at range`).not.toBeNull();
    const start = Number((m as RegExpMatchArray)[1] as string);
    const end = Number((m as RegExpMatchArray)[2] as string);
    const warn = warnLineFor("queue malformed message discarded");
    expect(warn).toBeGreaterThanOrEqual(start);
    expect(warn).toBeLessThanOrEqual(end);
  });

  it("pins the reopen-timeout shorthand warn cite to its warn line", () => {
    const row = rowFor("sync terminal claim reopen timed out");
    const m = row.match(/warn at `:(\d+)`/);
    expect(m, `reopen-timeout row carries a warn-at shorthand`).not.toBeNull();
    expect(Number((m as RegExpMatchArray)[1] as string)).toBe(
      warnLineFor("sync terminal claim reopen timed out"),
    );
  });
});

describe("refused-write and invite-config warning docs", () => {
  const HEADING = "## Refused-write and invite-config warnings";
  const WARNS = [
    "profile.write.malformed_body",
    "profile.write.shed",
    "event.write.malformed_body",
    "event.write.shed",
    "invite.config.unusable",
    "invite.config.shed",
  ];
  const OLD_INVITE =
    "services.discord.invite_url is unusable; serving the hardcoded fallback invite.";

  /** The new runbook section, up to (not including) the next ## heading. */
  function warningSection(): string {
    const docs = readFileSync(DOCS_PATH, "utf8");
    const start = docs.indexOf(HEADING);
    expect(start, `missing ${HEADING} in ${DOCS_PATH}`).toBeGreaterThanOrEqual(0);
    const rest = docs.slice(start + HEADING.length);
    const next = rest.search(/\n## /);
    return next === -1 ? rest : rest.slice(0, next);
  }

  it("documents every new warn and shed line with its carried fields", () => {
    const section = warningSection();
    for (const line of WARNS) expect(section).toContain(`\`${line}\``);
    expect(section).toContain("`exception`");
    expect(section).toContain("`content_type`");
    expect(section).toContain("`request_id`");
    expect(section).toContain("`dropped`");
    expect(section).toContain("`InviteConfigError`");
  });

  it("states the bucket, the silence rules, and the class-only boundary", () => {
    const section = warningSection();
    // One per-isolate bucket per leg, CSP-sized.
    expect(section).toContain("burst of 20");
    expect(section).toContain("3 seconds");
    expect(section).toContain("per isolate");
    expect(section).toContain("createRateLimitedWarn");
    // Only malformed bodies fire.
    expect(section).toContain("415s");
    expect(section).toContain("validation 422s");
    expect(section).toContain("stay silent");
    // Leak boundary: class-only, never request content.
    expect(section).toContain("never body bytes");
    expect(section).toContain("never the configured value");
  });

  it("links the invite page to the alert runbook and the triage rows", () => {
    const section = warningSection();
    expect(section).toContain("error.alert");
    expect(section).toContain("InviteConfigError@/discord");
    expect(section).toContain("five minutes");
    expect(section).toContain("runbook-alerts.md#source-lines");
    expect(section).toContain("http.request");
    // The profile-save triage row points at the new section.
    const docs = readFileSync(DOCS_PATH, "utf8");
    expect(docs).toContain(
      "[Refused-write and invite-config warnings](#refused-write-and-invite-config-warnings)",
    );
  });

  it("retires the per-call invite error line from source and docs", () => {
    expect(readFileSync("src/invite.ts", "utf8")).not.toContain(OLD_INVITE);
    expect(readFileSync(DOCS_PATH, "utf8")).not.toContain(OLD_INVITE);
  });

  it("sources emit the documented lines with scalar-only fields", () => {
    const cases = [
      {
        file: "src/profiles/routes-writes.tsx",
        warn: "profile.write.malformed_body",
        shed: "profile.write.shed",
      },
      {
        file: "src/events/routes-writes.ts",
        warn: "event.write.malformed_body",
        shed: "event.write.shed",
      },
      { file: "src/invite.ts", warn: "invite.config.unusable", shed: "invite.config.shed" },
    ];
    for (const { file, warn, shed } of cases) {
      const source = readFileSync(file, "utf8");
      expect(source).toContain(`"${warn}"`);
      expect(source).toContain(`shedLine: "${shed}"`);
      expect(source).toContain("exception");
    }
    // The write legs carry the refused content-type; the helper sheds counts only.
    expect(readFileSync("src/profiles/routes-writes.tsx", "utf8")).toContain("content_type");
    expect(readFileSync("src/events/routes-writes.ts", "utf8")).toContain("content_type");
    const budget = readFileSync("src/log-budget.ts", "utf8");
    expect(budget).toContain("console.warn");
    expect(budget).toContain("{ dropped }");
    // /discord pages a broken config once per window; serving is unchanged.
    const leaves = readFileSync("src/static-leaves.tsx", "utf8");
    expect(leaves).toContain("InviteConfigError");
    expect(leaves).toContain("alertRequestError");
    expect(leaves).toContain("inviteAlerts");
    expect(leaves).toContain("c.redirect(destination, 302)");
  });
});
