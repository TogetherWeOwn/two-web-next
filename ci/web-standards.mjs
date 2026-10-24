// Web standards gate (owner request 2026-10-10): on the Lighthouse fixture worker, every audited route must
// send the app's security headers (src/headers.ts), carry the HTML basics a crawler and a screen reader need,
// and link only to internal URLs that resolve. HSTS is set at the edge, not by the worker (src/index.tsx),
// so it is not required here. Writes .lighthouseci/standards-summary.md; exits 1 on any finding.
// --selftest checks the pure helpers without a server.
// --dry-run inventories the audited routes and checks without starting the fixture worker.
// --format json prints a versioned machine-readable report to stdout; the summary file is still written.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
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
const maxMalformedPerRoute = 10;
// Malformed href preview cap: the finding names the head of the href (at most
// the contracted 120 characters) while a pathological run of one repeated
// character can never dominate the finding text.
const malformedPreviewLength = 60;
const reportMessageLength = 300;
const argErrorLength = 500;

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

// Classify one raw href against the audited document URL with browser URL
// semantics. Never throws on any input and never fetches: external URLs are
// reported, never followed, and the fixed fixture-origin authority is unchanged.
export function classifyHref(href, documentUrl) {
  try {
    if (typeof href !== "string") return { kind: "malformed" };
    if (href.trim() === "" || href.startsWith("#")) return { kind: "fragment" };
    const scheme = href.match(/^\s*([A-Za-z][A-Za-z0-9+.-]*):/);
    if (scheme && !/^https?$/i.test(scheme[1])) return { kind: "non-http" };
    if (href.trim().startsWith("//")) return { kind: "external" };
    const base = new URL(documentUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") return { kind: "malformed" };
    const url = new URL(href, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "non-http" };
    if (url.origin !== base.origin) return { kind: "external" };
    const target = `${url.pathname}${url.search}`;
    try {
      decodeURI(target);
    } catch {
      return { kind: "malformed" };
    }
    return { kind: "internal", target };
  } catch {
    return { kind: "malformed" };
  }
}

function decodeEntities(value) {
  // Single pass with &amp; last so "&amp;lt;" decodes to "&lt;", not "<".
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// Tag-name boundary after "<script" / "</script": only whitespace, "/" or ">"
// ends the name, so "<scripts>" never matches. Quotes do not end a tag name
// (the HTML parser keeps them in the name), so "<script"x">" is not a script
// element either.
function isTagNameBoundary(ch) {
  return (
    ch === undefined ||
    ch === ">" ||
    ch === "/" ||
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "\f" ||
    ch === "\r"
  );
}

// Offset just past the ">" of a "<script ...>" open tag at i, or -1 when the
// position holds no script open tag. Case-insensitive on the element name only.
function matchScriptOpen(html, i) {
  if (html.slice(i, i + 7).toLowerCase() !== "<script") return -1;
  if (!isTagNameBoundary(html[i + 7])) return -1;
  const end = html.indexOf(">", i + 7);
  return end === -1 ? -1 : end + 1;
}

function indexOfTag(html, tag, from) {
  let i = from;
  for (;;) {
    i = html.indexOf("<", i);
    if (i === -1 || i + tag.length > html.length) return -1;
    if (html.slice(i, i + tag.length).toLowerCase() === tag) return i;
    i += 1;
  }
}

// Offset just past a script element's end tag: the first "</script" with a tag
// boundary after it, through its ">". End tags may carry whitespace or
// attributes ("</script foo>" still closes the element); without any end tag
// the script runs to end of input, the way browsers parse it.
function skipScriptBody(html, from) {
  let at = from;
  for (;;) {
    const close = indexOfTag(html, "</script", at);
    if (close === -1) return html.length;
    const after = close + "</script".length;
    if (!isTagNameBoundary(html[after])) {
      at = after;
      continue;
    }
    const end = html.indexOf(">", after);
    return end === -1 ? html.length : end + 1;
  }
}

// The document with HTML comments and script elements removed, found with an
// explicit scanner instead of filter regexes. A comment runs to the first
// "-->"; an unterminated comment runs to end of input, the way browsers
// parse it.
function stripNonRendered(html) {
  const kept = [];
  let runStart = 0;
  let i = 0;
  const n = html.length;
  while (i < n) {
    let skipTo = -1;
    if (html[i] === "<") {
      if (html.startsWith("<!--", i)) {
        const end = html.indexOf("-->", i + 4);
        skipTo = end === -1 ? n : end + 3;
      } else {
        const body = matchScriptOpen(html, i);
        if (body !== -1) skipTo = skipScriptBody(html, body);
      }
    }
    if (skipTo === -1) {
      i += 1;
    } else {
      if (i > runStart) kept.push(html.slice(runStart, i));
      i = skipTo;
      runStart = skipTo;
    }
  }
  if (n > runStart) kept.push(html.slice(runStart));
  return kept.join("");
}

// Raw anchor hrefs in document order. Anchors inside HTML comments and script
// text are not real links, so those regions are skipped before scanning. The
// first href attribute on an <a> tag wins, matching browser behavior; lookalike
// attributes such as data-href never match because "data-" sits between the
// whitespace and "href".
function rawHrefs(html) {
  const text = typeof html === "string" ? html : "";
  const visible = stripNonRendered(text);
  const out = [];
  for (const tag of visible.matchAll(/<a\b[^>]*>/gi)) {
    const attr = tag[0].match(/\s+href\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (attr) out.push(decodeEntities(attr[1] ?? attr[2] ?? ""));
  }
  return out;
}

function splitDocumentLinks(html, documentUrl) {
  const internal = [];
  const seenInternal = new Set();
  const malformed = [];
  const seenMalformed = new Set();
  for (const href of rawHrefs(html)) {
    const classified = classifyHref(href, documentUrl);
    if (classified.kind === "internal") {
      if (!seenInternal.has(classified.target)) {
        seenInternal.add(classified.target);
        internal.push(classified.target);
      }
    } else if (classified.kind === "malformed" && !seenMalformed.has(href)) {
      seenMalformed.add(href);
      malformed.push(href);
    }
  }
  return { internal, malformed };
}

export function internalLinks(html, documentUrl) {
  if (documentUrl === undefined) {
    const links = new Set();
    for (const href of rawHrefs(html)) {
      if (!href.startsWith("/") || href.startsWith("//")) continue;
      links.add(href.split("#")[0] || "/");
    }
    return [...links];
  }
  return splitDocumentLinks(html, documentUrl).internal;
}

// Source-derived route matchers, with honest limits: these patterns come from
// static route registrations (app.get/app.all/app.on) found in src/, so they
// cannot see routes built dynamically at runtime, redirects, middleware
// rewrites, handlers registered any other way, or routes served only in
// production. A matcher miss means "no static registration found", not proof
// that the Worker would 404; the link check stays fail-closed on a miss.
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

// URL canonicalization stays separate from public-file lookup: a link only
// resolves on a registered route match or an admitted regular file under the
// intended public root. Encoded dot segments, above-root traversal, malformed
// escapes, directories and out-of-root symlink targets never resolve. In-root
// dot segments, harmless escapes and in-root symlinks still resolve.
export function linkResolves(link, matchers, publicDir = "public") {
  try {
    if (typeof link !== "string") return false;
    const pathOnly = link.split("#")[0].split("?")[0];
    if (/%2e/i.test(pathOnly)) return false;
    let decoded;
    try {
      decoded = decodeURI(pathOnly);
    } catch {
      return false;
    }
    if (/%2e/i.test(decoded)) return false;
    if (matchers.some((re) => re.test(decoded))) return true;
    const root = resolve(publicDir);
    let realRoot;
    try {
      realRoot = realpathSync(root);
    } catch {
      return false;
    }
    const candidate = resolve(root, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return false;
    let stat;
    try {
      stat = statSync(candidate);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    let real;
    try {
      real = realpathSync(candidate);
    } catch {
      return false;
    }
    return real === realRoot || real.startsWith(`${realRoot}${sep}`);
  } catch {
    return false;
  }
}

function linkPathname(link) {
  return String(link).split("#")[0].split("?")[0];
}

function isMalformedLink(link) {
  if (typeof link !== "string") return true;
  try {
    decodeURI(linkPathname(link));
    return false;
  } catch {
    return true;
  }
}

// Bounded preview of a malformed href: query and hash are stripped so finding
// text never dumps query values, and the remainder is capped.
function malformedPreview(raw) {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  return text.split("#")[0].split("?")[0].slice(0, malformedPreviewLength);
}

export function linkFindingRecords(links, matchers, publicDir = "public") {
  const list = Array.isArray(links) ? links : [...links];
  const records = [];
  for (const link of list.slice(0, maxLinks)) {
    let malformed = true;
    let resolves = false;
    try {
      malformed = isMalformedLink(link);
      resolves = malformed ? false : linkResolves(link, matchers, publicDir);
    } catch {
      malformed = true;
      resolves = false;
    }
    if (malformed) {
      records.push({
        check: "link",
        code: "LINK_MALFORMED",
        detail: `internal link ${malformedPreview(link)}: malformed URL or percent escape; skipped`,
      });
    } else if (!resolves) {
      records.push({
        check: "link",
        code: "LINK_UNRESOLVED",
        detail: `internal link ${linkPathname(link)}: no app route or public file serves it`,
      });
    }
  }
  if (list.length > maxLinks) {
    records.push({
      check: "links",
      code: "LINKS_TRUNCATED",
      detail: `internal links truncated: checked first ${maxLinks} of ${list.length} collected; expand coverage so every collected link is checked`,
    });
  }
  return records;
}

export function linkFindings(links, matchers, publicDir = "public") {
  return linkFindingRecords(links, matchers, publicDir).map((record) => record.detail);
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

function headerFindingCode(detail) {
  if (detail.includes("Content-Security-Policy")) return "HEADER_CSP_MISSING";
  if (detail.includes("X-Content-Type-Options")) return "HEADER_CTO_MISSING";
  return "HEADER_REFERRER_MISSING";
}

function htmlFindingCode(detail) {
  if (detail.includes("<!doctype html>")) return "HTML_DOCTYPE_MISSING";
  if (detail.includes("has no lang")) return "HTML_LANG_MISSING";
  if (detail.includes("<title>")) return "HTML_TITLE_MISSING";
  if (detail.includes("viewport")) return "HTML_VIEWPORT_MISSING";
  if (detail.includes("meta description")) return "HTML_DESCRIPTION_MISSING";
  return "HTML_H1_COUNT";
}

export async function collectStandards(options = {}) {
  const {
    base,
    routes,
    fetchImpl = (...args) => fetch(...args),
    timeoutMs = ROUTE_READ_TIMEOUT_MS,
  } = options;
  const findings = [];
  const findingRecords = [];
  const links = new Set();
  const pushRouteFinding = (path, check, code, detail) => {
    findings.push(detail);
    findingRecords.push({ path, check, code, detail });
  };
  for (const path of routes) {
    let status;
    let headers;
    let html;
    try {
      ({ status, headers, html } = await fetchRoute(fetchImpl, base + path, { timeoutMs }));
    } catch (err) {
      if (err?.code === "ROUTE_READ_TIMEOUT")
        pushRouteFinding(
          path,
          "status",
          "STATUS_TIMEOUT",
          `${path}: timed out after ${timeoutMs}ms`,
        );
      else
        pushRouteFinding(
          path,
          "status",
          "STATUS_FETCH_FAILED",
          `${path}: ${err?.message || "request failed"}`,
        );
      continue;
    }
    if (status !== 200)
      pushRouteFinding(path, "status", "STATUS_NON_200", `${path}: status ${status}`);
    for (const detail of headerFindings(path, headers))
      pushRouteFinding(path, "headers", headerFindingCode(detail), detail);
    for (const detail of htmlFindings(path, html))
      pushRouteFinding(path, "html", htmlFindingCode(detail), detail);
    const document = splitDocumentLinks(html, base + path);
    for (const link of document.internal) links.add(link);
    for (const raw of document.malformed.slice(0, maxMalformedPerRoute))
      pushRouteFinding(
        path,
        "links",
        "LINK_MALFORMED",
        `${path}: malformed link ${malformedPreview(raw)}: skipped; fix or remove the href`,
      );
    if (document.malformed.length > maxMalformedPerRoute)
      pushRouteFinding(
        path,
        "links",
        "LINK_MALFORMED",
        `${path}: malformed links truncated: showing ${maxMalformedPerRoute} of ${document.malformed.length} collected; fix every malformed href so each link is checked`,
      );
  }
  return { findings, links, findingRecords };
}

// Versioned machine-readable report. Messages are bounded input detail;
// next_action is static per code and carries no input-derived text.
export const STANDARDS_REPORT_VERSION = 1;

const NEXT_ACTION_BY_CODE = {
  STATUS_NON_200: "Fix the route so it returns HTTP 200, then re-run the web-standards gate.",
  STATUS_TIMEOUT:
    "Speed up the route read or fix the hung response, then re-run the web-standards gate.",
  STATUS_FETCH_FAILED: "Fix the route fetch failure, then re-run the web-standards gate.",
  HEADER_CSP_MISSING:
    "Send a Content-Security-Policy with default-src or script-src, then re-run the web-standards gate.",
  HEADER_CTO_MISSING: "Send X-Content-Type-Options: nosniff, then re-run the web-standards gate.",
  HEADER_REFERRER_MISSING: "Send a Referrer-Policy header, then re-run the web-standards gate.",
  HTML_DOCTYPE_MISSING:
    "Start the document with <!doctype html>, then re-run the web-standards gate.",
  HTML_LANG_MISSING:
    "Add a lang attribute to the <html> element, then re-run the web-standards gate.",
  HTML_TITLE_MISSING: "Add a non-empty <title>, then re-run the web-standards gate.",
  HTML_VIEWPORT_MISSING: "Add a viewport meta tag, then re-run the web-standards gate.",
  HTML_DESCRIPTION_MISSING:
    "Add a meta description of at least 20 characters, then re-run the web-standards gate.",
  HTML_H1_COUNT: "Render exactly one <h1> on the page, then re-run the web-standards gate.",
  LINK_MALFORMED: "Fix or remove the malformed href, then re-run the web-standards gate.",
  LINK_UNRESOLVED:
    "Point the link at a served route or public file, then re-run the web-standards gate.",
  LINKS_TRUNCATED:
    "Expand link coverage so every collected link is checked, then re-run the web-standards gate.",
};
const DEFAULT_NEXT_ACTION = "Fix the finding, then re-run the web-standards gate.";

export function buildJsonReport(input = {}) {
  const routes = Array.isArray(input.routes) ? input.routes : [];
  const rawFindings = Array.isArray(input.findings) ? input.findings : [];
  const routeEntries = routes.map((path, index) => ({ id: `route-${index}`, path }));
  const routeIdFor = (path) => {
    const index = routes.indexOf(path);
    return index >= 0 ? `route-${index}` : null;
  };
  const findings = rawFindings.map((finding, index) => {
    const routeId = finding?.path == null ? null : routeIdFor(finding.path);
    const check = typeof finding?.check === "string" && finding.check ? finding.check : "unknown";
    const code = typeof finding?.code === "string" && finding.code ? finding.code : "UNKNOWN";
    return {
      id: `finding-${index}`,
      routeId,
      checkId: `${routeId ?? "global"}/${check}`,
      code,
      message: String(finding?.detail ?? "").slice(0, reportMessageLength),
      next_action: NEXT_ACTION_BY_CODE[finding?.code] ?? DEFAULT_NEXT_ACTION,
    };
  });
  return {
    version: STANDARDS_REPORT_VERSION,
    origin: typeof input.origin === "string" ? input.origin : "",
    routes: routeEntries,
    findings,
    counts: {
      routes: routes.length,
      findings: findings.length,
      linksChecked: Number.isInteger(input.linksChecked) ? input.linksChecked : 0,
      linksCollected: Number.isInteger(input.linksCollected) ? input.linksCollected : 0,
    },
  };
}

const USAGE = [
  "Usage: node ci/web-standards.mjs [--origin <url>] [--format human|json] [--dry-run] [--selftest]",
  "",
  "Audit the fixture worker (or an allowlisted --origin) for security headers,",
  "HTML basics and internal links. Writes .lighthouseci/standards-summary.md.",
  "",
  "  --origin <url>      audit a deployed origin instead of the fixture worker;",
  "                      must be one of the allowlisted origins",
  "  --format human|json human summary (default) or a versioned JSON report",
  "  --dry-run           list the audited routes and checks without starting",
  "                      the fixture worker, fetching, or writing",
  "  --selftest          check the pure helpers without a server",
].join("\n");

function badArgs(message) {
  const err = new Error(String(message).slice(0, argErrorLength));
  err.code = "BAD_ARGS";
  return err;
}

function previewArg(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

// Flag validation runs before any spawn, fetch or write: unknown flags,
// positionals, missing or wrong values, repeated value flags and
// non-allowlisted origins all fail here with a bounded BAD_ARGS error.
export function parseArgs(argv = []) {
  const args = { format: "human", dryRun: false, selftest: false, origin: null };
  let formatSeen = false;
  let originSeen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--selftest") {
      args.selftest = true;
    } else if (arg === "--format") {
      if (formatSeen) throw badArgs("option --format passed more than once");
      formatSeen = true;
      const value = argv[i + 1];
      i += 1;
      if (value !== "human" && value !== "json")
        throw badArgs(
          `invalid --format ${JSON.stringify(previewArg(value))}: expected "human" or "json"`,
        );
      args.format = value;
    } else if (arg === "--origin") {
      if (originSeen) throw badArgs("option --origin passed more than once");
      originSeen = true;
      const value = argv[i + 1];
      i += 1;
      if (typeof value !== "string" || value === "")
        throw badArgs("option --origin expects an allowlisted origin URL");
      try {
        args.origin = createRequire(import.meta.url)(
          "./lighthouse-origin-lib.cjs",
        ).requireAllowedOrigin(value);
      } catch (err) {
        throw badArgs(
          `invalid --origin ${JSON.stringify(previewArg(value))}: ${err?.message || "not allowlisted"}`,
        );
      }
    } else if (typeof arg === "string" && arg.startsWith("-")) {
      throw badArgs(`unknown option ${JSON.stringify(previewArg(arg))}`);
    } else {
      throw badArgs(`unexpected positional argument ${JSON.stringify(previewArg(arg))}`);
    }
  }
  return args;
}

const dryRunCheckNames = ["status", "headers", "html", "links"];

function printDryRun(format, deployed) {
  const routes = deployed ? paths.filter((p) => !p.startsWith("/e/")) : paths;
  if (format === "json") {
    console.log(
      JSON.stringify({
        version: STANDARDS_REPORT_VERSION,
        routes: routes.map((path, index) => ({ id: `route-${index}`, path })),
        checks: routes.flatMap((_, index) =>
          dryRunCheckNames.map((name) => ({ routeId: `route-${index}`, name })),
        ),
        counts: { routes: routes.length, checks: routes.length * dryRunCheckNames.length },
      }),
    );
    return;
  }
  console.log("web-standards dry-run: inventory only, no checks executed.");
  console.log(`Origin: ${deployed ?? origin}. Routes that would be audited (${routes.length}):`);
  for (const path of routes) console.log(`- ${path} (checks: ${dryRunCheckNames.join(", ")})`);
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
  // Flags are validated before any spawn, fetch or write: bad flags fail fast
  // without starting the fixture worker or touching the summary file.
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${USAGE}\n\n${err?.message || err}`);
    process.exitCode = 2;
    return;
  }
  if (args.dryRun) {
    printDryRun(args.format, args.origin);
    return;
  }
  // --origin <allowlisted origin>: check a deployed site (no fixture worker; DB-free routes only).
  const deployed = args.origin;
  const base = deployed ?? origin;
  const routes = deployed ? paths.filter((p) => !p.startsWith("/e/")) : paths;
  const child = deployed
    ? null
    : spawn("node", ["ci/lighthouse-admission.cjs"], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
  const findings = [];
  const findingRecords = [];
  const checked = new Set();
  let totalCollected = 0;
  try {
    if (child) await waitForServer(child);
    // Every route read runs under the per-route deadline; a timed-out route
    // becomes a route-named finding and later routes still run, so the summary
    // below is always reached.
    const {
      findings: routeFindings,
      links,
      findingRecords: routeRecords,
    } = await collectStandards({
      base,
      routes,
      timeoutMs: ROUTE_READ_TIMEOUT_MS,
    });
    findings.push(...routeFindings);
    findingRecords.push(...routeRecords);
    const matchers = routeMatchers();
    const collected = [...links];
    totalCollected = collected.length;
    findings.push(...linkFindings(collected, matchers));
    for (const record of linkFindingRecords(collected, matchers))
      findingRecords.push({
        path: null,
        check: record.check,
        code: record.code,
        detail: record.detail,
      });
    for (const link of collected.slice(0, maxLinks)) checked.add(link);
  } finally {
    if (child)
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // The fixture worker already exited; nothing left to terminate.
      }
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
  if (args.format === "json") {
    console.log(
      JSON.stringify(
        buildJsonReport({
          origin: base,
          routes,
          linksChecked: checked.size,
          linksCollected: totalCollected,
          findings: findingRecords,
        }),
      ),
    );
  } else {
    console.log(lines.join("\n"));
  }
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
