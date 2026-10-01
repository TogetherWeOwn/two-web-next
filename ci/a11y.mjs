import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium, request as apiRequest } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { assertNoViolations, auditCases, redactAuditLog, WCAG_AA_TAGS } from "./a11y-policy.mjs";
import { AUDIT_BROWSER_OPTIONS, createAuditLifecycle, stopChildProcess } from "./a11y-lifecycle.mjs";
import { buildAuditWorker } from "./a11y-build.mjs";
import { assertAuditContent } from "./a11y-content.mjs";

const output = resolve("artifacts/a11y");
const lifecycle = createAuditLifecycle();
const stop = lifecycle.stop;
let scratch;
const report = { sourceRevision: process.env.GITHUB_SHA || process.env.A11Y_REVISION || "local working tree", tags: WCAG_AA_TAGS, environment: "wrangler dev / local fixtures only", pages: [], failures: [] };
let server;
let browser;
let fixture;
let readiness;
let serverLog = "";

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => socket.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    report.failures.push(`Audit cancelled by ${signal}`);
    process.exitCode = 1;
    // Do not exit early: finally waits for this same promise and writes evidence.
    void stop().catch(() => {});
  });
}

try {
  await mkdir(output, { recursive: true });
  scratch = await lifecycle.acquire(() => mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "two-a11y-")), (path) => rm(path, { recursive: true, force: true }));
  await lifecycle.run(() => symlink(resolve("node_modules"), join(scratch, "node_modules"), "dir"));
  // Route discovery and Wrangler use one bundle with isolated bot read models.
  const bundled = join(scratch, "routes.mjs");
  await lifecycle.run(() => buildAuditWorker(bundled));
  const { routes, coverage } = await lifecycle.run(() => import(pathToFileURL(bundled).href));
  const scenarios = auditCases(routes, coverage);
  assert(scenarios.length > 0, "Empty accessibility coverage");
  report.coverage = { registered: [...new Set(routes.filter((r) => r.method === "GET").map((r) => r.path))], exclusions: Object.entries(coverage).filter(([, entry]) => entry.skip).map(([route, entry]) => ({ route, reason: entry.reason })) };

  const fixtureBundle = join(scratch, "fixtures.mjs");
  await lifecycle.run(() => build({ entryPoints: ["ci/a11y-fixtures.ts"], bundle: true, packages: "external", platform: "node", format: "esm", outfile: fixtureBundle,
    define: { "import.meta.url": JSON.stringify(pathToFileURL(resolve("test/helpers/member-data-db.ts")).href) } }));
  const { fixtures } = await lifecycle.run(() => import(pathToFileURL(fixtureBundle).href));
  const database = process.env.DATABASE_URL || "postgres://agent_test@agent-testdb:5432/two_web_next";
  fixture = await lifecycle.acquire(() => fixtures(database), (resource) => resource.dispose());

  const port = await lifecycle.run(freePort);
  const origin = `https://127.0.0.1:${port}`;
  const config = join(scratch, "wrangler.json");
  await lifecycle.run(() => writeFile(config, JSON.stringify({
    name: "two-web-next-a11y",
    main: bundled,
    compatibility_date: "2026-09-29",
    compatibility_flags: ["nodejs_compat"],
    assets: { directory: resolve("public") },
    vars: { APP_URL: origin, A11Y_DATABASE_URL: database, A11Y_SCHEMA: fixture.schemaName, A11Y_CI: String(process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true"), SESSION_SECRET: fixture.sessionSecret, DISCORD_CLIENT_ID: "local-fixture", DISCORD_GUILD_ID: "local-fixture", DISCORD_INVITE_URL: "/discord" },
    dev: { local_protocol: "https" },
  })));
  // Do not inherit DB URLs, Cloudflare credentials, or .dev.vars. This worker has no remote bindings.
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LD_LIBRARY_PATH", "FONTCONFIG_FILE", "FONTCONFIG_PATH", "NODE_EXTRA_CA_CERTS"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  server = await lifecycle.acquire(() => spawn(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", config, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--persist-to", join(scratch, "state")], { cwd: scratch, env: { ...env, CI: "true", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] }), stopChildProcess);
  server.on("error", (error) => { serverLog += `\n${error.message}`; });
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (data) => { serverLog += data.toString(); });
  readiness = await lifecycle.acquire(() => apiRequest.newContext({ ignoreHTTPSErrors: true }), (resource) => resource.dispose());
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline && server.exitCode === null && server.signalCode === null) {
    lifecycle.assertRunning();
    try { ready = (await readiness.get(`${origin}/up`, { timeout: 1000 })).ok(); } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(ready, "Local wrangler failed to become ready (see wrangler.log)");
  // The runner owns SIGINT/SIGTERM; Playwright's default SIGINT handler exits
  // the process independently, before fixture cleanup and evidence can finish.
  browser = await lifecycle.acquire(() => chromium.launch(AUDIT_BROWSER_OPTIONS), (resource) => resource.close());
  for (const viewport of [{ width: 360, height: 780 }, { width: 1280, height: 900 }]) {
    for (const scenario of scenarios) {
      lifecycle.assertRunning();
      const label = `${scenario.identity} ${scenario.path} ${scenario.state || "default"} ${viewport.width}px`;
      const result = { ...scenario, viewport, label };
      const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true, extraHTTPHeaders: { "x-a11y-read-state": scenario.readState || "populated" } });
      // Block every off-origin browser request, including redirects to Discord.
      await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const page = await context.newPage();
      const resourceErrors = [];
      page.on("pageerror", (error) => resourceErrors.push(error.message));
      page.on("requestfailed", (request) => {
        if (new URL(request.url()).origin === origin && ["script", "stylesheet"].includes(request.resourceType())) resourceErrors.push(`Failed ${request.resourceType()}: ${request.url()}`);
      });
      page.on("response", (response) => {
        if (response.status() >= 400 && ["script", "stylesheet"].includes(response.request().resourceType())) resourceErrors.push(`${response.status()} ${response.url()}`);
      });
      try {
        if (scenario.identity !== "guest") {
          const cookie = await fixture.cookie(scenario.identity);
          const equals = cookie.indexOf("=");
          await context.addCookies([{ name: cookie.slice(0, equals), value: cookie.slice(equals + 1), url: origin, secure: true, httpOnly: true, sameSite: "Lax" }]);
        }
        const response = await page.goto(`${origin}${scenario.path}`, { waitUntil: "networkidle" });
        assert.equal(response?.status(), scenario.status, "Unexpected page status");
        assert.match(response.headers()["content-type"], /text\/html/, "Expected a real HTML document");
        assert.equal(page.url(), `${origin}${scenario.path}`, "Unexpected redirect hides the intended page");
        await page.evaluate(() => document.fonts.ready);
        for (const field of scenario.fill || []) await page.getByLabel(field.label, { exact: true }).fill(field.value);
        if (scenario.click) await page.getByRole(scenario.click.role, { name: scenario.click.name, exact: true }).click();
        if (scenario.waitFor) await page.getByRole(scenario.waitFor.role).waitFor({ state: "visible" });
        assert(await page.evaluate(() => document.styleSheets.length > 0), "Stylesheet must be loaded for contrast checks");
        assert.deepEqual(resourceErrors, [], "Unexpected script/stylesheet failures");
        result.contentAssertions = await assertAuditContent(page, scenario);
        const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
        result.violations = results.violations;
        result.incomplete = results.incomplete;
        result.passedRules = results.passes.length;
        await page.screenshot({ path: join(output, `${report.pages.length}-${viewport.width}.png`), fullPage: true });
        assertNoViolations(results, label);
        result.verdict = "PASS";
      } catch (error) {
        result.verdict = "FAIL";
        result.error = error.message;
        report.failures.push(`${label}: ${error.message}`);
      } finally {
        report.pages.push(result);
        await context.close();
      }
      console.log(`${result.verdict} ${label}${result.error ? `: ${result.error}` : ""}`);
    }
  }
  // Prove that axe + our gate reject a real violation rather than merely completing scans.
  lifecycle.assertRunning();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent('<!doctype html><html lang="en"><head><title>Gate sentinel</title></head><body><main><h1>Sentinel</h1><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></main></body></html>');
  const sentinel = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
  assert(sentinel.violations.some((rule) => rule.id === "image-alt"), "axe must detect the sentinel's missing alt text");
  assert.throws(() => assertNoViolations(sentinel, "sentinel"), /image-alt/);
  report.axeVersion = sentinel.testEngine.version;
  report.sentinel = "PASS: injected image-alt violation rejected";
  await context.close();
  if (report.failures.length) process.exitCode = 1;
} catch (error) {
  report.failures.push(error.message);
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    await stop();
    report.cleanup = "PASS: Wrangler stopped and owned fixture schema removed";
  } catch (error) {
    report.failures.push(`Cleanup failed: ${error.message}`);
    process.exitCode = 1;
  }
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(output, "wrangler.log"), redactAuditLog(serverLog));
  await writeFile(join(output, "summary.md"), `# WCAG 2.2 AA automated audit\n\nSource: ${report.sourceRevision}. Axe: ${report.axeVersion || "NOT VERIFIED"}.\n\nEnvironment: ${report.environment}. No production/staging database or external calls.\n\nTags: ${WCAG_AA_TAGS.join(", ")}. No allowlist or rule exclusions.\n\n| Case | Status | Content assertions | Verdict |\n|---|---|---|---|\n${report.pages.map((page) => `| ${page.label} | ${page.status} | ${page.contentAssertions?.length ?? "NOT VERIFIED"} | ${page.verdict} |`).join("\n")}\n\nSentinel: ${report.sentinel || "NOT VERIFIED"}\n\nCleanup: ${report.cleanup || "NOT VERIFIED"}\n\nFailures: ${report.failures.length}\n${report.failures.map((failure) => `- ${failure}`).join("\n")}\n\nIncomplete axe checks are in report.json; automated scanning is not a manual screen-reader certification.\n`);
}
