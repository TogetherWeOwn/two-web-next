import type { CDPSession, Page, Response, TestInfo } from "@playwright/test";
import { type DefaultTreeAdapterTypes, parseFragment } from "parse5";
import { expect, localOrigin } from "../fixtures";
import { captureWithoutFontWait, renderedPlatformFonts } from "./font-evidence";

export const displayFont = "/fonts/mona-sans-latin-wght.woff2";
export const dataFont = "/fonts/fragment-mono-latin-400.woff2";
export const contentHeading = ".content-theme h1";
export type FontState = "cold" | "warm" | "cold-shaped";

const shape = {
  offline: false,
  latency: 150,
  downloadThroughput: 204800,
  uploadThroughput: 84480,
  connectionType: "cellular3g",
} as const;
const frameLimit = 35;
const isFont = (url: string) => /\.woff2(?:$|\?)/i.test(url);

function evidenceHeaders(headers: Record<string, unknown>) {
  const allowed =
    /^(link|cache-control|age|etag|content-type|content-length|priority|last-modified|vary|server-timing)$/i;
  return Object.fromEntries(Object.entries(headers).filter(([key]) => allowed.test(key)));
}

function observeNetwork(session: CDPSession, state: FontState) {
  const requests: { id: string; phase: string; url: string; type?: string; detail: unknown }[] = [];
  const events: { id: string; event: string; data?: unknown }[] = [];
  const record = (id: string, event: string, data?: unknown) => events.push({ id, event, data });
  let phase = state === "warm" ? "homepage" : "content";
  session.on(
    "Network.requestWillBeSent",
    ({ requestId: id, type, request, initiator, timestamp }) => {
      const { url, initialPriority, isLinkPreload } = request;
      if (new URL(url).origin === localOrigin && (type === "Document" || isFont(url))) {
        requests.push({
          id,
          phase,
          url,
          type,
          detail: { initialPriority, isLinkPreload, initiator, timestamp },
        });
      }
    },
  );
  session.on("Network.responseReceived", ({ requestId, response }) => {
    const { status, fromDiskCache, fromServiceWorker, fromPrefetchCache, timing, headers } =
      response;
    record(requestId, "response", {
      status,
      fromDiskCache,
      fromServiceWorker,
      fromPrefetchCache,
      timing,
      headers: evidenceHeaders(headers),
    });
  });
  session.on("Network.responseReceivedExtraInfo", ({ requestId, statusCode, headers }) =>
    record(requestId, "wire-response", { statusCode, headers: evidenceHeaders(headers) }),
  );
  session.on("Network.responseReceivedEarlyHints", ({ requestId, headers }) =>
    record(requestId, "early-hints", evidenceHeaders(headers)),
  );
  session.on("Network.requestServedFromCache", ({ requestId }) => record(requestId, "cache"));
  session.on("Network.loadingFinished", ({ requestId, timestamp, encodedDataLength }) =>
    record(requestId, "finished", { timestamp, encodedDataLength }),
  );
  session.on("Network.loadingFailed", ({ requestId, errorText }) =>
    record(requestId, "failed", errorText),
  );
  session.on("Network.resourceChangedPriority", ({ requestId, newPriority }) =>
    record(requestId, "priority", newPriority),
  );
  return {
    content: () => {
      phase = "content";
    },
    read: () =>
      requests.map((request) => ({
        ...request,
        events: events.filter(({ id }) => id === request.id),
      })),
  };
}

// Parse out of the browser so raw markup cannot initiate another request.
function readHints(html: string) {
  type Node = DefaultTreeAdapterTypes.ChildNode;
  type Hint = { rel: string; as: string; href: string | null; priority: string | null };
  function collect(node: Node): Hint[] {
    if ("tagName" in node && node.tagName === "link") {
      const attr = (key: string) => node.attrs.find(({ name }) => name === key)?.value ?? null;
      const rel = attr("rel") ?? "";
      if (/(?:^|\s)(?:preload|prefetch|modulepreload)(?:\s|$)/i.test(rel))
        return [{ rel, as: attr("as") ?? "", href: attr("href"), priority: attr("fetchpriority") }];
    }
    return "childNodes" in node ? node.childNodes.flatMap(collect) : [];
  }
  return parseFragment(html).childNodes.flatMap(collect);
}

async function inspectNavigation(page: Page, response: Response) {
  const { links, resources } = await page.evaluate(() => ({
    links: Array.from(document.querySelectorAll("link"), (link) => link.outerHTML).join(""),
    resources: performance
      .getEntriesByType("resource")
      .filter(({ name }) => /\.woff2(?:$|\?)/i.test(name))
      .map((entry) => entry.toJSON() as PerformanceResourceTiming),
  }));
  return {
    url: response.url(),
    status: response.status(),
    headers: evidenceHeaders(await response.allHeaders()),
    rawHints: readHints(await response.text()),
    hints: readHints(links),
    resources,
  };
}

type Box = { x: number; y: number; width: number; height: number };

async function headingPixels(page: Page, images: string[], box: Box) {
  return page.evaluate(
    async ({ images, box }) => {
      const x = Math.floor(box.x);
      const y = Math.floor(box.y);
      const width = Math.ceil(box.x + box.width) - x;
      const height = Math.ceil(box.y + box.height) - y;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("No canvas for heading pixel comparison");
      const pixels = async (image: string) => {
        const bytes = Uint8Array.from(atob(image), (byte) => byte.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        try {
          if (x < 0 || y < 0 || x + width > bitmap.width || y + height > bitmap.height) {
            throw new Error("Heading is outside the captured viewport");
          }
          ctx.clearRect(0, 0, width, height);
          ctx.drawImage(bitmap, -x, -y);
          return ctx.getImageData(0, 0, width, height).data;
        } finally {
          bitmap.close();
        }
      };
      const reference = await pixels(images[0]!);
      const matches = [];
      for (const image of images.slice(1)) {
        const sample = await pixels(image);
        matches.push(sample.every((value, i) => value === reference[i]));
      }
      return matches;
    },
    { images, box },
  );
}

export async function captureRealFont(
  page: Page,
  path: string,
  state: FontState,
  testInfo: TestInfo,
  trackedFont = displayFont,
) {
  const session = await page.context().newCDPSession(page);
  const network = observeNetwork(session, state);
  const frames: { data: string; timestamp: number }[] = [];
  let truncated = false;
  let acknowledgmentError: unknown;
  try {
    await session.send("Network.enable");
    if (state === "cold-shaped") await session.send("Network.emulateNetworkConditions", shape);
    await page.addInitScript(() => {
      const shifts: { startTime: number; value: number; hadRecentInput: boolean }[] = [];
      type Shift = PerformanceEntry & { value: number; hadRecentInput: boolean };
      const record = (entries: PerformanceEntry[]) => {
        for (const { startTime, value, hadRecentInput } of entries as Shift[])
          shifts.push({ startTime, value, hadRecentInput });
      };
      const observer = new PerformanceObserver((list) => record(list.getEntries()));
      observer.observe({ type: "layout-shift", buffered: true });
      Object.assign(window, {
        readFontShifts: () => {
          record(observer.takeRecords());
          return shifts;
        },
      });
    });
    let warmup = null;
    if (state === "warm") {
      const home = await page.goto("/", { waitUntil: "load" });
      if (home?.status() !== 200 || home.url() !== `${localOrigin}/`)
        throw new Error("Homepage did not load at fixture origin");
      await page.evaluate(() => document.fonts.ready);
      warmup = await inspectNavigation(page, home);
      network.content();
    }
    session.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
      void session.send("Page.screencastFrameAck", { sessionId }).catch((error: unknown) => {
        acknowledgmentError = error;
      });
      if (frames.length >= frameLimit) truncated = true;
      else if (metadata.timestamp !== undefined)
        frames.push({ data, timestamp: metadata.timestamp });
    });
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("No fixture viewport");
    await session.send("Page.startScreencast", {
      format: "png",
      maxWidth: viewport.width,
      maxHeight: viewport.height,
      everyNthFrame: 1,
    });
    const response = await page.goto(path, { waitUntil: "load" });
    if (response?.status() !== 200 || response.url() !== `${localOrigin}${path}`)
      throw new Error(`Unexpected fixture response for ${path}`);
    const readHeading = async () => ({
      atMs: await page.evaluate(() => performance.now()),
      box: await page.locator(contentHeading).boundingBox(),
      fonts: await renderedPlatformFonts(page, contentHeading),
    });
    const atLoad = await readHeading();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    const settled = await readHeading();
    if (!settled.box) throw new Error("No settled heading bounds");
    const png = await captureWithoutFontWait(page);
    await session.send("Page.stopScreencast");
    const content = await inspectNavigation(page, response);
    const timing = await page.evaluate((selector) => {
      const heading = document.querySelector(selector)!;
      const paints = performance.getEntriesByType("paint");
      const reply = paints.find(({ name }) => name === "first-contentful-paint") as
        | (PerformanceEntry & { paintTime?: number })
        | undefined;
      return {
        timeOrigin: performance.timeOrigin,
        firstContentfulPaint: reply?.startTime,
        paintTime: reply?.paintTime ?? reply?.startTime,
        paints: paints.map((paint) => paint.toJSON()),
        navigation: performance.getEntriesByType("navigation")[0]?.toJSON(),
        shifts: (window as unknown as { readFontShifts: () => unknown[] }).readFontShifts(),
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        headingText: heading.textContent,
        stack: getComputedStyle(heading).fontFamily,
        faces: Array.from(document.fonts, ({ family, display, status, weight, stretch }) => ({
          family,
          display,
          status,
          weight,
          stretch,
        })),
      };
    }, contentHeading);
    const samples = frames.map(({ data, timestamp }) => ({
      data,
      atMs: timestamp * 1000 - timing.timeOrigin,
    }));
    const painted = samples.filter(
      ({ atMs }) => timing.paintTime !== undefined && atMs >= timing.paintTime,
    );
    const matches = await headingPixels(
      page,
      [png.toString("base64"), ...painted.map(({ data }) => data)],
      settled.box,
    );
    const resourceEnd = content.resources.find(
      ({ name }) => name === `${localOrigin}${trackedFont}`,
    )?.responseEnd;
    const afterFont = painted.find(({ atMs }) => resourceEnd !== undefined && atMs > resourceEnd);
    const capture = {
      path,
      state,
      sha: process.env.GITHUB_SHA,
      profile: state === "cold-shaped" ? shape : "unshaped",
      browser: page.context().browser()?.version(),
      warmup,
      content,
      timing,
      atLoad,
      settled,
      requests: network.read(),
      trackedFont,
      resourceEnd,
      firstFrameAtMs: painted[0]?.atMs,
      afterFontAtMs: afterFont?.atMs,
      frames: painted.map(({ atMs }, i) => ({ atMs, sameHeadingPixels: matches[i] })),
    };
    const attachPng = (name: string, body: Buffer) =>
      testInfo.attach(name, { body, contentType: "image/png" });
    await attachPng("viewport", png);
    if (painted[0]) await attachPng("first-paint", Buffer.from(painted[0].data, "base64"));
    if (afterFont) await attachPng("after-font", Buffer.from(afterFont.data, "base64"));
    await testInfo.attach("browser", {
      body: JSON.stringify(capture, null, 2),
      contentType: "application/json",
    });
    expect(acknowledgmentError, "compositor frame acknowledgment failed").toBeUndefined();
    expect(truncated, "compositor frame limit exceeded").toBe(false);
    expect(
      capture.requests
        .filter(({ phase, type }) => phase === "content" && type === "Document")
        .map(({ url }) => url),
    ).toEqual([content.url]);
    expect(timing.firstContentfulPaint, "FCP was recorded").toBeGreaterThan(0);
    expect(painted[0]?.atMs, "first sampled content frame is close to FCP").toBeLessThanOrEqual(
      timing.firstContentfulPaint! + 50,
    );
    expect(matches, "sampled heading pixels match settled pixels").not.toContain(false);
    expect(atLoad.box).toEqual(settled.box);
    expect(atLoad.fonts).toEqual(settled.fonts);
    return capture;
  } finally {
    await session.detach();
  }
}
