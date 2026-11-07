import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
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
let readAsset = fs.readFile;
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/font.woff2") {
      res.setHeader("Content-Type", "font/woff2");
      res.end(
        await readAsset(
          path.join(root, "node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2"),
        ),
      );
    } else if (req.url === "/alternate.woff2") {
      res.setHeader("Content-Type", "font/woff2");
      res.end(await readAsset(path.join(root, "public/fonts/display-latin-500.woff2")));
    } else if (req.url === "/favicon.ico") {
      res.writeHead(204);
      res.end();
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(content);
    }
  } catch (e) {
    console.error("Fixture asset read failed", e);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Fixture asset unavailable");
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
      fontFamilies: { Rajdhani: ["Rajdhani Medium"] },
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
  const loadAsset = readAsset;
  const failureMessage = "Fixture asset read failure sentinel";
  try {
    readAsset = async () => {
      throw new Error(failureMessage);
    };
    const response = await fetch(`${url}/font.woff2`);
    assert.equal(response.status, 500);
    assert.equal(await response.text(), "Fixture asset unavailable");
  } finally {
    readAsset = loadAsset;
  }
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

// Exercise capture paths that the deliberately compact known-answer page cannot cover.
const page = (moved = false, fallback = false, comment = "") => `<!doctype html>
<html data-capture-seed="known-answer"><head><title>Capture paths</title><style>
@font-face { font-family: Inter; src: url('/font.woff2'); }
@font-face { font-family: Rajdhani; src: url('/alternate.woff2'); }
body { margin: 0; min-height: ${moved ? 1950 : 1900}px; background: white; color: black; font: 16px Inter; }
h1 { position: absolute; top: 20px; left: 40px; }
#anchor { position: absolute; top: 1000px; left: 0; width: 1px; height: 1px; }
[data-testid="moving"] { position: absolute; top: 1100px; left: 40px; width: 70px; height: 40px; background: black;
margin-top: ${moved ? 40 : 0}px;
}
[data-testid="type"] { position: absolute; top: 1050px; left: 180px; font-family: ${fallback ? "Missing, Inter" : "Rajdhani"}; }
#volatile { position: absolute; top: 1250px; left: 40px; width: 80px; height: 30px; background: red; }
</style></head><body><h1>Capture paths</h1><div id="anchor"></div><div data-testid="moving" aria-label="Swatch"></div><div data-testid="type">Typography</div><div id="volatile">Masked</div><!-- ${comment} --></body></html>`;
const audits = [];
await new Promise((resolve) => server.listen(new URL(url).port, "127.0.0.1", resolve));
try {
  for (const mode of ["full-page", "viewport", "fallback", "candidate-flake", "zero"]) {
    const started = performance.now();
    console.log("CAPTURE_PATH_STAGE", mode, "capture");
    const dir = path.join(run, mode);
    const frozen = {
      ...spec,
      fullPage: mode === "full-page",
      blind: mode === "full-page" || mode === "zero",
      views: spec.views.map((v) => ({
        ...v,
        masks: [{ selector: "#volatile", reason: "Fixture mask" }],
      })),
    };
    const a = page(false, false, `${mode} base`);
    const b =
      mode === "zero"
        ? page(false, false, `${mode} head`)
        : page(true, mode === "fallback") +
          (mode === "candidate-flake"
            ? `<script>const n = +(localStorage.getItem('probe') || 0); localStorage.setItem('probe', n + 1); document.querySelector('[data-testid="moving"]').style.backgroundColor = n ? 'red' : 'black';</script>`
            : "");
    content = a;
    const base = await commit(a);
    await capture({
      spec: frozen,
      sourceRoot: source,
      sha: base,
      url,
      out: path.join(dir, "base"),
    });
    content = b;
    const head = await commit(b);
    await capture({
      spec: frozen,
      sourceRoot: source,
      sha: head,
      url,
      out: path.join(dir, "head"),
    });
    const intent =
      mode === "zero"
        ? []
        : [
            {
              id: "moving",
              claim: "Change margin",
              selector: '[data-testid="moving"]',
              change: "style",
              deltas: [
                {
                  prop: "margin-top",
                  file: "index.html",
                  line: b.split("\n").findIndex((s) => s.startsWith("margin-top:")) + 1,
                },
              ],
            },
          ];
    console.log("CAPTURE_PATH_STAGE", mode, "compare");
    let manifest;
    if (["fallback", "candidate-flake"].includes(mode)) {
      await assert.rejects(() => compare({ dir, root: source, intent }), /capture_invalid/);
      manifest = JSON.parse(await fs.readFile(path.join(dir, "annotated-diff.manifest.json")));
    } else manifest = await compare({ dir, root: source, intent });
    for (const v of frozen.views) {
      const a = JSON.parse(await fs.readFile(path.join(dir, "base", `${v.id}.json`)));
      const b = JSON.parse(await fs.readFile(path.join(dir, "head", `${v.id}.json`)));
      assert(a.scrollY > 0 && a.scrollY === b.scrollY);
      assert.equal(a.coordinate_space, frozen.fullPage ? "document" : "viewport");
      const old = a.elements.find((e) => e.testid === "moving");
      const next = b.elements.find((e) => e.testid === "moving");
      assert.equal(old.rect.y, 1100 - (frozen.fullPage ? 0 : a.scrollY));
      assert.equal(next.rect.y - old.rect.y, mode === "zero" ? 0 : 40);
      assert.equal(a.mask_rects[0].y, 1250 - (frozen.fullPage ? 0 : a.scrollY));
      const image = PNG.sync.read(await fs.readFile(path.join(dir, "base", `${v.id}.png`)));
      const point = (Math.round((a.mask_rects[0].y + 10) * v.dpr) * image.width + 50 * v.dpr) * 4;
      assert.deepEqual([...image.data.subarray(point, point + 4)], [0, 0, 0, 255]);
      assert(a.font_evidence.some((f) => f.family === "Rajdhani" && f.verified));
      if (mode === "fallback") {
        assert.equal(b.fonts_loaded, false);
        assert(b.font_evidence.some((f) => f.family === "Missing" && !f.verified));
      } else assert.equal(b.fonts_loaded, true);
      if (frozen.fullPage) {
        assert.equal(image.height, 1900 * v.dpr);
        const headImage = PNG.sync.read(await fs.readFile(path.join(dir, "head", `${v.id}.png`)));
        assert.equal(headImage.height, 1950 * v.dpr);
        const pixel = (1120 * image.width * v.dpr + 60 * v.dpr) * 4;
        assert.equal(
          image.data[pixel],
          0,
          "Document-space rect must agree with captured source pixel",
        );
      }
    }
    if (["fallback", "candidate-flake"].includes(mode)) {
      assert.equal(manifest.status, "capture_invalid");
      assert.equal(manifest.views.length, 0);
      assert(
        manifest.flake_probe.every((g) =>
          g.reasons.includes(mode === "fallback" ? "page_state" : "candidate_flake"),
        ),
      );
      if (mode === "candidate-flake")
        assert(
          manifest.flake_probe.every(
            (g) => g.base_probe.status === "valid" && g.candidate_probe.flake_regions > 0,
          ),
        );
      await assert.rejects(() => render({ dir, author: "fixture:deterministic" }));
      audits.push({ mode, rejected: true });
      console.log("CAPTURE_PATH_STAGE", mode, "complete", Math.round(performance.now() - started));
      continue;
    }
    for (const v of manifest.views) {
      assert.equal(v.unexplained_count, 0);
      assert.equal(v.unverified_claims, 0);
      if (mode === "zero") {
        assert.equal(v.items.length, 0);
        assert.equal(v.regions.length, 0);
      } else {
        assert.equal(v.items.length, 1);
        assert(v.items[0].regions.every((r) => r.after.y - r.before.y === 40));
      }
    }
    await fs.writeFile(
      path.join(dir, "labels.todo.json"),
      JSON.stringify(
        manifest.views.flatMap((v) =>
          v.items.map((i) => ({ id: i.id, label: "Margin changed", rationale: "" })),
        ),
      ),
    );
    console.log("CAPTURE_PATH_STAGE", mode, "render");
    await render({ dir, author: "fixture:deterministic" });
    console.log("CAPTURE_PATH_STAGE", mode, "check");
    const checked = await check({ dir });
    assert.equal(checked.checks.passed, true, JSON.stringify(checked.checks));
    for (const v of checked.views) {
      assert.equal(v.geometry.label_fonts.length, 2);
      assert(v.geometry.label_fonts.every((f) => f.family === "Inter" && f.status === "loaded"));
      if (frozen.blind) {
        assert(v.images.some((i) => i.file === `${v.id}.A.png`));
        assert(v.images.some((i) => i.file === `${v.id}.B.png`));
        assert(!v.images.some((i) => /\.(before|after)\.png$/.test(i.file)));
        const judge = await fs.readFile(path.join(dir, `${v.id}.judge.md`), "utf8");
        assert(!judge.includes(base.slice(0, 7)) && !judge.includes(head.slice(0, 7)));
        assert(!/margin-top: 0px/.test(judge) || checked.blind_mapping.A === "base");
        const sourceHalf = checked.blind_mapping.A;
        assert.equal(
          hash(await fs.readFile(path.join(dir, `${v.id}.A.png`))),
          hash(await fs.readFile(path.join(dir, sourceHalf, `${v.id}.png`))),
        );
      }
      if (mode === "zero") assert.equal(v.geometry.marks.length, 0);
    }
    if (mode === "zero") {
      const manifestPath = path.join(dir, "annotated-diff.manifest.json");
      const probePath = path.join(dir, "head", `${frozen.views[0].id}.probe.json`);
      const originalProbe = await fs.readFile(probePath),
        originalManifest = await fs.readFile(manifestPath);
      try {
        const probe = JSON.parse(originalProbe);
        probe.console.push({ type: "error", text: "Planted candidate probe failure" });
        await fs.writeFile(probePath, JSON.stringify(probe));
        assert.equal(
          (await check({ dir })).checks.capture,
          false,
          "Candidate probe bytes must be hash-bound",
        );
        const refreshed = JSON.parse(await fs.readFile(manifestPath));
        refreshed.capture_inputs.find(
          (i) => i.file === `head/${frozen.views[0].id}.probe.json`,
        ).sha256 = hash(await fs.readFile(probePath));
        await fs.writeFile(manifestPath, JSON.stringify(refreshed));
        assert.equal(
          (await check({ dir })).checks.capture,
          false,
          "Check must independently revalidate candidate probe state, not only its hash",
        );
      } finally {
        await fs.writeFile(probePath, originalProbe);
        await fs.writeFile(manifestPath, originalManifest);
      }
      assert.equal((await check({ dir })).checks.passed, true);
      audits.push({
        mode: "candidate-probe-check",
        hash_bound: true,
        independently_reconciled: true,
        restored: true,
      });
    }
    audits.push({
      mode,
      checks: checked.checks,
      manifest_sha256: hash(await fs.readFile(path.join(dir, "annotated-diff.manifest.json"))),
    });
    console.log("CAPTURE_PATH_STAGE", mode, "complete", Math.round(performance.now() - started));
  }
} finally {
  await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}
await fs.writeFile(path.join(run, "capture-path-audit.json"), JSON.stringify(audits, null, 2));
console.log("CAPTURE_PATH_AUDIT", JSON.stringify(audits));
