import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import {
  THRESHOLDS,
  attribute,
  check,
  markdownFiles,
  verifyMarkdown,
  verifyImages,
  hash,
  contrast,
  diffHunks,
  digest,
  geometry,
  geometryCheck,
  normalizeIntent,
  palette,
  parity,
  parityPair,
  regionTargets,
  reconcileInputs,
  render,
  regions,
  segmentsCross,
  segmentHitsRect,
  splitView,
  validateLabels,
  validateSpec,
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

describe("readiness lifecycle", () => {
  it("revokes readiness before CLI intent loading without losing prohibited capture failures", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "annotated-intent-"));
    const file = path.join(dir, "annotated-diff.manifest.json");
    const intent = path.join(dir, "intent.json");
    try {
      for (const mode of ["missing", "malformed"]) {
        if (mode === "malformed") fs.writeFileSync(intent, "{");
        for (const status of ["gallery_ready", "capture_invalid", "too_many_regions"]) {
          const prior = {
            status,
            reasons: ["Original failure"],
            checks: { passed: true },
            judge_eligible: true,
          };
          fs.writeFileSync(file, JSON.stringify(prior));
          const result = spawnSync(
            process.execPath,
            ["scripts/annotated-diff/run.mjs", "diff", "--dir", dir, "--intent", intent],
            { encoding: "utf8", timeout: 10_000 },
          );
          expect(result.status).toBe(1);
          expect(result.stderr).toMatch(mode === "missing" ? /ENOENT/ : /JSON|property/);
          expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
            ...prior,
            status: status === "gallery_ready" ? "diffing" : status,
            checks: { passed: false },
            judge_eligible: false,
          });
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects changed presentation before expensive capture reconciliation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "annotated-presentation-"));
    const manifest = {
      blind_mapping: { A: "base", B: "head" },
      views: [{ id: "fixture", route: "/", items: [] }],
    };
    try {
      fs.writeFileSync(
        path.join(dir, "comparison.json"),
        JSON.stringify({
          blind_mapping: manifest.blind_mapping,
          presentation: [{ id: "fixture", route: "/" }],
        }),
      );
      for (const patch of [
        { blind_mapping: { A: "head", B: "base" } },
        { views: [{ id: "fixture", route: "/changed", items: [] }] },
      ]) {
        await expect(reconcileInputs(dir, { ...manifest, ...patch }, [])).resolves.toEqual({
          captureValid: false,
          ownershipValid: false,
        });
      }
      // Matching receipts must still read the independent capture inputs.
      await expect(reconcileInputs(dir, manifest, [])).rejects.toThrow(/ENOENT/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("revokes readiness before missing or malformed labels and invalid status can fail", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "annotated-readiness-"));
    const file = path.join(dir, "annotated-diff.manifest.json");
    try {
      for (const mode of ["missing", "malformed", "invalid-status"]) {
        fs.writeFileSync(
          file,
          JSON.stringify({
            status: mode === "invalid-status" ? "invalid" : "gallery_ready",
            checks: { passed: true },
            judge_eligible: true,
          }),
        );
        if (mode !== "missing") fs.writeFileSync(path.join(dir, "labels.todo.json"), "{");
        await expect(check({ dir })).rejects.toThrow();
        expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
          status: mode === "invalid-status" ? "invalid" : "checking",
          checks: { passed: false },
          judge_eligible: false,
        });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("preserves prohibited capture statuses across rejected check and render admission", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "annotated-admission-"));
    const file = path.join(dir, "annotated-diff.manifest.json");
    try {
      for (const status of ["capture_invalid", "too_many_regions"]) {
        const manifest = {
          status,
          reasons: ["Original capture failure"],
          checks: { passed: true },
          judge_eligible: true,
        };
        fs.writeFileSync(file, JSON.stringify(manifest));
        await expect(check({ dir })).rejects.toMatchObject({ code: "ERR_ASSERTION" });
        const rejected = JSON.parse(fs.readFileSync(file, "utf8"));
        expect(rejected).toEqual({
          ...manifest,
          checks: { passed: false },
          judge_eligible: false,
        });
        await expect(render({ dir, author: "fixture:deterministic" })).rejects.toMatchObject({
          code: "ERR_ASSERTION",
        });
        expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(rejected);
        expect(fs.readdirSync(dir)).toEqual(["annotated-diff.manifest.json"]);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("delivered image inventory integrity", () => {
  it("requires clean pairs and both exported halves with capture-derived bytes and metadata", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "annotated-companions-"));
    const record = (file, buffer) => {
      const image = PNG.sync.read(buffer);
      return {
        file,
        sha256: hash(buffer),
        bytes: buffer.length,
        width: image.width,
        height: image.height,
      };
    };
    try {
      for (const half of ["base", "head"]) fs.mkdirSync(path.join(dir, half));
      const source = [
        PNG.sync.write(png(8, 8, [255, 0, 0])),
        PNG.sync.write(png(8, 8, [0, 0, 255])),
      ];
      source.forEach((buffer, n) =>
        fs.writeFileSync(path.join(dir, n ? "head" : "base", "source.png"), buffer),
      );
      for (const blind of [false, true]) {
        for (const layout of ["stacked", "side-by-side"]) {
          const view = {
            id: "v",
            source_id: "source",
            width: 4,
            height: 4,
            dpr: 2,
            crop: { x: 0, y: 0, w: 4, h: 4 },
            layout,
            blind,
            blind_reverse: blind,
            mask: "v.mask.png",
            images: [],
          };
          const full = {
            buffer: PNG.sync.write(png(4, 4)),
            insets: [{ buffer: PNG.sync.write(png(3, 3)) }],
          };
          const judge = { buffer: full.buffer };
          const ordered = blind ? [...source].reverse() : source;
          const resized = await Promise.all(
            ordered.map((b) => sharp(b).resize({ width: 4 }).png().toBuffer()),
          );
          const clean = await sharp({
            create: {
              width: layout === "stacked" ? 4 : 8,
              height: layout === "stacked" ? 8 : 4,
              channels: 4,
              background: "white",
            },
          })
            .composite(
              resized.map((input, n) => ({
                input,
                left: layout === "stacked" ? 0 : n * 4,
                top: layout === "stacked" ? n * 4 : 0,
              })),
            )
            .png()
            .toBuffer();
          const files = [
            ["v.annotated.png", full.buffer],
            ["v.judge.png", judge.buffer],
            ["v.clean.png", clean],
            ["v.mask.png", full.buffer],
            ["v.inset-1.png", full.insets[0].buffer],
            ...(await Promise.all(
              ordered.map(async (buffer, n) => [
                `v.${blind ? ["A", "B"][n] : ["before", "after"][n]}.png`,
                await sharp(buffer)
                  .extract({ left: 0, top: 0, width: 8, height: 8 })
                  .png()
                  .toBuffer(),
              ]),
            )),
          ];
          for (const [file, buffer] of files) fs.writeFileSync(path.join(dir, file), buffer);
          view.images = files.map(([file, buffer]) => record(file, buffer));
          expect(await verifyImages(dir, view, full, judge)).toBe(true);
          const inventory = [...view.images];
          for (const [file, buffer] of files.filter(([file]) =>
            /\.(clean|before|after|A|B)\.png$/.test(file),
          )) {
            view.images = inventory.filter((i) => i.file !== file);
            expect(await verifyImages(dir, view, full, judge)).toBe(false);
            view.images = [...inventory];
            fs.unlinkSync(path.join(dir, file));
            await expect(verifyImages(dir, view, full, judge)).rejects.toThrow(/ENOENT/);
            const replacement = PNG.sync.write(
              png(PNG.sync.read(buffer).width, PNG.sync.read(buffer).height),
            );
            fs.writeFileSync(path.join(dir, file), replacement);
            view.images = inventory.map((i) => (i.file === file ? record(file, replacement) : i));
            expect(await verifyImages(dir, view, full, judge)).toBe(false);
            fs.writeFileSync(path.join(dir, file), buffer);
            view.images = [...inventory];
          }
          expect(await verifyImages(dir, view, full, judge)).toBe(true);
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("delivered Markdown integrity", () => {
  it("reconstructs facts-only, gallery and same-length PR content rather than trusting stored legends", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "annotated-markdown-"));
    const manifest = {
      capture_spec_hash: "spec",
      capture_spec: { runtime: { playwright: "pinned", os_image: "pinned" }, seed: "fixture" },
      views: [
        {
          id: "view",
          alt: "View: no changes",
          items: [],
          legend: "No surviving visual changes.",
          judge_legend: "No surviving visual changes.",
        },
      ],
    };
    const files = markdownFiles(manifest);
    try {
      for (const [file, text] of Object.entries(files))
        fs.writeFileSync(path.join(dir, file), text);
      expect(await verifyMarkdown(dir, manifest)).toBe(true);
      for (const [file, text] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, file), text.replace("No surviving", "No remaining"));
        expect(await verifyMarkdown(dir, manifest), file).toBe(false);
        fs.writeFileSync(path.join(dir, file), text);
      }
      manifest.views[0].judge_legend = "Author advocacy";
      expect(await verifyMarkdown(dir, manifest)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
      status: "explained",
      element: { name: "Card" },
      style_delta: [{ prop: "padding-top", old: "8px", new: "12px" }],
      token: null,
    },
    {
      id: "v#2",
      status: "unexplained",
      element: { name: "Badge" },
      style_delta: [],
      token: null,
    },
  ];
  const good = [
    { id: "v#1", label: "Padding changed", rationale: "Card padding changed from 8px to 12px" },
    { id: "v#2", label: "Unclaimed visual change", rationale: "Verify measured change" },
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

  it("rejects labels that contradict or ignore the measured facts", () => {
    // Assumption: the validator binds wording to the item's measured style_delta.
    for (const label of [
      "Opacity changed",
      "Padding unchanged",
      "Padding changed from 12px to 8px",
      "Border radius changed to 12px",
    ])
      expect(() => validateLabels(items, withLabel({ label }), names), label).toThrow();
    expect(
      validateLabels(
        items,
        withLabel({ label: "Padding changed", rationale: "Card padding changed from 8px to 12px" }),
        names,
      ),
    ).toBe(true);
  });

  it("rejects unclaimed or no-evidence wording on an explained item", () => {
    // Assumption: such phrases are only valid for unexplained items.
    expect(() =>
      validateLabels(items, withLabel({ label: "Unclaimed visual change" }), names),
    ).toThrow();
    expect(() =>
      validateLabels(items, withLabel({ rationale: "No visible evidence" }), names),
    ).toThrow();
  });

  it("rejects no-evidence wording on an unexplained item with observed regions", () => {
    const withSecond = (patch) => [good[0], { ...good[1], ...patch }];
    expect(() =>
      validateLabels(items, withSecond({ rationale: "No visible evidence" }), names),
    ).toThrow();
    expect(() =>
      validateLabels(items, withSecond({ label: "No visible evidence" }), names),
    ).toThrow();
  });

  it("requires no-visible-evidence wording even for a measured regionless style claim", () => {
    const item = { ...items[0], status: "unverified_claim" };
    for (const key of ["label", "rationale"])
      expect(() =>
        validateLabels(
          [item],
          [
            {
              id: item.id,
              label: "No visible evidence",
              rationale: "",
              [key]: "Padding changed from 8px to 12px",
            },
          ],
          names,
        ),
      ).toThrow(/Unreconciled wording/);
    expect(
      validateLabels(
        [item],
        [{ id: item.id, label: "No visible evidence", rationale: "Card no visible change" }],
        names,
      ),
    ).toBe(true);
  });

  it("limits an unverified item with no deltas to no-change wording", () => {
    const unverified = [
      { ...items[0] },
      {
        id: "v#2",
        status: "unverified_claim",
        element: { name: "Badge" },
        style_delta: [],
        token: null,
      },
    ];
    const second = (patch) => [
      good[0],
      { id: "v#2", label: "No visible change", rationale: "", ...patch },
    ];
    expect(validateLabels(unverified, second(), names)).toBe(true);
    expect(validateLabels(unverified, second({ rationale: "No visible evidence" }), names)).toBe(
      true,
    );
    expect(() =>
      validateLabels(unverified, second({ label: "Measured appearance change" }), names),
    ).toThrow();
  });

  it("accepts uncertainty templates despite ordinary-word element names but rejects actual references", () => {
    const item = { ...items[0], status: "unverified_claim", element: { name: "Control" } };
    for (const label of [
      "No visible change",
      "No visible evidence",
      "Control no visible change",
      "Control no visible evidence",
    ])
      expect(
        validateLabels(
          [item],
          [{ id: item.id, label, rationale: "No visible evidence" }],
          ["Visible", "Evidence", "Change", "Control"],
        ),
      ).toBe(true);
    for (const patch of [
      { label: "Visible no visible change" },
      { rationale: "Footer no visible evidence" },
      { label: "Control padding changed" },
    ])
      expect(() =>
        validateLabels(
          [item],
          [{ id: item.id, label: "No visible change", rationale: "", ...patch }],
          ["Visible", "Footer"],
        ),
      ).toThrow();
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

  it("preserves direct pixelmatch pass evidence and mask bytes on fast paths", () => {
    const white = png(40, 40);
    const cases = [
      [white, png(40, 40)],
      [white, png(40, 40, [255, 255, 255], square(10, 10, 3))],
      [white, png(40, 40, [255, 255, 255], square(15, 15, 10))],
      [white, png(40, 40, [245, 245, 245])],
      [white, png(40, 50)],
      [white, png(40, 50, [0, 0, 0])],
    ];
    for (const [a, b] of cases) {
      const width = a.width,
        height = Math.max(a.height, b.height),
        size = width * height;
      const aligned = [a, b].map((image) => {
        const data = Buffer.alloc(size * 4, 255);
        image.data.copy(data);
        return data;
      });
      const expectedMask = new PNG({ width, height });
      expectedMask.data.fill(255);
      const expectedPasses = [
        [THRESHOLDS.tolerant, THRESHOLDS.minimum],
        [THRESHOLDS.sensitive, size * THRESHOLDS.ratio],
      ].map(([threshold, floor]) => {
        const diff = new Uint8Array(size * 4);
        const count = pixelmatch(...aligned, diff, width, height, {
          threshold,
          includeAA: false,
          diffMask: true,
        });
        if (count >= floor)
          for (let i = 0; i < size; i++)
            if (diff[i * 4 + 3]) {
              expectedMask.data.fill(0, i * 4, i * 4 + 3);
            }
        return { threshold, count, floor, active: count >= floor };
      });
      const actual = regions(a, b, 1, true);
      expect(actual.passes).toEqual(expectedPasses);
      expect(actual.mask.equals(PNG.sync.write(expectedMask))).toBe(true);
      if (expectedPasses.every((p) => !p.active)) expect(actual.regions).toEqual([]);
      else expect(actual.regions.length).toBeGreaterThan(0);
    }
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
    scrollX: 0,
    coordinate_space: "viewport",
    font_evidence: [{ verified: true }],
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

  it("flags horizontal scroll mismatches", () => {
    expect(run(meta(), meta({ sha: "b", scrollX: 10 }), meta()).reasons).toContain("scroll");
  });

  it("requires verified font evidence and the matching coordinate space", () => {
    for (const bad of [
      { font_evidence: [] },
      { font_evidence: undefined },
      { font_evidence: [{ verified: true }, { verified: false }] },
      { coordinate_space: "document" },
    ]) {
      expect(
        run(meta(), meta({ sha: "b", ...bad }), meta()).reasons,
        JSON.stringify(bad),
      ).toContain("page_state");
    }
  });

  it("allows an unequal head height for fullPage but not an unequal base probe", () => {
    const full = { seed: "seed-1", fullPage: true };
    const m = (patch = {}) =>
      meta({ spec_hash: digest(full), coordinate_space: "document", ...patch });
    const go = (images) => parity(full, m(), m({ sha: "b" }), m(), images);
    const grown = go([png(20, 20), png(20, 30), png(20, 20)]);
    expect(grown.reasons).not.toContain("image_size");
    expect(grown.status).toBe("valid");
    const probe = go([png(20, 20), png(20, 20), png(20, 30)]);
    expect(probe.reasons).toContain("image_size");
    expect(probe.flake_regions).toBeNull();
    expect(
      parity({ ...full, fullPage: false }, m(), m({ sha: "b" }), m(), [
        png(20, 20),
        png(20, 20),
        png(20, 20),
      ]).reasons,
    ).toContain("page_state");
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

  it("does not attribute diff content or unsupported file headers to another file", () => {
    const { root } = fixture();
    const quoted = ["c\tname.css", 'd"name.css', "e\\name.css"];
    const original = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
    fs.writeFileSync(path.join(root, "a.css"), original);
    for (const file of [...quoted, "z-deleted.css"])
      fs.writeFileSync(path.join(root, file), original);
    git(root, "add", ".");
    git(root, "commit", "-qm", "header controls");
    const base = git(root, "rev-parse", "HEAD");
    fs.writeFileSync(
      path.join(root, "a.css"),
      original.replace("one", "++ b/b.css").replace("eight", "EIGHT"),
    );
    for (const file of quoted)
      fs.writeFileSync(path.join(root, file), original.replace("eight", "EIGHT"));
    fs.unlinkSync(path.join(root, "z-deleted.css"));
    git(root, "add", ".");
    git(root, "commit", "-qm", "changed header controls");
    const head = git(root, "rev-parse", "HEAD");
    const hunks = diffHunks(root, base, head);
    expect([...hunks]).toEqual([
      [
        "a.css",
        [
          [1, 2],
          [8, 9],
        ],
      ],
    ]);
    for (const file of ["a.css", "b.css", ...quoted, "z-deleted.css"]) {
      const intent = normalizeIntent([
        { id: "pad", claim: "c", selector: "#card", prop: "padding-top", file, line: 8 },
      ]);
      const { items } = attribute([el("8px")], [el("12px")], [], intent, hunks, head, view);
      if (file === "a.css") {
        expect(items[0].code_ref).toMatchObject({ file, line: 8, in_diff: true });
        expect(items[0].verification.valid).toBe(true);
      } else {
        expect(items[0].code_ref).toBe("unresolved");
        expect(items[0].verification.valid).toBe(false);
      }
    }
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

  it("routes bottom-edge strips in both prescribed layouts without relaxing geometry checks", () => {
    for (const [width, height] of [
      [390, 844],
      [1280, 832],
    ]) {
      const v = makeView({ width, height });
      const box = { x: 150, y: height - 5, w: 40, h: 5 };
      v.items = [
        {
          ...v.items[0],
          regions: [{ id: "bottom", bbox_css: box, half: "both", before: box, after: box }],
        },
      ];
      v.geometry = geometry(v);
      expect(v.geometry.marks).toHaveLength(2);
      expect(geometryCheck(v)).toBe(true);
    }
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

  it("swaps actual half origins for both blind_reverse values and keeps moved outlines on their half", () => {
    const targets = {
      before: { x: 100, y: 100, w: 50, h: 40 },
      after: { x: 100, y: 140, w: 50, h: 40 },
    };
    const build = (width, height, blind_reverse) => {
      const v = {
        id: "v",
        width,
        height,
        blind: true,
        blind_reverse,
        regions: [{ id: "r1", bbox_css: targets.before }],
        items: [],
      };
      v.items = [
        {
          id: "v#1",
          n: 1,
          status: "unexplained",
          scope: "local",
          regions: [{ ...v.regions[0], half: "both", ...targets }],
          style_delta: [],
        },
        {
          id: "v#2",
          n: 2,
          status: "unverified_claim",
          scope: "local",
          regions: [],
          style_delta: [],
        },
      ];
      v.geometry = geometry(v);
      return v;
    };
    for (const [width, height] of [
      [390, 844],
      [1280, 832],
    ]) {
      const fwd = build(width, height, false).geometry;
      for (const reverse of [false, true]) {
        const v = build(width, height, reverse);
        const g = v.geometry;
        // Slots are fixed; the actual halves swap into them when reversed.
        const slot = (h) => (reverse ? (h === "before" ? "after" : "before") : h);
        expect(g.halves.before).toEqual(fwd.halves[slot("before")]);
        expect(g.halves.after).toEqual(fwd.halves[slot("after")]);
        expect(g.halves.before).not.toEqual(g.halves.after);
        if (reverse) expect(g.halves).not.toEqual(fwd.halves);
        expect(g.marks).toHaveLength(2);
        for (const m of g.marks) {
          const o = g.halves[m.half];
          const t = targets[m.half];
          expect(m.outline).toEqual({ x: o.x + t.x - 3, y: o.y + t.y - 3, w: t.w + 6, h: t.h + 6 });
        }
        expect(g.marks.some((m) => m.item_id === "v#2")).toBe(false);
        expect(geometryCheck(v)).toBe(true);
      }
    }
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

describe("regionTargets", () => {
  const view = { width: 400, height: 150 };
  const box = { x: 100, y: 100, w: 50, h: 50 };
  const at = (x, y, w = 50, h = 50) => ({ rect: { x, y, w, h } });

  it("projects old and new patches onto the moved before and after halves", () => {
    expect(
      regionTargets(box, { before: at(100, 100), after: at(100, 140) }, { ...view, height: 400 }),
    ).toEqual({
      before: { x: 100, y: 90, w: 50, h: 60 },
      after: { x: 100, y: 130, w: 50, h: 60 },
    });
  });

  it("keeps an unrelated middle region when neither moved endpoint intersects it", () => {
    const middle = { x: 80, y: 40, w: 20, h: 20 };
    expect(
      regionTargets(middle, { before: at(0, 40, 20, 20), after: at(160, 40, 20, 20) }, view),
    ).toEqual({ before: middle, after: middle });
  });

  it("clips projected targets to the view", () => {
    const t = regionTargets(box, { before: at(100, 100), after: at(100, 140) }, view);
    expect(t.before).toEqual({ x: 100, y: 90, w: 50, h: 60 });
    expect(t.after).toEqual({ x: 100, y: 130, w: 50, h: 20 });
  });

  it("keeps the raw box when nothing moved or there is no match", () => {
    const resized = { before: at(100, 100), after: at(100, 100, 80, 80) };
    for (const match of [resized, null, { before: null, after: at(1, 1) }]) {
      const t = regionTargets(box, match, view);
      expect(t.before).toBe(box);
      expect(t.after).toBe(box);
    }
  });
});

describe("attribution of moved elements", () => {
  const view = { id: "v", width: 390, height: 844 };
  const el = (y, color, text = "Hi") => ({
    key: "testid:card",
    selector: "#card",
    testid: "card",
    tag: "div",
    depth: 2,
    role: null,
    name: "Card",
    text,
    rect: { x: 0, y, w: 100, h: 40 },
    style: { color },
  });
  const region = { id: "r1", bbox_css: { x: 0, y: 0, w: 100, h: 70 } };

  it("gives a moved style change distinct before and after targets", () => {
    const { items } = attribute([el(0, "red")], [el(30, "blue")], [region], [], [], "h", view);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("unexplained");
    expect(items[0].change).toBe("style");
    const [r] = items[0].regions;
    expect(r.half).toBe("both");
    expect(r.before).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect(r.after).toEqual({ x: 0, y: 20, w: 100, h: 60 });
    expect(r.bbox_css).toEqual(region.bbox_css);
  });

  it("leaves a pure shift unexplained without a causal preceding resize", () => {
    const { items } = attribute([el(0, "red")], [el(30, "red")], [region], [], [], "h", view);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("unexplained");
    expect(items[0].change).toBe("shift");
    expect(items[0].shifts).toEqual([]);
    expect(items[0].regions[0].before).not.toEqual(items[0].regions[0].after);
  });
});

describe("attribution audit regressions", () => {
  const view = { id: "v", width: 390, height: 844 };
  const hunks = new Map([["a.css", [[2, 3]]]]);
  const claimOf = (id, selector, prop) =>
    normalizeIntent([{ id, claim: "c", selector, prop, file: "a.css", line: 2 }]);
  const node = (testid, depth, rect, style = {}, extra = {}) => ({
    key: `testid:${testid}`,
    selector: `#${testid}`,
    testid,
    tag: "div",
    depth,
    role: null,
    name: testid,
    text: "x",
    rect,
    style,
    ...extra,
  });
  const itemFor = (items, region) => items.find((i) => i.regions.some((r) => r.id === region.id));

  it("keeps coincident unsupported paint or media content unexplained while allowing plain opacity", () => {
    const box = { x: 40, y: 40, w: 40, h: 40 };
    const region = { id: "paint", bbox_css: box };
    for (const kind of ["plain", "gradient", "url", "canvas", "img", "video"]) {
      const before = node(
        "paint",
        2,
        box,
        { opacity: "0.4" },
        {
          tag: ["canvas", "img", "video"].includes(kind) ? kind : "div",
          paint: { "background-image": kind === "url" ? 'url("/hero.png")' : "none" },
        },
      );
      const after = {
        ...before,
        style: { opacity: "1" },
        paint: {
          "background-image":
            kind === "gradient" ? "linear-gradient(red, blue)" : before.paint["background-image"],
        },
      };
      const { items } = attribute(
        [before],
        [after],
        [region],
        claimOf("op", "#paint", "opacity"),
        hunks,
        "h",
        view,
      );
      expect(itemFor(items, region).status).toBe(kind === "plain" ? "explained" : "unexplained");
      if (kind !== "plain")
        expect(items.find((i) => i.intent_ref === "op").status).toBe("unverified_claim");
      if (["canvas", "img", "video"].includes(kind))
        expect(itemFor(items, region).element).toBeNull();
      expect(items.find((i) => i.intent_ref === "op").style_delta).toEqual([
        { prop: "opacity", old: "0.4", new: "1" },
      ]);
    }
  });

  it("retains unsupported paint-only deltas in facts without saying unchanged", () => {
    const box = { x: 40, y: 40, w: 40, h: 40 };
    const before = node("paint", 2, box, {}, { paint: { "background-image": "none" } });
    const after = { ...before, paint: { "background-image": "linear-gradient(red, blue)" } };
    const { items } = attribute(
      [before],
      [after],
      [{ id: "paint", bbox_css: box }],
      [],
      hunks,
      "h",
      view,
    );
    expect(items[0]).toMatchObject({
      status: "unexplained",
      change: "style",
      style_delta: [],
      paint_delta: [{ prop: "background-image", old: "none", new: "linear-gradient(red, blue)" }],
    });
    const docs = markdownFiles({
      capture_spec_hash: "s",
      capture_spec: { runtime: { playwright: "p", os_image: "os" }, seed: "fixture" },
      views: [{ ...view, items, alt: "Paint" }],
    });
    expect(docs["v.judge.md"]).toContain("background-image: none → linear-gradient");
    expect(docs["v.judge.md"]).not.toContain("unchanged");
  });

  it("marks only visible halves when existing elements move outside either viewport axis", () => {
    const visible = { x: 100, y: 100, w: 20, h: 20 };
    for (const offscreen of [
      { ...visible, x: 500 },
      { ...visible, x: -100 },
      { ...visible, y: 1000 },
      { ...visible, y: -100 },
    ]) {
      for (const reverse of [false, true]) {
        const a = node("card", 2, reverse ? offscreen : visible);
        const b = node("card", 2, reverse ? visible : offscreen);
        const { items } = attribute(
          [a],
          [b],
          [{ id: "move", bbox_css: visible }],
          [],
          hunks,
          "h",
          view,
        );
        const [r] = items[0].regions;
        expect(r.half).toBe(reverse ? "after" : "before");
        expect(r[reverse ? "before" : "after"]).toBeNull();
        expect(r[reverse ? "after" : "before"].w).toBeGreaterThan(0);
        expect(r[reverse ? "after" : "before"].h).toBeGreaterThan(0);
        const projected = { ...view, items };
        projected.geometry = geometry(projected);
        expect(projected.geometry.marks.map((m) => m.half)).toEqual([r.half]);
        expect(geometryCheck(projected)).toBe(true);
      }
    }
  });

  it("does not explain an independent move with a simultaneous opacity claim", () => {
    const before = node("card", 2, { x: 50, y: 40, w: 20, h: 20 }, { opacity: "0.4" });
    const after = { ...before, rect: { ...before.rect, x: 150 }, style: { opacity: "1" } };
    const region = { id: "r", bbox_css: before.rect };
    const { items } = attribute(
      [before],
      [after],
      [region],
      claimOf("op", "#card", "opacity"),
      hunks,
      "h",
      view,
    );
    expect(itemFor(items, region).status).toBe("unexplained");
    expect(items.find((i) => i.intent_ref === "op").status).toBe("unverified_claim");
  });

  it("does not attribute the empty span between moved endpoints to a deep claimed element", () => {
    const a = node("moving", 5, { x: 0, y: 40, w: 20, h: 20 }, { opacity: "0.4" });
    const b = { ...a, rect: { ...a.rect, x: 160 }, style: { opacity: "1" } };
    const middle = { id: "middle", bbox_css: { x: 80, y: 40, w: 20, h: 20 } };
    const out = attribute(
      [a],
      [b],
      [middle],
      claimOf("op", "#moving", "opacity"),
      hunks,
      "h",
      view,
    );
    expect(itemFor(out.items, middle)).toMatchObject({ status: "unexplained", element: null });
    const sibling = node("sibling", 2, middle.bbox_css, { color: "red" });
    const changed = { ...sibling, style: { color: "blue" } };
    const withSibling = attribute(
      [a, sibling],
      [b, changed],
      [middle],
      claimOf("op", "#moving", "opacity"),
      hunks,
      "h",
      view,
    );
    expect(itemFor(withSibling.items, middle).element.selector).toBe("#sibling");
  });

  it("keeps ambiguous overlay and media pixels unexplained instead of preferring a claim", () => {
    const box = { x: 40, y: 40, w: 40, h: 40 };
    const image = node("image", 2, box, {}, { tag: "img" });
    const overlay = node("overlay", 3, box, { opacity: "0.4" });
    const region = { id: "media", bbox_css: box };
    const { items } = attribute(
      [image, overlay],
      [image, { ...overlay, style: { opacity: "1" } }],
      [region],
      claimOf("op", "#overlay", "opacity"),
      hunks,
      "h",
      view,
    );
    expect(itemFor(items, region)).toMatchObject({ status: "unexplained", element: null });
    expect(items.find((i) => i.intent_ref === "op").verification.valid).toBe(true);
  });

  it("does not let a deeper claimed opacity change hide a shallower sibling in a merged region", () => {
    const a = png(80, 40);
    const b = png(80, 40, [255, 255, 255], (x, y) =>
      square(10, 10, 20)(x, y) || square(35, 10, 20)(x, y) ? [0, 0, 0] : null,
    );
    const found = regions(a, b, 1).regions;
    expect(found).toHaveLength(1);
    const [region] = found;
    const left = { x: 10, y: 10, w: 20, h: 20 };
    const right = { x: 35, y: 10, w: 20, h: 20 };
    const { items } = attribute(
      [node("a", 2, left, { color: "red" }), node("b", 3, right, { opacity: "1" })],
      [node("a", 2, left, { color: "blue" }), node("b", 3, right, { opacity: "0.5" })],
      [region],
      claimOf("op", "#b", "opacity"),
      hunks,
      "h",
      view,
    );
    expect(itemFor(items, region).status).toBe("unexplained");
    // One surviving region has exactly one owning item, which lists both contributors.
    expect(items.filter((i) => i.regions.some((r) => r.id === region.id))).toHaveLength(1);
    const owner = itemFor(items, region);
    const selectors = owner.contributors.map((c) => c.element.selector);
    expect(selectors).toContain("#a");
    expect(selectors).toContain("#b");
  });

  it("keeps a text change unexplained when only opacity is claimed and records the text delta", () => {
    // Assumption: the unexplained item carries text_delta: { old, new }.
    const r = { x: 0, y: 0, w: 80, h: 20 };
    const region = { id: "r1", bbox_css: r };
    const { items } = attribute(
      [node("status", 2, r, { opacity: "1" }, { text: "Approved" })],
      [node("status", 2, r, { opacity: "0.5" }, { text: "Denied" })],
      [region],
      claimOf("op", "#status", "opacity"),
      hunks,
      "h",
      view,
    );
    const item = itemFor(items, region);
    expect(item.status).toBe("unexplained");
    expect(item.text_delta).toEqual({ old: "Approved", new: "Denied" });
  });

  describe("shift folding", () => {
    const flow = {
      parent: "#flow",
      position: "static",
      parent_display: "block",
      writing_mode: "horizontal-tb",
      float: "none",
      transform: "none",
      translate: "none",
      rotate: "none",
      scale: "none",
    };
    const card = (after = false, cardFlow = flow) =>
      node(
        "card",
        2,
        { x: 0, y: 0, w: 100, h: after ? 48 : 40 },
        {
          "padding-top": after ? "16px" : "8px",
          "padding-bottom": "0px",
          height: after ? "48px" : "40px",
        },
        { flow: cardFlow },
      );
    const follower = (name, y, x = 0, f = flow) =>
      node(name, 2, { x, y, w: 100, h: 20 }, {}, { flow: f });
    const run = (baseNodes, headNodes, bounds, cardFlow = flow) => {
      const regs = [
        { id: "rc", bbox_css: { x: 0, y: 0, w: 100, h: 48 } },
        ...bounds.map((b, i) => ({ id: `rf${i}`, bbox_css: b })),
      ];
      const out = attribute(
        [card(false, cardFlow), ...baseNodes],
        [card(true, cardFlow), ...headNodes],
        regs,
        claimOf("pad", "#card", "padding-top"),
        hunks,
        "h",
        view,
      );
      return { ...out, cause: out.items.find((i) => i.intent_ref === "pad"), regs };
    };

    it("validates a padding-driven height change", () => {
      const { cause } = run([], [], []);
      expect(cause.status).toBe("explained");
      expect(cause.verification).toEqual({ measured: true, valid: true });
    });

    it("does not fold an absolutely positioned horizontal shift", () => {
      const abs = { ...flow, position: "absolute" };
      const { cause, items } = run(
        [follower("footer", 50, 0, abs)],
        [follower("footer", 50, 100, abs)],
        [{ x: 0, y: 50, w: 200, h: 20 }],
      );
      expect(cause.shifts).toEqual([]);
      expect(
        items.some((i) => i.status === "unexplained" && i.element?.selector === "#footer"),
      ).toBe(true);
    });

    it("folds a same-parent normal-flow vertical shift equal to the height change", () => {
      const { cause, items } = run(
        [follower("next", 50)],
        [follower("next", 58)],
        [{ x: 0, y: 50, w: 100, h: 28 }],
      );
      expect(cause.shifts).toHaveLength(1);
      expect(cause.shifts[0]).toMatchObject({ dx: 0, dy: 8 });
      expect(items.some((i) => i.status === "unexplained")).toBe(false);
    });

    const notFolded = (res, selector = "#next") => {
      expect(res.cause.shifts).toEqual([]);
      expect(
        res.items.some((i) => i.status === "unexplained" && i.element?.selector === selector),
      ).toBe(true);
    };
    const shiftRun = (f, cardFlow = flow) =>
      run(
        [follower("next", 50, 0, f)],
        [follower("next", 58, 0, f)],
        [{ x: 0, y: 50, w: 100, h: 28 }],
        cardFlow,
      );

    it("does not fold when the card is floated", () => {
      notFolded(shiftRun(flow, { ...flow, float: "left" }));
    });

    it("does not fold when the follower is floated with its own transform", () => {
      notFolded(
        shiftRun(
          { ...flow, float: "left", transform: "matrix(1, 0, 0, 1, 0, 8)" },
          { ...flow, float: "left" },
        ),
      );
    });

    it("rejects a normal-flow follower with a transform or individual transform even at the matching dy", () => {
      for (const patch of [
        { transform: "matrix(1, 0, 0, 1, 0, 8)" },
        { translate: "0px 8px" },
        { rotate: "10deg" },
        { scale: "2" },
      ])
        notFolded(shiftRun({ ...flow, ...patch }));
    });

    it("rejects a relatively positioned follower or card", () => {
      notFolded(shiftRun({ ...flow, position: "relative" }));
      notFolded(shiftRun(flow, { ...flow, position: "relative" }));
    });

    it("does not fold a shift without flow metadata", () => {
      const bare = (y) => node("next", 2, { x: 0, y, w: 100, h: 20 });
      const { cause } = run([bare(50)], [bare(58)], [{ x: 0, y: 50, w: 100, h: 28 }]);
      expect(cause.shifts).toEqual([]);
    });

    it("leaves an inconsistent dy unknown", () => {
      const { cause, items } = run(
        [follower("next", 50)],
        [follower("next", 54)],
        [{ x: 0, y: 50, w: 100, h: 24 }],
      );
      expect(cause.shifts).toEqual([]);
      expect(items.some((i) => i.status === "unexplained" && i.element?.selector === "#next")).toBe(
        true,
      );
    });

    it("leaves a shift under a different parent unknown", () => {
      const other = { ...flow, parent: "#other" };
      const { cause, items } = run(
        [follower("next", 50, 0, other)],
        [follower("next", 58, 0, other)],
        [{ x: 0, y: 50, w: 100, h: 28 }],
      );
      expect(cause.shifts).toEqual([]);
      expect(items.some((i) => i.status === "unexplained" && i.element?.selector === "#next")).toBe(
        true,
      );
    });
  });
});

describe("parityPair", () => {
  const spec = { seed: "seed-1", fullPage: false };
  const meta = (patch = {}) => ({
    spec_hash: digest(spec),
    sha: "a",
    fonts_loaded: true,
    text: "Welcome home",
    console: [],
    seed: "seed-1",
    scrollY: 0,
    scrollX: 0,
    coordinate_space: "viewport",
    font_evidence: [{ verified: true }],
    view: { dpr: 1 },
    ...patch,
  });
  const a = () => meta();
  const b = () => meta({ sha: "b" });
  const stable = () => [png(40, 40), png(40, 40), png(40, 40), png(40, 40)];
  const run = (baseProbe = a(), headProbe = b(), images = stable()) =>
    parityPair(spec, a(), b(), baseProbe, headProbe, images);
  const flaky = png(40, 40, [255, 255, 255], square(10, 10, 12));

  it("is valid when both probes are stable", () => {
    const r = run();
    expect(r.status).toBe("valid");
    expect(r.reasons).toEqual([]);
    expect(r.flake_regions).toBe(0);
  });

  it("flags a pixel flake only in the candidate probe", () => {
    const r = run(a(), b(), [png(40, 40), png(40, 40), png(40, 40), flaky]);
    expect(r.status).toBe("capture_invalid");
    expect(r.reasons).toContain("candidate_flake");
    expect(r.reasons).not.toContain("flake");
    expect(r.base_probe.status).toBe("valid");
    expect(r.candidate_probe.flake_regions).toBeGreaterThan(0);
    expect(r.flake_regions).toBeGreaterThan(0);
  });

  it("flags a pixel flake only in the base probe", () => {
    const r = run(a(), b(), [png(40, 40), png(40, 40), flaky, png(40, 40)]);
    expect(r.reasons).toContain("flake");
    expect(r.reasons).not.toContain("candidate_flake");
  });

  it("flags candidate-probe console errors, missing fonts, scroll and spec mismatches", () => {
    const cases = [
      [{ console: [{ type: "error", text: "x" }] }, "candidate_page_state"],
      [{ fonts_loaded: false }, "candidate_page_state"],
      [{ scrollY: 40 }, "candidate_scroll"],
      [{ scrollX: 10 }, "candidate_scroll"],
      [{ spec_hash: "other" }, "candidate_spec_hash"],
    ];
    for (const [patch, reason] of cases) {
      const r = run(a(), b_(patch));
      expect(r.status, JSON.stringify(patch)).toBe("capture_invalid");
      expect(r.reasons, JSON.stringify(patch)).toContain(reason);
      expect(r.base_probe.status).toBe("valid");
    }
    function b_(patch) {
      return meta({ sha: "b", ...patch });
    }
  });

  it("flags a probe whose height differs", () => {
    const head = run(a(), b(), [png(40, 40), png(40, 40), png(40, 40), png(40, 50)]);
    expect(head.status).toBe("capture_invalid");
    expect(head.reasons).toContain("candidate_image_size");
    expect(head.flake_regions).toBeNull();
    const base = run(a(), b(), [png(40, 40), png(40, 40), png(40, 50), png(40, 40)]);
    expect(base.reasons).toContain("image_size");
  });
});

describe("merged ambiguous regions and unmeasured claims", () => {
  const node = (testid, depth, rect, style = {}, text = "x") => ({
    key: `testid:${testid}`,
    selector: `#${testid}`,
    testid,
    tag: "div",
    depth,
    role: null,
    name: testid,
    text,
    rect,
    style,
  });

  it("keeps both halves, targets and marks for an existing change merged with a nearby added node", () => {
    const left = { x: 10, y: 10, w: 20, h: 20 };
    const added = { x: 35, y: 10, w: 20, h: 20 };
    const region = { id: "r1", bbox_css: { x: 10, y: 10, w: 45, h: 20 } };
    const view = { id: "v", width: 390, height: 844, regions: [region] };
    const { items } = attribute(
      [node("old", 2, left, { opacity: "1" })],
      [node("old", 2, left, { opacity: "0.5" }), node("new", 3, added)],
      [region],
      [],
      new Map(),
      "h",
      view,
    );
    const owner = items.find((i) => i.regions.length);
    expect(owner.regions).toHaveLength(1);
    const [r] = owner.regions;
    expect(r.half).toBe("both");
    expect(r.before).not.toBeNull();
    expect(r.after).not.toBeNull();
    view.items = items;
    view.geometry = geometry(view);
    expect(
      view.geometry.marks
        .filter((m) => m.region_id === "r1")
        .map((m) => m.half)
        .sort(),
    ).toEqual(["after", "before"]);
    expect(geometryCheck(view)).toBe(true);
  });

  it("rejects change wording for unmeasured added, removed and text claims", () => {
    const names = ["Card"];
    for (const [change, label] of [
      ["added", "Added change"],
      ["removed", "Removed change"],
      ["text", "Text change"],
    ]) {
      const items = [
        {
          id: "v#1",
          status: "unverified_claim",
          change,
          element: { name: "Card" },
          style_delta: [],
          token: null,
          verification: { measured: false, valid: false },
        },
      ];
      const one = (patch) => [{ id: "v#1", label: "No visible change", rationale: "", ...patch }];
      expect(() => validateLabels(items, one({ label }), names), label).toThrow();
      expect(() => validateLabels(items, one({ rationale: label }), names), label).toThrow();
      expect(validateLabels(items, one(), names)).toBe(true);
    }
  });
});

describe("validateSpec", () => {
  const view = (route, theme, width, height) => ({
    id: `${route}-${theme}-${width}`,
    route,
    theme,
    width,
    height,
    dpr: 2,
    anchor: "main",
    expectedFont: "Inter",
    masks: [],
  });
  const make = (patch = {}) => ({
    schema: "annotated-diff/capture-v0",
    thresholds: { ...THRESHOLDS },
    runtime: { chromium_sha256: "c", os_image: "o", font_sha256: "f" },
    seed: "seed-1",
    locale: "en-US",
    timezone: "UTC",
    fixedTime: "2026-01-01T00:00:00Z",
    fullPage: false,
    style: "",
    routes: ["home"],
    views: ["light", "dark"].flatMap((theme) => [
      view("home", theme, 390, 844),
      view("home", theme, 1280, 832),
    ]),
    ...patch,
  });
  const withView = (i, patch) => {
    const spec = make();
    spec.views[i] = { ...spec.views[i], ...patch };
    return spec;
  };

  it("accepts a complete four-view spec, with or without blind", () => {
    expect(() => validateSpec(make())).not.toThrow();
    expect(make().views).toHaveLength(4);
    expect(() => validateSpec(make({ blind: true }))).not.toThrow();
    expect(() => validateSpec(make({ blind: false }))).not.toThrow();
  });

  it("rejects an invalid blind type", () => {
    for (const blind of ["yes", 1, null, {}])
      expect(() => validateSpec(make({ blind })), String(blind)).toThrow();
  });

  it("rejects unknown top-level fields", () => {
    expect(() => validateSpec(make({ cookies: [] }))).toThrow();
  });

  it("rejects a missing or duplicate route, theme or viewport", () => {
    const spec = make();
    expect(() => validateSpec(make({ routes: ["home", "home"] }))).toThrow();
    expect(() => validateSpec(make({ routes: [] }))).toThrow();
    expect(() => validateSpec(make({ routes: ["home", "about"] }))).toThrow();
    // Missing theme (dark dropped) and missing viewport (desktop dropped).
    expect(() =>
      validateSpec(make({ views: spec.views.filter((v) => v.theme === "light") })),
    ).toThrow();
    expect(() =>
      validateSpec(make({ views: spec.views.filter((v) => v.width === 390) })),
    ).toThrow();
    // Duplicate combination replacing another, and duplicate ids.
    expect(() =>
      validateSpec(make({ views: [spec.views[0], ...spec.views.slice(0, 3)] })),
    ).toThrow();
    expect(() => validateSpec(withView(1, { id: spec.views[0].id }))).toThrow();
    expect(() => validateSpec(withView(0, { theme: "sepia" }))).toThrow();
    expect(() => validateSpec(withView(0, { width: 400 }))).toThrow();
  });

  it("rejects unsupported per-view adapter fields", () => {
    for (const patch of [{ expectedStatus: 200 }, { persona: "member" }, { isMobile: true }])
      expect(() => validateSpec(withView(0, patch)), JSON.stringify(patch)).toThrow();
  });

  it("accepts well-formed fontFamilies aliases and rejects malformed ones", () => {
    expect(() =>
      validateSpec(withView(0, { fontFamilies: { Inter: ["Inter", "Inter Variable"] } })),
    ).not.toThrow();
    for (const fontFamilies of [
      [],
      "Inter",
      null,
      { Inter: "Inter" },
      { Inter: [] },
      { Inter: [""] },
      { Inter: ["  "] },
      { Inter: [1] },
      { "": ["Inter"] },
    ])
      expect(
        () => validateSpec(withView(0, { fontFamilies })),
        JSON.stringify(fontFamilies),
      ).toThrow();
  });
});
