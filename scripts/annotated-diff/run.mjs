import assert from "node:assert/strict";
import { createHash, randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import sharp from "sharp";
import { chromium } from "playwright";

export const THRESHOLDS = Object.freeze({
  tolerant: 0.15,
  minimum: 20,
  sensitive: 0.0225,
  ratio: 0.03,
  dilation: 6,
  area: 12,
  merge: 12,
  padding: 4,
});
export const STYLES = [
  "color",
  "background-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "opacity",
  "box-shadow",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "gap",
  "width",
  "height",
];
export const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (x) =>
  JSON.stringify(x, (_, v) =>
    v && !Array.isArray(v) && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b, "en")))
      : v,
  );
export const digest = (x) => hash(canonical(x));
const read = async (p) => JSON.parse(await fs.readFile(p, "utf8"));
const write = async (p, x) => fs.writeFile(p, `${JSON.stringify(x, null, 2)}\n`);
const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
const exact = (obj, keys) =>
  assert.deepEqual(Object.keys(obj).sort(), keys.sort(), "Unexpected or missing keys");
const rect = (x, y, w, h) => ({ x, y, w, h });
const area = (r) => Math.max(0, r.w) * Math.max(0, r.h);
const intersect = (a, b) =>
  rect(
    Math.max(a.x, b.x),
    Math.max(a.y, b.y),
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)),
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)),
  );
const overlap = (a, b) => area(intersect(a, b));
const union = (a, b) =>
  rect(
    Math.min(a.x, b.x),
    Math.min(a.y, b.y),
    Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x),
    Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y),
  );
const expand = (r, n) => rect(r.x - n, r.y - n, r.w + 2 * n, r.h + 2 * n);
const same = (a, b) => canonical(a) === canonical(b);

export async function runtime() {
  const executable = chromium.executablePath();
  return {
    tool_sha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
    node: process.versions.node,
    os_release_sha256: hash(await fs.readFile("/etc/os-release")),
    bold_font_sha256: hash(
      await fs.readFile(
        new URL(
          "../../node_modules/@fontsource/inter/files/inter-latin-700-normal.woff2",
          import.meta.url,
        ),
      ),
    ),
    playwright: JSON.parse(
      await fs.readFile(new URL("../../node_modules/playwright/package.json", import.meta.url)),
    ).version,
    chromium_sha256: hash(await fs.readFile(executable)),
    os_image: `${os.platform()}-${os.arch()}-${os.release()}`,
    flags: ["--disable-lcd-text", "--font-render-hinting=none"],
    font_sha256: hash(
      await fs.readFile(
        new URL(
          "../../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2",
          import.meta.url,
        ),
      ),
    ),
  };
}

export function validateSpec(s) {
  exact(s, [
    "schema",
    "thresholds",
    "runtime",
    "seed",
    "locale",
    "timezone",
    "fixedTime",
    "fullPage",
    "style",
    "routes",
    "views",
    ...(Object.hasOwn(s, "blind") ? ["blind"] : []),
  ]);
  assert.equal(s.schema, "annotated-diff/capture-v0");
  assert.deepEqual(s.thresholds, THRESHOLDS, "Protected thresholds differ");
  assert(s.seed && s.locale && s.timezone && Number.isFinite(Date.parse(s.fixedTime)));
  assert(s.runtime.chromium_sha256 && s.runtime.os_image && s.runtime.font_sha256);
  assert(s.routes.length > 0 && new Set(s.routes).size === s.routes.length);
  const expected = s.routes
    .flatMap((route) =>
      ["light", "dark"].flatMap((theme) =>
        [
          [390, 844],
          [1280, 832],
        ].map(([width, height]) => `${route}|${theme}|${width}|${height}|2`),
      ),
    )
    .sort();
  assert.deepEqual(
    s.views.map((v) => `${v.route}|${v.theme}|${v.width}|${v.height}|${v.dpr}`).sort(),
    expected,
    "Incomplete route/theme/viewport matrix",
  );
  assert(new Set(s.views.map((v) => v.id)).size === s.views.length);
  for (const v of s.views) {
    exact(v, [
      "id",
      "route",
      "theme",
      "width",
      "height",
      "dpr",
      "anchor",
      "expectedFont",
      "masks",
      ...(Object.hasOwn(v, "fontFamilies") ? ["fontFamilies"] : []),
    ]);
    assert(/^[a-z0-9-]+$/.test(v.id));
    assert(v.anchor && v.expectedFont && Array.isArray(v.masks));
    if (v.fontFamilies !== undefined) {
      assert(
        v.fontFamilies && !Array.isArray(v.fontFamilies) && typeof v.fontFamilies === "object",
      );
      for (const [family, names] of Object.entries(v.fontFamilies))
        assert(
          family &&
            Array.isArray(names) &&
            names.length > 0 &&
            names.every((n) => typeof n === "string" && n.trim()),
        );
    }
    for (const m of v.masks) {
      exact(m, ["selector", "reason"]);
      assert(m.selector && m.reason);
    }
  }
  assert(typeof s.style === "string" && typeof s.fullPage === "boolean");
  assert(s.blind === undefined || typeof s.blind === "boolean");
}

export async function normalizeMotion(page) {
  await page.evaluate(async () => {
    const active = () =>
      document.getAnimations().filter((a) => !["finished", "idle"].includes(a.playState));
    let idleFrames = 0;
    for (let pass = 0; pass < 16; pass++) {
      const animations = active();
      if (animations.length) idleFrames = 0;
      for (const animation of animations) {
        if (animation.effect?.getComputedTiming().endTime === Infinity) animation.cancel();
        else animation.finish();
      }
      // Scroll and completion callbacks can enqueue animation work in the next rendering update.
      await new Promise(requestAnimationFrame);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (active().length) idleFrames = 0;
      else if (++idleFrames === 2) {
        const style = document.createElement("style");
        style.textContent = "*, *::before, *::after { transition-property: none !important; }";
        document.head.append(style);
        return;
      }
    }
    throw new Error("Capture animations did not settle");
  });
}

// Capture only already-provisioned, clean source checkouts. This tool never creates worktrees.
export async function capture({ spec, sourceRoot, sha, url, out }) {
  validateSpec(spec);
  assert(same(await runtime(), spec.runtime), "Pinned browser/OS/font runtime mismatch");
  assert.equal(git(sourceRoot, "rev-parse", "HEAD"), sha);
  assert.equal(
    git(sourceRoot, "status", "--porcelain", "--untracked-files=no"),
    "",
    "Source checkout is dirty",
  );
  const origin = new URL(url);
  assert(["http:", "https:"].includes(origin.protocol) && !origin.username && !origin.password);
  await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch({ args: spec.runtime.flags });
  const captures = [];
  try {
    for (const view of spec.views) {
      const options = {
        viewport: { width: view.width, height: view.height },
        deviceScaleFactor: view.dpr,
        colorScheme: view.theme,
        reducedMotion: "reduce",
        locale: spec.locale,
        timezoneId: spec.timezone,
      };
      const context = await browser.newContext(options);
      try {
        const halves = [];
        for (let probe = 0; probe < 2; probe++) {
          const page = await context.newPage();
          const consoleLog = [];
          page.on("console", (m) => consoleLog.push({ type: m.type(), text: m.text() }));
          page.on("pageerror", (e) => consoleLog.push({ type: "error", text: String(e) }));
          await page.clock.setFixedTime(new Date(spec.fixedTime));
          const target = new URL(view.route, origin);
          assert.equal(target.origin, origin.origin);
          target.searchParams.set("captureSeed", spec.seed);
          const response = await page.goto(target.href, {
            waitUntil: "networkidle",
            timeout: 30_000,
          });
          assert(response?.ok(), "Capture route did not load");
          if (spec.style) await page.addStyleTag({ content: spec.style });
          await normalizeMotion(page);
          await page.evaluate(() => document.fonts.ready);
          assert.equal(await page.locator('[aria-busy="true"]').count(), 0, "Page is busy");
          const anchor = page.locator(view.anchor);
          assert.equal(await anchor.count(), 1);
          await anchor.scrollIntoViewIfNeeded();
          await normalizeMotion(page);
          await page.evaluate(() => document.fonts.ready);
          const maskRects = [];
          for (const mask of view.masks) {
            const nodes = page.locator(mask.selector);
            assert((await nodes.count()) > 0, "Mask matched nothing");
            for (const node of await nodes.all()) {
              const box = await node.boundingBox();
              if (box) {
                const offset = spec.fullPage
                  ? await page.evaluate(() => ({ x: scrollX, y: scrollY }))
                  : { x: 0, y: 0 };
                maskRects.push(rect(box.x + offset.x, box.y + offset.y, box.width, box.height));
              }
            }
          }
          const dom = await page.evaluate(
            ({ props, font, masks, fullPage }) => {
              const nodes = [...document.querySelectorAll("body *")].filter(
                (e) =>
                  !["SCRIPT", "STYLE", "LINK", "META"].includes(e.tagName) &&
                  !masks.some((m) => e.closest(m.selector)),
              );
              if (nodes.length > 20_000) throw new Error("DOM inventory exceeds limit");
              const cssPath = (e) => {
                if (e.id) return `#${CSS.escape(e.id)}`;
                if (!e.parentElement || e === document.body) return "body";
                return `${cssPath(e.parentElement)} > ${e.tagName.toLowerCase()}:nth-child(${[...e.parentElement.children].indexOf(e) + 1})`;
              };
              const elements = nodes
                .map((e) => {
                  const r = e.getBoundingClientRect(),
                    s = getComputedStyle(e),
                    testid = e.getAttribute("data-testid");
                  const text = e.childElementCount
                    ? [...e.childNodes]
                        .filter((n) => n.nodeType === 3)
                        .map((n) => n.textContent)
                        .join("")
                        .trim()
                    : e.textContent.trim();
                  const ancestors = [];
                  for (let p = e.parentElement; p; p = p.parentElement)
                    ancestors.push(
                      p.hasAttribute("data-testid")
                        ? `[data-testid="${CSS.escape(p.getAttribute("data-testid"))}"]`
                        : cssPath(p),
                    );
                  const parentStyle = getComputedStyle(e.parentElement);
                  return {
                    ancestors,
                    flow: {
                      parent: cssPath(e.parentElement),
                      position: s.position,
                      inset: ["top", "right", "bottom", "left"].map((p) =>
                        e.computedStyleMap().get(p).toString(),
                      ),
                      float: s.cssFloat,
                      transform: s.transform,
                      translate: s.translate,
                      rotate: s.rotate,
                      scale: s.scale,
                      parent_display: parentStyle.display,
                      writing_mode: parentStyle.writingMode,
                    },
                    key: testid ? `testid:${testid}` : `${cssPath(e)}|${text}`,
                    selector: testid ? `[data-testid="${CSS.escape(testid)}"]` : cssPath(e),
                    testid,
                    tag: e.tagName.toLowerCase(),
                    depth: cssPath(e).split(">").length,
                    role: e.getAttribute("role"),
                    name: e.getAttribute("aria-label") || text || testid || e.tagName.toLowerCase(),
                    text,
                    rect: {
                      x: r.x + (fullPage ? scrollX : 0),
                      y: r.y + (fullPage ? scrollY : 0),
                      w: r.width,
                      h: r.height,
                    },
                    style: Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)])),
                  };
                })
                .filter((e) => e.rect.w > 0 && e.rect.h > 0);
              return {
                elements,
                fonts_loaded:
                  document.fonts.check(`16px "${font}"`) &&
                  elements.some(
                    (e) => e.style["font-family"].split(",")[0].replaceAll('"', "").trim() === font,
                  ),
                scrollY,
                scrollX,
                coordinate_space: fullPage ? "document" : "viewport",
                title: document.title,
                text: elements.map((e) => e.text).join(" "),
                seed: document.documentElement.dataset.captureSeed || null,
              };
            },
            { props: STYLES, font: view.expectedFont, masks: view.masks, fullPage: spec.fullPage },
          );
          const fontNodes = dom.elements.filter((e) => e.text);
          dom.font_evidence = [];
          const cdp = await context.newCDPSession(page);
          try {
            await cdp.send("DOM.enable");
            await cdp.send("CSS.enable");
            const { root } = await cdp.send("DOM.getDocument");
            for (const e of fontNodes) {
              const { nodeId } = await cdp.send("DOM.querySelector", {
                nodeId: root.nodeId,
                selector: e.selector,
              });
              const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
              const family = e.style["font-family"].split(",")[0].replace(/["']/g, "").trim();
              const generic =
                /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded)$/i.test(
                  family,
                );
              const used = fonts.filter((f) => f.glyphCount > 0);
              const verified =
                used.length > 0 &&
                (generic ||
                  used.every((f) =>
                    (view.fontFamilies?.[family] || [family]).some(
                      (name) =>
                        f.familyName.replaceAll(" ", "").toLowerCase() ===
                        name.replaceAll(" ", "").toLowerCase(),
                    ),
                  ));
              dom.font_evidence.push({ selector: e.selector, family, fonts: used, verified });
              if (!verified) dom.fonts_loaded = false;
            }
            if (!fontNodes.length) dom.fonts_loaded = false;
          } finally {
            await cdp.detach();
          }
          const masks = view.masks.map((m) => page.locator(m.selector));
          for (const mask of masks) assert((await mask.count()) > 0, "Mask matched nothing");
          const prefix = `${view.id}${probe ? ".probe" : ""}`;
          await page.screenshot({
            path: path.join(out, `${prefix}.png`),
            fullPage: !!spec.fullPage,
            animations: "disabled",
            caret: "hide",
            scale: "device",
            mask: masks,
            maskColor: "#000000",
          });
          for (const mask of masks)
            await mask.evaluateAll((nodes) =>
              nodes.forEach((e) => e.setAttribute("aria-hidden", "true")),
            );
          const aria = await page.locator("body").ariaSnapshot();
          const metadata = {
            ...dom,
            spec_hash: digest(spec),
            sha,
            view,
            console: consoleLog,
            aria,
            masks: view.masks,
            mask_rects: maskRects,
            image: `${prefix}.png`,
          };
          await write(path.join(out, `${prefix}.json`), metadata);
          halves.push(metadata);
          await page.close();
        }
        captures.push({ id: view.id, capture: halves[0].image, probe: halves[1].image });
      } finally {
        await context.close();
      }
    }
    await write(path.join(out, "capture.json"), {
      sha,
      spec,
      spec_hash: digest(spec),
      views: captures,
    });
  } finally {
    await browser.close();
  }
}

export function regions(a, b, dpr = 2, fullPage = false) {
  assert.equal(a.width, b.width);
  assert(fullPage || a.height === b.height);
  const width = a.width,
    height = Math.max(a.height, b.height),
    size = width * height;
  assert(size <= 64_000_000, "Image exceeds bounded pixel workspace");
  function align(png) {
    const data = Buffer.alloc(size * 4, 255);
    png.data.copy(data);
    return data;
  }
  const aa = align(a),
    bb = align(b),
    mask = new Uint8Array(size),
    passes = [],
    identical = aa.equals(bb);
  for (const [threshold, floor] of [
    [THRESHOLDS.tolerant, THRESHOLDS.minimum],
    [THRESHOLDS.sensitive, size * THRESHOLDS.ratio],
  ]) {
    const diff = identical ? null : new Uint8Array(size * 4);
    const count = identical
      ? 0
      : pixelmatch(aa, bb, diff, width, height, {
          threshold,
          includeAA: false,
          diffMask: true,
        });
    passes.push({ threshold, count, floor, active: count >= floor });
    if (count >= floor) for (let i = 0; i < size; i++) if (diff[i * 4 + 3]) mask[i] = 1;
  }
  // An empty gated mask cannot grow regions; retain its exact PNG and pass evidence.
  if (passes.every((p) => !p.active)) {
    const raw = new PNG({ width, height });
    raw.data.fill(255);
    return { regions: [], mask: PNG.sync.write(raw), passes };
  }
  // Square dilation in two sliding-window passes, in device pixels.
  const radius = THRESHOLDS.dilation * dpr,
    horizontal = new Uint8Array(size),
    dilated = new Uint8Array(size);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = -radius; x < width; x++) {
      if (x + radius < width) sum += mask[y * width + x + radius];
      if (x - radius - 1 >= 0) sum -= mask[y * width + x - radius - 1];
      if (x >= 0) horizontal[y * width + x] = sum > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y < height; y++) {
      if (y + radius < height) sum += horizontal[(y + radius) * width + x];
      if (y - radius - 1 >= 0) sum -= horizontal[(y - radius - 1) * width + x];
      if (y >= 0) dilated[y * width + x] = sum > 0 ? 1 : 0;
    }
  }
  const seen = new Uint8Array(size),
    queue = new Int32Array(size),
    boxes = [];
  for (let start = 0; start < size; start++) {
    if (!dilated[start] || seen[start]) continue;
    let front = 0,
      end = 1,
      minx = width,
      miny = height,
      maxx = 0,
      maxy = 0;
    queue[0] = start;
    seen[start] = 1;
    while (front < end) {
      const at = queue[front++],
        x = at % width,
        y = Math.floor(at / width);
      minx = Math.min(minx, x);
      miny = Math.min(miny, y);
      maxx = Math.max(maxx, x);
      maxy = Math.max(maxy, y);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx,
            yy = y + dy,
            next = yy * width + xx;
          if (xx >= 0 && xx < width && yy >= 0 && yy < height && dilated[next] && !seen[next]) {
            seen[next] = 1;
            queue[end++] = next;
          }
        }
    }
    if (end / (dpr * dpr) >= THRESHOLDS.area)
      boxes.push(rect(minx / dpr, miny / dpr, (maxx - minx + 1) / dpr, (maxy - miny + 1) / dpr));
  }
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i],
          b = boxes[j];
        const dx = Math.max(0, a.x - b.x - b.w, b.x - a.x - a.w),
          dy = Math.max(0, a.y - b.y - b.h, b.y - a.y - a.h);
        if (Math.hypot(dx, dy) < THRESHOLDS.merge) {
          boxes[i] = union(a, b);
          boxes.splice(j, 1);
          merged = true;
          break outer;
        }
      }
  }
  const raw = new PNG({ width, height });
  for (let i = 0; i < size; i++) {
    const value = mask[i] ? 0 : 255;
    raw.data[i * 4] = value;
    raw.data[i * 4 + 1] = value;
    raw.data[i * 4 + 2] = value;
    raw.data[i * 4 + 3] = 255;
  }
  const bounds = rect(0, 0, width / dpr, height / dpr);
  return {
    regions: boxes
      .map((r) => intersect(expand(r, THRESHOLDS.padding), bounds))
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((bbox_css, i) => ({ id: `r${i + 1}`, bbox_css })),
    mask: PNG.sync.write(raw),
    passes,
  };
}

export function parity(spec, a, b, probe, images) {
  const reasons = [];
  if (![a, b, probe].every((x) => x.spec_hash === digest(spec))) reasons.push("spec_hash");
  if (a.sha === b.sha) reasons.push("same_sha");
  if (
    ![a, b, probe].every(
      (x) =>
        x.fonts_loaded &&
        x.font_evidence?.length > 0 &&
        x.font_evidence.every((f) => f.verified) &&
        x.coordinate_space === (spec.fullPage ? "document" : "viewport") &&
        x.text.trim() &&
        !/^(404|not found|loading|splash)\b/i.test(x.text.trim()) &&
        x.console.every((c) => c.type !== "error") &&
        x.seed === spec.seed,
    )
  )
    reasons.push("page_state");
  if (![b, probe].every((x) => x.scrollY === a.scrollY && x.scrollX === a.scrollX))
    reasons.push("scroll");
  if (
    !images.every(
      (x) => x.width === images[0].width && (spec.fullPage || x.height === images[0].height),
    ) ||
    images[2].height !== images[0].height
  )
    reasons.push("image_size");
  let flake = null;
  if (!reasons.includes("image_size")) {
    flake = regions(images[0], images[2], a.view.dpr, spec.fullPage).regions.length;
    if (flake) reasons.push("flake");
  }
  return { status: reasons.length ? "capture_invalid" : "valid", reasons, flake_regions: flake };
}

export function parityPair(spec, a, b, baseProbe, headProbe, images) {
  const base = parity(spec, a, b, baseProbe, [images[0], images[1], images[2]]);
  const head = parity(spec, b, a, headProbe, [images[1], images[0], images[3]]);
  const reasons = [...base.reasons, ...head.reasons.map((r) => `candidate_${r}`)];
  return {
    status: reasons.length ? "capture_invalid" : "valid",
    reasons,
    flake_regions:
      base.flake_regions === null || head.flake_regions === null
        ? null
        : base.flake_regions + head.flake_regions,
    base_probe: base,
    candidate_probe: head,
  };
}

export function normalizeIntent(input) {
  assert(Array.isArray(input) && input.length <= 512);
  const ids = new Set();
  return input.map((raw) => {
    assert(
      typeof raw.id === "string" && /^[a-z0-9-]+$/.test(raw.id) && !ids.has(raw.id),
      "Duplicate or invalid intent id",
    );
    ids.add(raw.id);
    let item = raw;
    if (Object.hasOwn(raw, "prop")) {
      exact(raw, ["id", "claim", "selector", "prop", "file", "line"]);
      item = {
        id: raw.id,
        claim: raw.claim,
        selector: raw.selector,
        change: "style",
        deltas: [{ prop: raw.prop, file: raw.file, line: raw.line }],
      };
    }
    assert(typeof item.claim === "string" && item.claim.length <= 1000);
    assert(
      typeof item.selector === "string" && item.selector && !/[,*]/.test(item.selector),
      "Broad selectors are not claims",
    );
    if (item.change === "style") {
      exact(item, ["id", "claim", "selector", "change", "deltas"]);
      assert(item.deltas.length > 0);
      const props = new Set();
      for (const d of item.deltas) {
        exact(d, ["prop", "file", "line"]);
        assert(STYLES.includes(d.prop) && !props.has(d.prop));
        props.add(d.prop);
        validateRef(d);
      }
    } else {
      assert(["added", "removed", "text"].includes(item.change));
      exact(item, ["id", "claim", "selector", "change", "file", "line"]);
      validateRef(item);
    }
    return item;
  });
}
function validateRef(r) {
  assert(
    typeof r.file === "string" &&
      r.file &&
      !path.isAbsolute(r.file) &&
      !r.file.split("/").includes("..") &&
      !/[\n\r\0]/.test(r.file),
  );
  assert(Number.isSafeInteger(r.line) && r.line > 0);
}
export function diffHunks(root, base, head) {
  assert(/^[a-f0-9]{40}$/.test(base) && /^[a-f0-9]{40}$/.test(head));
  const diff = git(
    root,
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-ext-diff",
    "--no-renames",
    "--unified=0",
    base,
    head,
    "--",
  );
  const lines = new Map();
  let file = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) file = line.slice(6);
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) {
      if (!lines.has(file)) lines.set(file, []);
      lines.get(file).push([+h[1], +h[1] + +(h[2] ?? 1)]);
    }
  }
  return lines;
}
const verifiedRef = (member, hunks, sha) =>
  hunks.get(member.file)?.some(([lo, hi]) => member.line >= lo && member.line < hi)
    ? {
        file: member.file,
        line: member.line,
        commit: sha,
        in_diff: true,
        source: "intent_verified",
      }
    : "unresolved";

export function attribute(base, head, regions, intent, hunks, sha, view) {
  const inventory = new Map(),
    matches = [],
    allMatches = [];
  for (const [half, elements] of [
    ["before", base],
    ["after", head],
  ])
    for (const el of elements) {
      if (!inventory.has(el.key)) inventory.set(el.key, { before: [], after: [] });
      inventory.get(el.key)[half].push(el);
    }
  for (const pair of inventory.values()) {
    const a = pair.before[0],
      b = pair.after[0],
      node = b || a;
    const ambiguousFallback =
      !node.testid &&
      [base, head].some(
        (nodes) =>
          nodes.filter((e) => !e.testid && e.tag === node.tag && e.text === node.text).length > 1,
      );
    const confidence =
      pair.before.length <= 1 && pair.after.length <= 1 && !ambiguousFallback ? "high" : "low";
    const delta =
      a && b
        ? STYLES.filter((p) => a.style[p] !== b.style[p]).map((prop) => ({
            prop,
            old: a.style[prop],
            new: b.style[prop],
          }))
        : [];
    const size = a && b && (a.rect.w !== b.rect.w || a.rect.h !== b.rect.h);
    const moved = a && b && (a.rect.x !== b.rect.x || a.rect.y !== b.rect.y);
    const matched = {
      before: a,
      after: b,
      selector: node.selector,
      confidence,
      delta,
      size,
      moved: !!moved,
      text_delta: a && b && a.text !== b.text ? { old: a.text, new: b.text } : null,
      shift: !!(a && b && moved && !size && !delta.length && a.text === b.text),
      change: !a
        ? "added"
        : !b
          ? "removed"
          : delta.length
            ? "style"
            : a.text !== b.text
              ? "text"
              : moved
                ? "shift"
                : "unchanged",
    };
    allMatches.push(matched);
    if (!a || !b || delta.length || a.text !== b.text || moved || confidence === "low")
      matches.push(matched);
  }
  const items = [],
    candidates = [];
  for (const claim of intent) {
    const found = allMatches.filter((p) => p.selector === claim.selector);
    const m = found.length === 1 ? found[0] : null;
    const members = claim.change === "style" ? claim.deltas : [claim];
    const refs = members.map((d, i) => ({
      intent_delta_index: i,
      code_ref:
        m?.confidence === "high" &&
        (claim.change === "style"
          ? m.before && m.after && m.delta.some((v) => v.prop === d.prop)
          : claim.change === "text"
            ? !!m.text_delta
            : m.change === claim.change)
          ? verifiedRef(d, hunks, sha)
          : "unresolved",
    }));
    const measured =
      m &&
      m.confidence === "high" &&
      (claim.change === "style"
        ? m.before && m.after && members.every((d) => m.delta.some((v) => v.prop === d.prop))
        : claim.change === "text"
          ? !!m.text_delta
          : m.change === claim.change);
    const valid = measured && refs.every((r) => r.code_ref !== "unresolved");
    const derivedSize = new Set();
    if (m?.before && m.after && claim.change === "style") {
      for (const [dimension, sides] of [
        ["height", ["padding-top", "padding-bottom"]],
        ["width", ["padding-left", "padding-right"]],
      ]) {
        const difference = sides.reduce(
          (n, prop) => n + (parseFloat(m.after.style[prop]) - parseFloat(m.before.style[prop])),
          0,
        );
        if (
          difference &&
          sides
            .filter((prop) => m.delta.some((d) => d.prop === prop))
            .every((prop) => members.some((d) => d.prop === prop)) &&
          parseFloat(m.after.style[dimension]) - parseFloat(m.before.style[dimension]) ===
            difference
        )
          derivedSize.add(dimension);
      }
    }
    const ownDelta =
      m?.delta.filter(
        (d) =>
          ["added", "removed"].includes(claim.change) ||
          members.some((p) => p.prop === d.prop) ||
          derivedSize.has(d.prop),
      ) || [];
    const item = {
      id: claim.id,
      n: 0,
      status: "unverified_claim",
      scope: "local",
      change: claim.change,
      regions: [],
      element: m
        ? element(m.after || m.before)
        : { selector: claim.selector, role: null, name: claim.id },
      match_confidence: m?.confidence || "low",
      style_delta: ownDelta,
      text_delta: m?.text_delta || null,
      contributors: [],
      token: null,
      code_ref:
        valid && refs.every((r) => same(r.code_ref, refs[0].code_ref))
          ? refs[0].code_ref
          : "unresolved",
      code_refs: refs,
      label: "",
      rationale: "",
      label_author: null,
      facts_author: "deterministic",
      intent_ref: claim.id,
      reviewer_findings: [],
      shifts: [],
      verification: { measured: !!measured, valid: !!valid },
      geometry: m ? { before: m.before?.rect || null, after: m.after?.rect || null } : null,
    };
    items.push(item);
    if (m)
      candidates.push({
        m,
        item,
        valid,
        residual: [
          ...m.delta.filter((d) => !ownDelta.includes(d)),
          ...(m.text_delta && claim.change !== "text" ? [{ prop: "text" }] : []),
          ...(m.moved && !marginMotion(m, ownDelta) ? [{ prop: "position" }] : []),
        ],
      });
  }
  const shifts = matches.filter((m) => m.shift && m.confidence === "high");
  for (const m of shifts) {
    const dx = m.after.rect.x - m.before.rect.x,
      dy = m.after.rect.y - m.before.rect.y;
    const prior = candidates
      .filter(
        (c) =>
          c.valid &&
          !c.residual.length &&
          c.m.size &&
          c.m.before.rect.y + c.m.before.rect.h <= m.before.rect.y &&
          dx === 0 &&
          dy !== 0 &&
          c.m.after.rect.h - c.m.before.rect.h === dy &&
          c.m.after.rect.w === c.m.before.rect.w &&
          [m.before, m.after, c.m.before, c.m.after].every(
            (e) =>
              e.flow &&
              e.flow.parent === m.before.flow?.parent &&
              e.flow.position === "static" &&
              e.flow.float === "none" &&
              ["transform", "translate", "rotate", "scale"].every((p) => e.flow[p] === "none") &&
              ["block", "flow-root"].includes(e.flow.parent_display) &&
              e.flow.writing_mode === "horizontal-tb",
          ),
      )
      .sort((a, b) => b.m.before.rect.y - a.m.before.rect.y);
    if (
      prior.length &&
      (prior.length === 1 || prior[0].m.before.rect.y !== prior[1].m.before.rect.y)
    ) {
      const c = prior[0];
      if (c.item.shifts.every((s) => s.dx === dx && s.dy === dy)) {
        c.item.shifts.push({
          kind: "shift",
          element: element(m.after),
          before: m.before.rect,
          after: m.after.rect,
          dx,
          dy,
          region_ids: [],
          parent_cause_id: c.item.id,
        });
        candidates.push({ m, item: c.item, valid: true, residual: [], folded: true });
      }
    }
  }
  const unknown = new Map();
  for (const region of regions) {
    const scores = matches
      .map((m) => {
        const boxes = [m.before?.rect, m.after?.rect].filter(Boolean);
        return {
          m,
          score: Math.max(
            ...boxes.map(
              (box) => overlap(region.bbox_css, box) / (area(union(region.bbox_css, box)) || 1),
            ),
          ),
          depth: (m.after || m.before).depth,
        };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.depth - a.depth || b.score - a.score);
    // Canvas/image pixels are not changes to the enclosing DOM element's appearance.
    const domless = [...base, ...head].some(
      (e) =>
        ["canvas", "video", "img"].includes(e.tag) &&
        overlap(e.rect, region.bbox_css) > 0 &&
        !matches.some((m) => m.selector === e.selector),
    );
    const best = domless ? null : scores[0]?.m;
    const causes = candidates.filter((c) => c.m === best);
    const contributors = scores.filter((s) => !aggregateAncestor(s.m, best));
    const owners = new Set(
      contributors.map((s) => {
        const claims = candidates.filter((c) => c.m === s.m);
        return claims.length === 1 && claims[0].valid && !claims[0].residual.length
          ? claims[0].item.id
          : `unknown:${s.m.selector}`;
      }),
    );
    const ambiguous = owners.size > 1;
    const c = causes.length === 1 && !ambiguous ? causes[0] : null;
    let item = c?.valid && !c.residual.length ? c.item : null;
    if (!item) {
      const key = best?.selector || region.id;
      if (!unknown.has(key)) {
        const deltas = best?.delta || [];
        const u = {
          id: `unexplained-${unknown.size + 1}`,
          n: 0,
          status: "unexplained",
          scope: "local",
          change: best?.change || "image",
          regions: [],
          element: best && !domless ? element(best.after || best.before) : null,
          match_confidence:
            ambiguous || best?.confidence === "low" ? "low" : best ? "high" : "none",
          style_delta: deltas,
          text_delta: best?.text_delta || null,
          contributors: ambiguous
            ? contributors.map(({ m }) => ({
                element: element(m.after || m.before),
                style_delta: m.delta,
                text_delta: m.text_delta,
              }))
            : [],
          token: null,
          code_ref: "unresolved",
          code_refs: [],
          label: "",
          rationale: "",
          label_author: null,
          facts_author: "deterministic",
          intent_ref: null,
          reviewer_findings: [],
          shifts: [],
          geometry: best
            ? { before: best.before?.rect || null, after: best.after?.rect || null }
            : null,
        };
        unknown.set(key, u);
        items.push(u);
      }
      item = unknown.get(key);
      if (ambiguous)
        for (const { m } of contributors)
          if (!item.contributors.some((c) => c.element.selector === m.selector))
            item.contributors.push({
              element: element(m.after || m.before),
              style_delta: m.delta,
              text_delta: m.text_delta,
            });
    } else item.status = "explained";
    const presence = ambiguous ? contributors.map((s) => s.m) : best ? [best] : [];
    const hasBefore = !presence.length || presence.some((m) => m.before);
    const hasAfter = !presence.length || presence.some((m) => m.after);
    const half = hasBefore && hasAfter ? "both" : hasBefore ? "before" : "after";
    const targets = regionTargets(region.bbox_css, ambiguous ? null : best, view);
    const r = {
      ...region,
      half,
      before: half === "after" ? null : targets.before,
      after: half === "before" ? null : targets.after,
    };
    if (c?.folded) {
      const s = c.item.shifts.find((s) => s.element.selector === best.selector);
      s.region_ids.push(region.id);
    }
    item.regions.push(r);
    for (const shift of item.shifts)
      if (
        overlap(union(shift.before, shift.after), region.bbox_css) &&
        !shift.region_ids.includes(region.id)
      )
        shift.region_ids.push(region.id);
  }
  for (const item of items) {
    if (
      item.regions.length > 3 ||
      item.regions.reduce((sum, r) => sum + area(r.bbox_css), 0) / (view.width * view.height) > 0.3
    )
      item.scope = "global";
  }
  items.sort(
    (a, b) =>
      (a.status === "unexplained" ? 0 : a.status === "explained" ? 1 : 2) -
        (b.status === "unexplained" ? 0 : b.status === "explained" ? 1 : 2) ||
      (a.regions[0]?.bbox_css.y ?? Infinity) - (b.regions[0]?.bbox_css.y ?? Infinity) ||
      (a.regions[0]?.bbox_css.x ?? Infinity) - (b.regions[0]?.bbox_css.x ?? Infinity) ||
      a.id.localeCompare(b.id, "en"),
  );
  items.forEach((item, i) => {
    item.n = i + 1;
    item.id = `${view.id}#${i + 1}`;
    for (const shift of item.shifts) shift.parent_cause_id = item.id;
  });
  return { items, matches };
}
function element(e) {
  return { selector: e.selector, role: e.role, name: e.name };
}

function marginMotion(m, deltas) {
  const a = m.before,
    b = m.after;
  if (
    !a?.flow?.inset ||
    !b?.flow?.inset ||
    !same(a.flow, b.flow) ||
    ![a, b].every((e) =>
      ["transform", "translate", "rotate", "scale"].every((p) => e.flow[p] === "none"),
    )
  )
    return false;
  // Only a measured, claimed margin displacement with unchanged positioning is derived here.
  return [
    ["x", "margin-left"],
    ["y", "margin-top"],
  ].every(([axis, prop]) => {
    const delta = deltas.find((d) => d.prop === prop);
    return (
      b.rect[axis] - a.rect[axis] === (delta ? parseFloat(delta.new) - parseFloat(delta.old) : 0)
    );
  });
}

function aggregateAncestor(ancestor, descendant) {
  if (
    !descendant ||
    ancestor === descendant ||
    ancestor.text_delta ||
    ancestor.moved ||
    !ancestor.delta.length
  )
    return false;
  return (
    ["before", "after"].every((h) => {
      const a = ancestor[h],
        d = descendant[h];
      return (
        a &&
        d &&
        d.ancestors?.includes(a.selector) &&
        a.style["background-color"] === "rgba(0, 0, 0, 0)" &&
        a.style["box-shadow"] === "none" &&
        ["top", "right", "bottom", "left"].every(
          (side) => a.style[`border-${side}-width`] === "0px",
        )
      );
    }) && ancestor.delta.every((d) => ["width", "height"].includes(d.prop))
  );
}

export function regionTargets(box, match, view) {
  const a = match?.before?.rect,
    b = match?.after?.rect;
  if (!a || !b || (a.x === b.x && a.y === b.y)) return { before: box, after: box };
  // Keep raw region ownership, but project its changed patches onto each moved half.
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const pad = THRESHOLDS.dilation + THRESHOLDS.padding;
  const oldPatch = intersect(box, expand(a, pad));
  const newPatch = intersect(box, expand(b, pad));
  if (!area(oldPatch) && !area(newPatch)) return { before: box, after: box };
  const translate = (r, x, y) => ({ ...r, x: r.x + x, y: r.y + y });
  const join = (patches) => patches.filter((r) => area(r) > 0).reduce(union);
  const bounds = rect(0, 0, view.width, view.height);
  return {
    before: intersect(join([oldPatch, translate(newPatch, -dx, -dy)]), bounds),
    after: intersect(join([translate(oldPatch, dx, dy), newPatch]), bounds),
  };
}

export function validateLabels(items, labels, names) {
  assert(
    Array.isArray(labels) && labels.length === items.length,
    "Labels must preserve every item",
  );
  const seen = new Set();
  const neutral = new Set(
    "measured visual appearance change changed update adjust preserve verify evidence".split(" "),
  );
  for (const label of labels) {
    exact(label, ["id", "label", "rationale"]);
    const item = items.find((i) => i.id === label.id);
    assert(item && !seen.has(label.id), "Unknown or duplicate label");
    seen.add(label.id);
    const facts = canonical([item.style_delta, item.token]);
    const templates = new Set();
    const add = (phrase) => {
      templates.add(phrase.toLowerCase());
      if (item.element?.name) templates.add(`${item.element.name} ${phrase}`.toLowerCase());
    };
    for (const d of item.status === "unverified_claim" ? [] : item.style_delta) {
      const aliases = new Set([d.prop, d.prop.replaceAll("-", " ")]);
      if (/^(padding|margin)-/.test(d.prop)) aliases.add(d.prop.split("-")[0]);
      if (/^border-.*-radius$/.test(d.prop)) aliases.add("border radius");
      if (/^border-.*-color$/.test(d.prop)) {
        aliases.add("border colour");
        aliases.add("border color");
      }
      for (const prop of aliases) {
        add(`${prop} changed`);
        add(`${prop} changed from ${d.old} to ${d.new}`);
      }
    }
    if (item.status === "unexplained") add("unclaimed visual change");
    if (item.status === "unverified_claim") {
      add("no visible change");
      add("no visible evidence");
    }
    if (item.status !== "unverified_claim" && ["added", "removed", "text"].includes(item.change))
      add(`${item.change} change`);
    for (const [key, limit] of [
      ["label", 12],
      ["rationale", 25],
    ]) {
      const text = label[key];
      assert(
        typeof text === "string" &&
          text.trim() === text &&
          (key !== "label" || text.length > 0) &&
          text.length <= 500 &&
          text.split(/\s+/u).filter(Boolean).length <= limit,
      );
      assert(!/[\n\r<>]/.test(text));
      assert(!/^[a-z]/.test(text), "Use sentence case");
      const numeric = text.match(/#[0-9a-f]{3,8}\b|[-+]?\d+(?:\.\d+)?(?:px|%|em|rem)?/gi) || [];
      const allowedNumbers = new Set(
        (facts.match(/#[0-9a-f]{3,8}\b|[-+]?\d+(?:\.\d+)?(?:px|%|em|rem)?/gi) || []).map((v) =>
          v.toLowerCase(),
        ),
      );
      for (const value of numeric)
        assert(allowedNumbers.has(value.toLowerCase()), `Invented value: ${value}`);
      for (const name of names)
        if (name && name !== item.element?.name && name.length > 2)
          assert(
            !text.toLowerCase().includes(name.toLowerCase()),
            `Names another element: ${name}`,
          );
      const words = text.toLowerCase().split(/\s+/u).filter(Boolean);
      assert(
        templates.has(text.toLowerCase()) ||
          !text ||
          (item.status !== "unverified_claim" && words.every((w) => neutral.has(w))),
        "Unreconciled wording: use a fact-bound template or neutral change wording",
      );
    }
  }
  return true;
}

export function splitView(view) {
  if (view.items.length <= 8) return [view];
  const visible = view.items.filter((i) => i.regions.length),
    invisible = view.items.filter((i) => !i.regions.length);
  const bounds = (i) => i.regions.map((r) => r.bbox_css).reduce(union);
  function divide(items) {
    if (items.length <= 6) return [items];
    const cuts = [];
    for (const axis of ["x", "y"]) {
      const span = axis === "x" ? "w" : "h",
        ordered = [...items].sort((a, b) => bounds(a)[axis] - bounds(b)[axis]);
      for (let n = 1; n < ordered.length; n++) {
        const far = Math.max(...ordered.slice(0, n).map((i) => bounds(i)[axis] + bounds(i)[span])),
          near = bounds(ordered[n])[axis];
        if (far < near)
          cuts.push({
            a: ordered.slice(0, n),
            b: ordered.slice(n),
            balance: Math.abs(n - ordered.length / 2),
            axis,
          });
      }
    }
    cuts.sort((a, b) => a.balance - b.balance || a.axis.localeCompare(b.axis, "en"));
    if (!cuts.length) {
      assert(items.length <= 8, "too_many_regions");
      return [items];
    }
    return [...divide(cuts[0].a), ...divide(cuts[0].b)];
  }
  const groups = visible.length ? divide(visible) : [[]];
  for (const item of invisible) {
    let group = groups.find((g) => g.length < 6);
    if (!group) {
      group = [];
      groups.push(group);
    }
    group.push(item);
  }
  return groups.map((group, n) => {
    const part = structuredClone(view),
      selected = new Set(group.map((i) => i.id));
    const bounding =
      group
        .filter((i) => i.regions.length)
        .map(bounds)
        .reduce((a, b) => (a ? union(a, b) : b), null) ||
      rect(0, 0, view.width, Math.min(32, view.height));
    const crop = intersect(expand(bounding, 20), rect(0, 0, view.width, view.height));
    crop.x = Math.floor(crop.x);
    crop.y = Math.floor(crop.y);
    crop.w = Math.min(view.width - crop.x, Math.ceil(crop.w));
    crop.h = Math.min(view.height - crop.y, Math.ceil(crop.h));
    part.source_id = view.id;
    part.id = `${view.id}-part-${n + 1}`;
    part.mask = `${part.id}.mask.png`;
    part.crop = crop;
    part.capture_viewport = { width: view.width, height: view.height };
    part.layout = view.width === 390 ? "side-by-side" : "stacked";
    part.width = crop.w;
    part.height = crop.h;
    const move = (r) => (r ? { ...r, x: r.x - crop.x, y: r.y - crop.y } : null);
    part.items = part.items.filter((i) => selected.has(i.id));
    part.items.forEach((i, n) => {
      i.origin_item_id = i.id;
      i.n = n + 1;
      i.id = `${part.id}#${n + 1}`;
      i.regions = i.regions.map((r) => ({
        ...r,
        source_bbox_css: r.bbox_css,
        bbox_css: move(r.bbox_css),
        before: move(r.before),
        after: move(r.after),
      }));
      for (const s of i.shifts) s.parent_cause_id = i.id;
    });
    part.regions = part.items.flatMap((i) =>
      i.regions.map((r) => ({
        id: r.id,
        bbox_css: r.bbox_css,
        source_bbox_css: r.source_bbox_css,
      })),
    );
    part.unexplained_count = part.items.filter((i) => i.status === "unexplained").length;
    part.unverified_claims = part.items.filter((i) => i.status === "unverified_claim").length;
    part.alt = `${part.id} ${part.theme}: ${part.items.length} changes, ${part.unexplained_count} unexplained; see list below`;
    return part;
  });
}
async function capturedImage(dir, half, view) {
  const buffer = await fs.readFile(path.join(dir, half, `${view.source_id || view.id}.png`));
  if (!view.crop) return buffer;
  const r = view.crop;
  const metadata = await sharp(buffer).metadata();
  const padded = await sharp(buffer)
    .extend({ bottom: Math.max(0, (r.y + r.h) * view.dpr - metadata.height), background: "white" })
    .png()
    .toBuffer();
  return sharp(padded)
    .extract({
      left: r.x * view.dpr,
      top: r.y * view.dpr,
      width: r.w * view.dpr,
      height: r.h * view.dpr,
    })
    .png()
    .toBuffer();
}

function comparisonView(view, spec, mapping, images, items, diff, base, head) {
  return {
    ...view,
    blind: !!spec.blind,
    blind_reverse: mapping?.A === "head",
    height: Math.max(...images.map((p) => p.height)) / view.dpr,
    items,
    regions: diff.regions,
    pixel_passes: diff.passes,
    element_names: [...new Set([...base.elements, ...head.elements].map((e) => e.name))],
    mask: `${view.id}.mask.png`,
    images: [],
    alt: `${view.id} ${view.theme}: ${items.length} changes, ${items.filter((i) => i.status === "unexplained").length} unexplained; see list below`,
    unexplained_count: items.filter((i) => i.status === "unexplained").length,
    unverified_claims: items.filter((i) => i.status === "unverified_claim").length,
  };
}

export async function compare({ dir, root, intent }) {
  await write(path.join(dir, "annotated-diff.manifest.json"), {
    schema: "annotated-diff/v0",
    status: "diffing",
    checks: { passed: false },
    judge_eligible: false,
  });
  const a = await read(path.join(dir, "base/capture.json")),
    b = await read(path.join(dir, "head/capture.json"));
  validateSpec(a.spec);
  validateSpec(b.spec);
  assert.equal(a.spec_hash, digest(a.spec));
  assert.equal(b.spec_hash, digest(b.spec));
  assert.equal(a.spec_hash, b.spec_hash);
  assert(same(await runtime(), a.spec.runtime), "Capture runtime is no longer pinned to this tool");
  const claims = normalizeIntent(intent),
    hunks = diffHunks(root, a.sha, b.sha);
  const result = {
    schema: "annotated-diff/v0",
    repository: path.relative(dir, root),
    base: a.sha,
    head: b.sha,
    capture_spec: a.spec,
    capture_spec_hash: a.spec_hash,
    capture_inputs: [],
    intent: claims,
    flake_probe: [],
    views: [],
    checks: {},
    tool_versions: {
      ...(await runtime()),
      pixelmatch: "7.1.0",
      pngjs: "7.0.0",
      sharp: sharp.versions,
    },
    status: "wording_required",
  };
  result.blind_mapping = a.spec.blind
    ? randomInt(2)
      ? { A: "head", B: "base" }
      : { A: "base", B: "head" }
    : null;
  for (const file of [
    "base/capture.json",
    "head/capture.json",
    ...a.spec.views.flatMap((v) => [
      `base/${v.id}.json`,
      `base/${v.id}.png`,
      `base/${v.id}.probe.json`,
      `base/${v.id}.probe.png`,
      `head/${v.id}.json`,
      `head/${v.id}.png`,
      `head/${v.id}.probe.json`,
      `head/${v.id}.probe.png`,
    ]),
  ])
    result.capture_inputs.push({ file, sha256: hash(await fs.readFile(path.join(dir, file))) });
  for (const view of a.spec.views) {
    const [base, head, probe, headProbe] = await Promise.all(
      [`base/${view.id}`, `head/${view.id}`, `base/${view.id}.probe`, `head/${view.id}.probe`].map(
        (p) => read(path.join(dir, `${p}.json`)),
      ),
    );
    const images = await Promise.all(
      [base.image, head.image, probe.image, headProbe.image].map((p, i) =>
        fs.readFile(path.join(dir, i % 2 ? "head" : "base", p)).then(PNG.sync.read),
      ),
    );
    const gate = parityPair(a.spec, base, head, probe, headProbe, images);
    if (
      base.sha !== a.sha ||
      probe.sha !== a.sha ||
      head.sha !== b.sha ||
      headProbe.sha !== b.sha ||
      !same(base.view, view) ||
      !same(head.view, view) ||
      !same(probe.view, view) ||
      !same(headProbe.view, view)
    ) {
      gate.status = "capture_invalid";
      gate.reasons.push("capture_identity");
    }
    result.flake_probe.push({ id: view.id, ...gate });
    if (gate.status !== "valid") {
      result.status = "capture_invalid";
      continue;
    }
    const diff = regions(images[0], images[1], view.dpr, a.spec.fullPage);
    const attribution = attribute(
      base.elements,
      head.elements,
      diff.regions,
      claims,
      hunks,
      b.sha,
      { ...view, height: Math.max(images[0].height, images[1].height) / view.dpr },
    );
    const mask = `${view.id}.mask.png`;
    await fs.writeFile(path.join(dir, mask), diff.mask);
    const output = comparisonView(
      view,
      a.spec,
      result.blind_mapping,
      images,
      attribution.items,
      diff,
      base,
      head,
    );
    let parts;
    try {
      parts = splitView(output);
    } catch (error) {
      result.status = "too_many_regions";
      await write(path.join(dir, "annotated-diff.manifest.json"), result);
      throw error;
    }
    for (const part of parts) {
      if (part.crop) {
        const r = part.crop;
        part.mask = `${part.id}.mask.png`;
        await fs.writeFile(
          path.join(dir, part.mask),
          await sharp(diff.mask)
            .extract({
              left: r.x * view.dpr,
              top: r.y * view.dpr,
              width: r.w * view.dpr,
              height: r.h * view.dpr,
            })
            .png()
            .toBuffer(),
        );
      }
      result.views.push(part);
    }
  }
  await write(path.join(dir, "comparison.json"), {
    base: a.sha,
    head: b.sha,
    capture_spec_hash: a.spec_hash,
    blind_mapping: result.blind_mapping,
    presentation: result.views.map(presentation),
  });
  result.capture_inputs.push({
    file: "comparison.json",
    sha256: hash(await fs.readFile(path.join(dir, "comparison.json"))),
  });
  await write(path.join(dir, "annotated-diff.manifest.json"), result);
  if (result.status === "capture_invalid")
    throw new Error(`capture_invalid: ${canonical(result.flake_probe)}`);
  await write(
    path.join(dir, "labels.todo.json"),
    result.views.flatMap((v) => v.items.map((i) => ({ id: i.id, label: "", rationale: "" }))),
  );
  return result;
}

const rgb = (hex) => hex.match(/[0-9a-f]{2}/gi).map((v) => parseInt(v, 16) / 255);
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (c) => c.map(linear).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
export const contrast = (a, b) =>
  (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
function oklab(c) {
  const [r, g, b] = c.map(linear),
    l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b),
    m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
    s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const distance = (a, b) => Math.hypot(...oklab(a).map((v, i) => v - oklab(b)[i]));
export function palette(pngs) {
  const buckets = new Map();
  for (const png of pngs)
    for (let i = 0; i < png.data.length; i += 16) {
      const key = [png.data[i], png.data[i + 1], png.data[i + 2]]
        .map((v) => Math.round(v / 16) * 16)
        .join(",");
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
  const dominant = [...buckets]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k]) => k.split(",").map((v) => Math.min(255, +v) / 255));
  for (const [fill, ink] of [
    ["#D55E00", "#000000"],
    ["#0072B2", "#FFFFFF"],
    ["#CC79A7", "#000000"],
  ])
    if (dominant.every((c) => distance(c, rgb(fill)) >= 0.1))
      return { fill, ink, contrast: contrast(rgb(fill), rgb(ink)), dominant };
  throw new Error("No prescribed badge palette is distinguishable from dominant colours");
}
export function segmentsCross(a, b) {
  const orient = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return (
    orient(a[0], a[1], b[0]) * orient(a[0], a[1], b[1]) < 0 &&
    orient(b[0], b[1], a[0]) * orient(b[0], b[1], a[1]) < 0
  );
}
const textFact = (delta, view) =>
  delta
    ? ` · text: ${JSON.stringify(view.blind_reverse ? delta.new : delta.old)} → ${JSON.stringify(view.blind_reverse ? delta.old : delta.new)}`
    : "";
const facts = (item, view = {}) =>
  `${item.status.toUpperCase()} · ${item.element?.name || "Image change"} · ${item.style_delta.map((d) => `${d.prop}: ${view.blind_reverse ? d.new : d.old} → ${view.blind_reverse ? d.old : d.new}`).join("; ") || (view.blind && ["added", "removed"].includes(item.change) ? `present in ${(item.change === "added") !== view.blind_reverse ? "B" : "A"} only` : item.change)}${textFact(item.text_delta, view)}${(item.contributors || []).map((c) => ` · contributor ${c.element.name}: ${c.style_delta.map((d) => `${d.prop}: ${view.blind_reverse ? d.new : d.old} → ${view.blind_reverse ? d.old : d.new}`).join("; ")}${textFact(c.text_delta, view)}`).join("")}${item.token ? ` · ${item.token}` : ""}${item.scope === "global" ? " · applies across the view" : ""}${item.shifts.map((s) => ` · ${s.element.name} shift (${view.blind_reverse ? -s.dx : s.dx}, ${view.blind_reverse ? -s.dy : s.dy}) CSS px`).join("")} · ${
    [item.code_ref, ...item.code_refs.map((r) => r.code_ref)]
      .filter((r) => r !== "unresolved")
      .map((r) => `${r.file}:${r.line}`)
      .filter((x, i, a) => a.indexOf(x) === i)
      .join(", ") || "unresolved"
  }`;

const escMd = (text) =>
  String(text)
    .replace(/[\\`*_{}\[\]()<>#!|]/g, (c) => String.fromCharCode(92) + c)
    .replace(/[\n\r]/g, " ");

function legend(view, judge = false) {
  return (
    view.items
      .map((i) =>
        judge
          ? `${i.n}. ${escMd(facts(i, view))}`
          : `${i.n}. **${escMd(i.label)}** — ${escMd(facts(i, view))}${i.rationale ? ` — ${escMd(i.rationale)}` : ""}`,
      )
      .join("\n") || "No surviving visual changes."
  );
}

export function markdownFiles(manifest) {
  const files = {};
  let markdown = `## Before / after\n\nCapture spec: \`${manifest.capture_spec_hash}\` · ${manifest.capture_spec.runtime.playwright} · ${manifest.capture_spec.runtime.os_image} · seeded ${manifest.capture_spec.seed}\n\n`;
  for (const view of manifest.views) {
    files[`${view.id}.judge.md`] =
      `![${view.alt}](${view.id}.judge.png)\n\n${legend(view, true)}\n`;
    markdown += `![${view.alt}](${view.id}.annotated.png)\n\n${legend(view)}\n\n[Clean pair](${view.id}.clean.png) · [Raw mask](${view.id}.mask.png) · [Facts-only comparison](${view.id}.judge.md)\n\n`;
  }
  return { ...files, "pr-section.md": markdown, "gallery.md": markdown };
}

export async function verifyMarkdown(dir, manifest) {
  for (const [file, expected] of Object.entries(markdownFiles(manifest)))
    if ((await fs.readFile(path.join(dir, file), "utf8")) !== expected) return false;
  return manifest.views.every((v) => v.legend === legend(v) && v.judge_legend === legend(v, true));
}

export function segmentHitsRect(line, box) {
  let lo = 0,
    hi = 1;
  for (const [axis, span] of [
    ["x", "w"],
    ["y", "h"],
  ]) {
    const start = line[0][axis],
      delta = line[1][axis] - start,
      min = box[axis],
      max = min + box[span];
    if (!delta) {
      if (start <= min || start >= max) return false;
      continue;
    }
    const a = (min - start) / delta,
      b = (max - start) / delta;
    lo = Math.max(lo, Math.min(a, b));
    hi = Math.min(hi, Math.max(a, b));
  }
  return lo < hi && hi > 0 && lo < 1;
}

export function geometry(view) {
  const horizontal = view.layout === "side-by-side" || (!view.layout && view.width === 390),
    gutter = 56,
    header = 76,
    gap = 52,
    panelWidth = view.width + gutter * 2;
  const width = horizontal ? panelWidth * 2 : panelWidth,
    pairHeight = horizontal ? view.height : view.height * 2 + gap;
  const halves = {
    before: { x: gutter, y: header },
    after: {
      x: horizontal ? panelWidth + gutter : gutter,
      y: horizontal ? header : header + view.height + gap,
    },
  };
  if (view.blind_reverse) [halves.before, halves.after] = [halves.after, halves.before];
  const marks = [],
    last = { left: -20, right: -20 };
  const pool = view.items
    .flatMap((item) =>
      item.regions
        .slice(0, item.scope === "global" ? 3 : undefined)
        .map((region) => ({ item, region, bbox: region.bbox_css })),
    )
    .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
  for (const { item, region, bbox } of pool) {
    const choices = [];
    for (const side of ["left", "right"]) {
      const first = Math.max(15, Math.min(view.height - 15, bbox.y + bbox.h / 2), last[side] + 30);
      for (let by = first; by <= view.height - 15; by += 15) {
        const proposed = [];
        for (const half of ["before", "after"]) {
          if (!region[half]) continue;
          const r = region[half],
            origin = halves[half],
            badge = { x: origin.x + (side === "left" ? -28 : view.width + 28), y: origin.y + by },
            outline = { x: origin.x + r.x - 3, y: origin.y + r.y - 3, w: r.w + 6, h: r.h + 6 };
          const line = [
            { x: badge.x + (side === "left" ? 14 : -14), y: badge.y },
            { x: side === "left" ? outline.x : outline.x + outline.w, y: origin.y + r.y + r.h / 2 },
          ];
          proposed.push({
            half,
            item_id: item.id,
            n: item.n,
            status: item.status,
            scope: item.scope,
            region_id: region.id,
            badge,
            outline,
            line,
          });
        }
        const safe = proposed.every(
          (m) =>
            !view.items.some((i) =>
              i.regions.some(
                (r) =>
                  r[m.half] &&
                  segmentHitsRect(m.line, {
                    ...r[m.half],
                    x: halves[m.half].x + r[m.half].x,
                    y: halves[m.half].y + r[m.half].y,
                  }),
              ),
            ) &&
            !marks.some(
              (p) =>
                p.half === m.half &&
                (segmentsCross(p.line, m.line) ||
                  overlap(
                    rect(p.badge.x - 15, p.badge.y - 15, 30, 30),
                    rect(m.badge.x - 15, m.badge.y - 15, 30, 30),
                  ) > 0),
            ),
        );
        if (safe) {
          choices.push({
            side,
            by,
            proposed,
            cost: proposed.reduce(
              (sum, m) => sum + Math.hypot(m.line[0].x - m.line[1].x, m.line[0].y - m.line[1].y),
              0,
            ),
          });
          break;
        }
      }
    }
    choices.sort((a, b) => a.cost - b.cost || a.side.localeCompare(b.side, "en"));
    assert(choices.length, "geometry_unroutable");
    const choice = choices[0];
    last[choice.side] = choice.by;
    marks.push(...choice.proposed);
  }
  return { width, pairHeight, header, gap, halves, marks };
}
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

async function renderView(browser, dir, manifest, view, colours, judge) {
  const g = geometry(view),
    insetItems = view.items.filter(
      (i) =>
        i.regions.length &&
        (i.regions.some((r) => r.bbox_css.w < 32 || r.bbox_css.h < 32) ||
          i.style_delta.some(
            (d) =>
              /font|opacity|color/.test(d.prop) ||
              Math.abs(parseFloat(d.old) - parseFloat(d.new)) <= 2,
          )),
    );
  const font = (
    await fs.readFile(
      new URL(
        "../../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2",
        import.meta.url,
      ),
    )
  ).toString("base64");
  const bold = (
    await fs.readFile(
      new URL(
        "../../node_modules/@fontsource/inter/files/inter-latin-700-normal.woff2",
        import.meta.url,
      ),
    )
  ).toString("base64");
  const png = {};
  for (const half of ["before", "after"])
    png[half] = (await capturedImage(dir, half === "before" ? "base" : "head", view)).toString(
      "base64",
    );
  const legends = view.items
    .map(
      (i) =>
        `<li><b>${i.n} ${esc(judge ? i.element?.name || "Image change" : i.label)}</b> — ${esc(facts(i, view))}${judge ? "" : `<br>${esc(i.rationale)}`}</li>`,
    )
    .join("");
  const context = await browser.newContext({
    viewport: { width: g.width, height: 800 },
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    await page.setContent(
      `<style>@font-face{font-family:Inter;src:url(data:font/woff2;base64,${font})}@font-face{font-family:Inter;src:url(data:font/woff2;base64,${bold});font-weight:700}*{box-sizing:border-box}body{margin:0;background:white;color:black;font:14px/1.6 Inter}h1{font-size:18px;margin:12px 56px}canvas{display:block}ol{margin:16px 56px;padding-left:24px}li{margin:12px 0;overflow-wrap:anywhere}#insets{margin:16px 56px}p{margin:0}</style><h1>${esc(view.id)} · ${esc(view.theme)} · ${view.width}×${view.height}</h1><canvas id="pair" width="${g.width}" height="${g.header + g.pairHeight + 24}"></canvas><div id="insets"></div><ol>${legends}</ol>`,
    );
    g.label_fonts = await page.evaluate(async () => {
      await Promise.all([
        document.fonts.load("14px Inter"),
        document.fonts.load("bold 14px Inter"),
      ]);
      await document.fonts.ready;
      return [...document.fonts].map((f) => ({
        family: f.family,
        weight: f.weight,
        status: f.status,
      }));
    });
    assert(
      g.label_fonts.length === 2 && g.label_fonts.every((f) => f.status === "loaded"),
      "Label font fallback",
    );
    const draw = await page.evaluate(
      async ({ g, view, png, colours, base, head, insetItems }) => {
        const canvas = document.getElementById("pair"),
          c = canvas.getContext("2d"),
          images = {};
        const load = (src) =>
          new Promise((ok, fail) => {
            const i = new Image();
            i.onload = () => ok(i);
            i.onerror = fail;
            i.src = src;
          });
        c.fillStyle = "white";
        c.fillRect(0, 0, canvas.width, canvas.height);
        c.font = "14px Inter";
        c.fillStyle = "black";
        for (const half of ["before", "after"]) {
          const o = g.halves[half];
          images[half] = await load(`data:image/png;base64,${png[half]}`);
          c.fillText(
            view.blind
              ? (half === "before") !== view.blind_reverse
                ? "A"
                : "B"
              : `${half === "before" ? "BEFORE · base" : "AFTER · candidate"} @${(half === "before" ? base : head).slice(0, 7)}`,
            o.x,
            o.y - 20,
          );
          c.drawImage(images[half], o.x, o.y, view.width, images[half].height / view.dpr);
        }
        for (const m of g.marks) {
          c.strokeStyle = "black";
          c.lineWidth = 1;
          c.beginPath();
          c.moveTo(m.line[0].x, m.line[0].y);
          c.lineTo(m.line[1].x, m.line[1].y);
          c.stroke();
          c.lineWidth = 2;
          c.beginPath();
          c.roundRect(m.outline.x, m.outline.y, m.outline.w, m.outline.h, 2);
          c.stroke();
          for (const [radius, fill] of [
            [15, "black"],
            [14, "white"],
            [12, colours.fill],
          ]) {
            c.fillStyle = fill;
            c.beginPath();
            if (m.status === "unexplained")
              c.rect(m.badge.x - radius, m.badge.y - radius, radius * 2, radius * 2);
            else c.arc(m.badge.x, m.badge.y, radius, 0, Math.PI * 2);
            c.fill();
          }
          if (m.status === "unexplained") {
            c.setLineDash([3, 2]);
            c.strokeStyle = "black";
            c.lineWidth = 1;
            c.strokeRect(m.badge.x - 12, m.badge.y - 12, 24, 24);
            c.setLineDash([]);
          }
          c.fillStyle = colours.ink;
          c.font = "bold 14px Inter";
          c.textAlign = "center";
          c.textBaseline = "middle";
          c.fillText(
            `${m.n}${m.status === "unexplained" ? "!" : m.scope === "global" ? "∗" : ""}`,
            m.badge.x,
            m.badge.y,
          );
        }
        const insets = [];
        for (const i of insetItems) {
          const r = i.regions[0],
            strip = document.createElement("div"),
            title = document.createElement("p");
          title.textContent = `${i.n} · ×3, 1:1 source · ${view.blind ? "A | B" : "before | after"}`;
          strip.append(title);
          const z = document.createElement("canvas");
          const crop = {
              ...r.bbox_css,
              w: Math.min(
                Math.max(...[r.before, r.after].filter(Boolean).map((b) => b.w)),
                Math.floor((g.width - 116) / (6 * view.dpr)),
              ),
              h: Math.min(Math.max(...[r.before, r.after].filter(Boolean).map((b) => b.h)), 80),
            },
            pad = 4,
            w = Math.ceil(crop.w * view.dpr),
            h = Math.ceil(crop.h * view.dpr);
          z.width = w * 6 + pad;
          z.height = h * 3;
          const ctx = z.getContext("2d");
          ctx.imageSmoothingEnabled = false;
          ctx.fillStyle = "white";
          ctx.fillRect(0, 0, z.width, z.height);
          for (const [idx, half] of (view.blind_reverse
            ? ["after", "before"]
            : ["before", "after"]
          ).entries())
            if (r[half])
              ctx.drawImage(
                images[half],
                Math.floor(r[half].x * view.dpr),
                Math.floor(r[half].y * view.dpr),
                w,
                h,
                idx * (w * 3 + pad),
                0,
                w * 3,
                h * 3,
              );
          z.style.maxWidth = "none";
          strip.append(z);
          document.getElementById("insets").append(strip);
          insets.push({ id: i.id, png: z.toDataURL("image/png") });
        }
        return { insets, pair: canvas.toDataURL("image/png") };
      },
      { g, view, png, colours, base: manifest.base, head: manifest.head, insetItems },
    );
    // Insets use bounded source crops, never rescaled to fit the composite.
    g.canvas_top = (await page.locator("#pair").boundingBox()).y;
    const buffer = await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" });
    return {
      buffer,
      geometry: g,
      insets: draw.insets.map((i) => ({
        id: i.id,
        buffer: Buffer.from(i.png.split(",")[1], "base64"),
      })),
      pair: Buffer.from(draw.pair.split(",")[1], "base64"),
    };
  } finally {
    await context.close();
  }
}

export async function render({ dir, author = "unattributed" }) {
  const manifest = await read(path.join(dir, "annotated-diff.manifest.json"));
  assert(
    [
      "wording_required",
      "rendering",
      "rendered",
      "checking",
      "checks_failed",
      "gallery_ready",
    ].includes(manifest.status),
  );
  manifest.status = "rendering";
  manifest.checks = { passed: false };
  manifest.judge_eligible = false;
  await write(path.join(dir, "annotated-diff.manifest.json"), manifest);
  assert(
    typeof author === "string" && author !== "unattributed" && author.length > 0,
    "Supply the actual served label model id; fixture runs are explicitly non-model",
  );
  manifest.labelling_mode = author === "fixture:deterministic" ? "fixture" : "model";
  assert(same(await runtime(), manifest.capture_spec.runtime), "Render runtime changed");
  const receipt = await read(path.join(dir, "comparison.json"));
  assert(
    same(receipt.blind_mapping, manifest.blind_mapping) &&
      same(receipt.presentation, manifest.views.map(presentation)),
    "Presentation differs from frozen comparison inputs",
  );
  const labels = await read(path.join(dir, "labels.todo.json"));
  for (const view of manifest.views) {
    validateLabels(
      view.items,
      labels.filter((l) => view.items.some((i) => i.id === l.id)),
      view.element_names,
    );
    for (const i of view.items) {
      const l = labels.find((l) => l.id === i.id);
      if (view.blind)
        assert(
          !/\b(before|after|new|old|added|removed|from|to)\b|\d/i.test(`${l.label} ${l.rationale}`),
          "Blind wording reveals ordering",
        );
      i.label = l.label;
      i.rationale = l.rationale;
      i.label_author = author;
    }
  }
  assert.equal(
    labels.length,
    manifest.views.reduce((s, v) => s + v.items.length, 0),
  );
  const allPng = await Promise.all(
    manifest.views.flatMap((v) =>
      ["base", "head"].map((h) =>
        fs.readFile(path.join(dir, h, `${v.source_id || v.id}.png`)).then(PNG.sync.read),
      ),
    ),
  );
  manifest.palette = palette(allPng);
  const browser = await chromium.launch({ args: manifest.capture_spec.runtime.flags });
  try {
    for (const view of manifest.views) {
      view.images = [];
      assert(view.items.length <= 8, "too_many_regions");
      const full = await renderView(browser, dir, manifest, view, manifest.palette, false),
        again = await renderView(browser, dir, manifest, view, manifest.palette, false),
        judge = await renderView(browser, dir, manifest, view, manifest.palette, true),
        judgeAgain = await renderView(browser, dir, manifest, view, manifest.palette, true);
      view.reproducible =
        full.buffer.equals(again.buffer) &&
        judge.buffer.equals(judgeAgain.buffer) &&
        full.insets.every((i, n) => i.buffer.equals(again.insets[n].buffer));
      view.geometry = full.geometry;
      for (const [file, buffer] of [
        [`${view.id}.annotated.png`, full.buffer],
        [`${view.id}.judge.png`, judge.buffer],
        [`${view.id}.clean.png`, await cleanPair(dir, view)],
        [`${view.id}.mask.png`, await fs.readFile(path.join(dir, view.mask))],
        ...(await Promise.all(
          (view.blind_reverse ? ["head", "base"] : ["base", "head"]).map(async (half, n) => [
            `${view.id}.${view.blind ? ["A", "B"][n] : ["before", "after"][n]}.png`,
            await capturedImage(dir, half, view),
          ]),
        )),
        ...full.insets.map((i, n) => [`${view.id}.inset-${n + 1}.png`, i.buffer]),
      ]) {
        await fs.writeFile(path.join(dir, file), buffer);
        const p = PNG.sync.read(buffer);
        view.images.push({
          file,
          sha256: hash(buffer),
          bytes: buffer.length,
          width: p.width,
          height: p.height,
        });
      }
      view.legend = legend(view);
      view.judge_legend = legend(view, true);
    }
  } finally {
    await browser.close();
  }
  const documents = markdownFiles(manifest);
  manifest.pr_body_chars = documents["pr-section.md"].length;
  manifest.status = "rendered";
  for (const [file, text] of Object.entries(documents))
    await fs.writeFile(path.join(dir, file), text);
  await write(path.join(dir, "annotated-diff.manifest.json"), manifest);
  return manifest;
}
async function cleanPair(dir, view) {
  const inputs = await Promise.all(
    (view.blind_reverse ? ["head", "base"] : ["base", "head"]).map((h) =>
      capturedImage(dir, h, view),
    ),
  );
  const resized = await Promise.all(
    inputs.map((b) => sharp(b).resize({ width: view.width }).png().toBuffer()),
  );
  const mobile = view.layout === "side-by-side" || (!view.layout && view.width === 390);
  return sharp({
    create: {
      width: mobile ? view.width * 2 : view.width,
      height: mobile ? view.height : view.height * 2,
      channels: 4,
      background: "white",
    },
  })
    .composite(
      resized.map((input, i) => ({
        input,
        left: mobile ? i * view.width : 0,
        top: mobile ? 0 : i * view.height,
      })),
    )
    .png()
    .toBuffer();
}

export function geometryCheck(view) {
  const g = view.geometry;
  if (!g) return false;
  const boxes = view.items.flatMap((i) =>
    i.regions.flatMap((r) =>
      ["before", "after"]
        .filter((h) => r[h])
        .map((half) => ({
          half,
          box: rect(
            g.halves[half].x + r[half].x,
            g.halves[half].y + r[half].y,
            r[half].w,
            r[half].h,
          ),
        })),
    ),
  );
  for (const m of g.marks) {
    const badge = rect(m.badge.x - 15, m.badge.y - 15, 30, 30),
      o = m.outline;
    const origin = g.halves[m.half];
    if (!(badge.x + badge.w <= origin.x || badge.x >= origin.x + view.width)) return false;
    if (boxes.some((b) => b.half === m.half && segmentHitsRect(m.line, b.box))) return false;
    if (
      ![badge, o].every(
        (r) =>
          r.x >= 0 && r.y >= 0 && r.x + r.w <= g.width && r.y + r.h <= g.header + g.pairHeight + 24,
      )
    )
      return false;
    if (
      boxes.some(
        (b) =>
          b.half === m.half &&
          (overlap(b.box, badge) > 0 ||
            (overlap(b.box, o) > 0 &&
              !(
                o.x < b.box.x &&
                o.y < b.box.y &&
                o.x + o.w > b.box.x + b.box.w &&
                o.y + o.h > b.box.y + b.box.h
              ))),
      )
    )
      return false;
    for (const other of g.marks)
      if (
        other !== m &&
        other.half === m.half &&
        (segmentsCross(m.line, other.line) ||
          overlap(badge, rect(other.badge.x - 15, other.badge.y - 15, 30, 30)) > 0)
      )
        return false;
  }
  return view.items.every((i) =>
    i.status === "unverified_claim"
      ? !g.marks.some((m) => m.item_id === i.id)
      : i.regions
          .slice(0, i.scope === "global" ? 3 : undefined)
          .every((r) =>
            ["before", "after"].every(
              (h) =>
                !r[h] ||
                g.marks.some((m) => m.item_id === i.id && m.region_id === r.id && m.half === h),
            ),
          ),
  );
}

async function verifyRender(dir, manifest) {
  const browser = await chromium.launch({ args: manifest.capture_spec.runtime.flags });
  let reproducible = true,
    geometryValid = true;
  try {
    for (const view of manifest.views) {
      const full = await renderView(browser, dir, manifest, view, manifest.palette, false),
        judge = await renderView(browser, dir, manifest, view, manifest.palette, true);
      reproducible &&=
        full.buffer.equals(await fs.readFile(path.join(dir, `${view.id}.annotated.png`))) &&
        judge.buffer.equals(await fs.readFile(path.join(dir, `${view.id}.judge.png`)));
      for (const [n, inset] of full.insets.entries())
        reproducible &&= inset.buffer.equals(
          await fs.readFile(path.join(dir, `${view.id}.inset-${n + 1}.png`)),
        );
      geometryValid &&= same(full.geometry, view.geometry);
    }
  } finally {
    await browser.close();
  }
  return { reproducible, geometryValid };
}

function presentation(view) {
  return Object.fromEntries(
    Object.entries(view).filter(
      ([key]) =>
        ![
          "items",
          "images",
          "legend",
          "judge_legend",
          "geometry",
          "reproducible",
          "contrast_samples",
        ].includes(key),
    ),
  );
}

export async function reconcileInputs(dir, manifest, hunks) {
  const receipt = await read(path.join(dir, "comparison.json"));
  const captures = await Promise.all(
    ["base", "head"].map((half) => read(path.join(dir, half, "capture.json"))),
  );
  const mapping = receipt.blind_mapping;
  let captureValid =
      captures.every(
        (c, n) =>
          c.sha === (n ? manifest.head : manifest.base) &&
          same(c.spec, manifest.capture_spec) &&
          c.spec_hash === digest(c.spec),
      ) &&
      receipt.base === manifest.base &&
      receipt.head === manifest.head &&
      receipt.capture_spec_hash === manifest.capture_spec_hash,
    ownershipValid =
      same(mapping, manifest.blind_mapping) &&
      (manifest.capture_spec.blind
        ? same(mapping, { A: "base", B: "head" }) || same(mapping, { A: "head", B: "base" })
        : mapping === null),
    expectedCount = 0;
  const expectedIds = [];
  const projectItem = (i) =>
    Object.fromEntries(
      Object.entries(i).filter(
        ([key]) => !["label", "rationale", "label_author", "reviewer_findings"].includes(key),
      ),
    );
  const claims = normalizeIntent(manifest.intent);
  for (const view of manifest.capture_spec.views) {
    const [a, b, p, q] = await Promise.all(
      [
        `base/${view.id}.json`,
        `head/${view.id}.json`,
        `base/${view.id}.probe.json`,
        `head/${view.id}.probe.json`,
      ].map((file) => read(path.join(dir, file))),
    );
    const images = await Promise.all(
      [
        `base/${view.id}.png`,
        `head/${view.id}.png`,
        `base/${view.id}.probe.png`,
        `head/${view.id}.probe.png`,
      ].map((file) => fs.readFile(path.join(dir, file)).then(PNG.sync.read)),
    );
    const gate = parityPair(manifest.capture_spec, a, b, p, q, images);
    captureValid &&=
      gate.status === "valid" &&
      a.sha === manifest.base &&
      p.sha === manifest.base &&
      b.sha === manifest.head &&
      q.sha === manifest.head &&
      [a, b, p, q].every((c) => same(c.view, view));
    const diff = regions(images[0], images[1], view.dpr, manifest.capture_spec.fullPage);
    const { items } = attribute(
      a.elements,
      b.elements,
      diff.regions,
      claims,
      hunks,
      manifest.head,
      { ...view, height: Math.max(images[0].height, images[1].height) / view.dpr },
    );
    const expected = splitView(
      comparisonView(view, manifest.capture_spec, mapping, images, items, diff, a, b),
    );
    expectedCount += expected.length;
    expectedIds.push(...expected.map((part) => part.id));
    for (const part of expected) {
      const actual = manifest.views.find((v) => v.id === part.id);
      ownershipValid &&=
        !!actual &&
        same(presentation(part), presentation(actual)) &&
        same(part.items.map(projectItem), actual.items.map(projectItem));
      if (!actual) continue;
      let mask = diff.mask;
      if (part.crop) {
        const r = part.crop;
        mask = await sharp(mask)
          .extract({
            left: r.x * view.dpr,
            top: r.y * view.dpr,
            width: r.w * view.dpr,
            height: r.h * view.dpr,
          })
          .png()
          .toBuffer();
      }
      ownershipValid &&= hash(mask) === hash(await fs.readFile(path.join(dir, actual.mask)));
      ownershipValid &&=
        actual.unexplained_count ===
          actual.items.filter((i) => i.status === "unexplained").length &&
        actual.unverified_claims ===
          actual.items.filter((i) => i.status === "unverified_claim").length;
    }
  }
  return {
    captureValid,
    ownershipValid:
      ownershipValid &&
      expectedCount === manifest.views.length &&
      same(
        expectedIds,
        manifest.views.map((v) => v.id),
      ) &&
      new Set(manifest.views.map((v) => v.id)).size === expectedCount,
  };
}

export async function check({ dir, root }) {
  const m = await read(path.join(dir, "annotated-diff.manifest.json"));
  const previousStatus = m.status;
  m.status = "checking";
  m.checks = { passed: false };
  m.judge_eligible = false;
  await write(path.join(dir, "annotated-diff.manifest.json"), m);
  assert(["rendered", "checking", "checks_failed", "gallery_ready"].includes(previousStatus));
  const labels = await read(path.join(dir, "labels.todo.json"));
  validateSpec(m.capture_spec);
  assert(same(await runtime(), m.capture_spec.runtime), "Check runtime changed");
  const hunks = diffHunks(root || path.resolve(dir, m.repository), m.base, m.head);
  const checks = {};
  checks.capture =
    m.capture_spec_hash === digest(m.capture_spec) &&
    m.flake_probe.length === m.capture_spec.views.length &&
    m.flake_probe.every((p) => p.status === "valid" && p.flake_regions === 0);
  for (const input of m.capture_inputs)
    checks.capture &&= hash(await fs.readFile(path.join(dir, input.file))) === input.sha256;
  checks.coverage = m.views.every(
    (v) =>
      v.regions.every(
        (r) => v.items.filter((i) => i.regions.some((x) => x.id === r.id)).length === 1,
      ) &&
      v.items.every(
        (i, n) =>
          i.status !== "unexplained" ||
          v.items.slice(0, n).every((p) => p.status === "unexplained"),
      ) &&
      v.items.every(
        (i) => (i.element && i.match_confidence === "high") || i.status !== "explained",
      ),
  );
  const reconciliation = await reconcileInputs(dir, m, hunks);
  checks.capture &&= reconciliation.captureValid;
  checks.coverage &&= reconciliation.ownershipValid;
  checks.claims = m.views.every((v) =>
    v.items.every((i) =>
      i.regions.length > 0 ? i.status !== "unverified_claim" : i.status === "unverified_claim",
    ),
  );
  checks.references = m.views.every((v) =>
    v.items.every((i) =>
      [i.code_ref, ...i.code_refs.map((r) => r.code_ref)].every(
        (r) =>
          r === "unresolved" ||
          (r.in_diff === true &&
            r.source === "intent_verified" &&
            r.commit === m.head &&
            same(verifiedRef(r, hunks, m.head), r)),
      ),
    ),
  );
  try {
    for (const v of m.views)
      validateLabels(
        v.items,
        labels.filter((l) => v.items.some((i) => i.id === l.id)),
        v.element_names,
      );
    checks.wording =
      labels.length === m.views.reduce((s, v) => s + v.items.length, 0) &&
      m.views.every((v) =>
        v.items.every((i) => {
          const l = labels.find((l) => l.id === i.id);
          return i.label === l.label && i.rationale === l.rationale;
        }),
      );
  } catch {
    checks.wording = false;
  }
  const markdownValid = await verifyMarkdown(dir, m);
  const rendering =
    Object.values(checks).every(Boolean) && markdownValid
      ? await verifyRender(dir, m)
      : { reproducible: false, geometryValid: false };
  checks.geometry = rendering.geometryValid && m.views.every(geometryCheck);
  checks.contrast = true;
  const markdown = await fs.readFile(path.join(dir, "pr-section.md"), "utf8");
  checks.limits = m.pr_body_chars === markdown.length && markdown.length <= 60_000;
  checks.reproducible = rendering.reproducible && m.views.every((v) => v.reproducible);
  checks.accessible =
    markdownValid &&
    m.views.every(
      (v) =>
        v.alt.length <= 155 &&
        !v.alt.startsWith("Image of") &&
        v.legend &&
        (v.items.length === 0
          ? v.legend === "No surviving visual changes."
          : v.legend.split("\n").length === v.items.length),
    );
  for (const v of m.views) {
    checks.limits &&= v.items.length <= 8;
    for (const image of v.images) {
      const buffer = await fs.readFile(path.join(dir, image.file));
      const actual = PNG.sync.read(buffer);
      checks.reproducible &&=
        hash(buffer) === image.sha256 &&
        buffer.length === image.bytes &&
        actual.width === image.width &&
        actual.height === image.height;
      checks.limits &&=
        buffer.length <= 5_000_000 &&
        image.width / (/\.(mask|before|after|A|B)\.png$/.test(image.file) ? v.dpr : 1) <= 1600;
    }
    const png = PNG.sync.read(await fs.readFile(path.join(dir, `${v.id}.annotated.png`)));
    const sample = (x, y) => {
      const at = (Math.round(y) * png.width + Math.round(x)) * 4;
      return [...png.data.subarray(at, at + 3)].map((c) => c / 255);
    };
    // Sample the actual solid fill, digit interiors and both adjacent halo rings.
    v.contrast_samples = [];
    for (const mark of v.geometry.marks) {
      const x = mark.badge.x,
        y = mark.badge.y + v.geometry.canvas_top;
      const fill = sample(x - 7, y + 6),
        inner = sample(x - 13, y),
        outer = sample(x - 15, y),
        under = sample(x - 17, y);
      let ink = null;
      for (let yy = -5; yy <= 5; yy++)
        for (let xx = -8; xx <= 8; xx++) {
          const c = sample(x + xx, y + yy);
          if (!ink || contrast(c, fill) > contrast(ink, fill)) ink = c;
        }
      const digits = contrast(ink, fill),
        halo = Math.max(contrast(inner, under), contrast(outer, under));
      v.contrast_samples.push({
        item_id: mark.item_id,
        half: mark.half,
        digits,
        halo,
        rings: contrast(inner, outer),
      });
      checks.contrast &&= digits >= 4.5 && halo >= 3 && contrast(inner, outer) >= 3;
    }
  }
  m.checks = checks;
  m.checks.passed = Object.values(checks).every(Boolean);
  m.status = m.checks.passed ? "gallery_ready" : "checks_failed";
  m.judge_eligible =
    m.checks.passed &&
    m.labelling_mode === "model" &&
    m.views.every((v) => v.unexplained_count === 0);
  await write(path.join(dir, "annotated-diff.manifest.json"), m);
  return m;
}

async function main() {
  const [command, ...argv] = process.argv.slice(2),
    args = {};
  assert(argv.length % 2 === 0);
  for (let i = 0; i < argv.length; i += 2) {
    assert(argv[i].startsWith("--"));
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (command === "capture")
    return capture({
      spec: await read(args.views),
      sourceRoot: args["source-root"],
      sha: args.sha,
      url: args.url,
      out: args.out,
    });
  if (command === "diff")
    return compare({
      dir: args.dir,
      root: args.repo || process.cwd(),
      intent: await read(args.intent),
    });
  if (command === "render") return render({ dir: args.dir, author: args.author });
  if (command === "check") {
    const m = await check({ dir: args.dir, root: args.repo });
    console.log(JSON.stringify(m.checks, null, 2));
    if (!m.checks.passed) process.exitCode = 1;
    return;
  }
  throw new Error("Usage: run.mjs capture|diff|render|check --key value (see README.md)");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
