import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, Route } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  holdFont,
  readGeometry,
  recorder,
  viewportPng,
  watchFont,
} from "./helpers/content-code-capture";

afterEach(() => vi.unstubAllGlobals());

describe("content code capture helpers", () => {
  it("flushes steps and PNG bytes with their dimensions and digest", () => {
    const out = mkdtempSync(join(tmpdir(), "content-capture-"));
    try {
      const rec = recorder(out, "cold");
      const path = join(out, "cold", "case.json");
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ case: "cold", steps: [] });
      rec.step("start", { state: "held" });
      const png = Buffer.alloc(24);
      png.writeUInt32BE(390, 16);
      png.writeUInt32BE(844, 20);
      rec.png("first", png);
      expect(readFileSync(join(out, "cold", "first.png"))).toEqual(png);
      const saved = JSON.parse(readFileSync(path, "utf8"));
      expect(saved.steps).toEqual([
        { label: "start", atMs: expect.any(Number), state: "held" },
        {
          label: "first-png",
          atMs: expect.any(Number),
          w: 390,
          h: 844,
          sha256: createHash("sha256").update(png).digest("hex"),
        },
      ]);
      rec.data.error = "failure";
      rec.flush();
      expect(JSON.parse(readFileSync(path, "utf8")).error).toBe("failure");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("records only Fragment Mono request, failure and response events", () => {
    const listeners: Record<string, (value: never) => void> = {};
    const page = {
      on: (event: string, listener: (value: never) => void) => {
        listeners[event] = listener;
      },
    } as unknown as Page;
    const log = watchFont(page);
    listeners.request!({ url: () => "/other.woff2" } as never);
    listeners.request!({ url: () => "/fragment-mono.woff2" } as never);
    listeners.requestfailed!({
      url: () => "/fragment-mono.woff2",
      failure: () => ({ errorText: "aborted" }),
    } as never);
    listeners.response!({ url: () => "/fragment-mono.woff2", status: () => 200 } as never);
    expect(log).toEqual([
      { event: "request", url: "/fragment-mono.woff2", t: expect.any(Number) },
      {
        event: "requestfailed",
        url: "/fragment-mono.woff2",
        t: expect.any(Number),
        why: "aborted",
      },
      { event: "response", url: "/fragment-mono.woff2", t: expect.any(Number), status: 200 },
    ]);
  });

  it("captures geometry, line boxes and computed font properties", async () => {
    const rect = { x: 1, y: 2, width: 3, height: 4 };
    const parent = {};
    const element = {
      parentElement: parent,
      getBoundingClientRect: () => rect,
      getClientRects: () => [rect],
    };
    const size = { scrollWidth: 10, scrollHeight: 20, clientWidth: 8, clientHeight: 18 };
    const query = vi.fn().mockReturnValue([element]);
    vi.stubGlobal("document", { body: size, documentElement: size, querySelectorAll: query });
    for (const [key, value] of Object.entries({
      innerWidth: 390,
      innerHeight: 844,
      scrollX: 0,
      scrollY: 5,
    }))
      vi.stubGlobal(key, value);
    vi.stubGlobal("getComputedStyle", (el: unknown) =>
      el === parent
        ? { lineHeight: "20px" }
        : { fontFamily: "mono", fontSize: "14px", letterSpacing: "normal", lineHeight: "18px" },
    );
    const page = {
      evaluate: (fn: (s: string) => unknown, selector: string) => fn(selector),
    } as unknown as Page;
    expect(await readGeometry(page, "code")).toEqual({
      viewport: [390, 844, 0, 5],
      body: [10, 20, 8, 18],
      document: [10, 20, 8, 18],
      codes: [
        {
          rect: [1, 2, 3, 4],
          lines: [[1, 2, 3, 4]],
          font: "mono|14px|normal|18px",
          parentLineHeight: "20px",
        },
      ],
    });
    expect(query).toHaveBeenCalledWith("code");
  });

  it("uses viewport-only CDP screenshots and detaches even on failure", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ data: Buffer.from("image").toString("base64") })
      .mockRejectedValueOnce(new Error("capture failed"));
    const detach = vi.fn().mockResolvedValue(undefined);
    const page = {
      context: () => ({ newCDPSession: async () => ({ send, detach }) }),
    } as unknown as Page;
    expect(await viewportPng(page)).toEqual(Buffer.from("image"));
    expect(send).toHaveBeenCalledWith("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await expect(viewportPng(page)).rejects.toThrow("capture failed");
    expect(detach).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])("holds the font until release, then fulfills=%s", async (fulfill) => {
    let handler!: (route: Route) => Promise<void>;
    const page = {
      route: vi.fn(async (_glob: string, fn: typeof handler) => {
        handler = fn;
      }),
    } as unknown as Page;
    const bytes = fulfill ? Buffer.from("font") : null;
    const state = await holdFont(page, "**/font.woff2", bytes);
    const route = { fulfill: vi.fn(), abort: vi.fn() };
    const pending = handler(route as unknown as Route);
    expect(state.requested).toBe(true);
    expect(state.released).toBe(false);
    expect(route.fulfill).not.toHaveBeenCalled();
    expect(route.abort).not.toHaveBeenCalled();
    state.release();
    await pending;
    expect(state.released).toBe(true);
    if (fulfill)
      expect(route.fulfill).toHaveBeenCalledWith({ body: bytes, contentType: "font/woff2" });
    else expect(route.abort).toHaveBeenCalledOnce();
  });
});
