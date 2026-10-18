// Web standards gate (owner request 2026-10-10): on the Lighthouse fixture worker, every audited route must
// send the app's security headers (src/headers.ts), carry the HTML basics a crawler and a screen reader need,
// and link only to internal URLs that resolve. HSTS is set at the edge, not by the worker (src/index.tsx),
// so it is not required here. Writes .lighthouseci/standards-summary.md; exits 1 on any finding.
// --selftest checks the pure helpers without a server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const origin = "http://127.0.0.1:8787";
const fixtureKey = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const paths = [
  "/",
  "/events",
  `/e/${fixtureKey}`,
  "/join",
  "/about",
  "/faq",
  "/rules",
  "/privacy",
];
const readyPattern = "Lighthouse fixture content admitted";
const maxLinks = 300;

export function headerFindings(path, headers) {
  const out = [];
  const csp = headers.get("content-security-policy") || "";
  if (!/default-src|script-src/.test(csp))
    out.push(`${path}: Content-Security-Policy missing or without default-src/script-src`);
  if ((headers.get("x-content-type-options") || "").toLowerCase() !== "nosniff")
    out.push(`${path}: X-Content-Type-Options is not nosniff`);
  if (!headers.get("referrer-policy")) out.push(`${path}: Referrer-Policy missing`);
  return out;
}

export function htmlFindings(path, html) {
  const out = [];
  if (!/^\s*<!doctype html>/i.test(html)) out.push(`${path}: missing <!doctype html>`);
  if (!/<html\b[^>]*\blang="[a-z]{2}/i.test(html)) out.push(`${path}: <html> has no lang`);
  const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
  if (!title) out.push(`${path}: empty or missing <title>`);
  if (!/<meta\b[^>]*name="viewport"/i.test(html)) out.push(`${path}: missing viewport meta`);
  if (!/<meta\b[^>]*name="description"[^>]*content="[^"]{20,}/i.test(html))
    out.push(`${path}: missing or short meta description`);
  if ((html.match(/<h1\b/gi) || []).length !== 1) out.push(`${path}: expected exactly one <h1>`);
  return out;
}

export function internalLinks(html) {
  const links = new Set();
  for (const m of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi)) {
    const href = m[1].replace(/&amp;/g, "&");
    if (!href.startsWith("/") || href.startsWith("//")) continue;
    links.add(href.split("#")[0] || "/");
  }
  return [...links];
}

export function routeMatchers(srcDir = "src") {
  const patterns = new Set(["/about", "/faq", "/admin"]);
  const adminDir = join(srcDir, "admin");
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) {
        // Sub-apps mount under a prefix (src/index.tsx: app.route("/admin", adminApp())).
        // Routes defined in src/admin/ serve under /admin, not at the root.
        const prefix = full === adminDir || full.startsWith(`${adminDir}/`) ? "/admin" : "";
        for (const m of readFileSync(full, "utf8").matchAll(
          /\.(?:get|all|on)\(\s*["'`](\/[^"'`]*)["'`]/g,
        )) {
          const route = m[1];
          patterns.add(prefix ? (route === "/" ? prefix : `${prefix}${route}`) : route);
        }
      }
    }
  };
  walk(srcDir);
  return [...patterns].map((p) => {
    const re = p
      .replace(/[.*+?^$()|[\]\\]/g, (c) => (c === "." ? "\\." : `\\${c}`))
      .replace(/:[A-Za-z]+\\\{([^}]*)\\\}/g, (_, inner) => `(?:${inner.replace(/\\\\/g, "\\")})`)
      .replace(/:[A-Za-z]+/g, "[^/]+");
    return new RegExp(`^${re}/?$`);
  });
}

export function linkResolves(link, matchers, publicDir = "public") {
  const pathname = decodeURI(link.split("?")[0]);
  if (matchers.some((re) => re.test(pathname))) return true;
  return pathname !== "/" && existsSync(join(publicDir, pathname));
}

export function linkFindings(links, matchers, publicDir = "public") {
  const list = Array.isArray(links) ? links : [...links];
  const out = [];
  for (const link of list.slice(0, maxLinks)) {
    if (!linkResolves(link, matchers, publicDir))
      out.push(`internal link ${link}: no app route or public file serves it`);
  }
  if (list.length > maxLinks) {
    out.push(
      `internal links truncated: checked first ${maxLinks} of ${list.length} collected; expand coverage so every collected link is checked`,
    );
  }
  return out;
}

// Per-route settlement deadline: headers AND the full body must settle within
// this long, or the route becomes a route-named timeout finding instead of
// stalling the collector until the enclosing workflow times out. It is a total
// deadline, not an idle timer: a dripping body cannot keep resetting it.
export const ROUTE_READ_TIMEOUT_MS = 15_000;

function routeTimeoutError(timeoutMs) {
  const err = new Error(`route read timed out after ${timeoutMs}ms`);
  err.code = "ROUTE_READ_TIMEOUT";
  return err;
}

async function cancelBody(res) {
  try {
    await res?.body?.cancel?.();
  } catch {
    // Best-effort cleanup only; the timeout error below carries the failure.
  }
}

async function readBodyText(res, refs) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  if (refs) refs.reader = reader;
  const textChunks = [];
  const byteChunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (typeof value === "string") textChunks.push(value);
      else if (value) byteChunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already cancelled on the deadline path; nothing left to release.
    }
  }
  if (!byteChunks.length) return textChunks.join("");
  const total = byteChunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let at = 0;
  for (const c of byteChunks) {
    merged.set(c, at);
    at += c.byteLength;
  }
  return textChunks.join("") + new TextDecoder().decode(merged);
}

export async function fetchRoute(fetchImpl, url, options = {}) {
  const timeoutMs = options.timeoutMs ?? ROUTE_READ_TIMEOUT_MS;
  const controller = new AbortController();
  let failDeadline;
  const deadline = new Promise((_, reject) => {
    failDeadline = reject;
  });
  // The deadline always has a listener, so a late settlement after the caller
  // moved on never surfaces as an unhandled rejection.
  deadline.catch(() => {});
  const refs = {};
  let res;
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      // Aborting is best-effort; the deadline rejection below is the signal.
    }
    // A body that ignores the abort signal still settles: cancel the reader so
    // the raced read below resolves instead of hanging on the stream.
    try {
      const cancelled = refs.reader?.cancel();
      if (cancelled?.catch) cancelled.catch(() => {});
    } catch {
      // Reader already released or never created; the deadline still applies.
    }
    failDeadline(routeTimeoutError(timeoutMs));
  }, timeoutMs);
  timer.unref?.();
  try {
    res = await Promise.race([
      fetchImpl(url, { redirect: "manual", signal: controller.signal }),
      deadline,
    ]);
    const html = await Promise.race([readBodyText(res, refs), deadline]);
    clearTimeout(timer);
    return { status: res.status, headers: res.headers, html };
  } catch (err) {
    clearTimeout(timer);
    try {
      await refs.reader?.cancel();
    } catch {
      // Already cancelled on the deadline path; nothing further to release.
    }
    await cancelBody(res);
    if (err?.code === "ROUTE_READ_TIMEOUT") throw err;
    // The fetch settled (abort rejection, reset connection) only because the
    // deadline fired first: report the timeout, not the abort fallout.
    if (controller.signal.aborted) throw routeTimeoutError(timeoutMs);
    throw err;
  }
}

export async function collectStandards(options = {}) {
  const {
    base,
    routes,
    fetchImpl = (...args) => fetch(...args),
    timeoutMs = ROUTE_READ_TIMEOUT_MS,
  } = options;
  const findings = [];
  const links = new Set();
  for (const path of routes) {
    let status;
    let headers;
    let html;
    try {
      ({ status, headers, html } = await fetchRoute(fetchImpl, base + path, { timeoutMs }));
    } catch (err) {
      if (err?.code === "ROUTE_READ_TIMEOUT")
        findings.push(`${path}: timed out after ${timeoutMs}ms`);
      else findings.push(`${path}: ${err?.message || "request failed"}`);
      continue;
    }
    if (status !== 200) findings.push(`${path}: status ${status}`);
    findings.push(...headerFindings(path, headers), ...htmlFindings(path, html));
    for (const link of internalLinks(html)) links.add(link);
  }
  return { findings, links };
}

function selftest() {
  const h = (o) => new Headers(o);
  assert.deepEqual(
    headerFindings(
      "/",
      h({
        "content-security-policy": "default-src 'self'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      }),
    ),
    [],
  );
  assert.equal(headerFindings("/", h({})).length, 3);
  const good =
    '<!doctype html><html lang="en"><head><title>T</title><meta name="viewport" content="w"><meta name="description" content="A long enough description here"></head><body><h1>x</h1></body></html>';
  assert.deepEqual(htmlFindings("/", good), []);
  assert.equal(htmlFindings("/", "<html><body></body></html>").length, 6);
  assert.equal(htmlFindings("/", good.replace("<h1>x</h1>", "<h1>a</h1><h1>b</h1>")).length, 1);
  assert.deepEqual(
    internalLinks(
      '<a href="/a#x">a</a><a href="https://x.y/">e</a><a href="//cdn/x">c</a><a href="/b?q=1&amp;r=2">b</a><a href="#top">t</a>',
    ),
    ["/a", "/b?q=1&r=2"],
  );
  const ms = routeMatchers();
  for (const ok of [
    "/",
    "/events?view=calendar&month=2026-10",
    "/events/01ARZ3NDEKTSV4RRFFQ69G5FAV.ics",
    "/e/abc",
    "/about",
    "/styles.css",
    "/auth/discord?next=%2Fevents",
    "/admin",
    "/admin/activity-log",
    "/admin/join-attempts/1",
    "/admin/featured/new",
  ])
    assert.ok(linkResolves(ok, ms), `should resolve: ${ok}`);
  for (const bad of [
    "/nope",
    "/events/a/b/c",
    "/about-us",
    // Admin routes mount under /admin (src/index.tsx), never at the root.
    "/activity-log",
    "/join-attempts/1",
    "/featured/new",
  ])
    assert.ok(!linkResolves(bad, ms), `should not resolve: ${bad}`);
  const okMatchers = [/^\/ok-\d+\/?$/];
  const probeDir = "/nonexistent-public-dir-for-selftest";
  const manyOk = Array.from({ length: maxLinks }, (_, i) => `/ok-${i}`);
  const overPastCap = [...manyOk, "/past-cap-missing"];
  const overPastFindings = linkFindings(overPastCap, okMatchers, probeDir);
  assert.equal(
    overPastFindings.filter((f) => /truncat/i.test(f)).length,
    1,
    `over-cap set must emit one truncation finding: ${overPastFindings}`,
  );
  const truncation = overPastFindings.find((f) => /truncat/i.test(f));
  assert.ok(
    truncation.includes(String(maxLinks)),
    `truncation finding must name the cap (${maxLinks}): ${truncation}`,
  );
  assert.ok(
    truncation.includes(String(overPastCap.length)),
    `truncation finding must name total collected (${overPastCap.length}): ${truncation}`,
  );
  assert.ok(
    !overPastFindings.includes(
      "internal link /past-cap-missing: no app route or public file serves it",
    ),
    `past-cap link is not checked, only truncated: ${overPastFindings}`,
  );
  assert.deepEqual(
    overPastFindings.filter((f) => !/truncat/i.test(f)),
    [],
    `all checked links resolve, so only truncation remains: ${overPastFindings}`,
  );
  const overWithinCap = ["/ok-1", "/within-cap-missing", ...manyOk];
  const overWithinFindings = linkFindings(overWithinCap, okMatchers, probeDir);
  assert.ok(
    overWithinFindings.includes(
      "internal link /within-cap-missing: no app route or public file serves it",
    ),
    `within-cap miss still reported under truncation: ${overWithinFindings}`,
  );
  assert.equal(
    overWithinFindings.filter((f) => /truncat/i.test(f)).length,
    1,
    `within-cap miss keeps one truncation finding: ${overWithinFindings}`,
  );
  assert.deepEqual(linkFindings(manyOk, okMatchers, probeDir), []);
  assert.deepEqual(linkFindings(["/ok-1", "/bad-a"], okMatchers, probeDir), [
    "internal link /bad-a: no app route or public file serves it",
  ]);
  console.log("web-standards selftest: ok");
}

async function waitForServer(child) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture worker not ready in 120s")), 120_000);
    const onData = (buf) => {
      if (buf.toString().includes(readyPattern)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`fixture worker exited (${code})`)));
  });
}

async function main() {
  // --origin <allowlisted origin>: check a deployed site (no fixture worker; DB-free routes only).
  const at = process.argv.indexOf("--origin");
  const deployed =
    at > 0
      ? createRequire(import.meta.url)("./lighthouse-origin-lib.cjs").requireAllowedOrigin(
          process.argv[at + 1],
        )
      : null;
  const base = deployed ?? origin;
  const routes = deployed ? paths.filter((p) => !p.startsWith("/e/")) : paths;
  const child = deployed
    ? null
    : spawn("node", ["ci/lighthouse-admission.cjs"], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
  const findings = [];
  const checked = new Set();
  let totalCollected = 0;
  try {
    if (child) await waitForServer(child);
    // Every route read runs under the per-route deadline; a timed-out route
    // becomes a route-named finding and later routes still run, so the summary
    // below is always reached.
    const { findings: routeFindings, links } = await collectStandards({
      base,
      routes,
      timeoutMs: ROUTE_READ_TIMEOUT_MS,
    });
    findings.push(...routeFindings);
    const matchers = routeMatchers();
    const collected = [...links];
    totalCollected = collected.length;
    findings.push(...linkFindings(collected, matchers));
    for (const link of collected.slice(0, maxLinks)) checked.add(link);
  } finally {
    if (child)
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
  }
  const lines = [
    "## Web standards",
    "",
    `Origin: ${base}. Routes: ${routes.length}. Internal links checked: ${checked.size} of ${totalCollected} collected.`,
    "",
  ];
  lines.push(
    ...(findings.length
      ? ["**Findings (fix these; do not loosen the check):**", "", ...findings.map((f) => `- ${f}`)]
      : ["All checks passed."]),
  );
  mkdirSync(".lighthouseci", { recursive: true });
  writeFileSync(".lighthouseci/standards-summary.md", lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  process.exit(findings.length ? 1 : 0);
}

// Import-safe: running the collector (fixture spawn, process.exit) happens only
// when this file is the invoked script. Importing it for fetchRoute /
// collectStandards never starts work.
const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (process.argv.includes("--selftest")) selftest();
else if (invokedDirectly) await main();
