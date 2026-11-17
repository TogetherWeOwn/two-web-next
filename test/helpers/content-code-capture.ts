import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

type Json = Record<string, unknown>;
const now = () => Math.round(performance.now());

/** Persist each case step and screenshot as soon as it exists. */
export function recorder(out: string, name: string) {
  const dir = join(out, name);
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
    step(`${label}-png`, {
      sha256: createHash("sha256").update(buf).digest("hex"),
      h: buf.readUInt32BE(20),
      w: buf.readUInt32BE(16),
    });
  };
  return { data, flush, step, png };
}

export function watchFont(page: Page) {
  const log: Json[] = [];
  const add = (event: string, url: string, extra: Json = {}) =>
    /fragment-mono/.test(url) && log.push({ event, url, t: now(), ...extra });
  page.on("request", (r) => add("request", r.url()));
  page.on("requestfailed", (r) => add("requestfailed", r.url(), { why: r.failure()?.errorText }));
  page.on("response", (r) => add("response", r.url(), { status: r.status() }));
  return log;
}

/** Geometry only: document plus every selected element and its line boxes. */
export const readGeometry = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    type Box = { x: number; y: number; width: number; height: number };
    type ElementSize = {
      scrollWidth: number;
      scrollHeight: number;
      clientWidth: number;
      clientHeight: number;
    };
    type CodeElement = {
      parentElement: unknown;
      getBoundingClientRect(): Box;
      getClientRects(): ArrayLike<Box>;
    };
    const { innerWidth, innerHeight, scrollX, scrollY, document, getComputedStyle } =
      globalThis as unknown as {
        innerWidth: number;
        innerHeight: number;
        scrollX: number;
        scrollY: number;
        document: {
          body: ElementSize;
          documentElement: ElementSize;
          querySelectorAll(selector: string): ArrayLike<CodeElement>;
        };
        getComputedStyle(element: unknown): {
          fontFamily: string;
          fontSize: string;
          letterSpacing: string;
          lineHeight: string;
        };
      };
    const box = (r: Box) => [r.x, r.y, r.width, r.height];
    const size = (e: ElementSize) => [e.scrollWidth, e.scrollHeight, e.clientWidth, e.clientHeight];
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
  }, selector);

export async function viewportPng(page: Page) {
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

/** Hold a routed font request until released, then fulfill or abort it. */
export async function holdFont(page: Page, glob: string, bytes: Buffer | null) {
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
  await page.route(glob, async (route) => {
    state.requested = true;
    await gate;
    if (bytes) await route.fulfill({ body: bytes, contentType: "font/woff2" });
    else await route.abort();
  });
  return state;
}
