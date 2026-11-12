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

// Loopback-only proxy. `mode` and `runIndex` are set by the runner between runs.
export function createProxy({ upstream = UPSTREAM } = {}) {
  const state = { mode: "control", runIndex: 0, log: [], failures: [], documents: {} };
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
      if (state.mode === "stylesheet-scheduling" && path === "/join" && /text\/html/.test(type)) {
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
  return { server, state, listen, close };
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

// The sha is the ACTUAL checked-out HEAD (on pull_request GITHUB_SHA is the merge
// commit, so it is never used). PR_HEAD_SHA, when set, is the explicit PR head the
// checkout must equal; on pull_request events it is mandatory.
export function resolveSha(env = process.env, git = spawnSync) {
  const run = (args) => String(git("git", args, { encoding: "utf8" }).stdout || "").trim();
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

export async function lighthouseCollect(configPath, cwd, dependencies = {}) {
  let chrome;
  try {
    const lighthouse = dependencies.lighthouse ?? (await import("lighthouse")).default;
    const launch = dependencies.launch ?? (await import("chrome-launcher")).launch;
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
  const plan = planRuns();
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
      const { code, output } = await collect(configPath, dir);
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
