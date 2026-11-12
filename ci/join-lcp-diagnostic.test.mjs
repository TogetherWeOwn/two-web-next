import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HEADING_RULE,
  HEADING_APPEND,
  assertLoopbackLhr,
  assertSampleEvidence,
  buildCollectConfig,
  createProxy,
  freezeStylesheets,
  main,
  lighthouseCollect,
  inlineStylesheetBundle,
  loadChromeLauncher,
  planRuns,
  resolveSha,
  scheduleStylesheetsLate,
  sha256,
  swapHeadingFont,
  validateHeadingFont,
  validateInlineResponse,
  validateStylesheetScheduling,
} from "./join-lcp-diagnostic.mjs";

const require = createRequire(import.meta.url);
const LINKS =
  '<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/theme-tokens.css"><link rel="stylesheet" href="/theme.css">';
const HTML = `<!doctype html><html><head><title>x</title>${LINKS}</head><body><main><h1>Join Together We Own</h1></main></body></html>`;
const CSS = `a{color:red}${HEADING_RULE}b{margin:0}`;

test("locked Lighthouse dependency exposes its Chrome launcher", async () => {
  assert.equal(typeof (await loadChromeLauncher()), "function");
});

test("plan: 3 paired controls per variant, alternating order, 12 runs", () => {
  const plan = planRuns();
  assert.equal(plan.length, 12);
  for (const variant of ["stylesheet-scheduling", "heading-font"]) {
    assert.equal(plan.filter((s) => s.mode === "control" && s.pairedWith === variant).length, 3);
    assert.equal(plan.filter((s) => s.mode === variant).length, 3);
  }
  assert.deepEqual(
    plan.slice(0, 2).map((s) => s.mode),
    ["control", "stylesheet-scheduling"],
  );
  assert.deepEqual(
    plan.slice(4, 6).map((s) => s.mode),
    ["stylesheet-scheduling", "control"],
  );
  assert.deepEqual(
    plan.map((s) => s.index),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
  assert.equal(new Set(plan.map((s) => s.label)).size, 12);
});

test("inline bundle uses exact stylesheet bytes and a scoped CSP hash", () => {
  const sheets = ["a{}", "b{}", "c{}"].map((text) => Buffer.from(text));
  const csp = "default-src 'none'; style-src 'self'; script-src 'self'";
  const result = inlineStylesheetBundle(HTML, sheets, csp);
  assert.equal(result.html, HTML.replace(LINKS, "<style>a{}\nb{}\nc{}</style>"));
  assert.equal(
    result.csp,
    csp.replace("style-src 'self'", `style-src 'self' 'sha256-${result.hash}'`),
  );
  assert.equal(result.hash, "jWnrc1zqXlZE0ijh0zkZItwWAxyNeJjd86IfffnEK4c=");
  assert.throws(
    () => inlineStylesheetBundle(HTML, sheets, `${csp}; style-src-elem 'none'`),
    /style-src-elem/,
  );
  assert.throws(
    () => inlineStylesheetBundle(HTML, sheets, `${csp}; STYLE-SRC-ELEM 'self'`),
    /style-src-elem/,
  );
  assert.throws(() => inlineStylesheetBundle(HTML, sheets.slice(1), csp), /three/);
  assert.throws(
    () => inlineStylesheetBundle(HTML, [Buffer.from([255]), ...sheets.slice(1)], csp),
    /UTF-8/,
  );
  assert.throws(
    () => inlineStylesheetBundle(HTML, [Buffer.from("</StYle>"), ...sheets.slice(1)], csp),
    /closing style/,
  );
  assert.throws(() => inlineStylesheetBundle(HTML, sheets, "default-src 'none'"), /style-src/);
  assert.throws(
    () => inlineStylesheetBundle(HTML, sheets, "style-src 'self' 'unsafe-inline'"),
    /style-src/,
  );
  assert.throws(
    () => inlineStylesheetBundle(HTML, sheets, "style-src 'self'; style-src 'self'"),
    /duplicate CSP/,
  );
  assert.throws(
    () => inlineStylesheetBundle(HTML, sheets, "STYLE-SRC 'none'; style-src 'self'"),
    /duplicate CSP/,
  );
  assert.throws(
    () =>
      inlineStylesheetBundle(
        HTML,
        sheets,
        "default-src 'none'; DEFAULT-SRC 'self'; style-src 'self'",
      ),
    /duplicate CSP/,
  );
});

test("stylesheet scheduling moves only the block, exactly", () => {
  const next = scheduleStylesheetsLate(HTML);
  const info = validateStylesheetScheduling(HTML, next);
  assert.ok(info.movedTo > info.movedFrom);
  assert.ok(next.endsWith(`${LINKS}</body></html>`));
  assert.equal(next.length, HTML.length);
  assert.equal(next.replace(LINKS, ""), HTML.replace(LINKS, ""));
});

test("stylesheet scheduling fails closed on unexpected shapes", () => {
  assert.throws(
    () => scheduleStylesheetsLate(HTML.replace("/theme.css", "/other.css")),
    /exactly one/,
  );
  assert.throws(() => scheduleStylesheetsLate(HTML.replace(LINKS, LINKS + LINKS)), /exactly one/);
  assert.throws(
    () =>
      scheduleStylesheetsLate(
        HTML.replace('href="/styles.css"', 'href="/styles.css" integrity="x"'),
      ),
    /exactly one|integrity/,
  );
  assert.throws(
    () => scheduleStylesheetsLate(HTML.replace("</body>", "</body></body>")),
    /one <\/body>/,
  );
  assert.throws(() => validateStylesheetScheduling(HTML, HTML), /not immediately before/);
  assert.throws(
    () => validateStylesheetScheduling(HTML, scheduleStylesheetsLate(HTML).replace("Join", "Jo1n")),
    /beyond/,
  );
});

test("heading font appends one #join-heading rule and preserves the rest", () => {
  const next = swapHeadingFont(CSS);
  assert.equal(next, CSS + HEADING_APPEND);
  assert.ok(next.includes(HEADING_RULE));
  assert.ok(HEADING_APPEND.includes("#join-heading") && !HEADING_APPEND.includes("h2"));
  assert.deepEqual(validateHeadingFont(CSS, next), {
    preserved: HEADING_RULE,
    appended: HEADING_APPEND,
  });
  assert.throws(() => swapHeadingFont("a{}"), /exactly one/);
  assert.throws(() => swapHeadingFont(CSS + HEADING_RULE), /exactly one/);
  assert.throws(() => swapHeadingFont(CSS + "#join-heading{}"), /already targets/);
  assert.throws(
    () => validateHeadingFont(CSS, next.replace("b{margin:0}", "b{margin:1px}")),
    /beyond/,
  );
  assert.throws(() => validateHeadingFont(CSS, CSS), /beyond/);
});

test("source sha is the checked-out HEAD, validated against PR_HEAD_SHA", () => {
  const head = "a".repeat(40);
  const other = "b".repeat(40);
  const git = (_cmd, args) => ({
    status: 0,
    stdout: args[0] === "rev-parse" ? `${head}\n` : " M x\n",
  });
  assert.deepEqual(resolveSha({ GITHUB_SHA: other }, git), {
    sha: head,
    expectedHeadSha: null,
    workingTreeClean: false,
  });
  assert.equal(
    resolveSha({ PR_HEAD_SHA: head, GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA: other }, git)
      .sha,
    head,
  );
  assert.throws(() => resolveSha({ PR_HEAD_SHA: other }, git), /!= PR_HEAD_SHA/);
  assert.throws(
    () => resolveSha({ GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA: head }, git),
    /required/,
  );
  assert.throws(() => resolveSha({ PR_HEAD_SHA: "abc" }, git), /full sha/);
  assert.throws(() => resolveSha({}, () => ({ status: 0, stdout: "" })), /unavailable/);
  assert.throws(
    () => resolveSha({}, () => ({ status: 128, stderr: "unsafe repository" })),
    /git rev-parse failed/,
  );
  assert.throws(
    () =>
      resolveSha({}, (_cmd, args) =>
        args[0] === "rev-parse"
          ? { status: 0, stdout: head }
          : { status: 128, stderr: "status failed" },
      ),
    /git status failed/,
  );
});

test("config copies checked-in settings verbatim, only the URL differs", () => {
  const base = require("./lighthouserc.cjs");
  const config = buildCollectConfig(base, 4321);
  assert.deepEqual(config.ci.collect.settings, base.ci.collect.settings);
  assert.deepEqual(config.ci.collect.url, ["http://127.0.0.1:4321/join"]);
  assert.equal(config.ci.collect.numberOfRuns, 1);
  assert.equal(config.ci.collect.startServerCommand, undefined);
  assert.throws(
    () =>
      buildCollectConfig({ ci: { collect: { url: ["http://127.0.0.1:8787/"], settings: {} } } }, 1),
    /missing/,
  );
  assert.throws(
    () =>
      buildCollectConfig(
        { ci: { collect: { url: ["http://example.com/join"], settings: {} } } },
        1,
      ),
    /loopback/,
  );
});

test("collector makes one attempt and retains a runtime-error LHR", async () => {
  const dir = mkdtempSync(join(tmpdir(), "join-attempt-"));
  let calls = 0;
  let kills = 0;
  try {
    const configPath = join(dir, "config.json");
    const config = buildCollectConfig(require("./lighthouserc.cjs"), 1234);
    writeFileSync(configPath, JSON.stringify(config));
    const result = await lighthouseCollect(configPath, dir, {
      launch: async ({ chromeFlags }) => {
        assert.deepEqual(chromeFlags, [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--headless=new",
        ]);
        return {
          port: 9876,
          kill: async () => {
            kills += 1;
          },
        };
      },
      lighthouse: async (url, flags) => {
        calls += 1;
        assert.equal(url, config.ci.collect.url[0]);
        assert.equal(flags.port, 9876);
        assert.equal(flags.throttlingMethod, config.ci.collect.settings.throttlingMethod);
        return { lhr: { runtimeError: { code: "FAIL" } } };
      },
    });
    assert.equal(result.code, 1);
    assert.equal(calls, 1);
    assert.equal(kills, 1);
    assert.equal(
      JSON.parse(readFileSync(join(dir, ".lighthouseci/lhr-1.json"))).runtimeError.code,
      "FAIL",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LHR must stay on the proxy origin", () => {
  const url = "http://127.0.0.1:9/join";
  const lhr = (items, extra = {}) => ({
    requestedUrl: url,
    finalUrl: url,
    audits: { "network-requests": { details: { items } } },
    ...extra,
  });
  assert.equal(assertLoopbackLhr(lhr([{ url }, { url: "data:x" }]), 9), 2);
  assert.throws(
    () => assertLoopbackLhr(lhr([{ url: "https://example.com/a" }]), 9),
    /non-loopback/,
  );
  assert.throws(() => assertLoopbackLhr(lhr([]), 9), /no network/);
  assert.throws(
    () => assertLoopbackLhr(lhr([{ url }], { runtimeError: { code: "X" } }), 9),
    /runtime error/,
  );
  assert.throws(
    () => assertLoopbackLhr(lhr([{ url }], { finalUrl: "http://127.0.0.1:9/" }), 9),
    /off the proxy/,
  );
});

test("sample evidence rejects absent metrics, failed proxy requests and failed resources", () => {
  const metrics = { performance: 0.9, fcp: 100, lcp: 200, cls: 0, tbt: 0 };
  const network = ["/join", "/styles.css", "/theme-tokens.css", "/theme.css"].map((path) => ({
    path,
    method: "GET",
    status: 200,
  }));
  assert.doesNotThrow(() => assertSampleEvidence(metrics, network, []));
  assert.throws(
    () => assertSampleEvidence({ ...metrics, lcp: null }, network, []),
    /non-finite lcp/,
  );
  assert.throws(
    () => assertSampleEvidence({ ...metrics, fcp: Infinity }, network, []),
    /non-finite fcp/,
  );
  assert.throws(() => assertSampleEvidence(metrics, network, [{ path: "/join" }]), /proxy failed/);
  assert.throws(
    () => assertSampleEvidence(metrics, network.slice(1), []),
    /required resource: \/join/,
  );
  assert.throws(
    () => assertSampleEvidence(metrics, [...network, { ...network[1], status: 404 }], []),
    /required resource: \/styles.css/,
  );
  const inline = { ...metrics, mode: "inline-stylesheets" };
  assert.doesNotThrow(() => assertSampleEvidence(inline, network.slice(0, 1), []));
  assert.throws(
    () => assertSampleEvidence(inline, network, []),
    /inline arm requested stylesheet: \/styles.css/,
  );
  assert.throws(() => assertSampleEvidence(inline, [], []), /required resource: \/join/);
});

test("sample evidence rejects upstream drift even on transformed and repeated resources", () => {
  const entry = { mode: "heading-font", performance: 0.9, fcp: 1, lcp: 2, cls: 0, tbt: 0 };
  const paths = ["/join", "/styles.css", "/theme-tokens.css", "/theme.css"];
  const control = Object.fromEntries(
    paths.map((path) => [path, { direct: sha256(path), bytes: Buffer.byteLength(path) }]),
  );
  const network = paths.map((path) => ({
    path,
    method: "GET",
    status: 200,
    upstreamSha256: sha256(path),
    upstreamBytes: Buffer.byteLength(path),
  }));
  assert.doesNotThrow(() => assertSampleEvidence(entry, network, [], control));
  assert.throws(
    () =>
      assertSampleEvidence(
        entry,
        [...network, { ...network[3], upstreamSha256: sha256("changed") }],
        [],
        control,
      ),
    /differs from frozen control: \/theme.css/,
  );
  assert.throws(
    () =>
      assertSampleEvidence(
        entry,
        [{ ...network[0], upstreamBytes: 0 }, ...network.slice(1)],
        [],
        control,
      ),
    /differs from frozen control: \/join/,
  );
});

async function withProxy(mode, fn) {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/join")
      res.writeHead(200, { "content-type": "text/html", etag: "e" }).end(HTML);
    else if (req.url === "/theme.css")
      res.writeHead(200, { "content-type": "text/css", etag: "e" }).end(CSS);
    else res.writeHead(404).end("no");
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const proxy = createProxy({ upstream: { host: "127.0.0.1", port: upstream.address().port } });
  const port = await proxy.listen();
  proxy.state.mode = mode;
  proxy.state.runIndex = 7;
  try {
    const get = async (path) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      return { response, text: await response.text() };
    };
    await fn(get, proxy);
  } finally {
    await proxy.close();
    await new Promise((r) => upstream.close(r));
  }
}

test("proxy: control is byte-identical and logs bytes", async () => {
  await withProxy("control", async (get, proxy) => {
    assert.equal((await get("/join")).text, HTML);
    assert.equal((await get("/theme.css")).text, CSS);
    assert.deepEqual([...new Set(proxy.state.log.map((e) => e.transform))], ["none"]);
    assert.equal(proxy.state.log[0].run, 7);
    assert.equal(proxy.state.log[0].servedSha256, sha256(HTML));
    assert.equal(proxy.state.log[0].clientAddress.endsWith("127.0.0.1"), true);
  });
});

test("proxy: each variant touches only its own resource", async () => {
  await withProxy("stylesheet-scheduling", async (get, proxy) => {
    const join = await get("/join");
    assert.equal(join.text, scheduleStylesheetsLate(HTML));
    assert.equal(join.response.headers.get("etag"), null);
    assert.equal((await get("/theme.css")).text, CSS);
    assert.deepEqual(
      proxy.state.log.map((e) => e.transform),
      ["stylesheet-scheduling", "none"],
    );
  });
  await withProxy("heading-font", async (get, proxy) => {
    assert.equal((await get("/join")).text, HTML);
    assert.equal((await get("/theme.css")).text, CSS + HEADING_APPEND);
    assert.deepEqual(
      proxy.state.log.map((e) => e.transform),
      ["none", "heading-font"],
    );
  });
});

test("proxy: inline arm serves the exact bundle and refuses a failed stylesheet", async () => {
  let badSheet = false;
  let requestId = 0;
  const csp = "default-src 'none'; style-src 'self'";
  const sheets = { "/styles.css": "a{}", "/theme-tokens.css": "b{}", "/theme.css": "c{}" };
  const upstream = http.createServer((req, res) => {
    if (req.url === "/join") {
      res
        .writeHead(200, {
          "content-type": "text/html",
          "content-security-policy": csp,
          "x-request-id": String(++requestId),
        })
        .end(HTML);
    } else if (req.url in sheets) {
      res
        .writeHead(badSheet && req.url === "/theme.css" ? 404 : 200, { "content-type": "text/css" })
        .end(sheets[req.url]);
    } else res.writeHead(404).end();
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const proxy = createProxy({ upstream: { host: "127.0.0.1", port: upstream.address().port } });
  const port = await proxy.listen();
  proxy.state.mode = "inline-stylesheets";
  try {
    const identity = Object.fromEntries(
      Object.entries(sheets).map(([path, text]) => [
        path,
        { direct: sha256(text), viaProxy: sha256(text), bytes: Buffer.byteLength(text) },
      ]),
    );
    const frozen = await freezeStylesheets(
      { host: "127.0.0.1", port: upstream.address().port },
      identity,
    );
    assert.equal(frozen.manifest.cspSha256Base64, "jWnrc1zqXlZE0ijh0zkZItwWAxyNeJjd86IfffnEK4c=");
    assert.equal(frozen.manifest.sheets[0].sha256, identity["/styles.css"].direct);
    proxy.setFrozenStylesheets(frozen.sheets);
    const expected = inlineStylesheetBundle(
      HTML,
      Object.values(sheets).map((s) => Buffer.from(s)),
      csp,
    );
    const otherResponse = await fetch(`http://127.0.0.1:${upstream.address().port}/join`);
    await otherResponse.arrayBuffer();
    proxy.state.captureInlineUpstream = true;
    const response = await fetch(`http://127.0.0.1:${port}/join`);
    const actualBody = Buffer.from(await response.arrayBuffer());
    assert.equal(actualBody.toString(), expected.html);
    assert.equal(response.headers.get("content-security-policy"), expected.csp);
    const direct = proxy.state.inlineUpstream;
    const actual = {
      res: { statusCode: response.status, headers: Object.fromEntries(response.headers) },
      body: actualBody,
    };
    assert.notEqual(otherResponse.headers.get("x-request-id"), actual.res.headers["x-request-id"]);
    assert.equal(direct.res.headers["x-request-id"], actual.res.headers["x-request-id"]);
    const control = { direct: sha256(HTML), bytes: Buffer.byteLength(HTML) };
    assert.equal(
      validateInlineResponse(direct, actual, frozen.sheets, control).cspSha256Base64,
      "jWnrc1zqXlZE0ijh0zkZItwWAxyNeJjd86IfffnEK4c=",
    );
    assert.throws(
      () =>
        validateInlineResponse(
          direct,
          { ...actual, body: Buffer.from("altered") },
          frozen.sheets,
          control,
        ),
      /body differs/,
    );
    assert.throws(
      () =>
        validateInlineResponse(
          direct,
          {
            ...actual,
            res: { ...actual.res, headers: { ...actual.res.headers, "x-extra": "changed" } },
          },
          frozen.sheets,
          control,
        ),
      /headers differ/,
    );
    assert.throws(
      () => validateInlineResponse(direct, actual, frozen.sheets, { ...control, direct: "drift" }),
      /frozen control/,
    );
    const duplicate = {
      ...direct,
      res: {
        ...direct.res,
        headers: {
          ...direct.res.headers,
          "content-security-policy": "STYLE-SRC 'none'; style-src 'self'",
        },
      },
    };
    assert.throws(
      () => validateInlineResponse(duplicate, actual, frozen.sheets, control),
      /duplicate CSP/,
    );
    const override = {
      ...direct,
      res: {
        ...direct.res,
        headers: {
          ...direct.res.headers,
          "content-security-policy": "STYLE-SRC-ELEM 'none'; style-src 'self'",
        },
      },
    };
    assert.throws(
      () => validateInlineResponse(override, actual, frozen.sheets, control),
      /style-src-elem/,
    );
    assert.equal(proxy.state.log[0].transform, "inline-stylesheets");
    badSheet = true;
    const stillFrozen = await fetch(`http://127.0.0.1:${port}/join`);
    assert.equal(await stillFrozen.text(), expected.html);
    await assert.rejects(
      () => freezeStylesheets({ host: "127.0.0.1", port: upstream.address().port }, identity),
      /unexpected stylesheet response/,
    );
    badSheet = false;
    sheets["/theme.css"] = "d{}";
    await assert.rejects(
      () => freezeStylesheets({ host: "127.0.0.1", port: upstream.address().port }, identity),
      /differs from control/,
    );
    sheets["/theme.css"] = "c{}";
    await assert.rejects(
      () =>
        freezeStylesheets(
          { host: "127.0.0.1", port: upstream.address().port },
          { ...identity, "/theme.css": { ...identity["/theme.css"], direct: "changed" } },
        ),
      /differs from control/,
    );
  } finally {
    await proxy.close();
    await new Promise((r) => upstream.close(r));
  }
});

test("proxy: unrecognised document is refused, not partially varied", async () => {
  await withProxy("heading-font", async (get, proxy) => {
    proxy.state.mode = "stylesheet-scheduling";
    const bad = await get("/missing");
    assert.equal(bad.response.status, 404);
  });
});

async function fakeUpstream() {
  const sheets = { "/styles.css": "x", "/theme-tokens.css": "x", "/theme.css": CSS };
  const headers = { csp: "default-src 'none'; style-src 'self'" };
  const server = http.createServer((req, res) => {
    if (req.url === "/join")
      res
        .writeHead(200, { "content-type": "text/html", "content-security-policy": headers.csp })
        .end(HTML);
    else res.writeHead(200, { "content-type": "text/css" }).end(sheets[req.url] ?? "x");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port, sheets, headers };
}

const lhrFor = (origin, path = "/join") =>
  JSON.stringify({
    requestedUrl: `${origin}/join`,
    finalUrl: `${origin}/join`,
    categories: { performance: { score: 0.9 } },
    audits: {
      "network-requests": { details: { items: [{ url: `${origin}${path}` }] } },
      "largest-contentful-paint": { numericValue: 1234 },
      "first-contentful-paint": { numericValue: 500 },
      "cumulative-layout-shift": { numericValue: 0 },
      "total-blocking-time": { numericValue: 0 },
    },
  });

function baseDeps(upstream, out, collect, stops) {
  return {
    env: { PR_HEAD_SHA: "a".repeat(40) },
    git: (_cmd, args) => ({ status: 0, stdout: args[0] === "rev-parse" ? "a".repeat(40) : "" }),
    log: () => {},
    upstream: { host: "127.0.0.1", port: upstream.port },
    admission: {
      startFixture: () => ({ admission: Promise.resolve(), stop: () => stops.push(1) }),
    },
    collect,
  };
}

test("main: records order, HEAD sha, raw LHRs, network and preflight; stops the fixture", async () => {
  const out = mkdtempSync(join(tmpdir(), "join-lcp-"));
  const upstream = await fakeUpstream();
  const stops = [];
  try {
    const code = await main(
      ["--out", out],
      baseDeps(
        upstream,
        out,
        async (configPath, cwd) => {
          const config = JSON.parse(readFileSync(configPath, "utf8"));
          const origin = `http://127.0.0.1:${new URL(config.ci.collect.url[0]).port}`;
          for (const path of ["/join", "/styles.css", "/theme-tokens.css", "/theme.css"]) {
            await fetch(`${origin}${path}`);
          }
          mkdirSync(join(cwd, ".lighthouseci"), { recursive: true });
          writeFileSync(join(cwd, ".lighthouseci", "lhr-1.json"), lhrFor(origin));
          return { code: 0, output: "ok" };
        },
        stops,
      ),
    );
    assert.equal(code, 0);
    assert.equal(stops.length, 1);
    const order = JSON.parse(readFileSync(join(out, "run-order.json"), "utf8"));
    assert.equal(order.source.sha, "a".repeat(40));
    assert.equal(order.planned.length, 12);
    assert.deepEqual(order.completed, order.planned);
    assert.equal(order.attempted[1].lcp, 1234);
    const net = JSON.parse(readFileSync(join(out, order.attempted[1].network), "utf8"));
    assert.deepEqual(
      net.map((e) => e.transform),
      ["stylesheet-scheduling", "none", "none", "none"],
    );
    assert.equal(
      sha256(readFileSync(join(out, order.attempted[0].lhr[0].file))),
      order.attempted[0].lhr[0].sha256,
    );
    const pre = JSON.parse(readFileSync(join(out, "preflight.json"), "utf8"));
    assert.equal(pre.status, "ok");
    assert.equal(pre.controlEquality["/join"].direct, pre.controlEquality["/join"].viaProxy);
    assert.equal(pre.headingFont.appended, HEADING_APPEND);
    assert.ok(pre.stylesheetScheduling.movedTo > pre.stylesheetScheduling.movedFrom);
  } finally {
    await new Promise((r) => upstream.server.close(r));
    rmSync(out, { recursive: true, force: true });
  }
});

test("main: a failed validation keeps its LHR, network log, order and failure", async () => {
  const out = mkdtempSync(join(tmpdir(), "join-lcp-"));
  const upstream = await fakeUpstream();
  const stops = [];
  let calls = 0;
  try {
    const code = await main(
      ["--out", out],
      baseDeps(
        upstream,
        out,
        async (configPath, cwd) => {
          calls += 1;
          const config = JSON.parse(readFileSync(configPath, "utf8"));
          const origin = `http://127.0.0.1:${new URL(config.ci.collect.url[0]).port}`;
          for (const path of ["/join", "/styles.css", "/theme-tokens.css", "/theme.css"]) {
            await fetch(`${origin}${path}`);
          }
          mkdirSync(join(cwd, ".lighthouseci"), { recursive: true });
          // Second run reports an off-origin request: validation throws after collect.
          const bad = calls === 2;
          const text = bad
            ? lhrFor(origin).replace(`${origin}/join"}]`, 'https://example.com/x"}]')
            : lhrFor(origin);
          writeFileSync(join(cwd, ".lighthouseci", "lhr-1.json"), text);
          return { code: 0, output: "ok" };
        },
        stops,
      ),
    );
    assert.equal(code, 1);
    assert.equal(stops.length, 1);
    const order = JSON.parse(readFileSync(join(out, "run-order.json"), "utf8"));
    assert.equal(order.planned.length, 12);
    assert.equal(order.completed.length, 1);
    assert.equal(order.attempted.length, 2);
    assert.equal(order.attempted[1].status, "failed");
    assert.match(order.failure, /non-loopback/);
    const savedLhr = JSON.parse(readFileSync(join(out, order.attempted[1].lhr[0].file), "utf8"));
    assert.equal(
      new URL(savedLhr.audits["network-requests"].details.items[0].url).hostname,
      "example.com",
    );
    assert.ok(readFileSync(join(out, order.attempted[1].network), "utf8").includes("/join"));
  } finally {
    await new Promise((r) => upstream.server.close(r));
    rmSync(out, { recursive: true, force: true });
  }
});

test("main: inline drift and failed collection retain attempted evidence", async () => {
  for (const scenario of ["before", "after", "collect", "throw"]) {
    const out = mkdtempSync(join(tmpdir(), "join-inline-"));
    const upstream = await fakeUpstream();
    let calls = 0;
    try {
      const deps = baseDeps(
        upstream,
        out,
        async (configPath, cwd) => {
          calls += 1;
          const config = JSON.parse(readFileSync(configPath, "utf8"));
          const origin = new URL(config.ci.collect.url[0]).origin;
          const paths =
            calls === 1 ? ["/join", "/styles.css", "/theme-tokens.css", "/theme.css"] : ["/join"];
          for (const path of paths) await fetch(`${origin}${path}`);
          mkdirSync(join(cwd, ".lighthouseci"), { recursive: true });
          writeFileSync(join(cwd, ".lighthouseci", "lhr-1.json"), lhrFor(origin));
          if ((scenario === "before" && calls === 1) || (scenario === "after" && calls === 2)) {
            upstream.sheets["/theme.css"] = "changed";
          }
          if (scenario === "throw" && calls === 2) throw new Error("collector threw");
          return {
            code: scenario === "collect" && calls === 2 ? 1 : 0,
            output: "attempt recorded",
          };
        },
        [],
      );
      deps.variants = ["inline-stylesheets"];
      deps.rounds = 1;
      deps.validateBrowser = async () => ({ fixture: "stubbed for drift test" });
      assert.equal(await main(["--out", out], deps), 1, scenario);
      const order = JSON.parse(readFileSync(join(out, "run-order.json"), "utf8"));
      const inline = order.attempted[1];
      assert.equal(inline.status, "failed", scenario);
      assert.equal(inline.stylesheetChecks.before.status, scenario === "before" ? "failed" : "ok");
      assert.equal(calls, scenario === "before" ? 1 : 2);
      if (scenario === "before") {
        assert.match(order.failure, /stylesheet differs from control/);
        assert.equal(inline.lhr, undefined);
      } else {
        assert.equal(inline.stylesheetChecks.after.status, scenario === "after" ? "failed" : "ok");
        assert.equal(inline.lhr.length, 1);
        assert.ok(readFileSync(join(out, inline.network), "utf8").includes("/join"));
        assert.match(
          readFileSync(join(out, "runs", inline.label, "collect.log"), "utf8"),
          scenario === "throw" ? /collector threw/ : /attempt recorded/,
        );
        assert.match(
          order.failure,
          scenario === "after" ? /stylesheet differs from control/ : /collect exit 1/,
        );
      }
    } finally {
      await new Promise((r) => upstream.server.close(r));
      rmSync(out, { recursive: true, force: true });
    }
  }
});

test("main: duplicate CSP introduced after preflight fails the inline sample", async () => {
  const out = mkdtempSync(join(tmpdir(), "join-csp-drift-"));
  const upstream = await fakeUpstream();
  let calls = 0;
  try {
    const deps = baseDeps(
      upstream,
      out,
      async (configPath, cwd) => {
        calls += 1;
        const origin = new URL(JSON.parse(readFileSync(configPath, "utf8")).ci.collect.url[0])
          .origin;
        const paths =
          calls === 1 ? ["/join", "/styles.css", "/theme-tokens.css", "/theme.css"] : ["/join"];
        for (const path of paths) await fetch(`${origin}${path}`);
        mkdirSync(join(cwd, ".lighthouseci"), { recursive: true });
        writeFileSync(join(cwd, ".lighthouseci", "lhr-1.json"), lhrFor(origin));
        if (calls === 1) upstream.headers.csp = "STYLE-SRC 'none'; style-src 'self'";
        return { code: 0, output: "attempt recorded" };
      },
      [],
    );
    deps.variants = ["inline-stylesheets"];
    deps.rounds = 1;
    deps.validateBrowser = async () => ({});
    assert.equal(await main(["--out", out], deps), 1);
    const order = JSON.parse(readFileSync(join(out, "run-order.json"), "utf8"));
    assert.equal(order.attempted[1].status, "failed");
    assert.match(order.failure, /proxy failed/);
    assert.match(order.proxyFailures[0].error, /duplicate CSP/);
    assert.equal(order.attempted[1].lhr.length, 1);
  } finally {
    await new Promise((r) => upstream.server.close(r));
    rmSync(out, { recursive: true, force: true });
  }
});

test("main: browser preflight failure prevents any collection", async () => {
  const out = mkdtempSync(join(tmpdir(), "join-browser-"));
  const upstream = await fakeUpstream();
  let calls = 0;
  try {
    const deps = baseDeps(
      upstream,
      out,
      async () => {
        calls += 1;
      },
      [],
    );
    deps.variants = ["inline-stylesheets"];
    deps.rounds = 1;
    deps.validateBrowser = async () => {
      throw new Error("CSP mismatch");
    };
    assert.equal(await main(["--out", out], deps), 1);
    assert.equal(calls, 0);
    const preflight = JSON.parse(readFileSync(join(out, "preflight.json"), "utf8"));
    assert.equal(preflight.browser.status, "failed");
    assert.match(preflight.browser.error, /CSP mismatch/);
  } finally {
    await new Promise((r) => upstream.server.close(r));
    rmSync(out, { recursive: true, force: true });
  }
});

test("main: a failed collect and a bad HEAD both persist a failure record", async () => {
  const out = mkdtempSync(join(tmpdir(), "join-lcp-"));
  const upstream = await fakeUpstream();
  try {
    const deps = baseDeps(upstream, out, async () => ({ code: 1, output: "chrome crash" }), []);
    assert.equal(await main(["--out", out], deps), 1);
    let order = JSON.parse(readFileSync(join(out, "run-order.json"), "utf8"));
    assert.match(order.failure, /collect exit 1, 0 LHR files/);
    assert.equal(order.attempted[0].collectExit, 1);
    assert.deepEqual(order.completed, []);

    const mismatch = { ...deps, env: { PR_HEAD_SHA: "b".repeat(40) } };
    assert.equal(await main(["--out", out], mismatch), 1);
    order = JSON.parse(readFileSync(join(out, "run-order.json"), "utf8"));
    assert.match(order.failure, /!= PR_HEAD_SHA/);
    assert.equal(order.planned.length, 12);
  } finally {
    await new Promise((r) => upstream.server.close(r));
    rmSync(out, { recursive: true, force: true });
  }
});
