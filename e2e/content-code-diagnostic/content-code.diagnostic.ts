import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expect, localOrigin, test } from "../fixtures";

// Cross-revision diagnostic for first full-page capture of /privacy inline code.
// Observation only: no thresholds, no app-policy assertions beyond actual glyph
// evidence. Runs unchanged on a base tree with no Fragment Mono request. Every
// PNG and case record is written to disk as soon as it exists.
const REVISION = process.env.CONTENT_CODE_DIAG_REVISION ?? "unlabelled";
const OUT = join(
  resolve(process.env.CONTENT_CODE_DIAG_OUT ?? "content-code-diagnostic-output"),
  REVISION.replace(/[^A-Za-z0-9._-]/g, "_"),
);
const REPEATS = Math.max(1, Number(process.env.CONTENT_CODE_DIAG_REPEATS ?? "3"));
const ARM = process.env.CONTENT_CODE_DIAG_ARM ?? "normal";
const NO_FONT_READY = process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY ?? "";
// Head tree only: a warm Fragment Mono glyph is then required, not just observed.
const WARM: Frag =
  process.env.CONTENT_CODE_DIAG_EXPECT_WARM_FRAGMENT === "1" ? "required" : "observe";
const FONT_GLOB = "**/fonts/fragment-mono-latin-400.woff2";
const BOUND_MS = 5_000;
const CODE = ".content-theme code, code";
const SIZES = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

type Frag = "none" | "required" | "observe";
type Json = Record<string, unknown>;
const now = () => Math.round(performance.now());
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function recorder(name: string) {
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  const data: { case: string; steps: Json[]; error?: string } = { case: name, steps: [] };
  const flush = () => writeFileSync(join(dir, "case.json"), JSON.stringify(data, null, 2));
  flush();
  const step = (label: string, value: Json = {}) => {
    data.steps.push({ label, atMs: now(), ...value });
    flush();
  };
  const png = (label: string, buf: Buffer) => {
    writeFileSync(join(dir, `${label}.png`), buf);
    step(`${label}-png`, { sha256: sha(buf), h: buf.readUInt32BE(20), w: buf.readUInt32BE(16) });
  };
  return { data, flush, step, png };
}
type Rec = ReturnType<typeof recorder>;

function watchFont(page: Page) {
  const log: Json[] = [];
  const add = (event: string, url: string, extra: Json = {}) =>
    /fragment-mono/.test(url) && log.push({ event, url, t: now(), ...extra });
  page.on("request", (r) => add("request", r.url()));
  page.on("requestfailed", (r) => add("requestfailed", r.url(), { why: r.failure()?.errorText }));
  page.on("response", (r) => add("response", r.url(), { status: r.status() }));
  return log;
}

/** Geometry only: document plus every inline code element and its line boxes. */
const readGeometry = (page: Page) =>
  page.evaluate((selector) => {
    const box = (r: DOMRect) => [r.x, r.y, r.width, r.height];
    const size = (e: Element) => [e.scrollWidth, e.scrollHeight, e.clientWidth, e.clientHeight];
    return {
      viewport: [innerWidth, innerHeight, scrollX, scrollY],
      body: size(document.body),
      document: size(document.documentElement),
      codes: Array.from(document.querySelectorAll(selector), (el) => {
        const s = getComputedStyle(el);
        return {
          rect: box(el.getBoundingClientRect()),
          lines: Array.from(el.getClientRects(), box),
          font: [s.fontFamily, s.fontSize, s.letterSpacing, s.lineHeight].join("|"),
          parentLineHeight: getComputedStyle(el.parentElement!).lineHeight,
        };
      }),
    };
  }, CODE);

/** Record document.fonts and Chromium's actual glyph usage per code element; assert it. */
async function observe(page: Page, rec: Rec, label: string, frag: Frag) {
  const faces = await page.evaluate(() => ({
    status: document.fonts.status,
    faces: Array.from(document.fonts, (f) => `${f.family}:${f.status}`),
  }));
  const session = await page.context().newCDPSession(page);
  const glyphs = [];
  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument", { depth: 0 });
    const { nodeIds } = await session.send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector: CODE,
    });
    for (const nodeId of nodeIds)
      glyphs.push((await session.send("CSS.getPlatformFontsForNode", { nodeId })).fonts);
  } finally {
    await session.detach();
  }
  rec.step(label, { ...faces, glyphs });
  expect.soft(glyphs.length, `${label}: code elements`).toBeGreaterThan(0);
  for (const fonts of glyphs) {
    const painted = fonts.some((f) => f.glyphCount > 0);
    const custom = fonts.some((f) => f.isCustomFont && f.familyName === "Fragment Mono");
    expect.soft(painted, `${label}: actual glyphs`).toBe(true);
    if (frag !== "observe")
      expect.soft(custom, `${label}: custom Fragment`).toBe(frag === "required");
  }
}

type Capture = { before: unknown; after: unknown; png: Buffer };

/** One capture: measure, screenshot (PNG persisted at once), measure, record fonts. */
async function capture(
  page: Page,
  rec: Rec,
  label: string,
  viewport: boolean,
  frag: Frag,
  bounded = false,
) {
  const before = await readGeometry(page);
  rec.step(`${label}-before`, { geometry: before });
  const t0 = now();
  let png: Buffer;
  try {
    png = viewport
      ? await viewportPng(page)
      : await page.screenshot({ fullPage: true, ...(bounded ? { timeout: BOUND_MS } : {}) });
  } catch (error) {
    rec.step(`${label}-failed`, { error: String(error), captureMs: now() - t0, image: null });
    throw error;
  }
  rec.png(label, png);
  const after = await readGeometry(page);
  rec.step(`${label}-geometry`, { captureMs: now() - t0, before, after });
  await observe(page, rec, `${label}-fonts`, frag);
  return { before, after, png } as Capture;
}

async function viewportPng(page: Page) {
  const s = await page.context().newCDPSession(page);
  try {
    const { data } = await s.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    return Buffer.from(data, "base64");
  } finally {
    await s.detach();
  }
}

/** First and second capture; geometry equalities and exact PNG bytes only. */
async function pair(page: Page, rec: Rec, frag: Frag, viewport = false, bounded = false) {
  let a: Capture;
  try {
    a = await capture(page, rec, "first", viewport, frag, bounded);
  } catch (error) {
    rec.step("second-not-reached", { image: null });
    throw error;
  }
  const b = await capture(page, rec, "second", viewport, frag, bounded);
  expect.soft(a.after, "geometry stable across first capture").toEqual(a.before);
  expect.soft(b.before, "geometry between captures").toEqual(a.after);
  expect.soft(b.after, "geometry stable across second capture").toEqual(b.before);
  expect.soft(a.png.equals(b.png), "first and second PNG bytes equal").toBe(true);
}

const goto = async (page: Page, waitUntil: "load" | "domcontentloaded" = "load") =>
  expect((await page.goto(`${localOrigin}/privacy`, { waitUntil }))?.status()).toBe(200);
const firstPaint = (page: Page) =>
  page.waitForFunction(
    () => performance.getEntriesByName("first-contentful-paint").length > 0,
    null,
    { timeout: BOUND_MS },
  );

/** Case file is flushed with its error even when the body throws. */
async function run(name: string, body: (rec: Rec) => Promise<void>) {
  const rec = recorder(name);
  try {
    rec.step("protocol", { arm: ARM, diagnosticOnly: true, noFontReady: NO_FONT_READY });
    expect(["normal", "held-font-playwright-no-font-ready-diagnostic"]).toContain(ARM);
    expect(NO_FONT_READY).toBe(ARM === "normal" ? "" : "1");
    if (ARM !== "normal") expect(name.startsWith("cold-delayed-")).toBe(true);
    await body(rec);
  } catch (error) {
    rec.data.error = String((error as Error)?.stack ?? error);
    throw error;
  } finally {
    rec.flush();
  }
}

/** Hold the Fragment request (routed before navigation) until released. */
async function holdFont(page: Page, bytes: Buffer | null) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const state = {
    requested: false,
    released: false,
    release: () => {
      state.released = true;
      release();
    },
  };
  await page.route(FONT_GLOB, async (route) => {
    state.requested = true;
    await gate;
    if (bytes) await route.fulfill({ body: bytes, contentType: "font/woff2" });
    else await route.abort();
  });
  return state;
}

for (const size of SIZES) {
  for (let n = 1; n <= REPEATS; n++) {
    const id = `${size.width}-r${n}`;

    test(`cold aborted ${id}`, ({ page }) =>
      run(`cold-aborted-${id}`, async (rec) => {
        const log = watchFont(page);
        await page.setViewportSize(size);
        await page.route(FONT_GLOB, (route) => route.abort());
        await goto(page);
        await observe(page, rec, "loaded", "none");
        await pair(page, rec, "none");
        rec.step("requests", { log });
      }));

    test(`cold delayed ${id}`, ({ page }) =>
      run(`cold-delayed-${id}`, async (rec) => {
        const log = watchFont(page);
        await page.setViewportSize(size);
        const hold = await holdFont(
          page,
          readFileSync(resolve("public/fonts/fragment-mono-latin-400.woff2")),
        );
        try {
          await goto(page, "domcontentloaded");
          await firstPaint(page);
          rec.step("request-state", { requested: hold.requested ? "held" : "not requested" });
          if (WARM === "required")
            expect.soft(hold.requested, "Fragment Mono request held").toBe(true);
          await observe(page, rec, "held", "none");
          rec.step("screenshot-options", { fullPage: true, timeoutMs: BOUND_MS });
          await pair(page, rec, "none", false, true);
          rec.step("captures-complete", {
            requested: hold.requested,
            released: hold.released,
            log,
          });
          if (hold.requested) expect.soft(hold.released, "font held through captures").toBe(false);
        } finally {
          hold.release();
          rec.step("released", { log });
        }
        // Bounded: a held font must never hang the case on document.fonts.ready.
        const ready = await page.evaluate(
          (ms) =>
            Promise.race([
              document.fonts.ready.then(() => "ready"),
              new Promise((r) => setTimeout(() => r("timeout"), ms)),
            ]),
          BOUND_MS,
        );
        rec.step("late-ready", { ready });
        await observe(page, rec, "late-release", "observe");
      }));

    test(`warm ${id}`, ({ page }) =>
      run(`warm-${id}`, async (rec) => {
        const log = watchFont(page);
        await page.setViewportSize(size);
        await goto(page);
        const before = await readGeometry(page);
        await page.evaluate(() =>
          document.fonts.load('14px "Fragment Mono"', "__Host-two_session"),
        );
        expect((await page.reload())?.status()).toBe(200);
        const after = await readGeometry(page);
        rec.step("reloaded", { log, before, after });
        expect
          .soft(after.codes.map((c) => c.parentLineHeight))
          .toEqual(before.codes.map((c) => c.parentLineHeight));
        await observe(page, rec, "reloaded", WARM);
        await pair(page, rec, WARM);
      }));

    test(`viewport control ${id}`, ({ page }) =>
      run(`viewport-control-${id}`, async (rec) => {
        await page.setViewportSize(size);
        const hold = await holdFont(page, null);
        try {
          await goto(page, "domcontentloaded");
          await firstPaint(page);
          await observe(page, rec, "held", "none");
          await pair(page, rec, "none", true);
        } finally {
          hold.release();
        }
      }));

    test(`timing control ${id}`, ({ page }) =>
      run(`timing-control-${id}`, async (rec) => {
        await page.setViewportSize(size);
        await page.route(FONT_GLOB, (route) => route.abort());
        await goto(page);
        const samples = [await readGeometry(page)];
        await observe(page, rec, "sample-0", "none");
        for (let i = 1; i <= 3; i++) {
          // Fixed frame barriers, no screenshot, no loop-until-stable.
          await page.evaluate(
            () => new Promise((d) => requestAnimationFrame(() => requestAnimationFrame(d))),
          );
          samples.push(await readGeometry(page));
          rec.step(`sample-${i}`, { geometry: samples[i] });
        }
        for (const s of samples.slice(1))
          expect.soft(s, "geometry without screenshot").toEqual(samples[0]);
      }));
  }
}
