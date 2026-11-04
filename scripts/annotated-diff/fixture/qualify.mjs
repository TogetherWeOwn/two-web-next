import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  capture,
  compare,
  render,
  check,
  runtime,
  THRESHOLDS,
  validateLabels,
  normalizeIntent,
  attribute,
  diffHunks,
  hash,
} from "../run.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const run = path.join(root, ".climb/diff", `qualification-${Date.now()}`);
await fs.mkdir(run, { recursive: true });
const source = path.join(run, "synthetic-source");
await fs.mkdir(source);
// A synthetic Git fixture, not a clone, worktree or substitute execution workspace.
const git = (...args) =>
  execFileSync("git", ["-C", source, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_DATE: "2026-01-01T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T12:00:00Z",
    },
  }).trim();
git("init", "-q", "--initial-branch=fixture");
git("config", "user.name", "Fixture");
git("config", "user.email", "fixture@example.invalid");
const before = await fs.readFile(new URL("./before.html", import.meta.url), "utf8");
const after = await fs.readFile(new URL("./after.html", import.meta.url), "utf8");
let content = before;
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/font.woff2") {
      res.setHeader("Content-Type", "font/woff2");
      res.end(
        await fs.readFile(
          path.join(root, "node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2"),
        ),
      );
    } else if (req.url === "/alternate.woff2") {
      res.setHeader("Content-Type", "font/woff2");
      res.end(await fs.readFile(path.join(root, "public/fonts/display-latin-500.woff2")));
    } else if (req.url === "/favicon.ico") {
      res.writeHead(204);
      res.end();
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(content);
    }
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const spec = {
  schema: "annotated-diff/capture-v0",
  thresholds: THRESHOLDS,
  runtime: await runtime(),
  seed: "known-answer",
  locale: "en-US",
  timezone: "UTC",
  fixedTime: "2026-01-01T12:00:00Z",
  fullPage: false,
  style: "",
  routes: ["/"],
  views: ["light", "dark"].flatMap((theme) =>
    [
      [390, 844],
      [1280, 832],
    ].map(([width, height]) => ({
      id: `fixture-${theme}-${width}`,
      route: "/",
      theme,
      width,
      height,
      dpr: 2,
      anchor: "#anchor",
      expectedFont: "Inter",
      masks: [],
    })),
  ),
};
const commit = async (html) => {
  await fs.writeFile(path.join(source, "index.html"), html);
  git("add", "index.html");
  git("commit", "-qm", "test: plant fixture");
  return git("rev-parse", "HEAD");
};
let base, head;
try {
  base = await commit(before);
  await capture({ spec, sourceRoot: source, sha: base, url, out: path.join(run, "base") });
  content = after;
  head = await commit(after);
  await capture({ spec, sourceRoot: source, sha: head, url, out: path.join(run, "head") });
} finally {
  await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}
const line = (term) => {
  const lines = after.split("\n").flatMap((text, n) => (text.includes(term) ? [n + 1] : []));
  assert.equal(lines.length, 1, term);
  return lines[0];
};
const member = (prop) => ({
  prop,
  file: "index.html",
  line: line(
    prop.endsWith("-color")
      ? "border: 1px solid"
      : prop === "font-family"
        ? '[data-testid="type"] {'
        : `${prop}:`,
  ),
});
const style = (id, selector, props) => ({
  id,
  claim: id,
  selector: `[data-testid="${selector}"]`,
  change: "style",
  deltas: props.map(member),
});
const intent = [
  style("card-geometry", "card", [
    "border-top-left-radius",
    "border-top-right-radius",
    "border-bottom-left-radius",
    "border-bottom-right-radius",
    "padding-bottom",
  ]),
  style("opacity", "opacity", ["opacity"]),
  style("font-family", "type", ["font-family"]),
  style("border-colour", "border", [
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
  ]),
  {
    id: "added-badge",
    claim: "Add status",
    selector: '[data-testid="badge"]',
    change: "added",
    file: "index.html",
    line: line('<div data-testid="badge"'),
  },
  style("unseen-state", "noop", ["opacity"]),
];
// The border shorthand's one changed line proves each measured longhand, not an invented declaration.
for (const d of intent[3].deltas) d.line = line("border: 1px solid");
// The negative claim deliberately references a real changed line, but no measured opacity change.
intent[5].deltas[0].line = line("opacity:");
await fs.writeFile(path.join(run, "intent.json"), JSON.stringify(intent, null, 2));
const manifest = await compare({ dir: run, root: source, intent });
for (const view of manifest.views) {
  console.log(
    view.id,
    view.items.map((i) => ({
      n: i.n,
      status: i.status,
      element: i.element?.name,
      regions: i.regions.length,
      delta: i.style_delta,
      shifts: i.shifts.length,
    })),
  );
  assert.equal(view.regions.length, 10, "Seven visible causes include four separated font regions");
  const typography = view.items.find((i) => i.intent_ref === "font-family");
  assert.equal(typography.regions.length, 4);
  assert.equal(typography.scope, "global");
  assert.equal(view.items.filter((i) => i.status === "explained").length, 5);
  assert.equal(view.items.filter((i) => i.status === "unexplained").length, 2);
  assert.equal(view.items.filter((i) => i.status === "unverified_claim").length, 1);
  assert.equal(view.items.find((i) => i.status === "unexplained" && !i.element)?.change, "image");
  const geometry = view.items.find((i) => i.intent_ref === "card-geometry");
  assert(
    geometry.style_delta.some(
      (d) => d.prop === "padding-bottom" && d.old === "10px" && d.new === "18px",
    ),
  );
  assert.equal(geometry.code_refs.length, 5);
  assert(geometry.code_refs.every((r) => r.code_ref.source === "intent_verified"));
  assert.equal(geometry.code_ref, "unresolved");
  assert(geometry.shifts.some((s) => s.dy === 8 && s.dx === 0));
}
const labels = manifest.views.flatMap((v) =>
  v.items.map((i) => ({
    id: i.id,
    label:
      i.status === "unexplained"
        ? "Unclaimed visual change"
        : i.status === "unverified_claim"
          ? "No visible change"
          : "Measured appearance change",
    rationale: "",
  })),
);
const bad = structuredClone(labels);
bad[0].rationale = "Adjust padding to 999px";
assert.throws(
  () =>
    validateLabels(
      manifest.views[0].items,
      bad.filter((l) => manifest.views[0].items.some((i) => i.id === l.id)),
      manifest.views[0].element_names,
    ),
  /Invented value/,
);
assert.throws(() => normalizeIntent([{ ...intent[0], prop: "padding-bottom" }]));
const incomplete = structuredClone(intent);
incomplete[0].deltas.push({ prop: "opacity", file: "index.html", line: line("opacity:") });
const v = manifest.views[0],
  a = JSON.parse(await fs.readFile(path.join(run, "base", `${v.id}.json`))),
  b = JSON.parse(await fs.readFile(path.join(run, "head", `${v.id}.json`)));
const rejected = attribute(
  a.elements,
  b.elements,
  v.regions,
  normalizeIntent(incomplete),
  diffHunks(source, base, head),
  head,
  v,
);
assert(!rejected.items.some((i) => i.intent_ref === "card-geometry" && i.status === "explained"));
await fs.writeFile(path.join(run, "labels.bad.json"), JSON.stringify(bad, null, 2));
await fs.writeFile(path.join(run, "labels.todo.json"), JSON.stringify(labels, null, 2));
await render({ dir: run, author: "fixture:deterministic" });
await fs.writeFile(path.join(run, "labels.todo.json"), JSON.stringify(bad, null, 2));
const badChecks = await check({ dir: run });
assert.equal(badChecks.checks.wording, false);
assert.equal(badChecks.checks.passed, false);
assert.equal(badChecks.status, "checks_failed");
await fs.writeFile(
  path.join(run, "invented-value-check.json"),
  JSON.stringify(badChecks.checks, null, 2),
);
await assert.rejects(() => render({ dir: run, author: "fixture:deterministic" }), /Invented value/);
const rejectedRender = JSON.parse(
  await fs.readFile(path.join(run, "annotated-diff.manifest.json")),
);
assert.notEqual(rejectedRender.status, "gallery_ready");
assert.equal(rejectedRender.checks.passed, false);
await fs.writeFile(path.join(run, "labels.todo.json"), JSON.stringify(labels, null, 2));
await render({ dir: run, author: "fixture:deterministic" });
const checked = await check({ dir: run });
console.log(JSON.stringify(checked.checks, null, 2));
assert.equal(checked.checks.passed, true);
assert.equal(
  checked.judge_eligible,
  false,
  "Intentionally unexplained fixture must not dispatch judges",
);
const report = {
  run: path.relative(root, run),
  manifest_sha256: hash(await fs.readFile(path.join(run, "annotated-diff.manifest.json"))),
  base,
  head,
  checks: checked.checks,
  views: checked.views.map((v) => ({
    id: v.id,
    explained: v.items.filter((i) => i.status === "explained").length,
    unexplained: v.unexplained_count,
    unverified: v.unverified_claims,
  })),
  invented_value_rejected: true,
  incomplete_compound_rejected: true,
};
await fs.writeFile(path.join(run, "qualification.json"), JSON.stringify(report, null, 2));
console.log(`QUALIFICATION ${path.relative(root, run)}`);
