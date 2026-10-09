// Nightly mutation signal for the auth blast radius: `src/sessions.ts`,
// `src/join/service.ts` and `src/join/route.ts`.
//
// Each mutant weakens exactly one auth check (expired-session blindness, lost
// revocation, throttle/review bypass, forged join outcomes). The runner applies
// one mutant at a time to the working tree, runs the hermetic DB-free kill
// suite, then restores the file byte-for-byte (hash-verified). A mutant the
// suite fails to kill is a coverage gap, not a test failure.
//
// hermetic: the kill suite uses the memory session store and stubbed fetch, so
// this runs with no DATABASE_URL, no Discord, no secrets. Postgres-store SQL
// mutants are deliberately out of scope here; they need a live database and
// belong in a follow-up, not in this nightly slice.
//
// Exit codes: 0 = report written (survivors are data, listed in the report).
// 1 = runner infrastructure failure (unmutated suite not green, a run with no
// verdict, stale anchor, restore mismatch).
// 2 = usage error or missing vitest. The workflow stays non-blocking: no
// required check reads this job, whatever it reports.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_DIR = join(repoRoot, "artifacts", "mutation-sessions-join");
const VITEST = join(repoRoot, "node_modules", ".bin", "vitest");
const MUTANT_TIMEOUT_MS = 300_000;

// DB-free kill suite: memory session store + stubbed fetch only. Every file
// below passes with DATABASE_URL unset.
const KILL_SUITE = [
  "test/safe-next-control-bytes.test.ts",
  "test/memory-session-same-token-contract.test.ts",
  "test/session-prelogin-revoke.test.ts",
  "test/session-recovery.test.ts",
  "test/admin-session-recovery.test.ts",
  "test/join-blocked-copy.test.ts",
  "test/join-blank-bot.test.ts",
  "test/join-idempotence.test.ts",
  "test/w15b-exposure-throttle-race.test.ts",
];

const DB_URL_VARS = ["DATABASE_URL", "AUDIT_IMPORT_TEST_DATABASE_URL", "LEGACY_DATABASE_URL"];

// One auth-check weakening each. `find` must occur exactly once in `file`;
// when the source drifts the mutant reports STALE instead of silently
// mutating the wrong line.
const MUTANTS = [
  {
    id: "S1-live-expiry-blind",
    file: "src/sessions.ts",
    note: "memory store honors revoked/expiry reads: expired sessions stay live",
    find: "if (!r || r.expiresAt <= clock()) {",
    replace: "if (!r) {",
  },
  {
    id: "S2-replace-keeps-old",
    file: "src/sessions.ts",
    note: "fresh login retires the presented session: the prior token survives replace",
    find: 'throw new Error("Session replacement must use a fresh token");\n      }\n      rows.delete(oldHash);',
    replace: 'throw new Error("Session replacement must use a fresh token");\n      }',
  },
  {
    id: "S3-rotate-unknown-succeeds",
    file: "src/sessions.ts",
    note: "rotation of a consumed/unknown token reports success and mints a session",
    find: "const source = live(oldHash);\n      if (!source) return false;",
    replace: "const source = live(oldHash);\n      if (!source) return true;",
  },
  {
    id: "S4-revoke-noop",
    file: "src/sessions.ts",
    note: "revocation deletes the row: revoked tokens stay readable",
    find: "async revoke(hash) {\n      rows.delete(hash);\n    },",
    replace: "async revoke(hash) {\n    },",
  },
  {
    id: "S5-revoke-wrong-user",
    file: "src/sessions.ts",
    note: "fresh login revokes only the same user's sessions: other users are revoked instead",
    find: "if (hash !== exceptTokenHash && r.userId === userId) rows.delete(hash);",
    replace: "if (hash !== exceptTokenHash && r.userId !== userId) rows.delete(hash);",
  },
  {
    id: "S6-create-drops-member",
    file: "src/sessions.ts",
    note: "created sessions keep their member/moderator flags: flags are cleared on write",
    find: "rows.set(s.tokenHash, { ...s, expiresAt: s.expiresAt.getTime(), statusHash: s.tokenHash });",
    replace:
      "rows.set(s.tokenHash, { ...s, member: false, moderator: false, expiresAt: s.expiresAt.getTime(), statusHash: s.tokenHash });",
  },
  {
    id: "J3-safeNext-allows-del",
    file: "src/join/service.ts",
    note: "post-join redirect rejects control bytes: DEL survives into the Location header",
    find: 'if (typeof raw !== "string" || raw === "" || /[\\s\\x00-\\x1f\\x7f]/.test(raw)) return null;',
    replace:
      'if (typeof raw !== "string" || raw === "" || /[\\s\\x00-\\x1f]/.test(raw)) return null;',
  },
  {
    id: "J5-finishJoin-outcome-swap",
    file: "src/join/service.ts",
    note: "bot result maps to the join outcome: added and already_member are swapped",
    find: 'const outcome: JoinOutcome = result === "joined" ? "added" : "already_member";',
    replace: 'const outcome: JoinOutcome = result === "joined" ? "already_member" : "added";',
  },
  {
    id: "J6-finishJoin-throw-mislabels",
    file: "src/join/service.ts",
    note: "bot transport failure degrades: the attempt is recorded as error instead of degraded",
    find: 'return { kind: "recoverable", outcome: "degraded", requestId: null };',
    replace: 'return { kind: "recoverable", outcome: "error", requestId: null };',
  },
  {
    id: "J7-recordAttempt-forces-added",
    file: "src/join/service.ts",
    note: "join attempts record their real outcome: every row is recorded as added",
    find: "VALUES (${attempt.outcome}, ${attempt.source}, ${attempt.requestId}, ${attempt.discordId})",
    replace: 'VALUES (${"added"}, ${attempt.source}, ${attempt.requestId}, ${attempt.discordId})',
  },
  {
    id: "J8-failed-maps-added",
    file: "src/join/service.ts",
    note: "bot refusal degrades: a failed add is recorded as a successful added join",
    find: 'if (result === "failed") return { kind: "recoverable", outcome: "degraded", requestId };',
    replace:
      'if (result === "failed") return { kind: "recoverable", outcome: "added", requestId };',
  },
  {
    id: "J9-state-cookie-binding-dropped",
    file: "src/join/route.ts",
    note: "callback state must match the journey cookie: the binding is dropped",
    find: "state && expected && state === expected ? await hooks.storeFor(c)",
    replace: "state && expected ? await hooks.storeFor(c)",
  },
  {
    id: "J10-journey-replay-admitted",
    file: "src/join/route.ts",
    note: "callback admits a consumed journey: a replayed state is accepted",
    find: '(await store.journeys.consume(await hashToken(state!), "join").catch(() => false))',
    replace:
      '(true || await store.journeys.consume(await hashToken(state!), "join").catch(() => false))',
  },
  {
    id: "J11-start-throttle-ignored",
    file: "src/join/route.ts",
    note: "start route ignores its per-client budget: no 429 is returned",
    find: "if (limited) return limited;\n    const source = sanitizeSource(",
    replace: "if (limited && false) return limited;\n    const source = sanitizeSource(",
  },
  {
    id: "J12-callback-throttle-ignored",
    file: "src/join/route.ts",
    note: "callback ignores its per-client budget: token exchanges are unthrottled",
    find: "if (limited) return limited;\n    const sql = await joinStore(c);",
    replace: "if (limited && false) return limited;\n    const sql = await joinStore(c);",
  },
];

function sha(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// green: every test passed. red: a test failed. error: no verdict (spawn failure,
// timeout, signal, or an exit code vitest does not use for test failures).
export function verdictFor({ status, signal, error }) {
  if (error || signal || status === null) return "error";
  if (status === 0) return "green";
  if (status === 1) return "red";
  return "error";
}

const OUTCOME = {
  red: { status: "killed", detail: "kill suite failed as expected" },
  green: { status: "survived", detail: "kill suite passed; coverage gap" },
  error: { status: "error", detail: "kill suite gave no verdict" },
};

// Default kill command: the hermetic suite, DB-free by construction.
function defaultKill(suite) {
  const env = { ...process.env };
  for (const name of DB_URL_VARS) delete env[name];
  const child = spawnSync(process.execPath, [VITEST, "run", ...suite], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: MUTANT_TIMEOUT_MS,
  });
  const output = [child.stdout, child.stderr].filter(Boolean).join("\n").slice(-4000);
  return { verdict: verdictFor(child), output };
}

export function runMutant(root, mutant, kill = defaultKill) {
  const path = join(root, mutant.file);
  const before = readFileSync(path, "utf8");
  const beforeHash = sha(before);
  const occurrences = countOccurrences(before, mutant.find);
  if (occurrences !== 1) {
    return {
      id: mutant.id,
      status: occurrences === 0 ? "stale" : "ambiguous",
      detail: `anchor occurs ${occurrences}x`,
    };
  }
  const started = Date.now();
  writeFileSync(path, before.replace(mutant.find, mutant.replace));
  // Targeted restore, never a whole-tree checkout: only this mutant's exact
  // replacement is reversed, then the hash must match the pre-run content.
  // Restore failures are collected, never thrown from `finally` (lint:
  // noUnsafeFinally); the file is left intact for inspection on mismatch.
  const restore = () => {
    const mutated = readFileSync(path, "utf8");
    if (!mutated.includes(mutant.replace)) {
      return `${mutant.id}: mutated text missing at restore; refusing to touch ${mutant.file}`;
    }
    writeFileSync(path, mutated.replace(mutant.replace, mutant.find));
    if (sha(readFileSync(path, "utf8")) !== beforeHash) {
      return `${mutant.id}: restore hash mismatch in ${mutant.file}; left intact for inspection`;
    }
    return null;
  };
  let outcome;
  try {
    const { verdict, output } = kill(KILL_SUITE);
    const { status, detail } = OUTCOME[verdict] ?? OUTCOME.error;
    outcome = { id: mutant.id, status, detail, output, ms: Date.now() - started };
  } finally {
    outcome = outcome ?? { id: mutant.id, status: "error", detail: "kill command threw" };
    outcome.restoreError = restore();
  }
  if (outcome.restoreError) throw new Error(outcome.restoreError);
  return outcome;
}

export function renderReport({ sha: headSha, startedAt, results }) {
  const killed = results.filter((r) => r.status === "killed").length;
  const survived = results.filter((r) => r.status === "survived");
  const stale = results.filter((r) => r.status !== "killed" && r.status !== "survived");
  const lines = [
    "# Mutation report: sessions + join (nightly, non-blocking)",
    "",
    `- head: ${headSha}`,
    `- started: ${startedAt}`,
    `- kill suite: ${KILL_SUITE.length} files, DB-free (memory store, stubbed fetch)`,
    `- score: ${killed}/${results.length} mutants killed`,
    "",
    "| mutant | file | status | what it proves |",
    "| --- | --- | --- | --- |",
    ...results.map((r) => {
      const m = MUTANTS.find((x) => x.id === r.id) ?? { file: "?", note: r.detail ?? "" };
      return `| ${r.id} | ${m.file} | ${r.status.toUpperCase()} | ${m.note} |`;
    }),
    "",
  ];
  if (survived.length) {
    lines.push("## Surviving mutants (coverage gaps)", "");
    for (const r of survived) lines.push(`- ${r.id}: kill suite passed with the check weakened.`);
    lines.push("");
  }
  if (stale.length) {
    lines.push("## Mutants without a verdict (stale or ambiguous anchor, or runner error)", "");
    for (const r of stale) lines.push(`- ${r.id}: ${r.detail}.`);
    lines.push("");
  }
  const report = {
    head: headSha,
    startedAt,
    suite: KILL_SUITE,
    score: { killed, total: results.length },
    results,
  };
  return { json: JSON.stringify(report, null, 2) + "\n", markdown: lines.join("\n") };
}

export function run(root, kill = defaultKill) {
  if (!existsSync(VITEST)) {
    console.error("vitest is not installed; run npm ci --include=dev first.");
    return 2;
  }
  // Guard: the runner rewrites working-tree files briefly. Refuse when a
  // target file is dirty so a mutant never stacks on uncommitted work.
  if (!process.argv.includes("--allow-dirty")) {
    try {
      const targets = [...new Set(MUTANTS.map((m) => m.file))];
      const dirty = execFileSync("git", ["status", "--porcelain", "--", ...targets], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      if (dirty) {
        console.error(
          `refusing: target files are dirty:\n${dirty}\nre-run with --allow-dirty on a clean tree.`,
        );
        return 1;
      }
    } catch {
      console.error("refusing: cannot confirm a clean tree (git status failed).");
      return 1;
    }
  }
  let headSha = "unknown";
  try {
    headSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    // Report still names the run; the sha is informational.
  }
  const baseline = kill(KILL_SUITE);
  if (baseline.verdict !== "green") {
    console.error(`refusing: the kill suite is ${baseline.verdict} on the unmutated tree.`);
    console.error(baseline.output);
    return 1;
  }
  const startedAt = new Date().toISOString();
  const results = MUTANTS.map((m) => runMutant(root, m, kill));
  const { json, markdown } = renderReport({ sha: headSha, startedAt, results });
  rmSync(REPORT_DIR, { recursive: true, force: true });
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, "report.json"), json);
  writeFileSync(join(REPORT_DIR, "report.md"), markdown);
  const stale = results.filter((r) => r.status !== "killed" && r.status !== "survived");
  const survivedRows = survived(results);
  console.log(
    `mutation sessions+join: ${results.length - survivedRows.length - stale.length}/${results.length} killed.`,
  );
  console.log(`report: artifacts/mutation-sessions-join/report.{json,md}`);
  for (const r of [...survivedRows, ...stale])
    console.log(`- ${r.id}: ${r.status} (${r.detail ?? ""})`);
  return stale.length ? 1 : 0;
}

function survived(results) {
  return results.filter((r) => r.status === "survived");
}

function selftest() {
  let cases = 0;
  const check = (name, fn) => {
    fn();
    cases += 1;
    console.log(`ok: ${name}`);
  };

  // End-to-end mutant cycle against a scratch tree with stub kill commands.
  check("killed mutant restores the file byte-for-byte", () => {
    const dir = join(repoRoot, "artifacts", ".mutation-selftest");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    try {
      const target = join(dir, "sample.ts");
      writeFileSync(target, "const guard = true;\n");
      const mutant = {
        id: "T1",
        file: "sample.ts",
        find: "guard = true",
        replace: "guard = false",
      };
      const before = readFileSync(target, "utf8");
      const result = runMutant(dir, mutant, () => ({ verdict: "red", output: "1 failed" }));
      assert.equal(result.status, "killed");
      assert.equal(readFileSync(target, "utf8"), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("survived mutant is reported, not thrown", () => {
    const dir = join(repoRoot, "artifacts", ".mutation-selftest");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, "sample.ts"), "const guard = true;\n");
      const mutant = {
        id: "T2",
        file: "sample.ts",
        find: "guard = true",
        replace: "guard = false",
      };
      const result = runMutant(dir, mutant, () => ({ verdict: "green", output: "all passed" }));
      assert.equal(result.status, "survived");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("drifted anchor reports stale without writing", () => {
    const dir = join(repoRoot, "artifacts", ".mutation-selftest");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, "sample.ts"), "const other = 1;\n");
      const mutant = {
        id: "T3",
        file: "sample.ts",
        find: "guard = true",
        replace: "guard = false",
      };
      const result = runMutant(dir, mutant, () => {
        throw new Error("kill must not run on a stale mutant");
      });
      assert.equal(result.status, "stale");
      assert.equal(readFileSync(join(dir, "sample.ts"), "utf8"), "const other = 1;\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("kill verdict: exit 0 is green, exit 1 is red, anything else is error", () => {
    assert.equal(verdictFor({ status: 0, signal: null }), "green");
    assert.equal(verdictFor({ status: 1, signal: null }), "red");
    assert.equal(verdictFor({ status: 2, signal: null }), "error");
    assert.equal(verdictFor({ status: null, signal: "SIGTERM" }), "error");
    assert.equal(verdictFor({ status: 1, error: new Error("ETIMEDOUT") }), "error");
  });

  check("runner error is not counted as a kill", () => {
    const dir = join(repoRoot, "artifacts", ".mutation-selftest");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    try {
      const target = join(dir, "sample.ts");
      writeFileSync(target, "const guard = true;\n");
      const before = readFileSync(target, "utf8");
      const mutant = {
        id: "T4",
        file: "sample.ts",
        find: "guard = true",
        replace: "guard = false",
      };
      const result = runMutant(dir, mutant, () => ({ verdict: "error", output: "timed out" }));
      assert.equal(result.status, "error");
      assert.equal(readFileSync(target, "utf8"), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("report renders a row per mutant plus gap sections", () => {
    const { json, markdown } = renderReport({
      sha: "abc1234",
      startedAt: "2026-10-09T00:00:00.000Z",
      results: [
        { id: "S1-live-expiry-blind", status: "killed", detail: "kill suite failed as expected" },
        {
          id: "J3-safeNext-allows-del",
          status: "survived",
          detail: "kill suite passed; coverage gap",
        },
        { id: "S9-gone", status: "stale", detail: "anchor occurs 0x" },
      ],
    });
    const parsed = JSON.parse(json);
    assert.equal(parsed.score.killed, 1);
    assert.equal(parsed.score.total, 3);
    assert.match(markdown, /\| S1-live-expiry-blind \| src\/sessions\.ts \| KILLED \|/);
    assert.match(markdown, /## Surviving mutants/);
    assert.match(markdown, /## Mutants without a verdict/);
  });

  console.log(`mutation sessions-join selftest: ${cases} cases passed.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--selftest" && a !== "--allow-dirty");
  if (unknown.length) {
    console.error("Usage: node ci/mutation-sessions-join.mjs [--selftest] [--allow-dirty]");
    process.exitCode = 2;
  } else {
    process.exitCode = args.includes("--selftest") ? selftest() : run(repoRoot);
  }
}
