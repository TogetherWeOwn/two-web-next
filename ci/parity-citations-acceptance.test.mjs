// Acceptance: the parity document must not cite current-repository files
// that do not exist, and the docs checker must say so.
//
// The defect this pins: docs/parity.md cited `src/jobs/event-store-pg.ts`
// for the pg EventStore adapter, but that file has never existed — the
// adapter is `pgEventStore` in `src/jobs/events.ts`. The docs checker
// strips inline code spans before looking for Markdown links, so a literal
// file citation in backticks evaded every gate and `npm run docs:links`
// stayed green while the evidence column pointed at nothing.
//
// These tests run the real checker (`checkLinks` from
// ci/check-doc-links.mjs, the same function `npm run docs:links` executes)
// against synthetic scratch repositories and against this repository. They
// pin the outcome contract only:
//
// - a literal current-repository citation in docs/parity.md (`src/...`,
//   `test/...`, optionally with a `:line` suffix) naming a missing file
//   fails with exit 1 and a diagnostic carrying document, line and target;
// - the same citations naming existing files pass;
// - legacy/historical paths (`routes/web.php`, `app/Mail`,
//   `config/mail.php`), route examples (`GET /events/{event}`), globs,
//   non-path inline code and fenced code stay valid;
// - the real docs/parity.md no longer cites the missing adapter file, its
//   pg EventStore row cites the real adapter file, and the real checker
//   passes on this repository (no false positives on the live document);
// - pre-existing link checking is not weakened, and `docs:links` stays in
//   the required `check` chain.
//
// Run: node --test ci/parity-citations-acceptance.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkLinks } from "./check-doc-links.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Every file the checker's explicit scope requires, stubbed the same way
// the checker's own selftest stubs them: the checker fails closed on an
// unreadable scoped file, so a scratch tree without them exits 2 before
// any citation behaviour is exercised.
const SCOPE_STUBS = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  ".github/pull_request_template.md",
  "bin/import/README.md",
  "ci/featured-proof/README.md",
  "docs/scope-stub.md",
];

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

// A scratch repository shaped like this one where the citations matter:
// the real adapter file exists, the stale one does not. `parity` is the
// docs/parity.md body under test.
function scratchRepo(t, parity) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "parity-cite-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const stub of SCOPE_STUBS) write(root, stub, "# Stub\n");
  write(root, "src/jobs/events.ts", "export function pgEventStore() {}\n");
  write(root, "src/jobs/cron.ts", "export function reconcileEvents() {}\n");
  write(root, "test/recurrence.test.ts", "// fixture\n");
  write(root, "ci/tool.mjs", "// fixture\n");
  mkdirSync(join(root, "public/icons"), { recursive: true });
  write(root, "docs/parity.md", parity);
  return root;
}

function runChecker(root) {
  const messages = [];
  const code = checkLinks(root, {
    log() {},
    error(text) {
      messages.push(text);
    },
  });
  return { code, messages };
}

test("real parity document no longer cites the missing pg EventStore file", () => {
  const parity = readFileSync(join(repoRoot, "docs/parity.md"), "utf8");
  assert.ok(
    !parity.includes("src/jobs/event-store-pg.ts"),
    "docs/parity.md still cites src/jobs/event-store-pg.ts, which does not exist",
  );
});

test("real pg EventStore citation names the file that defines pgEventStore", () => {
  // Control: the adapter really lives in src/jobs/events.ts today.
  const adapter = readFileSync(join(repoRoot, "src/jobs/events.ts"), "utf8");
  assert.ok(adapter.includes("pgEventStore"), "src/jobs/events.ts defines pgEventStore");
  assert.ok(!existsSync(join(repoRoot, "src/jobs/event-store-pg.ts")));

  const lines = readFileSync(join(repoRoot, "docs/parity.md"), "utf8").split(/\r?\n/);
  const row = lines.find((line) => line.includes("pg EventStore"));
  assert.ok(row, "docs/parity.md still documents the pg EventStore");
  assert.ok(
    row.includes("src/jobs/events.ts"),
    `pg EventStore row must cite src/jobs/events.ts, got: ${row}`,
  );
});

test("missing adapter citation in parity fails with document, line and target", (t) => {
  const parity = [
    "# Parity",
    "",
    "| Legacy | Next | Evidence |",
    "| `events:reconcile` | `reconcileEvents` in `src/jobs/cron.ts` on the pg EventStore (`src/jobs/event-store-pg.ts`) | x |",
    "",
  ].join("\n");
  const { code, messages } = runChecker(scratchRepo(t, parity));
  assert.equal(code, 1, `expected exit 1, got ${code}: ${messages.join("; ")}`);
  const joined = messages.join("\n");
  assert.ok(
    joined.includes("docs/parity.md:4:"),
    `diagnostic carries document and line: ${joined}`,
  );
  assert.ok(
    joined.includes("src/jobs/event-store-pg.ts"),
    `diagnostic carries the missing target: ${joined}`,
  );
});

test("existing adapter citation in parity passes", (t) => {
  const parity = [
    "# Parity",
    "",
    "| Legacy | Next | Evidence |",
    "| `events:reconcile` | `reconcileEvents` in `src/jobs/cron.ts` on the pg EventStore (`src/jobs/events.ts`) | `test/recurrence.test.ts` |",
    "",
  ].join("\n");
  const { code, messages } = runChecker(scratchRepo(t, parity));
  assert.equal(code, 0, `expected exit 0, got ${code}: ${messages.join("; ")}`);
});

test("missing generic implementation citation fails", (t) => {
  const parity = "# Parity\n\nShipped in `src/no-such-module.ts` behind the flag.\n";
  const { code, messages } = runChecker(scratchRepo(t, parity));
  assert.equal(code, 1, `expected exit 1, got ${code}: ${messages.join("; ")}`);
  assert.ok(messages.join("\n").includes("docs/parity.md:3:"));
  assert.ok(messages.join("\n").includes("src/no-such-module.ts"));
});

test("missing evidence test citation fails", (t) => {
  const parity = "# Parity\n\nProven by `test/no-such-evidence.test.ts` on disposable data.\n";
  const { code, messages } = runChecker(scratchRepo(t, parity));
  assert.equal(code, 1, `expected exit 1, got ${code}: ${messages.join("; ")}`);
  assert.ok(messages.join("\n").includes("docs/parity.md:3:"));
  assert.ok(messages.join("\n").includes("test/no-such-evidence.test.ts"));
});

test("line-suffixed citations resolve to the file before the suffix", (t) => {
  const existing = [
    "# Parity",
    "",
    "Adapter at `src/jobs/events.ts:67`; proof at `test/recurrence.test.ts:135,194`.",
    "",
  ].join("\n");
  const okRun = runChecker(scratchRepo(t, existing));
  assert.equal(
    okRun.code,
    0,
    `existing files with line suffixes pass: ${okRun.messages.join("; ")}`,
  );

  const missing = "# Parity\n\nAdapter at `src/jobs/no-such-adapter.ts:12`.\n";
  const badRun = runChecker(scratchRepo(t, missing));
  assert.equal(
    badRun.code,
    1,
    `missing file with line suffix fails: ${badRun.messages.join("; ")}`,
  );
  assert.ok(badRun.messages.join("\n").includes("src/jobs/no-such-adapter.ts"));
});

test("missing-citation diagnostics are deterministic across runs", (t) => {
  const parity = [
    "# Parity",
    "",
    "First `src/missing-one.ts` then later prose.",
    "",
    "Second `src/missing-two.ts` on another line.",
    "",
  ].join("\n");
  const root = scratchRepo(t, parity);
  const first = runChecker(root);
  const second = runChecker(root);
  assert.equal(first.code, 1);
  assert.deepEqual(second.messages, first.messages);
  const joined = first.messages.join("\n");
  assert.ok(joined.includes("docs/parity.md:3:") && joined.includes("src/missing-one.ts"));
  assert.ok(joined.includes("docs/parity.md:5:") && joined.includes("src/missing-two.ts"));
});

test("legacy paths, routes, globs and non-path code stay valid", (t) => {
  const parity = [
    "# Parity",
    "",
    "Legacy routes in `routes/web.php`, `routes/api.php` and `routes/funnel.php`;",
    "mail under `app/Mail` and `app/Notifications`, config in `config/mail.php`.",
    "Routes: `GET /events/{event}`, `POST /logout`, `/e/{key}`, `ALL /admin/*`.",
    "Globs: `test/islands-*.test.ts`, `content/welcome/*`, icons in `public/icons/`.",
    "Not paths: `reconcileEvents`, `EventService::materializeMissingInstances`,",
    "`text/html`, `data/page/limit`, `webcal://`, and `node ci/tool.mjs`.",
    "Current repo: `src/jobs/events.ts`, `src/jobs/cron.ts`, `test/recurrence.test.ts`.",
    "",
    "```md",
    "Fenced samples are not citations: `src/missing-in-fence.ts`",
    "```",
    "",
  ].join("\n");
  const { code, messages } = runChecker(scratchRepo(t, parity));
  assert.equal(code, 0, `expected exit 0, got ${code}: ${messages.join("; ")}`);
});

test("existing Markdown link checking is not weakened", (t) => {
  const parity = "# Parity\n\n[lost](missing.md)\n";
  const { code, messages } = runChecker(scratchRepo(t, parity));
  assert.equal(code, 1, `broken link still fails, got ${code}: ${messages.join("; ")}`);
  assert.ok(messages.join("\n").includes("docs/parity.md:3:"));
});

test("real checker passes on this repository (no false positives on the live parity prose)", () => {
  const { code, messages } = runChecker(repoRoot);
  assert.equal(
    code,
    0,
    `live docs must pass once the stale citation is fixed: ${messages.join("; ")}`,
  );
});

test("docs:links stays wired into the required check chain", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.ok(pkg.scripts.check.includes("npm run docs:links"), "check chain runs docs:links");
  assert.ok(
    pkg.scripts["docs:links"].includes("ci/check-doc-links.mjs"),
    "docs:links runs the docs checker",
  );
  assert.ok(
    pkg.scripts["docs:links"].includes("--selftest"),
    "docs:links still runs the checker selftest",
  );
});
