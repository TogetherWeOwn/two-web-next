#!/usr/bin/env node
// Draft-PR diagnostic: what moves /join mobile LCP? NEVER a gate.
//
// One runner, one admitted and UNMODIFIED fixture worker (ci/lighthouse-admission.cjs
// startFixture, the same admission `npm run lighthouse` uses), and a loopback
// reverse proxy in front of it. The proxy is the only place a variant is applied:
//   control               byte-identical pass-through (the proxy itself is in every run)
//   stylesheet-scheduling the three render-blocking head stylesheet links of /join
//                         move, byte-identical and in order, to just before </body>
//   heading-font          one rule is APPENDED to /theme.css targeting #join-heading
//                         alone (existing rules, other headings untouched); the /join
//                         document is byte-identical to control
// Each variant changes exactly ONE factor and is validated against the control
// bytes before its run. Production source, CSP headers, fixture identity and
// ci/lighthouserc.cjs are untouched: the Lighthouse settings are copied from the
// checked-in config; only the single URL differs. The engine is the existing
// Lighthouse Node API, one attempt per invocation, so failed LHRs are kept.
//
// Order alternates control/variant (ABBA-style per round) so drift is not
// confounded with a variant: each variant gets 3 controls and 3 variant runs.
//
// Usage: node ci/join-lcp-diagnostic.mjs [--out artifacts/join-lcp-diagnostic]
// Selftest: node --test ci/join-lcp-diagnostic.test.mjs
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

export const OUTPUT_DIR = "artifacts/join-lcp-diagnostic";
export const VARIANTS = ["stylesheet-scheduling", "heading-font"];
export const ROUNDS = 3;
export const UPSTREAM = { host: "127.0.0.1", port: 8787 };

const STYLESHEET_BLOCK =
  /<link rel="stylesheet" href="\/styles\.css"\s*\/?>\s*<link rel="stylesheet" href="\/theme-tokens\.css"\s*\/?>\s*<link rel="stylesheet" href="\/theme\.css"\s*\/?>/g;
export const HEADING_RULE =
  ".base-theme:not(.content-theme) :is(h1,h2,h3){font-family:var(--font-display)}";
// Appended after the existing rules: the id selector outranks the shared heading
// rule for #join-heading only; every other heading keeps its production font.
export const HEADING_APPEND =
  ".base-theme:not(.content-theme) #join-heading{font-family:system-ui,sans-serif}";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Match the shipped bundle generator without importing it (its module writes a file).
export function inlineStylesheetBundle(html, sheets, csp) {
  if (sheets.length !== 3 || sheets.some((sheet) => !Buffer.isBuffer(sheet))) {
    throw new Error("expected three served stylesheet buffers");
  }
  const css = sheets
    .map((sheet) => {
      const text = sheet.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(sheet)) throw new Error("stylesheet is not UTF-8");
      return text;
    })
    .join("\n");
  if (/<\/style/i.test(css)) throw new Error("stylesheet contains a closing style tag");
  const block = oneBlock(html);
  const directives = csp.split(";");
  const names = directives
    .map((value) => value.trim().split(/\s+/)[0].toLowerCase())
    .filter(Boolean);
  if (new Set(names).size !== names.length) throw new Error("duplicate CSP directive");
  const style = directives
    .map((value) => value.trim())
    .filter((value) => /^style-src(?:\s|$)/.test(value));
  if (directives.some((value) => /^style-src-elem(?:\s|$)/i.test(value.trim()))) {
    throw new Error("unsupported style-src-elem policy");
  }
  if (
    style.length !== 1 ||
    !/^style-src\s+'self'(?:\s|$)/.test(style[0]) ||
    style[0].includes("'unsafe-inline'")
  ) {
    throw new Error("unexpected style-src policy");
  }
  const hash = createHash("sha256").update(css, "utf8").digest("base64");
  const replacement = `<style>${css}</style>`;
  return {
    html: html.slice(0, block.index) + replacement + html.slice(block.index + block.text.length),
    csp: directives
      .map((value) =>
        /^style-src(?:\s|$)/.test(value.trim()) ? `${value} 'sha256-${hash}'` : value,
      )
      .join(";"),
    hash,
  };
}

function countOf(text, needle) {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length))
    count += 1;
  return count;
}

function oneBlock(html) {
  const matches = [...html.matchAll(STYLESHEET_BLOCK)];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one head stylesheet block, found ${matches.length}`);
  }
  const [match] = matches;
  const headEnd = html.indexOf("</head>");
  if (headEnd === -1 || match.index + match[0].length > headEnd || html.indexOf("<head>") < 0) {
    throw new Error("stylesheet block is not inside <head>");
  }
  return { text: match[0], index: match.index };
}

// Pure transform for the /join document. Throws (fail closed) on any shape it
// does not recognise; never returns a partially applied variant.
export function scheduleStylesheetsLate(html) {
  if (/\bintegrity=/.test(html)) throw new Error("integrity attributes forbid relocation");
  if (countOf(html, "</body>") !== 1) throw new Error("expected exactly one </body>");
  const block = oneBlock(html);
  const stripped = html.slice(0, block.index) + html.slice(block.index + block.text.length);
  const at = stripped.indexOf("</body>");
  return stripped.slice(0, at) + block.text + stripped.slice(at);
}

// Exact validation: the variant is the control with ONLY that block relocated.
export function validateStylesheetScheduling(control, variant) {
  const original = oneBlock(control);
  const moved = [...variant.matchAll(STYLESHEET_BLOCK)];
  if (moved.length !== 1) throw new Error("variant must contain the stylesheet block once");
  if (moved[0][0] !== original.text) throw new Error("stylesheet block bytes changed");
  const without = (html, m) => html.slice(0, m.index) + html.slice(m.index + m[0].length);
  const originalMatch = [...control.matchAll(STYLESHEET_BLOCK)][0];
  if (without(control, originalMatch) !== without(variant, moved[0])) {
    throw new Error("variant differs from control beyond the block relocation");
  }
  if (variant.slice(moved[0].index + moved[0][0].length).indexOf("</body>") !== 0) {
    throw new Error("block is not immediately before </body>");
  }
  if (moved[0].index === originalMatch.index) throw new Error("variant did not move the block");
  return {
    movedFrom: originalMatch.index,
    movedTo: moved[0].index,
    blockBytes: original.text.length,
  };
}

export function swapHeadingFont(css) {
  if (countOf(css, HEADING_RULE) !== 1) {
    throw new Error(
      `expected exactly one heading rule in theme.css, found ${countOf(css, HEADING_RULE)}`,
    );
  }
  if (css.includes("#join-heading")) throw new Error("theme.css already targets #join-heading");
  return css + HEADING_APPEND;
}

export function validateHeadingFont(control, variant) {
  if (variant !== control + HEADING_APPEND) {
    throw new Error("theme.css differs from control beyond the single appended #join-heading rule");
  }
  if (countOf(variant, HEADING_RULE) !== 1) throw new Error("existing heading rule was altered");
  return { preserved: HEADING_RULE, appended: HEADING_APPEND };
}

// run i of 12: per round, the two variants each get a paired control; the
// control/variant order flips every round (A/B then B/A) to cancel drift.
export function planRuns(variants = VARIANTS, rounds = ROUNDS) {
  const plan = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const variant of variants) {
      const pair = [
        { mode: "control", pairedWith: variant },
        { mode: variant, pairedWith: variant },
      ];
      if (round % 2 === 1) pair.reverse();
      for (const entry of pair) plan.push({ ...entry, round: round + 1 });
    }
  }
  return plan.map((entry, index) => ({
    ...entry,
    index: index + 1,
    label: `${String(index + 1).padStart(2, "0")}-${entry.mode === "control" ? `control-for-${entry.pairedWith}` : entry.mode}`,
  }));
}

const HOP = new Set([
  "connection",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  "keep-alive",
]);

function fetchUpstream(upstream, req) {
  return new Promise((resolveFetch, reject) => {
    const headers = {
      ...req.headers,
      host: `${upstream.host}:${upstream.port}`,
      "accept-encoding": "identity",
    };
    delete headers.connection;
    const outbound = http.request(
      { host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolveFetch({ res, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    outbound.setTimeout(15000, () => outbound.destroy(new Error("upstream timeout")));
    outbound.on("error", reject);
    outbound.end();
  });
}

const SHEET_PATHS = ["/styles.css", "/theme-tokens.css", "/theme.css"];

// Capture once before collection; these buffers are never fetched on a measured navigation.
export async function freezeStylesheets(upstream, controlEquality) {
  const sheets = [];
  const manifest = [];
  for (const path of SHEET_PATHS) {
    const { res, body } = await fetchUpstream(upstream, { method: "GET", url: path, headers: {} });
    const type = String(res.headers["content-type"] || "");
    if (
      res.statusCode !== 200 ||
      !/^text\/css(?:\s*;|$)/i.test(type) ||
      res.headers["content-encoding"] ||
      res.headers.location
    ) {
      throw new Error(`unexpected stylesheet response: ${path}`);
    }
    const digest = sha256(body);
    if (
      !controlEquality[path] ||
      controlEquality[path].direct !== digest ||
      controlEquality[path].viaProxy !== digest ||
      controlEquality[path].bytes !== body.length
    ) {
      throw new Error(`stylesheet differs from control: ${path}`);
    }
    sheets.push(Buffer.from(body));
    manifest.push({ path, bytes: body.length, sha256: digest });
  }
  const combined = Buffer.concat(
    sheets.flatMap((sheet, index) => (index ? [Buffer.from("\n"), sheet] : [sheet])),
  );
  return {
    sheets,
    manifest: {
      sheets: manifest,
      combinedBytes: combined.length,
      combinedSha256: sha256(combined),
      cspSha256Base64: createHash("sha256").update(combined).digest("base64"),
    },
  };
}

// Compare actual proxy bytes and headers independently of the transformation helper.
export function validateInlineResponse(direct, actual, sheets, control) {
  if (
    direct.res.statusCode !== 200 ||
    actual.res.statusCode !== 200 ||
    sha256(direct.body) !== control.direct ||
    direct.body.length !== control.bytes
  ) {
    throw new Error("inline document differs from frozen control");
  }
  const html = direct.body.toString("utf8");
  if (!Buffer.from(html).equals(direct.body)) throw new Error("document is not UTF-8");
  const block = oneBlock(html);
  const css = Buffer.concat(
    sheets.flatMap((sheet, index) => (index ? [Buffer.from("\n"), sheet] : [sheet])),
  );
  const expected = Buffer.concat([
    Buffer.from(html.slice(0, block.index)),
    Buffer.from("<style>"),
    css,
    Buffer.from("</style>"),
    Buffer.from(html.slice(block.index + block.text.length)),
  ]);
  if (!actual.body.equals(expected))
    throw new Error("inline response body differs from expected bytes");
  const csp = direct.res.headers["content-security-policy"];
  if (typeof csp === "string") {
    const seen = new Set();
    for (const directive of csp.split(";")) {
      const name = directive.trim().split(/\s+/)[0].toLowerCase();
      if (name && seen.has(name)) throw new Error("duplicate CSP directive");
      if (name === "style-src-elem") throw new Error("unsupported style-src-elem policy");
      if (name) seen.add(name);
    }
  }
  if (typeof csp !== "string" || !/(?:^|;)\s*style-src\s+'self'(?:\s*;|\s*$)/.test(csp)) {
    throw new Error("unsupported inline validation CSP");
  }
  const digest = createHash("sha256").update(css).digest("base64");
  const expectedCsp = csp.replace(
    /((?:^|;)\s*style-src\s+'self')(?=\s*;|\s*$)/,
    `$1 'sha256-${digest}'`,
  );
  const expectedHeaders = {};
  for (const [name, value] of Object.entries(direct.res.headers)) {
    if (!HOP.has(name) && name !== "etag" && name !== "last-modified")
      expectedHeaders[name] = value;
  }
  expectedHeaders["content-security-policy"] = expectedCsp;
  expectedHeaders["content-length"] = String(expected.length);
  const sorted = (headers) =>
    JSON.stringify(
      Object.entries(headers)
        .filter(
          ([name]) =>
            name !== "connection" && name !== "keep-alive" && name !== "transfer-encoding",
        )
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  if (sorted(actual.res.headers) !== sorted(expectedHeaders))
    throw new Error("inline response headers differ from expected headers");
  return { bodySha256: sha256(actual.body), bytes: actual.body.length, cspSha256Base64: digest };
}

// Loopback-only proxy. `mode` and `runIndex` are set by the runner between runs.
export function createProxy({ upstream = UPSTREAM } = {}) {
  const state = {
    mode: "control",
    runIndex: 0,
    log: [],
    failures: [],
    captureInlineUpstream: false,
    inlineUpstream: null,
  };
  let frozenSheets = null;
  const setFrozenStylesheets = (sheets) => {
    frozenSheets = sheets.map((sheet) => Buffer.from(sheet));
  };
  const server = http.createServer(async (req, res) => {
    const path = (req.url || "").split("?")[0];
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      const { res: up, body } = await fetchUpstream(upstream, req);
      const type = String(up.headers["content-type"] || "");
      let served = body;
      let transform = "none";
      if (state.mode === "inline-stylesheets" && path === "/join" && req.method === "GET") {
        if (
          up.statusCode !== 200 ||
          !/^text\/html(?:\s*;|$)/i.test(type) ||
          up.headers["content-encoding"] ||
          up.headers.location
        ) {
          throw new Error("unexpected join document response");
        }
        if (!frozenSheets) throw new Error("stylesheet preflight not completed");
        const html = body.toString("utf8");
        if (!Buffer.from(html, "utf8").equals(body)) throw new Error("document is not UTF-8");
        const csp = up.headers["content-security-policy"];
        if (typeof csp !== "string" || up.headers["content-security-policy-report-only"]) {
          throw new Error("unexpected document CSP");
        }
        if (state.captureInlineUpstream) {
          state.inlineUpstream = {
            res: { statusCode: up.statusCode, headers: { ...up.headers } },
            body: Buffer.from(body),
          };
          state.captureInlineUpstream = false;
        }
        const result = inlineStylesheetBundle(html, frozenSheets, csp);
        served = Buffer.from(result.html, "utf8");
        up.headers["content-security-policy"] = result.csp;
        transform = "inline-stylesheets";
      } else if (
        state.mode === "stylesheet-scheduling" &&
        path === "/join" &&
        /text\/html/.test(type)
      ) {
        const html = body.toString("utf8");
        const next = scheduleStylesheetsLate(html);
        validateStylesheetScheduling(html, next);
        served = Buffer.from(next, "utf8");
        transform = "stylesheet-scheduling";
      } else if (state.mode === "heading-font" && path === "/theme.css") {
        const css = body.toString("utf8");
        const next = swapHeadingFont(css);
        validateHeadingFont(css, next);
        served = Buffer.from(next, "utf8");
        transform = "heading-font";
      }
      const headers = {};
      for (const [name, value] of Object.entries(up.headers)) {
        if (!HOP.has(name)) headers[name] = value;
      }
      if (transform !== "none") {
        delete headers.etag;
        delete headers["last-modified"];
      }
      headers["content-length"] = String(served.length);
      state.log.push({
        run: state.runIndex,
        mode: state.mode,
        method: req.method,
        path: req.url,
        status: up.statusCode,
        transform,
        upstreamBytes: body.length,
        servedBytes: served.length,
        upstreamSha256: sha256(body),
        servedSha256: sha256(served),
        clientAddress: req.socket.remoteAddress,
      });
      res.writeHead(up.statusCode || 502, headers);
      res.end(req.method === "HEAD" ? undefined : served);
    } catch (error) {
      state.failures.push({ run: state.runIndex, path, error: String(error?.message || error) });
      res.writeHead(502, { "content-type": "text/plain" }).end("diagnostic proxy refused");
    }
  });
  const listen = () =>
    new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolveListen(server.address().port));
    });
  const close = () => new Promise((resolveClose) => server.close(() => resolveClose()));
  return { server, state, listen, close, setFrozenStylesheets };
}

// The checked-in mobile settings, verbatim, with only the URL swapped. A proxy
// URL replaces the fixed 8787 URL; nothing else may differ.
export function buildCollectConfig(base, proxyPort) {
  const collect = base.ci.collect;
  const target = collect.url.find((url) => new URL(url).pathname === "/join");
  if (!target) throw new Error("/join missing from ci/lighthouserc.cjs");
  if (new URL(target).hostname !== "127.0.0.1") throw new Error("fixture URL is not loopback");
  return {
    ci: {
      collect: {
        url: [`http://127.0.0.1:${proxyPort}/join`],
        numberOfRuns: 1,
        settings: JSON.parse(JSON.stringify(collect.settings)),
      },
    },
  };
}

export function assertLoopbackLhr(lhr, proxyPort) {
  const origin = `http://127.0.0.1:${proxyPort}`;
  const url = `${origin}/join`;
  if (lhr.requestedUrl !== url || lhr.finalUrl !== url)
    throw new Error("LHR navigated off the proxy URL");
  if (lhr.runtimeError) throw new Error(`LHR runtime error: ${lhr.runtimeError.code}`);
  const items = lhr.audits?.["network-requests"]?.details?.items;
  if (!Array.isArray(items) || items.length === 0) throw new Error("LHR has no network-requests");
  for (const item of items) {
    if (!/^data:|^blob:/.test(item.url) && !item.url.startsWith(`${origin}/`)) {
      throw new Error(`non-loopback request in LHR: ${item.url}`);
    }
  }
  return items.length;
}

export function assertSampleEvidence(entry, network, failures, controlEquality) {
  for (const metric of ["performance", "fcp", "lcp", "cls", "tbt"]) {
    if (!Number.isFinite(entry[metric])) throw new Error(`missing or non-finite ${metric}`);
  }
  if (failures.length) throw new Error(`proxy failed during sample: ${failures[0].path}`);
  const stylesheets = ["/styles.css", "/theme-tokens.css", "/theme.css"];
  for (const path of ["/join", ...stylesheets]) {
    const requests = network.filter(
      (item) => item.method === "GET" && item.path.split("?")[0] === path,
    );
    if (entry.mode === "inline-stylesheets" && stylesheets.includes(path)) {
      if (requests.length) throw new Error(`inline arm requested stylesheet: ${path}`);
    } else if (!requests.length || requests.some((item) => item.status !== 200)) {
      throw new Error(`missing or failed required resource: ${path}`);
    }
    if (
      controlEquality &&
      requests.some(
        (item) =>
          item.upstreamSha256 !== controlEquality[path]?.direct ||
          item.upstreamBytes !== controlEquality[path]?.bytes,
      )
    ) {
      throw new Error(`sample resource differs from frozen control: ${path}`);
    }
  }
}

// The sha is the ACTUAL checked-out HEAD (on pull_request GITHUB_SHA is the merge
// commit, so it is never used). PR_HEAD_SHA, when set, is the explicit PR head the
// checkout must equal; on pull_request events it is mandatory.
export function resolveSha(env = process.env, git = spawnSync) {
  const run = (args) => {
    const result = git("git", args, { encoding: "utf8" });
    if (result.error || result.status !== 0) {
      throw new Error(
        `git ${args[0]} failed: ${result.error?.message || result.stderr || "unknown error"}`,
      );
    }
    return String(result.stdout || "").trim();
  };
  const head = run(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("checked-out HEAD unavailable");
  const expected = env.PR_HEAD_SHA || null;
  if (expected !== null && !/^[0-9a-f]{40}$/.test(expected))
    throw new Error("PR_HEAD_SHA is not a full sha");
  if (env.GITHUB_EVENT_NAME === "pull_request" && expected === null) {
    throw new Error("PR_HEAD_SHA is required on pull_request events");
  }
  if (expected !== null && expected !== head) {
    throw new Error(`checked-out HEAD ${head} != PR_HEAD_SHA ${expected}`);
  }
  return {
    sha: head,
    expectedHeadSha: expected,
    workingTreeClean: run(["status", "--porcelain"]) === "",
  };
}

export async function loadChromeLauncher() {
  const lighthouseRequire = createRequire(require.resolve("lighthouse"));
  return (await import(pathToFileURL(lighthouseRequire.resolve("chrome-launcher")))).launch;
}

export async function lighthouseCollect(configPath, cwd, dependencies = {}) {
  let chrome;
  try {
    const lighthouse = dependencies.lighthouse ?? (await import("lighthouse")).default;
    const launch = dependencies.launch ?? (await loadChromeLauncher());
    const collect = JSON.parse(readFileSync(configPath, "utf8")).ci.collect;
    const { chromeFlags, ...settings } = collect.settings;
    chrome = await launch({ chromeFlags: [...chromeFlags.split(/\s+/), "--headless=new"] });
    const result = await lighthouse(collect.url[0], { ...settings, port: chrome.port });
    if (!result?.lhr) throw new Error("Lighthouse returned no LHR");
    const dir = join(cwd, ".lighthouseci");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "lhr-1.json"), JSON.stringify(result.lhr));
    return { code: result.lhr.runtimeError ? 1 : 0, output: "One Lighthouse attempt completed" };
  } catch (error) {
    return { code: 1, output: String(error?.stack || error) };
  } finally {
    if (chrome) await chrome.kill();
  }
}

const write = (file, data) =>
  writeFileSync(file, typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);

export async function main(argv = process.argv.slice(2), deps = {}) {
  const outIndex = argv.indexOf("--out");
  const out = resolve(outIndex >= 0 ? argv[outIndex + 1] : OUTPUT_DIR);
  const base = deps.base ?? require("./lighthouserc.cjs");
  const collect = deps.collect ?? lighthouseCollect;
  const upstream = deps.upstream ?? UPSTREAM;
  const { startFixture } = deps.admission ?? require("./lighthouse-admission.cjs");
  const log = deps.log ?? console.log;
  const plan = planRuns(deps.variants ?? VARIANTS, deps.rounds ?? ROUNDS);
  const results = [];
  let source = null;
  let preflight = null;
  let failure = null;
  let fixture = null;
  const proxy = createProxy({ upstream });
  const persist = () => {
    write(join(out, "run-order.json"), {
      source,
      planned: plan.map((step) => step.label),
      completed: results.filter((r) => r.status === "ok").map((r) => r.label),
      attempted: results,
      failure,
      proxyFailures: proxy.state.failures,
    });
    write(join(out, "summary.json"), {
      diagnostic: true,
      gate: false,
      source,
      config:
        "ci/lighthouserc.cjs collect.settings (verbatim), /join only, numberOfRuns=1 per invocation",
      runs: results,
      failure,
      limitations: [
        "n=3 per arm per variant: descriptive only, no significance claim",
        "Chrome-initiated background requests outside LHR network-requests are not captured",
        "simulated throttling: variant effects reflect Lighthouse's model, not a real network",
      ],
    });
    if (preflight) write(join(out, "preflight.json"), preflight);
  };
  try {
    source = resolveSha(deps.env, deps.git);
    for (const dir of ["lhr", "network", "runs"]) mkdirSync(join(out, dir), { recursive: true });
    fixture = startFixture(base.ci.collect.url);
    await fixture.admission; // admitted, unmodified server: all eight audited fixture pages
    const proxyPort = await proxy.listen();
    const config = buildCollectConfig(base, proxyPort);

    // Pre-flight: through the proxy, control bytes equal direct bytes, and every
    // variant validates exactly. A failure here is a blocker, nothing is measured.
    preflight = { upstream, proxyPort, controlEquality: {}, status: "running" };
    persist();
    const fetchBytes = async (port, path) =>
      Buffer.from(
        await (await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "error" })).arrayBuffer(),
      );
    const paths = ["/join", "/theme.css", "/styles.css", "/theme-tokens.css"];
    for (const path of paths) {
      const direct = await fetchBytes(upstream.port, path);
      const viaProxy = await fetchBytes(proxyPort, path);
      preflight.controlEquality[path] = {
        direct: sha256(direct),
        viaProxy: sha256(viaProxy),
        bytes: direct.length,
      };
      if (sha256(direct) !== sha256(viaProxy)) throw new Error(`control proxy altered ${path}`);
    }
    const frozen = await freezeStylesheets(upstream, preflight.controlEquality);
    proxy.setFrozenStylesheets(frozen.sheets);
    preflight.inlineStylesheetManifest = frozen.manifest;
    if (plan.some((step) => step.mode === "inline-stylesheets")) {
      const request = { method: "GET", url: "/join", headers: {} };
      proxy.state.mode = "inline-stylesheets";
      proxy.state.captureInlineUpstream = true;
      const actual = await fetchUpstream({ host: "127.0.0.1", port: proxyPort }, request);
      const direct = proxy.state.inlineUpstream;
      if (!direct) throw new Error("inline upstream response was not captured");
      preflight.inlineResponse = validateInlineResponse(
        direct,
        actual,
        frozen.sheets,
        preflight.controlEquality["/join"],
      );
      proxy.state.inlineUpstream = null;
      proxy.state.mode = "control";
      preflight.browser = { status: "running" };
      persist();
      try {
        const validateBrowser =
          deps.validateBrowser ??
          (await import("./join-lcp-browser-preflight.mjs")).validateInlineInBrowser;
        const chromium =
          deps.chromium ??
          (deps.validateBrowser ? undefined : (await import("playwright")).chromium);
        const observations = await validateBrowser(
          proxyPort,
          (mode) => {
            proxy.state.mode = mode;
          },
          chromium,
        );
        preflight.browser = { status: "ok", observations };
      } catch (error) {
        preflight.browser = { status: "failed", error: String(error?.message || error) };
        throw error;
      }
    }
    persist();
    const html = (await fetchBytes(upstream.port, "/join")).toString("utf8");
    const css = (await fetchBytes(upstream.port, "/theme.css")).toString("utf8");
    preflight.stylesheetScheduling = validateStylesheetScheduling(
      html,
      scheduleStylesheetsLate(html),
    );
    preflight.headingFont = validateHeadingFont(css, swapHeadingFont(css));
    preflight.status = "ok";
    proxy.state.log.length = 0;
    persist();

    for (const step of plan) {
      const dir = join(out, "runs", step.label);
      mkdirSync(dir, { recursive: true });
      const configPath = join(dir, "lighthouserc.json");
      write(configPath, config);
      proxy.state.mode = step.mode;
      proxy.state.runIndex = step.index;
      const entry = { ...step, startedAt: new Date().toISOString(), status: "failed" };
      results.push(entry);
      // The inline navigation does not request external sheets. Check the upstream
      // snapshot on both sides of the sample, outside Lighthouse's timing window.
      const checkInlineDrift = async (phase) => {
        if (step.mode !== "inline-stylesheets") return;
        entry.stylesheetChecks ??= {};
        try {
          const snapshot = await freezeStylesheets(upstream, preflight.controlEquality);
          entry.stylesheetChecks[phase] = { status: "ok", manifest: snapshot.manifest };
        } catch (error) {
          entry.stylesheetChecks[phase] = {
            status: "failed",
            error: String(error?.message || error),
          };
          persist();
          throw error;
        }
        persist();
      };
      await checkInlineDrift("before");
      let collection;
      try {
        collection = await collect(configPath, dir);
      } catch (error) {
        collection = { code: 1, output: String(error?.stack || error) };
      }
      const { code, output } = collection;
      write(join(dir, "collect.log"), output);
      // Retain everything available BEFORE any check can throw.
      const network = proxy.state.log.filter((e) => e.run === step.index);
      write(join(out, "network", `${step.label}.json`), network);
      entry.network = `network/${step.label}.json`;
      let lhrDir = [];
      try {
        lhrDir = readdirSync(join(dir, ".lighthouseci")).filter((name) =>
          /^lhr-\d+\.json$/.test(name),
        );
      } catch {
        lhrDir = [];
      }
      entry.lhr = lhrDir.map((name, i) => {
        const target = `lhr/${step.label}${lhrDir.length > 1 ? `.${i + 1}` : ""}.json`;
        copyFileSync(join(dir, ".lighthouseci", name), join(out, target));
        return { file: target, sha256: sha256(readFileSync(join(out, target))) };
      });
      entry.collectExit = code;
      persist();
      await checkInlineDrift("after");
      if (code !== 0 || lhrDir.length !== 1)
        throw new Error(`${step.label}: collect exit ${code}, ${lhrDir.length} LHR files`);
      const lhr = JSON.parse(readFileSync(join(out, entry.lhr[0].file), "utf8"));
      const audit = (id) => lhr.audits?.[id]?.numericValue ?? null;
      Object.assign(entry, {
        performance: lhr.categories?.performance?.score ?? null,
        fcp: audit("first-contentful-paint"),
        lcp: audit("largest-contentful-paint"),
        cls: audit("cumulative-layout-shift"),
        tbt: audit("total-blocking-time"),
      });
      entry.lhrNetworkRequests = assertLoopbackLhr(lhr, proxyPort);
      assertSampleEvidence(
        entry,
        network,
        proxy.state.failures.filter((item) => item.run === step.index),
        preflight.controlEquality,
      );
      if (
        network.some(
          (e) => e.clientAddress !== "127.0.0.1" && e.clientAddress !== "::ffff:127.0.0.1",
        )
      ) {
        throw new Error(`${step.label}: non-loopback client`);
      }
      const expectTransform = step.mode === "control" ? [] : [step.mode];
      const seen = [...new Set(network.map((e) => e.transform).filter((name) => name !== "none"))];
      if (JSON.stringify(seen) !== JSON.stringify(expectTransform)) {
        throw new Error(
          `${step.label}: transform applied ${JSON.stringify(seen)}, expected ${JSON.stringify(expectTransform)}`,
        );
      }
      entry.status = "ok";
      persist();
      log(`${step.label}: lcp=${entry.lcp}`);
    }
  } catch (error) {
    failure = String(error?.message || error);
    if (preflight && preflight.status === "running") preflight.status = "failed";
  } finally {
    fixture?.stop();
    await proxy.close();
    mkdirSync(out, { recursive: true });
    persist();
  }
  if (failure) {
    console.error(`join LCP diagnostic failed: ${failure}`);
    return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
  process.exit(process.exitCode);
}
