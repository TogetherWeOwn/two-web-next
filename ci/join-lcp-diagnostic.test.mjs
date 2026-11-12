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
  buildCollectConfig,
  createProxy,
  main,
  planRuns,
  resolveSha,
  scheduleStylesheetsLate,
  sha256,
  swapHeadingFont,
  validateHeadingFont,
  validateStylesheetScheduling,
} from "./join-lcp-diagnostic.mjs";

const require = createRequire(import.meta.url);
const LINKS =
  '<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/theme-tokens.css"><link rel="stylesheet" href="/theme.css">';
const HTML = `<!doctype html><html><head><title>x</title>${LINKS}</head><body><main><h1>Join Together We Own</h1></main></body></html>`;
const CSS = `a{color:red}${HEADING_RULE}b{margin:0}`;

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
  const git = (_cmd, args) => ({ stdout: args[0] === "rev-parse" ? `${head}\n` : " M x\n" });
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
  assert.throws(() => resolveSha({}, () => ({ stdout: "" })), /unavailable/);
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

test("proxy: unrecognised document is refused, not partially varied", async () => {
  await withProxy("heading-font", async (get, proxy) => {
    proxy.state.mode = "stylesheet-scheduling";
    const bad = await get("/missing");
    assert.equal(bad.response.status, 404);
  });
});

async function fakeUpstream() {
  const server = http.createServer((req, res) => {
    if (req.url === "/join") res.writeHead(200, { "content-type": "text/html" }).end(HTML);
    else if (req.url === "/theme.css") res.writeHead(200, { "content-type": "text/css" }).end(CSS);
    else res.writeHead(200, { "content-type": "text/css" }).end("x");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port };
}

const lhrFor = (origin, path = "/join") =>
  JSON.stringify({
    requestedUrl: `${origin}/join`,
    finalUrl: `${origin}/join`,
    categories: { performance: { score: 0.9 } },
    audits: {
      "network-requests": { details: { items: [{ url: `${origin}${path}` }] } },
      "largest-contentful-paint": { numericValue: 1234 },
    },
  });

function baseDeps(upstream, out, collect, stops) {
  return {
    env: { PR_HEAD_SHA: "a".repeat(40) },
    git: (_cmd, args) => ({ stdout: args[0] === "rev-parse" ? "a".repeat(40) : "" }),
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
          await fetch(`${origin}/join`);
          await fetch(`${origin}/theme.css`);
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
      ["stylesheet-scheduling", "none"],
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
          await fetch(`${origin}/join`);
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
    assert.ok(
      readFileSync(join(out, order.attempted[1].lhr[0].file), "utf8").includes("example.com"),
    );
    assert.ok(readFileSync(join(out, order.attempted[1].network), "utf8").includes("/join"));
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
