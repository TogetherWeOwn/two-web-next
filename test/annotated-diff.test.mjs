import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterAll, describe, expect, it } from "vitest";
import {
  THRESHOLDS,
  attribute,
  contrast,
  diffHunks,
  digest,
  geometry,
  geometryCheck,
  normalizeIntent,
  palette,
  parity,
  regions,
  segmentsCross,
  segmentHitsRect,
  splitView,
  validateLabels,
} from "../scripts/annotated-diff/run.mjs";

const png = (width, height, fill = [255, 255, 255], paint = () => null) => {
  const p = new PNG({ width, height });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const c = paint(x, y) || fill;
      const i = (y * width + x) * 4;
      p.data[i] = c[0];
      p.data[i + 1] = c[1];
      p.data[i + 2] = c[2];
      p.data[i + 3] = 255;
    }
  return p;
};
const square = (x0, y0, size) => (x, y) =>
  x >= x0 && x < x0 + size && y >= y0 && y < y0 + size ? [0, 0, 0] : null;

describe("normalizeIntent", () => {
  const compound = {
    id: "card-pad",
    claim: "Card padding grows",
    selector: "#card",
    change: "style",
    deltas: [{ prop: "padding-top", file: "src/a.css", line: 4 }],
  };
  const legacy = {
    id: "card-pad",
    claim: "Card padding grows",
    selector: "#card",
    prop: "padding-top",
    file: "src/a.css",
    line: 4,
  };

  it("accepts canonical compound style, added, removed and text claims", () => {
    expect(normalizeIntent([compound])).toEqual([compound]);
    for (const change of ["added", "removed", "text"]) {
      const item = { id: change, claim: "c", selector: "#x", change, file: "src/a.css", line: 1 };
      expect(normalizeIntent([item])).toEqual([item]);
    }
  });

  it("converts a legacy single-prop claim to the compound form", () => {
    expect(normalizeIntent([legacy])).toEqual([compound]);
  });

  it("rejects malformed input", () => {
    expect(() => normalizeIntent({})).toThrow();
    expect(() =>
      normalizeIntent(Array.from({ length: 513 }, (_, i) => ({ ...compound, id: `i${i}` }))),
    ).toThrow();
    expect(() => normalizeIntent([{ ...compound, id: "Bad_Id" }])).toThrow();
    expect(() => normalizeIntent([{ ...compound, claim: 5 }])).toThrow();
    expect(() => normalizeIntent([{ ...compound, claim: "x".repeat(1001) }])).toThrow();
    expect(() => normalizeIntent([{ ...compound, extra: 1 }])).toThrow();
    expect(() => normalizeIntent([{ ...compound, selector: "" }])).toThrow();
    expect(() => normalizeIntent([{ ...legacy, extra: 1 }])).toThrow();
  });

  it("rejects duplicate ids", () => {
    expect(() => normalizeIntent([compound, { ...compound }])).toThrow();
  });

  it("rejects unknown change kinds and unknown style props", () => {
    expect(() => normalizeIntent([{ ...compound, change: "moved" }])).toThrow();
    expect(() => normalizeIntent([{ ...legacy, prop: "z-index" }])).toThrow();
    expect(() =>
      normalizeIntent([{ ...compound, deltas: [{ prop: "z-index", file: "a.css", line: 1 }] }]),
    ).toThrow();
  });

  it("rejects wildcard and list selectors", () => {
    expect(() => normalizeIntent([{ ...compound, selector: "*" }])).toThrow();
    expect(() => normalizeIntent([{ ...compound, selector: ".a, .b" }])).toThrow();
    expect(() => normalizeIntent([{ ...compound, selector: "div *" }])).toThrow();
  });

  it("rejects mixed legacy and compound shapes", () => {
    expect(() => normalizeIntent([{ ...legacy, change: "style" }])).toThrow();
    expect(() => normalizeIntent([{ ...legacy, deltas: compound.deltas }])).toThrow();
    expect(() => normalizeIntent([{ ...compound, prop: "padding-top" }])).toThrow();
    expect(() => normalizeIntent([{ ...compound, file: "a.css", line: 1 }])).toThrow();
  });

  it("validates every compound member", () => {
    const ok = { prop: "padding-top", file: "a.css", line: 1 };
    expect(() => normalizeIntent([{ ...compound, deltas: [] }])).toThrow();
    expect(() => normalizeIntent([{ ...compound, deltas: [ok, { ...ok }] }])).toThrow(); // duplicate prop
    expect(() =>
      normalizeIntent([{ ...compound, deltas: [ok, { ...ok, prop: "color", file: "/abs.css" }] }]),
    ).toThrow();
    expect(() =>
      normalizeIntent([{ ...compound, deltas: [ok, { ...ok, prop: "color", file: "../up.css" }] }]),
    ).toThrow();
    expect(() =>
      normalizeIntent([{ ...compound, deltas: [ok, { ...ok, prop: "color", line: 0 }] }]),
    ).toThrow();
    expect(() =>
      normalizeIntent([{ ...compound, deltas: [ok, { ...ok, prop: "color", line: 1.5 }] }]),
    ).toThrow();
    expect(() =>
      normalizeIntent([{ ...compound, deltas: [ok, { ...ok, prop: "color", extra: 1 }] }]),
    ).toThrow();
    expect(
      normalizeIntent([{ ...compound, deltas: [ok, { ...ok, prop: "color", line: 2 }] }])[0].deltas,
    ).toHaveLength(2);
  });
});

describe("validateLabels", () => {
  const items = [
    {
      id: "v#1",
      element: { name: "Card" },
      style_delta: [{ prop: "padding-top", old: "8px", new: "12px" }],
      token: null,
    },
    { id: "v#2", element: { name: "Badge" }, style_delta: [], token: null },
  ];
  const good = [
    { id: "v#1", label: "Padding changed", rationale: "Card padding changed from 8px to 12px" },
    { id: "v#2", label: "Unclaimed visual change", rationale: "No visible evidence" },
  ];
  const names = ["Card", "Badge", "Footer"];
  const withLabel = (patch) => [{ ...good[0], ...patch }, good[1]];

  it("accepts labels built from measured facts", () => {
    expect(validateLabels(items, good, names)).toBe(true);
  });

  it("rejects invented numbers in label and rationale", () => {
    expect(() => validateLabels(items, withLabel({ label: "Padding 99px" }), names)).toThrow(
      /Invented value/,
    );
    expect(() =>
      validateLabels(items, withLabel({ rationale: "Card padding changed to 99px" }), names),
    ).toThrow(/Invented value/);
  });

  it("rejects empty labels and numeric substrings of measured facts", () => {
    expect(() => validateLabels(items, withLabel({ label: "" }), names)).toThrow();
    expect(() => validateLabels(items, withLabel({ label: "Padding 2px" }), names)).toThrow(
      /Invented value/,
    );
  });

  it("rejects added, dropped and duplicate ids", () => {
    expect(() => validateLabels(items, [good[0]], names)).toThrow(/preserve every item/);
    expect(() => validateLabels(items, [...good, { ...good[0], id: "v#3" }], names)).toThrow();
    expect(() => validateLabels(items, [good[0], { ...good[0], id: "v#3" }], names)).toThrow(
      /Unknown or duplicate/,
    );
    expect(() => validateLabels(items, [good[0], { ...good[0] }], names)).toThrow(
      /Unknown or duplicate/,
    );
    expect(() => validateLabels(items, [good[0], { ...good[1], extra: 1 }], names)).toThrow();
  });

  it("enforces word limits (12 for label, 25 for rationale)", () => {
    const words = (n) => ["Change", ...Array(n - 1).fill("change")].join(" ");
    expect(validateLabels(items, withLabel({ label: words(12) }), names)).toBe(true);
    expect(() => validateLabels(items, withLabel({ label: words(13) }), names)).toThrow();
    expect(validateLabels(items, withLabel({ rationale: words(25) }), names)).toBe(true);
    expect(() => validateLabels(items, withLabel({ rationale: words(26) }), names)).toThrow();
  });

  it("rejects names of another element", () => {
    expect(() =>
      validateLabels(items, withLabel({ rationale: "Footer padding changed" }), names),
    ).toThrow(/another element/);
    expect(() =>
      validateLabels(items, withLabel({ label: "Badge padding changed" }), names),
    ).toThrow(/another element/);
  });

  it("rejects wording outside the vocabulary, lowercase starts and markup", () => {
    expect(() => validateLabels(items, withLabel({ label: "Gorgeous padding" }), names)).toThrow(
      /Unreconciled/,
    );
    expect(() => validateLabels(items, withLabel({ label: "padding changed" }), names)).toThrow(
      /sentence case/,
    );
    expect(() => validateLabels(items, withLabel({ label: "Padding <b>" }), names)).toThrow();
  });
});

describe("regions", () => {
  it("returns no regions for zero differing pixels", () => {
    const r = regions(png(40, 40), png(40, 40), 1);
    expect(r.regions).toEqual([]);
    expect(r.passes.map((p) => p.count)).toEqual([0, 0]);
    expect(r.passes.every((p) => !p.active)).toBe(true);
    expect(PNG.sync.read(r.mask).width).toBe(40);
    expect(PNG.sync.read(r.mask).data.every((value) => value === 255)).toBe(true);
  });

  it("freezes the pass thresholds", () => {
    expect(Object.isFrozen(THRESHOLDS)).toBe(true);
    expect(() => {
      THRESHOLDS.tolerant = 1;
    }).toThrow();
    expect(THRESHOLDS).toMatchObject({
      tolerant: 0.15,
      minimum: 20,
      sensitive: 0.0225,
      ratio: 0.03,
      dilation: 6,
      area: 12,
      merge: 12,
      padding: 4,
    });
    const r = regions(png(40, 40), png(40, 40), 1);
    expect(r.passes.map((p) => [p.threshold, p.floor])).toEqual([
      [0.15, 20],
      [0.0225, 40 * 40 * 0.03],
    ]);
  });

  it("ignores a difference below the pixel floor", () => {
    const r = regions(png(40, 40), png(40, 40, [255, 255, 255], square(10, 10, 3)), 1);
    expect(r.passes[0]).toMatchObject({ count: 9, active: false });
    expect(r.regions).toEqual([]);
  });

  it("boxes a real difference inside the image bounds", () => {
    const r = regions(png(40, 40), png(40, 40, [255, 255, 255], square(15, 15, 10)), 1);
    expect(r.passes[0]).toMatchObject({ count: 100, active: true });
    const mask = PNG.sync.read(r.mask);
    expect(
      Array.from({ length: 40 * 40 }, (_, i) => mask.data[i * 4]).filter((v) => v === 0),
    ).toHaveLength(100);
    expect(
      Array.from({ length: 40 * 40 }, (_, i) => mask.data[i * 4 + 3]).every((v) => v === 255),
    ).toBe(true);
    expect(r.regions).toHaveLength(1);
    const { x, y, w, h } = r.regions[0].bbox_css;
    expect(r.regions[0].id).toBe("r1");
    expect(x).toBeLessThanOrEqual(15);
    expect(y).toBeLessThanOrEqual(15);
    expect(x + w).toBeGreaterThanOrEqual(25);
    expect(y + h).toBeGreaterThanOrEqual(25);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x + w).toBeLessThanOrEqual(40);
    expect(y + h).toBeLessThanOrEqual(40);
  });

  it("rejects mismatched widths and, unless full page, heights", () => {
    expect(() => regions(png(40, 40), png(41, 40), 1)).toThrow();
    expect(() => regions(png(40, 40), png(40, 50), 1)).toThrow();
    expect(() => regions(png(40, 40), png(40, 50), 1, true)).not.toThrow();
  });
});

describe("parity", () => {
  const spec = { seed: "seed-1", fullPage: false };
  const meta = (patch = {}) => ({
    spec_hash: digest(spec),
    sha: "a",
    fonts_loaded: true,
    text: "Welcome home",
    console: [],
    seed: "seed-1",
    scrollY: 0,
    view: { dpr: 1 },
    ...patch,
  });
  const imgs = () => [png(20, 20), png(20, 20), png(20, 20)];
  const run = (a, b, probe, images = imgs()) => parity(spec, a, b, probe, images);

  it("is valid for identical, well-formed captures", () => {
    expect(run(meta(), meta({ sha: "b" }), meta())).toEqual({
      status: "valid",
      reasons: [],
      flake_regions: 0,
    });
  });

  it("flags unequal spec hashes", () => {
    expect(run(meta(), meta({ sha: "b", spec_hash: "other" }), meta()).reasons).toContain(
      "spec_hash",
    );
    expect(run(meta(), meta({ sha: "b" }), meta({ spec_hash: "other" })).reasons).toContain(
      "spec_hash",
    );
  });

  it("flags identical shas", () => {
    expect(run(meta(), meta(), meta()).reasons).toContain("same_sha");
  });

  it("flags scroll mismatches", () => {
    const r = run(meta(), meta({ sha: "b", scrollY: 40 }), meta());
    expect(r.status).toBe("capture_invalid");
    expect(r.reasons).toContain("scroll");
  });

  it("flags error pages, console errors, missing fonts and wrong seed as page_state", () => {
    const b = { sha: "b" };
    for (const bad of [
      { text: "404 Not Found" },
      { text: "  " },
      { text: "Loading..." },
      { console: [{ type: "error", text: "x" }] },
      { fonts_loaded: false },
      { seed: "other" },
    ]) {
      expect(run(meta(), meta({ ...b, ...bad }), meta()).reasons, JSON.stringify(bad)).toContain(
        "page_state",
      );
    }
    expect(
      run(meta(), meta({ ...b, console: [{ type: "warning", text: "x" }] }), meta()).reasons,
    ).not.toContain("page_state");
  });

  it("flags image size mismatches and skips the flake comparison", () => {
    const r = run(meta(), meta({ sha: "b" }), meta(), [png(20, 20), png(20, 30), png(20, 20)]);
    expect(r.reasons).toContain("image_size");
    expect(r.flake_regions).toBeNull();
  });

  it("flags a flaky probe", () => {
    const r = run(meta(), meta({ sha: "b" }), meta(), [
      png(40, 40),
      png(40, 40),
      png(40, 40, [255, 255, 255], square(10, 10, 12)),
    ]);
    expect(r.reasons).toContain("flake");
    expect(r.flake_regions).toBeGreaterThan(0);
  });
});

describe("diffHunks and attribution of code references", () => {
  const dirs = [];
  afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const git = (root, ...args) =>
    execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", ...args], {
      encoding: "utf8",
      env,
    }).trim();
  const fixture = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "annotated-diff-"));
    dirs.push(root);
    git(root, "init", "-q");
    fs.writeFileSync(path.join(root, "a.css"), "one\ntwo\nthree\nfour\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "base");
    const base = git(root, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(root, "a.css"), "one\nTWO\nthree\nfour\nfive\n");
    fs.writeFileSync(path.join(root, "b.css"), "new\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "head");
    return { root, base, head: git(root, "rev-parse", "HEAD") };
  };

  it("maps changed lines per file from a real git diff", () => {
    const { root, base, head } = fixture();
    const hunks = diffHunks(root, base, head);
    expect(hunks.get("a.css")).toEqual([
      [2, 3],
      [5, 6],
    ]);
    expect(hunks.get("b.css")).toEqual([[1, 2]]);
    expect(hunks.has("c.css")).toBe(false);
  });

  it("rejects non-sha revisions", () => {
    const { root } = fixture();
    expect(() => diffHunks(root, "HEAD", "HEAD~1")).toThrow();
  });

  const el = (padding) => ({
    key: "testid:card",
    selector: "#card",
    testid: "card",
    tag: "div",
    depth: 2,
    role: null,
    name: "Card",
    text: "Hi",
    rect: { x: 0, y: 0, w: 100, h: 40 },
    style: { "padding-top": padding },
  });
  const view = { id: "v", width: 390, height: 844 };
  const claim = (line) =>
    normalizeIntent([
      { id: "pad", claim: "c", selector: "#card", prop: "padding-top", file: "a.css", line },
    ]);

  it("verifies a claim whose line is inside a hunk", () => {
    const { root, base, head } = fixture();
    const { items } = attribute(
      [el("8px")],
      [el("12px")],
      [],
      claim(2),
      diffHunks(root, base, head),
      head,
      view,
    );
    expect(items).toHaveLength(1);
    expect(items[0].code_ref).toEqual({
      file: "a.css",
      line: 2,
      commit: head,
      in_diff: true,
      source: "intent_verified",
    });
    expect(items[0].verification).toEqual({ measured: true, valid: true });
    expect(items[0].style_delta).toEqual([{ prop: "padding-top", old: "8px", new: "12px" }]);
  });

  it("leaves a claim unresolved when its line is outside the diff", () => {
    const { root, base, head } = fixture();
    const { items } = attribute(
      [el("8px")],
      [el("12px")],
      [],
      claim(3),
      diffHunks(root, base, head),
      head,
      view,
    );
    expect(items[0].code_ref).toBe("unresolved");
    expect(items[0].code_refs[0].code_ref).toBe("unresolved");
    expect(items[0].verification.valid).toBe(false);
    expect(items[0].status).toBe("unverified_claim");
  });

  it("leaves a claim unresolved when the file is not in the diff", () => {
    const { root, base, head } = fixture();
    const c = normalizeIntent([
      { id: "pad", claim: "c", selector: "#card", prop: "padding-top", file: "zzz.css", line: 1 },
    ]);
    const { items } = attribute(
      [el("8px")],
      [el("12px")],
      [],
      c,
      diffHunks(root, base, head),
      head,
      view,
    );
    expect(items[0].code_ref).toBe("unresolved");
  });

  it("does not measure a claim for a property that did not change", () => {
    const { root, base, head } = fixture();
    const { items } = attribute(
      [el("8px")],
      [el("8px")],
      [],
      claim(2),
      diffHunks(root, base, head),
      head,
      view,
    );
    expect(items[0].verification.measured).toBe(false);
  });
});

describe("density splitting", () => {
  const make = (dense = false) => ({
    id: "view",
    theme: "light",
    width: 390,
    height: 844,
    items: Array.from({ length: 12 }, (_, n) => {
      const bbox_css = { x: 60, y: dense ? 60 : n * 60 + 10, w: 30, h: 20 };
      return {
        id: `view#${n + 1}`,
        n: n + 1,
        status: n === 0 ? "unexplained" : "explained",
        scope: "local",
        shifts: [],
        regions: [{ id: `r${n}`, bbox_css, half: "both", before: bbox_css, after: bbox_css }],
      };
    }),
  });
  it("splits dense inventories into lossless bounded spatial crops", () => {
    const original = make(),
      parts = splitView(original);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.items.length <= 8)).toBe(true);
    expect(parts.flatMap((p) => p.items.map((i) => i.origin_item_id)).sort()).toEqual(
      original.items.map((i) => i.id).sort(),
    );
    expect(parts.flatMap((p) => p.regions.map((r) => r.id)).sort()).toEqual(
      original.items.flatMap((i) => i.regions.map((r) => r.id)).sort(),
    );
    expect(
      parts.every(
        (p) => p.layout === "side-by-side" && geometryCheck({ ...p, geometry: geometry(p) }),
      ),
    ).toBe(true);
  });
  it("fails closed when spatial splitting cannot separate more than eight causes", () => {
    expect(() => splitView(make(true))).toThrow(/too_many_regions/);
  });
});

describe("geometry and geometryCheck", () => {
  const box = { x: 100, y: 100, w: 50, h: 40 };
  const makeView = (extra = {}) => {
    const v = {
      id: "v",
      width: 390,
      height: 844,
      regions: [
        { id: "r1", bbox_css: box },
        { id: "r2", bbox_css: { x: 220, y: 300, w: 50, h: 40 } },
      ],
      items: [],
      ...extra,
    };
    const region = (r) => ({ ...r, half: "both", before: r.bbox_css, after: r.bbox_css });
    v.items = [
      {
        id: "v#1",
        n: 1,
        status: "explained",
        scope: "local",
        regions: [region(v.regions[0])],
        style_delta: [],
      },
      {
        id: "v#2",
        n: 2,
        status: "unexplained",
        scope: "local",
        regions: [region(v.regions[1])],
        style_delta: [],
      },
      { id: "v#3", n: 3, status: "unverified_claim", scope: "local", regions: [], style_delta: [] },
    ];
    v.geometry = geometry(v);
    return v;
  };

  it("lays out mobile side by side and desktop stacked", () => {
    const m = geometry(makeView());
    expect(m.width).toBe((390 + 112) * 2);
    expect(m.halves.after.y).toBe(m.halves.before.y);
    const d = geometry(makeView({ width: 1280, height: 832 }));
    expect(d.halves.after.y).toBe(d.header + 832 + d.gap);
  });

  it("marks both halves of every region and no unverified claim", () => {
    const v = makeView();
    expect(v.geometry.marks).toHaveLength(4);
    expect(v.geometry.marks.some((m) => m.item_id === "v#3")).toBe(false);
    expect(geometryCheck(v)).toBe(true);
  });

  it("fails when a half of a region has no mark", () => {
    const v = makeView();
    v.geometry.marks = v.geometry.marks.filter((m) => !(m.item_id === "v#1" && m.half === "after"));
    expect(geometryCheck(v)).toBe(false);
  });

  it("fails without geometry", () => {
    const v = makeView();
    v.geometry = null;
    expect(geometryCheck(v)).toBe(false);
  });

  it("fails when leader lines cross", () => {
    const v = makeView();
    const [first, second] = v.geometry.marks.filter((m) => m.half === "before");
    first.line = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ];
    second.line = [
      { x: 0, y: 10 },
      { x: 10, y: 0 },
    ];
    expect(geometryCheck(v)).toBe(false);
  });

  it("fails when a badge overlaps a changed region or leaves the canvas", () => {
    const v = makeView();
    const m = v.geometry.marks[0];
    const o = v.geometry.halves[m.half];
    m.badge = { x: o.x + box.x + 10, y: o.y + box.y + 10 };
    expect(geometryCheck(v)).toBe(false);
    const w = makeView();
    w.geometry.marks[0].badge = { x: -40, y: 200 };
    expect(geometryCheck(w)).toBe(false);
  });

  it("rejects leaders crossing another changed region and plans mirrored halves together", () => {
    const v = makeView();
    for (const mark of v.geometry.marks) {
      const other = v.items.flatMap((i) => i.regions).filter((r) => r.id !== mark.region_id);
      const o = v.geometry.halves[mark.half];
      for (const r of other)
        expect(
          segmentHitsRect(mark.line, {
            ...r.bbox_css,
            x: o.x + r.bbox_css.x,
            y: o.y + r.bbox_css.y,
          }),
        ).toBe(false);
    }
    const [before, after] = v.geometry.marks.filter((m) => m.item_id === "v#1");
    expect(before.badge.x - v.geometry.halves.before.x).toBe(
      after.badge.x - v.geometry.halves.after.x,
    );
    expect(before.badge.y - v.geometry.halves.before.y).toBe(
      after.badge.y - v.geometry.halves.after.y,
    );
    before.line = [
      { x: 0, y: v.geometry.halves.before.y + 110 },
      { x: 390, y: v.geometry.halves.before.y + 110 },
    ];
    expect(geometryCheck(v)).toBe(false);
  });

  it("detects proper segment crossings only", () => {
    const P = (x, y) => ({ x, y });
    expect(segmentsCross([P(0, 0), P(10, 10)], [P(0, 10), P(10, 0)])).toBe(true);
    expect(segmentsCross([P(0, 0), P(10, 0)], [P(0, 5), P(10, 5)])).toBe(false);
    expect(segmentsCross([P(0, 0), P(5, 5)], [P(5, 5), P(10, 0)])).toBe(false);
  });
});

describe("palette and contrast", () => {
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

  it("computes WCAG contrast ratios", () => {
    expect(contrast([0, 0, 0], [1, 1, 1])).toBeCloseTo(21, 5);
    expect(contrast([1, 1, 1], [1, 1, 1])).toBeCloseTo(1, 5);
  });

  it("picks the first distinguishable badge fill with measured contrast", () => {
    const p = palette([png(8, 8), png(8, 8, [20, 20, 20])]);
    expect(p).toMatchObject({ fill: "#D55E00", ink: "#000000" });
    expect(p.contrast).toBeCloseTo(contrast(rgb("#D55E00"), [0, 0, 0]), 10);
    expect(p.contrast).toBeGreaterThanOrEqual(4.5);
    expect(p.dominant.length).toBeGreaterThan(0);
  });

  it("skips a fill that is already dominant in the screenshots", () => {
    const p = palette([png(8, 8, [213, 94, 0])]);
    expect(p.fill).toBe("#0072B2");
    expect(p.ink).toBe("#FFFFFF");
    expect(p.contrast).toBeGreaterThanOrEqual(4.5);
  });

  it("throws when every prescribed fill collides with a dominant colour", () => {
    // palette() samples every fourth pixel: columns 0, 4 and 8.
    const stripes = png(12, 1, [255, 255, 255], (x) =>
      x === 0 ? [213, 94, 0] : x === 4 ? [0, 114, 178] : x === 8 ? [204, 121, 167] : null,
    );
    expect(() => palette([stripes])).toThrow(/No prescribed badge palette/);
  });
});
