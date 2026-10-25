import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyHref,
  collectStandards,
  internalLinks,
  linkFindingRecords,
} from "./web-standards.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repo, "ci/web-standards.mjs");
const origin = "https://next.togetherweown.com";
const shell = (body) =>
  '<!doctype html><html lang="en"><head><title>Fixture</title>' +
  '<meta name="viewport" content="width=device-width">' +
  '<meta name="description" content="A long enough local fixture description.">' +
  `</head><body><h1>Fixture</h1>${body}</body></html>`;

// Run the actual CLI and its artifact writer, with no Worker, DB or network.
function runCli(body, slowPipe = false) {
  const cwd = mkdtempSync(join(tmpdir(), "standards-regression-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src/routes.ts"), 'app.get("/about", handler);');
  writeFileSync(join(cwd, "response.html"), shell(body));
  const preload = join(cwd, "fetch.mjs");
  writeFileSync(
    preload,
    `import { readFileSync } from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
cp.spawn = () => { throw new Error('Worker spawn forbidden in offline CLI test'); };
syncBuiltinESMExports();
const html = readFileSync(new URL('./response.html', import.meta.url), 'utf8');
const empty = ${JSON.stringify(shell(""))};
const paths = new Set(['/', '/events', '/join', '/about', '/faq', '/rules', '/privacy']);
globalThis.fetch = async (input) => {
  const url = new URL(input);
  if (url.origin !== ${JSON.stringify(origin)} || !paths.has(url.pathname))
    throw new Error('Unexpected fetch in offline CLI test');
  return new Response(url.pathname === '/' ? html : empty, {headers: {
    'content-security-policy': "default-src 'self'",
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer'
  }});
};
`,
  );
  const argv = ["--import", preload, script, "--origin", origin, "--format", "json"];
  // A real POSIX pipe with a delayed reader deterministically exercises stdout
  // backpressure. Every argument is passed positionally, never shell-expanded.
  const result = slowPipe
    ? spawnSync(
        "bash",
        ["-o", "pipefail", "-c", '"$@" | (sleep 0.2; cat)', "--", process.execPath, ...argv],
        { cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      )
    : spawnSync(process.execPath, argv, {
        cwd,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  return {
    ...result,
    summary: readFileSync(join(cwd, ".lighthouseci/standards-summary.md"), "utf8"),
    report: JSON.parse(result.stdout),
  };
}

const brokenAnchors = [
  '<a title="a > b" href="/review-missing">x</a>',
  "<a href=/review-missing>x</a>",
  '<span title="<!--">x</span><a href="/review-missing">x</a>',
  '<span title="<script>">x</span><a href="/review-missing">x</a>',
  '<a title=" href=\'/not-the-href\'" href="/review-missing">x</a>',
  '<a href="//next.togetherweown.com/review-missing">x</a>',
  '<a href="&#47;review-missing">x</a>',
  '<a href="&#x2f;review-missing">x</a>',
];
for (const html of brokenAnchors) {
  test(`browser anchor is collected and rejected: ${html}`, () => {
    assert.deepEqual(internalLinks(html, `${origin}/`), ["/review-missing"]);
    const result = runCli(html);
    assert.equal(result.status, 1);
    assert.deepEqual(result.report.counts, {
      routes: 7,
      findings: 1,
      linksChecked: 1,
      linksCollected: 1,
    });
    assert.equal(result.report.findings[0].code, "LINK_UNRESOLVED");
    assert.match(result.summary, /internal link \/review-missing:/);
  });
}

test("attribute references use HTML decoding exactly once", () => {
  const html = [
    '<a href="&#47;about">decimal</a>',
    '<a href="&#x2f;about">hex</a>',
    '<a href="&sol;about">named</a>',
    '<a href="/about?a=1&amp;b=2">query</a>',
    '<a href="/about?x=&amp;sol;">one pass</a>',
  ].join("");
  assert.deepEqual(internalLinks(html, `${origin}/`), [
    "/about",
    "/about?a=1&b=2",
    "/about?x=&sol;",
  ]);
  const result = runCli(html);
  assert.equal(result.status, 0);
  assert.equal(result.report.counts.findings, 0);
  assert.equal(result.report.counts.linksChecked, 3);
});

test("only actual anchors contribute hrefs", () => {
  const html =
    '<!-- <a href="/comment"> -->' +
    "<script>const text = '<a href=\"/script\">';</script>" +
    '<textarea><a href="/textarea">x</a></textarea>' +
    "<style>a::before { content: '<a href=\"/style\">'; }</style>" +
    '<template><a href="/template">x</a></template>' +
    "<span title=\"<a href='/attribute'>\">x</span>" +
    '<a title=" href=\'/attribute\'" href="/about">real</a>';
  assert.deepEqual(internalLinks(html, `${origin}/`), ["/about"]);
  assert.equal(runCli(html).status, 0);
});

test("network-path URLs compare the resolved origin, including ports", () => {
  assert.deepEqual(classifyHref("//next.togetherweown.com/about", `${origin}/`), {
    kind: "internal",
    target: "/about",
  });
  assert.deepEqual(classifyHref("//next.togetherweown.com:443/about", `${origin}/`), {
    kind: "internal",
    target: "/about",
  });
  for (const href of ["//example.invalid/missing", "//next.togetherweown.com:444/missing"])
    assert.deepEqual(classifyHref(href, `${origin}/`), { kind: "external" });
  const result = runCli(
    '<a href="//example.invalid/missing">other host</a>' +
      '<a href="//next.togetherweown.com:444/missing">other port</a>',
  );
  assert.equal(result.status, 0);
  assert.equal(result.report.counts.linksCollected, 0);
});

test("unparseable authorities never echo credential canaries in either report", () => {
  const canary = "SYNTHETIC_USERINFO_CANARY";
  const result = runCli(
    `<a href="https://user:${canary}@[broken/">absolute</a>` +
      `<a href="//user:${canary}@[broken/">network path</a>` +
      '<a href="/review-missing">sibling</a>',
  );
  assert.equal(result.status, 1);
  assert.equal(result.report.findings.filter((f) => f.code === "LINK_MALFORMED").length, 2);
  assert.equal(result.report.findings.filter((f) => f.code === "LINK_UNRESOLVED").length, 1);
  for (const output of [result.stdout, result.stderr, result.summary]) {
    assert.ok(!output.includes(canary));
    assert.ok(!output.includes("@[broken"));
  }
});

test("direct link records reject malformed authorities even without percent escapes", () => {
  const canary = "SYNTHETIC_USERINFO_CANARY";
  const records = linkFindingRecords(
    [`https://user:${canary}@[broken/`, `//user:${canary}@[broken/`],
    [],
  );
  assert.deepEqual(
    records.map((record) => record.code),
    ["LINK_MALFORMED", "LINK_MALFORMED"],
  );
  assert.ok(!JSON.stringify(records).includes(canary));
  assert.ok(!JSON.stringify(records).includes("@[broken"));
});

test("route fetch failures keep static diagnostics and continue without echoing exceptions", async () => {
  const fetched = [];
  const { findings, findingRecords } = await collectStandards({
    base: origin,
    routes: ["/about", "/faq"],
    fetchImpl: async (url) => {
      fetched.push(url);
      throw new Error("PRIVATE_FETCH_CANARY /private/fixture/path?value=not-for-reports");
    },
  });
  assert.deepEqual(fetched, [`${origin}/about`, `${origin}/faq`]);
  assert.deepEqual(findings, ["/about: request failed", "/faq: request failed"]);
  assert.deepEqual(
    findingRecords,
    ["/about", "/faq"].map((path) => ({
      path,
      check: "status",
      code: "STATUS_FETCH_FAILED",
      detail: `${path}: request failed`,
    })),
  );
});

test("normal CLI flushes a report larger than a stdout pipe buffer before failing", () => {
  const body = Array.from(
    { length: 300 },
    (_, i) => `<a href="/missing-${i}-${"x".repeat(220)}">x</a>`,
  ).join("");
  const result = runCli(body, true);
  assert.equal(result.status, 1);
  assert.ok(Buffer.byteLength(result.stdout) > 65_536);
  assert.deepEqual(result.report.counts, {
    routes: 7,
    findings: 300,
    linksChecked: 300,
    linksCollected: 300,
  });
  assert.equal(result.report.findings.length, 300);
  assert.equal(result.report.findings.at(-1).id, "finding-299");
  assert.equal(result.summary.split("\n").filter((line) => line.startsWith("- ")).length, 300);
});
