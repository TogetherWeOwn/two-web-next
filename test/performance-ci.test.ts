import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { URL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import worker, { fixtureEnvForRequest } from "../ci/lighthouse-worker";
import type { Db } from "../src/db/index";
import { events, rsvps } from "../src/db/admin-schema";
import { getPublicEvent, listHomeUpcoming } from "../src/events/reads";
import { listVisibleFeatured } from "../src/featured";
import { auditPaths, fixtureKey } from "../ci/lighthouse-paths";

const require = createRequire(import.meta.url);
const config = require("../ci/lighthouserc.cjs").ci;
const { assertFixtureContent, probeFixture, startFixture, readyPattern } = require("../ci/lighthouse-admission.cjs");
const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

async function request(path: string, method = "GET") {
  // The wrapper must not trust/inherit even a mistakenly injected live binding.
  return worker.fetch(new Request(`http://127.0.0.1:8787${path}`, { method }), {
    DATABASE_URL: "postgres://must-not-connect.invalid/forbidden",
    DB: { connectionString: "postgres://must-not-connect.invalid/forbidden" },
    DISCORD_BOT_TOKEN: "must-not-use",
  }, context);
}

describe("performance CI", () => {
  it("measures all five real public pages, not error pages or redirects", async () => {
    const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected outbound fetch"));
    try {
      for (const path of auditPaths) {
        const response = await request(path);
        expect(response.status, path).toBe(200);
        expect(response.headers.get("location"), path).toBeNull();
        expect(response.headers.get("content-type"), path).toContain("text/html");
        const html = await response.text();
        expect(html, path).toContain("/styles.css");
        if (path === "/" || path === "/events" || path.startsWith("/e/")) {
          expect(html).toContain("Lighthouse fixture game night");
          expect(html).toContain(fixtureKey);
          expect(html).toContain("Community voice channel");
          expect(html).toContain(path === "/" ? "3 going" : "3 of 20 going");
          expect(html).toMatch(/<time\b[^>]*datetime="[^"]+"/);
        }
        if (path === "/") {
          expect(html).toContain('data-testid="home-events-list"');
          expect(html).toContain('data-testid="featured-content"');
          expect(html).toContain("Lighthouse fixture community news");
          expect(html).toContain(`href="/e/${fixtureKey}"`);
          expect(html).not.toContain('data-testid="home-events-empty"');
          expect(html).not.toContain('data-state="unavailable"');
          expect(html).not.toContain("Game nights are unavailable right now.");
        }
        if (path === "/events") {
          expect(html).toContain('data-testid="event-card"');
          expect(html).not.toMatch(/data-testid="events-empty-(never|gap|error|search)"/);
        }
        if (path.startsWith("/e/")) {
          expect(html).toContain("A local-only community game night used to measure the real event page.");
          expect(html).toContain('data-testid="event-join-pitch"');
          expect(html).toContain('<h1 data-waitlist-position="">Lighthouse fixture game night</h1>');
        }
        if (path === "/join") expect(html).not.toContain("<iframe");
      }
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      outbound.mockRestore();
    }
  });

  it("blocks OAuth, mutations and nonfixture routes", async () => {
    for (const path of ["/auth/discord", "/auth/discord/callback?code=fixture", "/events?q=search", "/events?view=calendar", "/admin",
      "/events.json", "/events.rss", "/events.ics", "/events/past", "/api/agent-events", "/csp-reports", "/#fragment"]) {
      expect((await request(path)).status, path).toBe(404);
    }
    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect((await request("/join", method)).status, method).toBe(404);
    }
    expect((await request("/e/01ARZ3NDEKTSV4RRFFQ69G5FAA")).status).toBe(404);
    for (const url of ["https://example.invalid/", "http://localhost:8787/", "https://127.0.0.1:8787/", "http://127.0.0.1:8788/"]) {
      expect((await worker.fetch(new Request(url), {}, context)).status, url).toBe(404);
    }
    for (const headers of [new Headers({ cookie: "arbitrary-session" }), new Headers({ authorization: "Bearer arbitrary" })]) {
      expect((await worker.fetch(new Request("http://127.0.0.1:8787/", { headers }), {}, context)).status).toBe(404);
    }
  });

  it("supports the real homepage read transactions without SQL transport or shared settings", async () => {
    const now = new Date("2030-01-01T00:00:00Z");
    const db = fixtureEnvForRequest(now.getTime()).ADMIN_DB as Db;
    const [home, featured] = await Promise.all([listHomeUpcoming(db, now), listVisibleFeatured(db, now)]);
    expect(home).toEqual([{ eventKey: fixtureKey, title: "Lighthouse fixture game night", startsAt: new Date("2030-01-08T00:00:00Z"),
      timezone: "Europe/London", location: "Community voice channel", goingCount: 3 }]);
    expect(featured).toEqual([{ id: 1, title: "Lighthouse fixture community news", body: "Local community games and upcoming game nights.",
      url: "/events", imageUrl: null, imageAlt: null }]);
    const failure = new Error("Local callback failed");
    await expect(db.transaction(async () => { throw failure; })).rejects.toBe(failure);
    // A rejected callback has no mutable state to leak to the next read.
    expect(await listHomeUpcoming(db, now)).toEqual(home);
    await expect(db.transaction((tx) => tx.transaction(async () => undefined))).rejects.toThrow("Unsupported Lighthouse fixture transaction");
    await expect(db.transaction(async () => undefined, { accessMode: "read write" })).rejects.toThrow("Unsupported Lighthouse fixture transaction");
    let escaped!: Pick<Db, "execute">;
    await db.transaction(async (tx) => { escaped = tx; });
    await expect(escaped.execute(sql`select set_config('lock_timeout', ${"400ms"}, true), set_config('statement_timeout', ${"400ms"}, true)`)).rejects.toThrow();
  });

  it.each([
    ["session-level settings", "select set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)", ["400ms", "400ms"]],
    ["unbounded timeout", "select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)", ["0ms", "0ms"]],
    ["unrelated setting", "select set_config('search_path', $1, true)", ["public"]],
    ["mixed timeout budgets", "select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)", ["400ms", "250ms"]],
    ["multi-statement settings", "select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true); delete from rsvps", ["400ms", "400ms"]],
    ["unknown read", 'select "user_id" from "rsvps"', []],
    ["write with an allowed-looking substring", 'delete from "rsvps" where "status" = $1', ["going"]],
  ])("fails closed on %s SQL", async (_label, statement, params) => {
    const db = fixtureEnvForRequest(Date.now()).ADMIN_DB as Db;
    // Retain bound parameters while testing complete-statement admission.
    const parts = statement.split(/\$\d+/);
    const query = sql.join(parts.flatMap((part, index) => index < params.length ? [sql.raw(part!), sql`${params[index]}`] : [sql.raw(part!)]), sql.raw(""));
    await expect(db.transaction((tx) => tx.execute(query))).rejects.toThrow();
  });

  it("refuses transaction-local settings outside a callback, arbitrary event rows and private projections", async () => {
    const db = fixtureEnvForRequest(Date.now()).ADMIN_DB as Db;
    await expect(db.execute(sql`select set_config('lock_timeout', ${"400ms"}, true), set_config('statement_timeout', ${"400ms"}, true)`)).rejects.toThrow();
    await expect(getPublicEvent(db, "01ARZ3NDEKTSV4RRFFQ69G5FAA")).rejects.toThrow();
    await expect(db.select().from(events)).rejects.toThrow();
    await expect(db.select({ creator: events.createdBy }).from(events)).rejects.toThrow();
    await expect(db.select({ user: rsvps.userId }).from(rsvps)).rejects.toThrow();
    await expect(db.delete(rsvps)).rejects.toThrow();
    await expect(db.execute(sql`select pg_sleep(1)`)).rejects.toThrow();
  });

  it("admits populated real app content before collection and refuses nonlocal URL sets before fetching", async () => {
    const fetchPage = vi.fn((url: string, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return request(new URL(url).pathname);
    });
    await probeFixture(config.collect.url, fetchPage);
    expect(fetchPage.mock.calls.map(([url]) => url)).toEqual(config.collect.url);
    fetchPage.mockClear();
    for (const urls of [["https://example.invalid/"], [...config.collect.url, "http://127.0.0.1:8787/admin"],
      config.collect.url.slice(1), [...config.collect.url.slice(0, 4), "http://127.0.0.1:8787/about?probe=1"]]) {
      await expect(probeFixture(urls, fetchPage)).rejects.toThrow("Only the five local fixture URLs");
    }
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it.each([
    ["homepage unavailable fallback", "/", (html: string) => html.replace(/<ul\b[^>]*data-testid="home-events-list"[^>]*>[\s\S]*?<\/ul>/, '<div data-testid="home-events-empty" data-state="unavailable">Game nights are unavailable right now.</div>')],
    ["homepage empty list", "/", (html: string) => html.replace(/(<ul\b[^>]*data-testid="home-events-list"[^>]*>)[\s\S]*?(<\/ul>)/, "$1$2")],
    ["homepage missing aggregate", "/", (html: string) => html.replace("3 going", "0 going")],
    ["homepage missing featured fixture", "/", (html: string) => html.replace("Lighthouse fixture community news", "")],
    ["calendar absent card", "/events", (html: string) => html.replace('data-testid="event-card"', 'data-testid="missing-card"')],
    ["calendar empty state", "/events", (html: string) => html.replace("</main>", '<div data-testid="events-empty-never"></div></main>')],
    ["calendar wrong aggregate", "/events", (html: string) => html.replace("3 of 20 going", "0 of 20 going")],
    ["detail missing heading despite populated metadata", `/e/${fixtureKey}`, (html: string) => html.replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/, "")],
    ["detail missing description", `/e/${fixtureKey}`, (html: string) => html.replaceAll("A local-only community game night used to measure the real event page.", "")],
    ["detail wrong aggregate", `/e/${fixtureKey}`, (html: string) => html.replace("3 of 20 going", "0 of 20 going")],
    ["epoch fixture dates", "/", (html: string) => html.replace(/datetime="[^"]+"/g, 'datetime="1970-01-08T00:00:00.000Z"')],
    ["missing real app CSS", "/", (html: string) => html.replace('href="/styles.css"', 'href="/missing.css"')],
    ["external Discord embed", "/join", (html: string) => html.replace("</main>", '<iframe src="https://discord.com"></iframe></main>')],
    ["static error content", "/about", (html: string) => html.replace("About Together We Own</h1>", "Unavailable</h1>")],
  ])("refuses %s even when the route remains HTTP 200", async (_label, path, mutate) => {
    const before = Date.now();
    const response = await request(path);
    const html = await response.text();
    const after = Date.now();
    expect(() => assertFixtureContent(path, response, html, before, after)).not.toThrow();
    expect(() => assertFixtureContent(path, response, mutate(html), before, after)).toThrow();
  });

  it("refuses redirects and non-HTML responses before Lighthouse admission", async () => {
    const response = await request("/");
    const html = await response.text();
    for (const badResponse of [new Response(html, { status: 302, headers: { location: "/join", "content-type": "text/html" } }),
      new Response(html, { headers: { "content-type": "text/plain" } }),
      { status: 200, redirected: true, headers: response.headers }]) {
      expect(() => assertFixtureContent("/", badResponse, html, Date.now(), Date.now())).toThrow();
    }
  });

  it("withholds the LHCI ready marker until every real page passes, then cleans up once", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    const chunks: string[] = [];
    const stopServer = vi.fn();
    const fetchPage = vi.fn((url: string) => request(new URL(url).pathname));
    const running = startFixture(config.collect.url, { spawnServer: () => child, fetchPage, stopServer,
      output: { write: (chunk: string | Buffer) => chunks.push(String(chunk)) }, errors: { write: vi.fn() } });
    child.stdout.emit("data", "[wrangler:info] Ready on http://127.0.0.");
    expect(fetchPage).not.toHaveBeenCalled();
    child.stdout.emit("data", "1:8787\n");
    expect(chunks.join("")).not.toContain(readyPattern);
    await running.admission;
    expect(fetchPage).toHaveBeenCalledTimes(5);
    expect(chunks.join("")).toContain(readyPattern);
    expect(stopServer).not.toHaveBeenCalled();
    running.stop();
    running.stop();
    expect(stopServer).toHaveBeenCalledExactlyOnceWith(child);
  });

  it("kills the local server and never announces readiness for a 200 homepage fallback", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    const chunks: string[] = [];
    const stopServer = vi.fn();
    const fetchPage = vi.fn(async (url: string) => {
      const response = await request(new URL(url).pathname);
      const html = (await response.text()).replace('data-testid="home-events-list"', 'data-testid="home-events-empty"');
      return new Response(html, { headers: response.headers });
    });
    const running = startFixture(config.collect.url, { spawnServer: () => child, fetchPage, stopServer,
      output: { write: (chunk: string | Buffer) => chunks.push(String(chunk)) }, errors: { write: vi.fn() } });
    child.stdout.emit("data", "Ready on http://127.0.0.1:8787\n");
    await expect(running.admission).rejects.toThrow("Homepage fallback");
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(chunks.join("")).not.toContain(readyPattern);
    expect(stopServer).toHaveBeenCalledExactlyOnceWith(child);
  });

  it("never publishes late readiness if the server exits during admission", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    const chunks: string[] = [];
    const stopServer = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchPage = vi.fn(async (url: string) => { await gate; return request(new URL(url).pathname); });
    const running = startFixture(config.collect.url, { spawnServer: () => child, fetchPage, stopServer,
      output: { write: (chunk: string | Buffer) => chunks.push(String(chunk)) }, errors: { write: vi.fn() } });
    child.stdout.emit("data", "Ready on http://127.0.0.1:8787\n");
    child.emit("exit", 1);
    await expect(running.admission).rejects.toThrow("exited before content admission");
    release();
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(5));
    expect(chunks.join("")).not.toContain(readyPattern);
    expect(stopServer).toHaveBeenCalledExactlyOnceWith(child);
  });

  it("fails closed before LHCI's unchanged 60s warn-and-continue timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      const output = { write: vi.fn() };
      const stopServer = vi.fn();
      const fetchPage = vi.fn();
      const running = startFixture(config.collect.url, { spawnServer: () => child, fetchPage, stopServer, output, errors: output });
      const rejected = expect(running.admission).rejects.toThrow("content admission exceeded 55s");
      await vi.advanceTimersByTimeAsync(55000);
      await rejected;
      expect(stopServer).toHaveBeenCalledExactlyOnceWith(child);
      expect(fetchPage).not.toHaveBeenCalled();
      expect(output.write).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      // Late Wrangler startup cannot admit content after the watchdog failed.
      child.stdout.emit("data", "Ready on http://127.0.0.1:8787\n");
      expect(fetchPage).not.toHaveBeenCalled();
      expect(output.write.mock.calls.flat().join("")).not.toContain(readyPattern);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pins legacy public thresholds, median sampling and the phone profile", () => {
    expect(config.collect.url).toEqual(auditPaths.map((path) => `http://127.0.0.1:8787${path}`));
    expect(config.collect.numberOfRuns).toBe(3);
    expect(config.assert.assertions).toEqual({
      "largest-contentful-paint": ["error", { maxNumericValue: 2000, aggregationMethod: "median" }],
      "cumulative-layout-shift": ["error", { maxNumericValue: 0.1, aggregationMethod: "median" }],
      "server-response-time": ["error", { maxNumericValue: 600, aggregationMethod: "median" }],
      "total-blocking-time": ["warn", { maxNumericValue: 300, aggregationMethod: "median" }],
      "first-contentful-paint": ["warn", { maxNumericValue: 1800, aggregationMethod: "median" }],
    });
    expect(config.collect.settings.formFactor).toBe("mobile");
    expect(config.collect.settings.screenEmulation).toEqual({
      mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false,
    });
    expect(config.collect.settings.throttlingMethod).toBe("simulate");
    expect(config.collect.settings.throttling).toEqual({
      rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4,
      requestLatencyMs: 562.5, downloadThroughputKbps: 1474.56, uploadThroughputKbps: 675,
    });
    expect(config.upload.target).toBe("filesystem");
  });

  it.each([
    ["largest-contentful-paint", 2001],
    ["cumulative-layout-shift", 0.11],
  ])("blocks the required check after a real LHCI %s assertion failure", (audit, numericValue) => {
    const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "performance-assert-"));
    try {
      const audits = Object.fromEntries(Object.keys(config.assert.assertions)
        .map((key) => [key, { numericValue: 0 }]));
      audits[audit] = { numericValue };
      const report = join(root, "report.json");
      writeFileSync(report, JSON.stringify({ finalUrl: "http://127.0.0.1:8787/events", audits }));
      // Real assertion command and production thresholds; no collection/network.
      const assertion = spawnSync(process.execPath, [resolve("node_modules/.bin/lhci"), "assert",
        "--config", resolve("ci/lighthouserc.cjs"), "--lhr", report], { cwd: root, encoding: "utf8" });
      expect(assertion.status, assertion.stdout + assertion.stderr).toBe(1);
      expect(assertion.stdout + assertion.stderr).toContain(audit);
      const gate = spawnSync(process.execPath, [resolve("ci/require-performance.mjs"),
        assertion.status === 0 ? "success" : "failure", "success"], { encoding: "utf8" });
      expect(gate.status, gate.stdout + gate.stderr).toBe(1);
      expect(gate.stderr).toContain("lighthouse did not succeed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads the pinned Lighthouse toolchain with patched transitive dependencies", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.devDependencies["@lhci/cli"]).toBe("0.15.1");
    expect(pkg.overrides["@lhci/cli"]).toEqual({ tmp: "0.2.7", "@puppeteer/browsers": "3.2.3" });
    // GHSA-c475-qrg2-pj4r: only LHCI's proxy chain pulls basic-ftp in.
    expect(pkg.overrides["basic-ftp"]).toBe("6.2.1");
    // Main's engines floor (^22.18.0 || >=24) satisfies the ESM-only browser
    // helper's own >=22.12.0 requirement; pin the merged value, not the floor.
    expect(pkg.engines.node).toBe("^22.18.0 || >=24");
    // Exercise both module entry points used by LHCI and Lighthouse, without Chrome/network.
    const loaded = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      import { existsSync, writeFileSync } from "node:fs";
      const require = createRequire(import.meta.url);
      const lhciRequire = createRequire(require.resolve("@lhci/cli/package.json"));
      const tmp = lhciRequire("tmp");
      assert.equal(lhciRequire("tmp/package.json").version, "0.2.7");
      const file = tmp.fileSync({ postfix: ".html" });
      try {
        assert.ok(file.name.endsWith(".html"));
        writeFileSync(file.name, "local fixture");
        assert.ok(existsSync(file.name));
      } finally { file.removeCallback(); }
      assert.equal(existsSync(file.name), false);
      assert.equal(typeof require("puppeteer-core").connect, "function");
      assert.equal(typeof (await import("puppeteer-core")).connect, "function");
      assert.equal(typeof (await import("lighthouse")).default, "function");
      // Both proxy chains (LHCI's and Puppeteer's) must resolve the patched FTP client.
      for (const chain of [["@lhci/cli", "proxy-agent", "pac-proxy-agent", "get-uri"],
        ["lighthouse", "puppeteer-core", "proxy-agent", "pac-proxy-agent", "get-uri"]]) {
        let req = require;
        for (const name of chain) req = createRequire(req.resolve(name + "/package.json"));
        assert.equal(req("basic-ftp/package.json").version, "6.2.1");
        assert.equal(typeof req("basic-ftp").Client, "function");
      }
    `], { encoding: "utf8", timeout: 20000 });
    expect(loaded.status, loaded.stdout + loaded.stderr).toBe(0);
  });

  it("wires both performance results into the always-running required check", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const check = workflow.split("\n  check:\n")[1]!.split("\n  bundle-budget:\n")[0]!;
    expect(check).toContain("name: check");
    expect(check).toContain("needs: [a11y, lighthouse, bundle-budget, scope]");
    expect(check).toContain("if: always()");
    expect(check).toContain('node ci/require-performance.mjs "${{ needs.lighthouse.result }}" "${{ needs.bundle-budget.result }}"');
    expect(check).toContain("if: always() && needs.scope.outputs.docs_only != 'true'");
    expect(check).toContain("run: npm run deps:audit:selftest");
    expect(check).toContain("run: npm run deps:audit");
  });

  it("uses a standalone local-only Wrangler config", () => {
    const raw = readFileSync(new URL("../ci/wrangler.lighthouse.jsonc", import.meta.url), "utf8");
    const wrangler = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
    expect(wrangler.main).toBe("./lighthouse-worker.ts");
    expect(wrangler.assets.directory).toBe("../public");
    for (const remote of ["hyperdrive", "queues", "routes", "triggers", "vars", "services"]) {
      expect(wrangler).not.toHaveProperty(remote);
    }
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["dev:lighthouse"]).toContain("--local --ip 127.0.0.1 --port 8787");
    expect(config.collect.startServerCommand).toBe("node ci/lighthouse-admission.cjs");
    expect(config.collect.startServerReadyPattern).toBe(readyPattern);
    expect(config.collect.startServerReadyTimeout).toBe(60000);
  });
});
