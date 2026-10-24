// Acceptance: the web-standards gate must validate browser-resolved links
// against served routes and files, with truthful coverage and bounded findings.
//
// Roadmap item A1/M265 (source 2b4f1902e): release agents get truthful link
// coverage and bounded findings rather than false serviceability or a crashed
// collector. Source premise, re-verified at execution HEAD 2b4f1902e:
// ci/web-standards.mjs internalLinks discovers only double-quoted
// root-relative anchors, and linkResolves decodes before checking and admits
// any existing filesystem object. Observed at that base (node probe, not a
// historical CI-bypass claim):
// - single-quoted, relative and same-origin absolute anchors escape
//   accounting, while anchors inside HTML comments and script text are
//   collected as if they were real links;
// - /fonts resolves (a directory), /../src/index.tsx and /%2e%2e/src/*
//   resolve (repository traversal appears served);
// - malformed escapes such as /%E0%A4%A and /% throw URIError out of
//   linkResolves, which can crash the collector past its summary.
//
// Locked builder contract (this file is acceptance-owned; implement against
// it, do not edit it to make an implementation pass):
// - classifyHref(href, documentUrl) classifies one raw href against the
//   audited document URL with browser URL semantics. Returns { kind, target }
//   with kind "internal" (same-origin http(s); target is pathname+search, no
//   hash), "fragment" (same-document #sect, "" or whitespace), "external"
//   (other origin incl. protocol-relative and scheme change), "non-http"
//   (mailto/tel/javascript/data/...), or "malformed" (unparseable URL or bad
//   percent escape). Never throws on any input; never fetches.
// - internalLinks(html, documentUrl?) keeps its single-argument legacy shape
//   (deduplicated array, document order) and additionally parses single-quoted
//   hrefs, decodes entities, and ignores anchors inside <!-- comments --> and
//   <script> blocks. With documentUrl it resolves relative, root-relative and
//   same-origin absolute hrefs via classifyHref and drops fragments,
//   externals, non-http and malformed hrefs.
// - linkResolves(link, matchers, publicDir?) is hardened without changing its
//   signature: it never throws, strips query/hash, safely decodes escapes,
//   rejects encoded dot segments and above-root traversal, and admits only a
//   matcher hit or a regular file under publicDir. Directories, repository
//   files reached by traversal, and out-of-root symlink targets do not
//   resolve; in-root dot segments and in-root symlinks still resolve.
// - linkFindings keeps its signature, cap (maxLinks=300) and truncation
//   finding, never throws, reports malformed links with a finding containing
//   the word "malformed" plus at most the first 120 characters of the raw
//   href, and never interpolates query values, absolute paths or exception
//   text into finding text. Under-cap findings for ordinary links stay
//   byte-identical to today.
// - linkFindingRecords(links, matchers, publicDir?) returns one record per
//   linkFindings entry: { check, code, detail } with detail deep-equal to the
//   human finding, check "link" (code LINK_UNRESOLVED or LINK_MALFORMED) or
//   "links" (code LINKS_TRUNCATED).
// - collectStandards threads each route's document URL into collection, emits
//   one bounded "<path>: malformed ..." route finding per malformed href (at
//   most 10 per route plus one overflow finding naming the total), and keeps
//   collecting sibling links and later routes. It never fetches a URL outside
//   the fixed fixture base.
// - STANDARDS_REPORT_VERSION is 1. buildJsonReport({ origin, routes,
//   linksChecked, linksCollected, findings }) returns plain JSON with version,
//   routes [{ id: "route-<i>", path }], findings [{ id: "finding-<i>",
//   routeId, checkId, code, message, next_action }] where routeId is the
//   matching route id (null for path:null global findings) and checkId is
//   "<routeId>/<check>" ("global/<check>" when routeId is null), and counts
//   { routes, findings, linksChecked, linksCollected }. Messages are the input
//   detail truncated to 300 characters; next_action is static per code and
//   carries no input-derived text. Same input yields deep-equal output.
// - parseArgs(argv) validates argv-style flags and returns { format, dryRun,
//   selftest, origin }: --format human|json, --dry-run, --selftest,
//   --origin <allowlisted url>. Unknown flags, positionals, missing or wrong
//   values, repeated value flags and non-allowlisted origins throw an Error
//   with code BAD_ARGS and a message of at most 500 characters. main() calls
//   it before any spawn, fetch or write.
// - --dry-run exits 0 after printing a human inventory naming every audited
//   route without starting a fixture Worker, fetching, writing, or claiming
//   execution ("All checks passed" must not appear). --dry-run --format json
//   prints exactly one JSON document to stdout with version 1, the 8 routes
//   with stable route-<i> ids, and per-route checks covering at least
//   status/headers/html/links. --selftest stays offline.
// - routeMatchers keeps its behavior and gains an honest limits note naming
//   what source-derived matching cannot see. Default fixture-only invocation,
//   the sole .lighthouseci/standards-summary.md output, the --origin
//   allowlist, maxLinks accounting, per-route deadlines and the
//   header/HTML checks are preserved; no new network target, ignore, budget
//   or gate relaxation.
//
// Honest limits of this suite: it is offline (synthetic HTML plus run-owned
// mkdtemp fixtures; CLI probes stub PATH so "node" cannot spawn a Worker). It
// does not require link->route provenance (link-phase findings are global with
// stable check ids), and full-run JSON fidelity (every CLI finding appears in
// --format json on a live run) is the builder's own verification, not an
// offline assertion. Fixture-only evidence here must not claim browser or
// runtime execution.
//
// Integration: the builder continues this pushed history on their
// harness-owned branch and never edits this file; wire it into the
// standards:selftest script (asserted below) so CI runs it. Return justified
// corrections through the acceptance author; do not merge this failing suite
// alone.
//
// Run: node --test ci/web-standards-browser-links-acceptance.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The module historically ran main() on import unless --selftest was present;
// keep the import inert so RED is a clean contract failure instead of a
// spawned fixture. The builder's import-safety guard makes this belt-and-braces.
if (!process.argv.includes("--selftest")) process.argv.push("--selftest");
const standards = await import("./web-standards.mjs");

const require = createRequire(import.meta.url);
const originLib = require("./lighthouse-origin-lib.cjs");

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(repoRoot, "ci/web-standards.mjs");
const source = readFileSync(scriptPath, "utf8");
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

const ORIGIN = "http://127.0.0.1:8787";
const DOC = `${ORIGIN}/`;
const PATHS = [
  "/",
  "/events",
  "/e/01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "/join",
  "/about",
  "/faq",
  "/rules",
  "/privacy",
];
const CAP = 300;
const CLI_BOUND_MS = 15_000;

const GOOD_HTML =
  '<!doctype html><html lang="en"><head><title>T</title><meta name="viewport" content="w">' +
  '<meta name="description" content="A long enough description here"></head>' +
  '<body><h1>x</h1><a href="/about">about</a><a href="https://example.invalid/">ext</a></body></html>';
const GOOD_HEADERS = {
  "content-security-policy": "default-src 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const MALFORMED_SHORT = "/%E0%A4%A";
const MALFORMED_LONG = `/${"%E0%A4%A"}-` + "B".repeat(480);

function makePublicFixture() {
  const root = mkdtempSync(join(tmpdir(), "standards-links-"));
  const pub = join(root, "public");
  mkdirSync(join(pub, "fonts"), { recursive: true });
  mkdirSync(join(pub, "sub"), { recursive: true });
  writeFileSync(join(pub, "ok.txt"), "ok");
  writeFileSync(join(pub, "sub", "inner.txt"), "inner");
  writeFileSync(join(root, "outside.txt"), "outside");
  symlinkSync(join(root, "outside.txt"), join(pub, "escape"));
  symlinkSync(join(pub, "ok.txt"), join(pub, "alias"));
  return { root, pub };
}

function summarySnapshot() {
  const dir = resolve(repoRoot, ".lighthouseci");
  let entries = null;
  try {
    entries = readdirSync(dir).sort();
  } catch {
    entries = null;
  }
  let summary = null;
  try {
    summary = readFileSync(join(dir, "standards-summary.md"), "utf8");
  } catch {
    summary = null;
  }
  return { entries, summary };
}

// CLI probes run with a stub PATH whose `node` only records invocation: the
// real fixture Worker can never start, so flag/dry-run RED fails fast with no
// orphaned processes instead of hanging on the 120s worker wait.
function runCli(args) {
  const probeDir = mkdtempSync(join(tmpdir(), "standards-spawn-probe-"));
  const spawnLog = join(probeDir, "spawn.log");
  const stub = join(probeDir, "node");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(spawnLog)}\nexit 1\n`);
  chmodSync(stub, 0o755);
  const before = summarySnapshot();
  const started = Date.now();
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, PATH: `${probeDir}${delimiter}${process.env.PATH}` },
    encoding: "utf8",
    timeout: CLI_BOUND_MS + 5_000,
  });
  const elapsedMs = Date.now() - started;
  let spawned = null;
  try {
    spawned = readFileSync(spawnLog, "utf8");
  } catch {
    spawned = null;
  }
  return { ...result, elapsedMs, spawned, summaryBefore: before, summaryAfter: summarySnapshot() };
}

function assertSummaryUntouched(run) {
  assert.deepEqual(
    run.summaryAfter,
    run.summaryBefore,
    "flag/dry-run handling must not write reports",
  );
}

function shell(links) {
  return (
    '<!doctype html><html lang="en"><head><title>T</title><meta name="viewport" content="w">' +
    `<meta name="description" content="A long enough description here"></head><body><h1>x</h1>${links}</body></html>`
  );
}

const MIXED_HTML = shell(
  '<a href="about">rel</a>' +
    `<a href="${ORIGIN}/faq">abs</a>` +
    '<a href="https://example.invalid/x">ext</a>' +
    `<a href="${MALFORMED_SHORT}">bad</a>` +
    '<!-- <a href="/ghost">g</a> -->',
);

// --- Positive controls: these pass at the base and pin unchanged behavior. ---

test("control: header, HTML and legacy single-argument link helpers keep their findings", () => {
  assert.deepEqual(standards.headerFindings("/", new Headers(GOOD_HEADERS)), []);
  assert.equal(standards.headerFindings("/", new Headers({})).length, 3);
  assert.deepEqual(standards.htmlFindings("/", GOOD_HTML), []);
  assert.deepEqual(
    standards.internalLinks(
      '<a href="/a#x">a</a><a href="https://x.y/">e</a><a href="//cdn/x">c</a>' +
        '<a href="/b?q=1&amp;r=2">b</a><a href="#top">t</a>',
    ),
    ["/a", "/b?q=1&r=2"],
  );
});

test("control: link helpers stay synchronous pure functions (no network validation)", () => {
  const matchers = [/^\/ok-\d+\/?$/];
  const { pub } = makePublicFixture();
  assert.ok(!(standards.linkResolves("/ok-1", matchers, pub) instanceof Promise));
  assert.ok(!(standards.linkFindings(["/ok-1"], matchers, pub) instanceof Promise));
  assert.ok(!(standards.internalLinks(GOOD_HTML) instanceof Promise));
});

test("control: audited route list is unchanged", () => {
  assert.deepEqual(standards.paths, PATHS);
});

test("control: default fixture-only invocation, sole summary output and failing exit stay", () => {
  assert.match(source, /http:\/\/127\.0\.0\.1:8787/, "default base stays the fixture worker");
  assert.match(source, /standards-summary\.md/, "summary file must still be written");
  assert.match(
    source,
    /process\.exit\(findings\.length \? 1 : 0\)/,
    "failing exit must be retained",
  );
});

test("control: --origin allowlist still admits the fixed origins and rejects anything else", () => {
  for (const allowed of [
    "https://next.togetherweown.com",
    "https://togetherweown.com",
    "https://www.togetherweown.com",
  ]) {
    assert.equal(originLib.requireAllowedOrigin(allowed), allowed);
  }
  assert.throws(() => originLib.requireAllowedOrigin("https://evil.example/"));
  assert.throws(() => originLib.requireAllowedOrigin("https://next.togetherweown.com/extra"));
});

test("control: maxLinks cap and truncation accounting are preserved", () => {
  const matchers = [/^\/ok-\d+\/?$/];
  const { pub } = makePublicFixture();
  const over = Array.from({ length: CAP + 1 }, (_, i) => `/ok-${i}`);
  const findings = standards.linkFindings(over, matchers, pub);
  assert.equal(findings.filter((f) => /truncat/i.test(f)).length, 1);
  assert.ok(findings.find((f) => /truncat/i.test(f)).includes(String(CAP)));
  assert.ok(findings.find((f) => /truncat/i.test(f)).includes(String(over.length)));
  assert.deepEqual(standards.linkFindings(["/ok-1", "/bad-a"], matchers, pub), [
    "internal link /bad-a: no app route or public file serves it",
  ]);
});

test("control: legitimate routes and public files still resolve", () => {
  const matchers = standards.routeMatchers();
  const publicDir = resolve(repoRoot, "public");
  for (const ok of ["/about", "/e/abc", "/admin/activity-log", "/styles.css", "/"]) {
    assert.equal(standards.linkResolves(ok, matchers, publicDir), true, `${ok} must resolve`);
  }
  assert.equal(standards.linkResolves("/nope", matchers, publicDir), false);
});

test("control: in-root dot segments and harmless escapes still resolve to their file", () => {
  const { pub } = makePublicFixture();
  assert.equal(standards.linkResolves("/./ok.txt", [], pub), true);
  assert.equal(standards.linkResolves("/sub/../ok.txt", [], pub), true);
  assert.equal(standards.linkResolves("/%6f%6b.txt", [], pub), true);
});

test("control: per-route deadline export and timeout-to-finding behavior stay", async () => {
  assert.equal(typeof standards.ROUTE_READ_TIMEOUT_MS, "number");
  assert.ok(Number.isFinite(standards.ROUTE_READ_TIMEOUT_MS));
  const fetchImpl = (url, init) => {
    if (url.endsWith("/slow")) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    }
    return Promise.resolve(new Response(GOOD_HTML, { status: 200, headers: GOOD_HEADERS }));
  };
  const { findings } = await standards.collectStandards({
    base: ORIGIN,
    routes: ["/slow", "/good"],
    fetchImpl,
    timeoutMs: 60,
  });
  assert.equal(findings.filter((f) => f.startsWith("/slow:")).length, 1);
  assert.ok(!findings.some((f) => f.startsWith("/good:")));
});

test("control: importing the module never launches a Worker", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(new URL("./web-standards.mjs", import.meta.url).href)});`,
      "--",
      "--selftest",
    ],
    { cwd: repoRoot, env: {}, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.status, 0, `hermetic import must exit 0\n${result.stdout}\n${result.stderr}`);
  assert.ok(!result.stdout.includes("Lighthouse fixture content admitted"));
});

test("control: --selftest stays offline and passing", () => {
  const run = runCli(["--selftest"]);
  assert.equal(run.status, 0, `expected exit 0\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /web-standards selftest: ok/);
  assert.equal(run.spawned, null, "selftest must not spawn a Worker");
  assert.ok(run.elapsedMs < CLI_BOUND_MS, `selftest must stay fast, took ${run.elapsedMs}ms`);
});

test("control: invalid --origin is rejected before any spawn", () => {
  const run = runCli(["--origin", "https://evil.example/"]);
  assert.notEqual(run.status, 0, "invalid origin must fail");
  assert.equal(run.spawned, null, "invalid origin must not spawn a Worker");
  assert.match(run.stderr, /runs only against/);
  assertSummaryUntouched(run);
});

// --- Browser-URL anchor classification. ---

test("web-standards exports classifyHref for browser-URL anchor classification", () => {
  assert.equal(
    typeof standards.classifyHref,
    "function",
    "ci/web-standards.mjs must export classifyHref(href, documentUrl)",
  );
});

test("relative, root-relative and same-origin absolute hrefs resolve to internal targets", () => {
  assert.equal(typeof standards.classifyHref, "function", "classifyHref must exist");
  const cases = [
    ["about", DOC, "/about"],
    ["./x", DOC, "/x"],
    ["../y", `${ORIGIN}/events`, "/y"],
    ["e/abc", `${ORIGIN}/events/`, "/events/e/abc"],
    ["e/abc", `${ORIGIN}/events`, "/e/abc"],
    ["/about?x=1#s", DOC, "/about?x=1"],
    ["?x=1", `${ORIGIN}/events`, "/events?x=1"],
    [`${ORIGIN}/faq`, DOC, "/faq"],
    [`${ORIGIN}/`, `${ORIGIN}/events`, "/"],
  ];
  for (const [href, documentUrl, target] of cases) {
    const got = standards.classifyHref(href, documentUrl);
    assert.ok(!(got instanceof Promise), "classification must be synchronous");
    assert.equal(got?.kind, "internal", `${href} against ${documentUrl} must be internal`);
    assert.equal(got?.target, target, `${href} against ${documentUrl} must target ${target}`);
  }
});

test("fragments, external origins and non-HTTP schemes are explicitly classified", () => {
  assert.equal(typeof standards.classifyHref, "function", "classifyHref must exist");
  for (const href of ["#sec", "", "   "]) {
    assert.equal(standards.classifyHref(href, DOC)?.kind, "fragment", `${href} is a fragment`);
  }
  for (const href of [
    "https://example.invalid/x",
    "//cdn.example/x",
    "https://127.0.0.1:8787/faq",
  ]) {
    const got = standards.classifyHref(href, DOC);
    assert.equal(got?.kind, "external", `${href} is external and must never be followed`);
    assert.equal(got?.target, undefined, "external hrefs carry no internal target");
  }
  for (const href of [
    "mailto:a@b.invalid",
    "tel:+100",
    "javascript:void(0)",
    "data:text/plain,x",
  ]) {
    assert.equal(standards.classifyHref(href, DOC)?.kind, "non-http", `${href} is non-http`);
  }
  assert.equal(standards.classifyHref("MAILTO:upper@x.invalid", DOC)?.kind, "non-http");
});

test("malformed URLs and escapes classify as malformed without throwing", () => {
  assert.equal(typeof standards.classifyHref, "function", "classifyHref must exist");
  for (const href of [MALFORMED_SHORT, "/%", "http://", null, undefined]) {
    let got = null;
    let threw = null;
    try {
      got = standards.classifyHref(href, DOC);
    } catch (err) {
      threw = err;
    }
    assert.equal(threw, null, `classifyHref must not throw on ${String(href)}, threw: ${threw}`);
    assert.equal(got?.kind, "malformed", `${String(href)} must be malformed`);
  }
});

// --- Anchor discovery against the audited document. ---

test("single-argument discovery parses both quote styles and ignores comments and script text", () => {
  const html =
    '<a href="/double">d</a>' +
    "<a href='/single'>s</a>" +
    '<a href="/ent?q=1&amp;x=2">e</a>' +
    '<!-- <a href="/ghost">g</a> -->' +
    "<script>var s = '<a href=\"/js\">';</script>" +
    '<a href="/double">again</a>';
  assert.deepEqual(standards.internalLinks(html), ["/double", "/single", "/ent?q=1&x=2"]);
});

test("document-URL discovery resolves browser forms and drops non-internal hrefs", () => {
  const html =
    '<a href="about">rel</a>' +
    "<a href='./faq'>dot</a>" +
    '<a href="../rules">up</a>' +
    '<a href="/privacy">root</a>' +
    `<a href="${ORIGIN}/join">abs</a>` +
    '<a href="#sec">frag</a>' +
    '<a href="https://example.invalid/x">ext</a>' +
    '<a href="mailto:a@b.invalid">mail</a>' +
    `<a href="${MALFORMED_SHORT}">bad</a>` +
    '<a href="/dup">one</a><a href="/dup">two</a>';
  assert.deepEqual(standards.internalLinks(html, DOC), [
    "/about",
    "/faq",
    "/rules",
    "/privacy",
    "/join",
    "/dup",
  ]);
});

test("collection resolves per-document links and never follows external URLs", async () => {
  const fetched = [];
  const fetchImpl = (url) => {
    fetched.push(url);
    return Promise.resolve(new Response(MIXED_HTML, { status: 200, headers: GOOD_HEADERS }));
  };
  const { links } = await standards.collectStandards({
    base: ORIGIN,
    routes: ["/a"],
    fetchImpl,
    timeoutMs: 1_000,
  });
  assert.deepEqual([...links], ["/about", "/faq"]);
  assert.ok(fetched.length > 0);
  assert.ok(
    fetched.every((url) => url.startsWith(ORIGIN)),
    `only the fixture base is ever fetched: ${fetched}`,
  );
});

// --- Serviceability admission: routes or admitted regular files only. ---

test("directories never establish serviceability", () => {
  const { pub } = makePublicFixture();
  assert.equal(standards.linkResolves("/fonts", [], pub), false);
  assert.equal(standards.linkResolves("/fonts/", [], pub), false);
  assert.equal(
    standards.linkResolves("/fonts", standards.routeMatchers(), resolve(repoRoot, "public")),
    false,
    "/fonts is a directory, not a served page or file",
  );
});

test("literal and encoded above-root traversal never resolves", () => {
  const { pub } = makePublicFixture();
  for (const link of [
    "/../outside.txt",
    "/%2e%2e/outside.txt",
    "/%2E%2E/outside.txt",
    "/sub/../../outside.txt",
  ]) {
    assert.equal(standards.linkResolves(link, [], pub), false, `${link} must not escape the root`);
  }
});

test("out-of-root symlink targets cannot manufacture serviceability", () => {
  const { pub } = makePublicFixture();
  assert.equal(standards.linkResolves("/escape", [], pub), false);
  assert.equal(standards.linkResolves("/alias", [], pub), true);
});

test("malformed escapes never resolve and never throw", () => {
  const { pub } = makePublicFixture();
  for (const link of [MALFORMED_SHORT, "/%", "/a%2"]) {
    let got = null;
    let threw = null;
    try {
      got = standards.linkResolves(link, [], pub);
    } catch (err) {
      threw = err;
    }
    assert.equal(threw, null, `linkResolves must not throw on ${link}, threw: ${threw}`);
    assert.equal(got, false, `${link} must not resolve`);
  }
});

test("malformed links become bounded findings while siblings are still reported", () => {
  const { pub } = makePublicFixture();
  const links = [MALFORMED_LONG, "/bad-sibling"];
  let findings = null;
  let threw = null;
  try {
    findings = standards.linkFindings(links, [], pub);
  } catch (err) {
    threw = err;
  }
  assert.equal(threw, null, `linkFindings must not throw on malformed input, threw: ${threw}`);
  assert.equal(findings.length, 2, `both links must be accounted: ${findings}`);
  const malformed = findings.find((f) => f.includes("malformed"));
  assert.ok(malformed, `one finding must say malformed: ${findings}`);
  assert.ok(malformed.length < 400, `malformed finding must stay bounded: ${malformed.length}`);
  assert.ok(malformed.includes(MALFORMED_LONG.slice(0, 60)));
  assert.ok(!malformed.includes(MALFORMED_LONG.slice(-60)));
  assert.ok(!malformed.includes("URIError"), "raw exception text must not leak into findings");
  assert.ok(
    findings.some((f) => f.includes("/bad-sibling")),
    `sibling still reported: ${findings}`,
  );
});

test("finding text never dumps query values", () => {
  const { pub } = makePublicFixture();
  const findings = standards.linkFindings(["/bad?token=SECRET123"], [], pub);
  assert.equal(findings.length, 1);
  assert.ok(findings[0].includes("/bad"), `pathname is named: ${findings[0]}`);
  assert.ok(!findings[0].includes("SECRET123"), `query value must not leak: ${findings[0]}`);
});

// --- Malformed accounting inside the collector. ---

test("a malformed href becomes a bounded route finding without dropping siblings", async () => {
  const fetchImpl = (url) => {
    const html = url.endsWith("/a") ? MIXED_HTML : GOOD_HTML;
    return Promise.resolve(new Response(html, { status: 200, headers: GOOD_HEADERS }));
  };
  const { findings, links } = await standards.collectStandards({
    base: ORIGIN,
    routes: ["/a", "/b"],
    fetchImpl,
    timeoutMs: 1_000,
  });
  const malformed = findings.filter((f) => f.startsWith("/a:") && f.includes("malformed"));
  assert.equal(malformed.length, 1, `expected one /a malformed finding: ${findings}`);
  assert.ok(malformed[0].length < 400, "malformed route finding must stay bounded");
  assert.ok(!malformed[0].includes("URIError"));
  assert.deepEqual([...links].sort(), ["/about", "/faq"]);
  assert.ok(!findings.some((f) => f.startsWith("/b:")), "later routes still run clean");
});

test("malformed findings per route are capped with an overflow total", async () => {
  const many = Array.from({ length: 25 }, (_, i) => `<a href="/%E0%A4%A-${i}">b${i}</a>`).join("");
  const fetchImpl = () =>
    Promise.resolve(new Response(shell(many), { status: 200, headers: GOOD_HEADERS }));
  const { findings } = await standards.collectStandards({
    base: ORIGIN,
    routes: ["/many"],
    fetchImpl,
    timeoutMs: 1_000,
  });
  const route = findings.filter((f) => f.startsWith("/many:"));
  assert.ok(route.length <= 12, `malformed findings must be capped, got ${route.length}`);
  assert.ok(
    route.some((f) => f.includes("25")),
    `overflow finding must name the total: ${route}`,
  );
});

// --- Structured link records and the versioned JSON report. ---

test("web-standards exports structured link finding records", () => {
  assert.equal(
    typeof standards.linkFindingRecords,
    "function",
    "ci/web-standards.mjs must export linkFindingRecords(links, matchers, publicDir)",
  );
});

test("record details stay deep-equal to the human findings", () => {
  assert.equal(typeof standards.linkFindingRecords, "function", "linkFindingRecords must exist");
  const matchers = [/^\/ok-\d+\/?$/];
  const { pub } = makePublicFixture();
  const sets = {
    mixed: ["/ok-1", "/bad-a", MALFORMED_SHORT, "/bad?token=SECRET123"],
    over: Array.from({ length: CAP + 1 }, (_, i) => `/ok-${i}`),
  };
  for (const [name, links] of Object.entries(sets)) {
    const records = standards.linkFindingRecords(links, matchers, pub);
    assert.deepEqual(
      records.map((r) => r.detail),
      standards.linkFindings(links, matchers, pub),
      `${name}: record details must match human findings`,
    );
  }
});

test("records carry the fixed link error codes", () => {
  assert.equal(typeof standards.linkFindingRecords, "function", "linkFindingRecords must exist");
  const matchers = [/^\/ok-\d+\/?$/];
  const { pub } = makePublicFixture();
  const records = standards.linkFindingRecords(["/ok-1", "/bad-a", MALFORMED_SHORT], matchers, pub);
  assert.deepEqual(
    records.map((r) => `${r.check}:${r.code}`),
    ["link:LINK_UNRESOLVED", "link:LINK_MALFORMED"],
  );
  const over = standards.linkFindingRecords(
    Array.from({ length: CAP + 1 }, (_, i) => `/ok-${i}`),
    matchers,
    pub,
  );
  assert.deepEqual(
    over.map((r) => `${r.check}:${r.code}`),
    ["links:LINKS_TRUNCATED"],
  );
});

test("web-standards exports a versioned JSON report builder", () => {
  assert.equal(standards.STANDARDS_REPORT_VERSION, 1, "report version must be 1");
  assert.equal(
    typeof standards.buildJsonReport,
    "function",
    "ci/web-standards.mjs must export buildJsonReport",
  );
});

test("JSON reports carry stable ids, counts and static next actions", () => {
  assert.equal(typeof standards.buildJsonReport, "function", "buildJsonReport must exist");
  const input = {
    origin: ORIGIN,
    routes: ["/", "/about"],
    linksChecked: 5,
    linksCollected: 7,
    findings: [
      { path: "/about", check: "headers", code: "HEADER_CSP_MISSING", detail: "CSP missing" },
      {
        path: null,
        check: "link",
        code: "LINK_UNRESOLVED",
        detail: "internal link /bad: no app route or public file serves it",
      },
      {
        path: null,
        check: "links",
        code: "LINKS_TRUNCATED",
        detail: "internal links truncated: checked first 300 of 301 collected",
      },
      { path: "/", check: "html", code: "HTML_TITLE_MISSING", detail: "T".repeat(500) },
    ],
  };
  const first = standards.buildJsonReport(input);
  assert.equal(first.version, 1);
  assert.deepEqual(first.routes, [
    { id: "route-0", path: "/" },
    { id: "route-1", path: "/about" },
  ]);
  assert.deepEqual(
    first.findings.map((f) => [f.id, f.routeId, f.checkId, f.code]),
    [
      ["finding-0", "route-1", "route-1/headers", "HEADER_CSP_MISSING"],
      ["finding-1", null, "global/link", "LINK_UNRESOLVED"],
      ["finding-2", null, "global/links", "LINKS_TRUNCATED"],
      ["finding-3", "route-0", "route-0/html", "HTML_TITLE_MISSING"],
    ],
  );
  assert.deepEqual(first.counts, { routes: 2, findings: 4, linksChecked: 5, linksCollected: 7 });
  assert.equal(first.findings[3].message, "T".repeat(300), "messages truncate to 300 characters");
  for (const finding of first.findings) {
    assert.equal(typeof finding.next_action, "string");
    assert.ok(finding.next_action.length > 0);
  }
  assert.deepEqual(
    standards.buildJsonReport(input),
    first,
    "stable input must yield a stable report",
  );
  const again = standards.buildJsonReport({
    ...input,
    findings: input.findings.map((f) => ({ ...f, detail: `${f.detail} SECRET-XYZ extra` })),
  });
  assert.deepEqual(
    again.findings.map((f) => f.next_action),
    first.findings.map((f) => f.next_action),
    "next_action is static per code",
  );
  assert.ok(
    again.findings.every((f) => !f.next_action.includes("SECRET-XYZ")),
    "next_action carries no input-derived text",
  );
});

test("report JSON never leaks queries, raw hrefs, exceptions or absolute paths", () => {
  assert.equal(typeof standards.buildJsonReport, "function", "buildJsonReport must exist");
  assert.equal(typeof standards.linkFindingRecords, "function", "linkFindingRecords must exist");
  const { pub } = makePublicFixture();
  const longBad = `/${"%E0%A4%A"}-` + "Q".repeat(480);
  const links = ["/bad?token=COMPOSITION-SECRET-1", longBad];
  const records = standards.linkFindingRecords(links, [], pub);
  assert.ok(
    records.every((r) => !r.detail.includes(pub)),
    "details never carry absolute paths",
  );
  const report = standards.buildJsonReport({
    origin: ORIGIN,
    routes: ["/"],
    linksChecked: links.length,
    linksCollected: links.length,
    findings: records.map((r) => ({ path: null, check: r.check, code: r.code, detail: r.detail })),
  });
  const json = JSON.stringify(report);
  assert.ok(!json.includes("COMPOSITION-SECRET-1"));
  assert.ok(!json.includes("Q".repeat(200)));
  assert.ok(!json.includes("URIError"));
  assert.ok(!json.includes(pub));
});

// --- Flag parsing before any side effect. ---

test("web-standards exports parseArgs for up-front flag validation", () => {
  assert.equal(
    typeof standards.parseArgs,
    "function",
    "ci/web-standards.mjs must export parseArgs(argv)",
  );
});

test("parseArgs accepts the documented flags", () => {
  assert.equal(typeof standards.parseArgs, "function", "parseArgs must exist");
  assert.deepEqual(standards.parseArgs([]), {
    format: "human",
    dryRun: false,
    selftest: false,
    origin: null,
  });
  assert.equal(standards.parseArgs(["--format", "json"]).format, "json");
  assert.equal(standards.parseArgs(["--format", "human"]).format, "human");
  assert.equal(standards.parseArgs(["--dry-run"]).dryRun, true);
  assert.equal(standards.parseArgs(["--dry-run", "--dry-run"]).dryRun, true);
  assert.equal(standards.parseArgs(["--selftest"]).selftest, true);
  assert.equal(
    standards.parseArgs(["--origin", "https://next.togetherweown.com"]).origin,
    "https://next.togetherweown.com",
  );
  assert.deepEqual(standards.parseArgs(["--dry-run", "--format", "json"]), {
    format: "json",
    dryRun: true,
    selftest: false,
    origin: null,
  });
});

test("parseArgs rejects unknown, extra and wrong flags with bounded BAD_ARGS", () => {
  assert.equal(typeof standards.parseArgs, "function", "parseArgs must exist");
  const bad = [
    ["--bogus-flag"],
    ["oops-positional"],
    ["--format"],
    ["--format", "xml"],
    ["--format", "json", "--format", "human"],
    ["--origin"],
    ["--origin", "https://evil.example/"],
    ["--", "--dry-run"],
  ];
  for (const argv of bad) {
    assert.throws(
      () => standards.parseArgs(argv),
      (err) => {
        assert.equal(err?.code, "BAD_ARGS", `${argv} must throw BAD_ARGS, got: ${err}`);
        assert.ok(
          String(err?.message).length <= 500,
          `BAD_ARGS message must stay bounded: ${err?.message}`,
        );
        return true;
      },
    );
  }
  const greedy = `--${"Z".repeat(300)}`;
  assert.throws(
    () => standards.parseArgs([greedy]),
    (err) => {
      assert.equal(err?.code, "BAD_ARGS");
      assert.ok(!String(err?.message).includes("Z".repeat(100)));
      return true;
    },
  );
});

test("bad flags fail before any spawn, fetch or write", () => {
  for (const args of [["--bogus-flag"], ["oops-positional"], ["--format"], ["--format", "xml"]]) {
    const run = runCli(args);
    assert.notEqual(run.status, 0, `${args} must fail, got ${run.status}\n${run.stdout}`);
    assert.equal(run.spawned, null, `${args} must not spawn a Worker`);
    assert.ok(run.elapsedMs < CLI_BOUND_MS, `${args} must fail fast, took ${run.elapsedMs}ms`);
    assert.match(run.stderr, /usage|unknown option|invalid|expected/i, `${args} prints usage`);
    assert.ok(run.stderr.includes("--format"), `${args} usage names the valid flags`);
    assertSummaryUntouched(run);
  }
});

// --- Read-only dry run. ---

test("--dry-run inventories checks without spawning, fetching, writing or claiming execution", () => {
  const run = runCli(["--dry-run"]);
  assert.equal(run.status, 0, `expected exit 0, got ${run.status}\n${run.stdout}\n${run.stderr}`);
  assert.equal(run.spawned, null, "dry run must not start a fixture Worker");
  assert.ok(run.elapsedMs < CLI_BOUND_MS, `dry run must stay fast, took ${run.elapsedMs}ms`);
  for (const path of PATHS) {
    assert.ok(run.stdout.includes(path), `inventory must name ${path}`);
  }
  assert.match(run.stdout, /dry-?run/i, "inventory must say it is a dry run");
  assert.ok(!run.stdout.includes("All checks passed"), "dry run must not claim execution");
  assertSummaryUntouched(run);
});

test("--dry-run --format json prints one stable versioned inventory document", () => {
  const first = runCli(["--dry-run", "--format", "json"]);
  assert.equal(first.status, 0, `expected exit 0\n${first.stdout}\n${first.stderr}`);
  assert.equal(first.spawned, null, "json dry run must not start a fixture Worker");
  const doc = JSON.parse(first.stdout);
  assert.equal(doc.version, 1);
  assert.deepEqual(
    doc.routes.map((r) => r.path),
    PATHS,
  );
  assert.deepEqual(
    doc.routes.map((r) => r.id),
    PATHS.map((_, i) => `route-${i}`),
  );
  for (const route of doc.routes) {
    const names = doc.checks.filter((c) => c.routeId === route.id).map((c) => c.name);
    for (const name of ["status", "headers", "html", "links"]) {
      assert.ok(names.includes(name), `${route.id} inventory must list ${name}`);
    }
  }
  assert.equal(doc.counts?.routes, PATHS.length);
  assert.ok(!("findings" in doc) || doc.findings.length === 0, "inventory claims no execution");
  assert.ok(!first.stdout.includes("All checks passed"));
  assertSummaryUntouched(first);
  const second = runCli(["--dry-run", "--format", "json"]);
  assert.equal(second.status, 0);
  assert.deepEqual(
    JSON.parse(second.stdout).routes,
    doc.routes,
    "inventory ids must be stable across runs",
  );
});

// --- Wiring: dispatch order, honest limits, and suite registration. ---

test("flag parsing, dry-run and json branches precede any spawn", () => {
  const spawnAt = source.indexOf("spawn(");
  assert.ok(spawnAt > 0, "expected the fixture spawn to exist");
  const parseAt = source.indexOf("parseArgs(");
  assert.ok(parseAt > 0, "main must parse flags through parseArgs");
  assert.ok(parseAt < spawnAt, "flag parsing must precede the fixture spawn");
  const dryAt = source.search(/dry-?run/i);
  assert.ok(dryAt > 0, "a dry-run branch must exist");
  assert.ok(dryAt < spawnAt, "dry-run handling must precede the fixture spawn");
  assert.ok(source.includes("buildJsonReport"), "--format json must use the report builder");
});

test("source-derived route matching states its limits honestly", () => {
  const start = source.indexOf("function routeMatchers");
  assert.ok(start > 0);
  const end = source.indexOf("export function linkResolves");
  const region = source.slice(Math.max(0, start - 600), end > 0 ? end : start + 1200);
  assert.match(region, /limit/i, "routeMatchers must document what it cannot see");
});

test("main still reads routes through the bounded collector and the link cap helper", () => {
  const mainAt = source.indexOf("async function main");
  assert.ok(mainAt > 0);
  const mainBody = source.slice(mainAt);
  assert.match(mainBody, /collectStandards\(/, "main must use the bounded collector");
  assert.match(mainBody, /linkFindings\(/, "main must use the capped link helper");
});

test("standards:selftest runs this acceptance file", () => {
  assert.match(
    pkg.scripts["standards:selftest"] ?? "",
    /web-standards-browser-links-acceptance\.test\.mjs/,
    "standards:selftest must run this acceptance file (CI already runs that script)",
  );
});
