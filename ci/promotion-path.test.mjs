import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  classifyPromotionPath,
  isPromotionPath,
  publishPromotionPath,
  runPromotionPathStep,
} from "./promotion-path.mjs";

const pull = "/pulls/42";
const issueLabels = "/issues/42/labels";
const head = "a".repeat(40);
const base = "b".repeat(40);
const yes = "promotion-path: yes";
const no = "promotion-path: no";
const file = (filename, status = "modified", previous_filename) => ({
  filename,
  status,
  previous_filename,
});
const http = (status = 200) => new Response(null, { status });
const docs = (length) => Array.from({ length }, (_, i) => file(`docs/${i}.md`));
const ordinary = docs(101);

function github(rows, options = {}) {
  const labels = options.labelState ?? new Set(["unrelated", ...(options.labels ?? [])]);
  const summary = [];
  const pages = [];
  const writes = [];
  let reads = 0;
  let repoLabelExists = !options.createRace;
  const api = async (method, path, body, signal) => {
    if (method !== "GET") writes.push(method);
    await options.before?.(method, path);
    signal?.throwIfAborted();
    if (method === "GET") {
      if (path === pull) {
        if (options.failPR) return http(502);
        return Response.json({
          state: "open",
          head: { sha: head },
          base: { sha: base, ref: "main" },
          changed_files: options.count ?? rows.length,
          ...options.revision?.(++reads),
        });
      }
      if (path.startsWith(`${pull}/files?per_page=100&page=`)) {
        const page = Number(path.split("=").at(-1));
        pages.push(page);
        return page === options.failPage
          ? http(502)
          : Response.json(rows.slice(100 * (page - 1), 100 * page));
      }
      if (path === `/compare/${base}...${head}?per_page=1`)
        return Response.json({ files: options.comparison ?? rows });
      if (path.startsWith("/labels/")) return http(repoLabelExists ? 200 : 404);
    }
    if (method === "POST" && path === "/labels" && options.createRace) {
      repoLabelExists = true;
      return http(422);
    }
    if (method === "DELETE" && path.startsWith(`${issueLabels}/`)) {
      const deleted = labels.delete(decodeURIComponent(path.slice(issueLabels.length + 1)));
      await options.after?.(method, path);
      return http(deleted ? 200 : 404);
    }
    if (method === "POST" && path === issueLabels) {
      for (const label of body.labels) labels.add(label);
      await options.after?.(method, path);
      return http();
    }
    assert.fail(`Unexpected fixture request: ${method} ${path}`);
  };
  const classify = (signal) => classifyPromotionPath(api, 42, signal);
  const publish = (classification, signal) =>
    publishPromotionPath(api, 42, classification, (entry) => summary.push(entry), signal);
  const run = async () => publish(await classify(options.signal));
  return { api, labels, pages, writes, summary, classify, publish, run };
}

test("only promotion surfaces match, including directly called tooling", () => {
  const included = `.github/workflows/ci.yml .github/actions/gradual-promote/action.yml
    deep/web/wrangler.production.toml tail/wrangler.jsonc drizzle/meta/_journal.json migrations.lock db/migrations/0001.sql
    ci/resolve-promotion-sha.mjs ci/production-deploy-gate.mjs ci/rollback-target.mjs ci/drill-scripts-ref.mjs
    ci/check-snapshot-chain-selftest.mjs e2e/search-retry.mjs src/worker.ts web/src/hooks.server.ts web/src/lib/server/hono.ts
    ci/staging-provenance.mjs ci/staging-deploy-gate.mjs ci/staging-forward.mjs ci/staging-soak-receipt.mjs ci/web-standards.mjs ci/db-migrate.mjs
    ci/lighthouse-origin-lib.cjs ci/lighthouserc.cjs ci/quality-budget.json ci/lighthouse-samples.cjs ci/lighthouse-serving-values.cjs ci/lighthouse-preserve-mobile.sh
    ci/migration-runtime-rights.mjs src/up-database.ts bin/version-check.mjs e2e/staging/join.spec.ts
    e2e/watch/guest-journeys.spec.ts playwright.watch.config.ts e2e/watch-guard.mjs e2e/ci-only.mjs
    e2e/watch/events/calendar.spec.ts e2e/staging/events/lists/calendar.spec.ts
    playwright.staging.config.ts e2e/staging-guard.mjs e2e/join-oneclick.ts src/qa.ts ci/rendered-page.mjs
    web/package.json web/scripts/copy-public.mjs ci/kit-route-evidence.mjs bin/ts-hook.mjs bin/ts-hooks.mjs`;
  const excluded = `docs/runbook.md docs/wrangler.md test/fixtures/legacy/verify.sql
    src/routes/events.ts web/src/routes/+page.svelte ci/staging-provenance.test.mjs
    ci/check-doc-links.mjs ci/lighthouse-summary.mjs e2e/staging/journey-ledger.test.mjs e2e/watch/events/calendar.test.ts`;
  for (const path of included.split(/\s+/)) assert.ok(isPromotionPath(path), path);
  for (const path of excluded.split(/\s+/)) assert.equal(isPromotionPath(path), false, path);
});

test("paginates, detects removal and either side of renames, and flips only its labels", async () => {
  for (const change of [
    file("migrations.lock", "removed"),
    file("docs/former-config.txt", "renamed", "tail/wrangler.jsonc"),
    file("tail/wrangler.jsonc", "renamed", "docs/former-config.txt"),
  ]) {
    const run = github([...docs(2998), change], { labels: [no] });
    await run.run();
    const allPages = Array.from({ length: 30 }, (_, i) => i + 1);
    assert.deepEqual(run.pages, allPages);
    assert.deepEqual([...run.labels], ["unrelated", yes]);
    assert.ok(run.summary[0].includes("verdict **yes**"));
  }
  const run = github(docs(299), { labels: [yes, no], createRace: true });
  await run.run();
  await run.run();
  assert.deepEqual([...run.labels], ["unrelated", no]);
  const identity = `PR #42 · head \`${head}\` · base \`${base}\``;
  assert.ok(run.summary[0].includes(`${identity} · verdict **no**`));
});

test("failed, capped, incomplete or inconsistent reads produce no verdict label", async () => {
  for (const [rows, options] of [
    [ordinary, { failPR: true, labels: [no] }],
    [ordinary.slice(0, 100), { count: 101 }],
    [ordinary, { failPage: 2 }],
    [ordinary, { count: 3000 }],
    [docs(300), {}],
    [[...ordinary.slice(0, 100), ordinary[0]], {}],
    [[file("docs/new.txt", "renamed")], {}],
    [ordinary, { comparison: [...ordinary.slice(0, 100), file("ci/production-deploy-gate.mjs")] }],
  ]) {
    const run = github(rows, { labels: [yes, no], ...options });
    await assert.rejects(run.run());
    assert.deepEqual([...run.labels], ["unrelated"]);
    assert.ok(run.writes.every((method) => method === "DELETE"));
    assert.ok(run.summary[0].includes("verdict **unknown**"));
  }
});

test("exhausted budget still awaits both label deletions and reports both errors", async () => {
  const budget = new AbortController();
  const expired = new Error("Classification budget exhausted");
  const unavailable = new Error("Label deletion unavailable");
  const run = github(ordinary, {
    labels: [no],
    signal: budget.signal,
    async before(method, path) {
      if (path.startsWith(`${pull}/files?`)) budget.abort(expired);
      if (method === "DELETE" && path.endsWith("yes")) throw unavailable;
      if (method === "DELETE") await setImmediate();
    },
  });
  await assert.rejects(run.run(), { errors: [expired, unavailable] });
  assert.deepEqual(run.writes, ["DELETE", "DELETE"]);
  assert.deepEqual([...run.labels], ["unrelated"]);
  assert.ok(run.summary[0].includes("verdict **unknown**"));
});

test("ref changes prevent publication, including same-SHA retarget and a race during label write", async () => {
  const retargetBase = { sha: base, ref: "other" };
  const retarget = github(ordinary, { revision: (n) => n > 1 && { base: retargetBase } });
  await assert.rejects(retarget.run(), /refs or file count changed/);
  assert.ok(retarget.writes.every((method) => method === "DELETE"));
  const moved = github(ordinary, {
    revision: (read) => read > 3 && { head: { sha: "c".repeat(40) } },
  });
  await assert.rejects(moved.run(), /refs or file count changed/);
  assert.deepEqual([...moved.labels], ["unrelated"]);
  assert.ok(moved.summary[0].includes("verdict **unknown**"));
});

test("a PR event burst cancels superseded reads and drains in-flight label writes", async (t) => {
  const workflow = readFileSync(
    new URL("../.github/workflows/promotion-path.yml", import.meta.url),
    "utf8",
  );
  const cancelRunning = /^  cancel-in-progress: true$/m.test(workflow);
  // Model Actions' per-group running slot and replaceable pending slot. Only
  // the publication condition stays true when Actions re-evaluates steps.
  const drainWrites =
    workflow.includes("    if: ${{ always() }}\n") &&
    workflow.includes(
      "if: ${{ always() && (steps.classify.outcome == 'success' || steps.classify.outcome == 'failure') }}",
    );
  const newestHead = "c".repeat(40);
  const newestBase = "d".repeat(40);
  const newest = { head: { sha: newestHead }, base: { sha: newestBase, ref: "stable" } };
  const scratch = mkdtempSync(join(tmpdir(), "promotion-path-burst-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const event = join(scratch, "event.json");
  writeFileSync(event, JSON.stringify({ number: 42 }));

  for (const point of ["read", "delete", "add"]) {
    const reading = new AbortController();
    const publishing = new AbortController();
    const paused = Promise.withResolvers();
    const resume = Promise.withResolvers();
    let parked = false;
    const pause = async () => {
      if (parked) return;
      parked = true;
      paused.resolve();
      await resume.promise;
    };
    let live = {};
    const first = github(docs(1), {
      labels: [yes],
      revision: () => live,
      async before(method, path) {
        if (point === "read" && method === "GET" && path.startsWith(`${pull}/files?`))
          await pause();
      },
      async after(method) {
        if ((point === "delete" && method === "DELETE") || (point === "add" && method === "POST"))
          await pause();
      },
    });
    const oldRun = (async () => {
      const classification = await first.classify(reading.signal);
      if (reading.signal.aborted) return "cancelled";
      await first.publish(classification, publishing.signal);
      return "success";
    })().catch((error) => error.message);

    await Promise.race([paused.promise, oldRun]);
    assert.ok(parked, `first run reached ${point}`);
    assert.deepEqual(first.summary, [], `no verdict while paused at ${point}`);
    if (point === "delete") assert.deepEqual([...first.labels], ["unrelated"]);
    if (point === "add") assert.deepEqual([...first.labels], ["unrelated", no]);

    // A base edit queues a run. A synchronize event replaces that pending run.
    live = { base: { sha: base, ref: "stable" } };
    let pending = github(docs(1), { labelState: first.labels, revision: () => live });
    const edited = pending;
    if (cancelRunning) {
      reading.abort();
      if (!drainWrites) publishing.abort();
    }
    live = newest;
    pending = github([file(".github/workflows/ci.yml")], {
      labelState: first.labels,
      revision: () => live,
    });
    resume.resolve();

    const oldConclusion = await oldRun;
    if (point === "read") {
      assert.equal(oldConclusion, "cancelled");
      assert.deepEqual(first.writes, []);
      assert.deepEqual(first.summary, []);
    } else {
      assert.match(oldConclusion, /refs or file count changed/);
      assert.match(first.summary[0], /verdict \*\*unknown\*\*/);
      assert.deepEqual([...first.labels], ["unrelated"]);
    }
    // Run the same entry point as both workflow steps. Resolve the output name
    // from the publisher's environment mapping so a wiring change is exercised.
    const [, environmentName, outputName] =
      workflow.match(/^          (\w+): \$\{\{ steps\.classify\.outputs\.(\w+) \}\}$/m) ?? [];
    assert.ok(environmentName && outputName, "publisher reads the classifier step output");
    const output = join(scratch, `${point}.output`);
    const summary = join(scratch, `${point}.summary`);
    await runPromotionPathStep("classify", pending.api, {
      GITHUB_EVENT_PATH: event,
      GITHUB_OUTPUT: output,
    });
    const value = readFileSync(output, "utf8")
      .trimEnd()
      .split("\n")
      .find((line) => line.startsWith(`${outputName}=`))
      ?.slice(outputName.length + 1);
    await runPromotionPathStep("publish", pending.api, {
      [environmentName]: value,
      GITHUB_EVENT_PATH: event,
      GITHUB_STEP_SUMMARY: summary,
    });
    assert.deepEqual(edited.pages, []);
    assert.deepEqual([...pending.labels], ["unrelated", yes]);
    assert.ok(
      readFileSync(summary, "utf8").includes(
        `head \`${newestHead}\` · base \`${newestBase}\` · verdict **yes**`,
      ),
    );
  }
  assert.match(
    workflow,
    /^      group: promotion-path-\$\{\{ github\.event\.pull_request\.number \}\}\n      cancel-in-progress: false$/m,
  );
});
