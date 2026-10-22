// Acceptance (browser): overlay renders on OBS canvas sizes with the watermark.
//
// Opt-in like the other Chromium suites (also needs DATABASE_URL for the
// token fixtures):
// OVERLAY_BROWSER_TESTS=true npx vitest run test/overlay-render-browser.test.ts
//
// CI wiring belongs to the build PR: run this file in the a11y job and verify
// it through ci/a11y-require-executed.mjs with suite
// "overlay render browser (OBS canvas sizes)" and minimum 5.
//
// The loopback server serves overlay HTML fetched through app.request plus the
// checked-in public/ assets, so the browser proof stays hermetic (no wrangler,
// no network): routing is covered by test/overlay-render-acceptance.test.ts,
// this file proves what OBS composites at 1920x1080 and 1280x720.
//
// Owned by the acceptance card: the Builder builds on this branch and never
// edits this file.
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import app from "./app";
import type { Db } from "../src/db/index";
import { createMemorySessionStore, type SessionStore, type Sql } from "../src/sessions";
import { env, MEMBER, seed } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import {
  insertOverlayConfig,
  insertOverlayToken,
  mintOverlayToken,
} from "./helpers/overlay-fixture";

export const OVERLAY_BROWSER_SUITE = "overlay render browser (OBS canvas sizes)";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(repoRoot, "public");

function publicAsset(pathname: string): { body: Buffer; type: string } | undefined {
  const rel = normalize(pathname).replace(/^[/\\]+/, "");
  if (rel === "" || rel.startsWith("..")) return undefined;
  const full = join(publicDir, rel);
  if (full !== publicDir && !full.startsWith(publicDir + sep)) return undefined;
  const ext = full.slice(full.lastIndexOf(".")).toLowerCase();
  const type =
    ext === ".svg"
      ? "image/svg+xml"
      : ext === ".js"
        ? "text/javascript"
        : ext === ".css"
          ? "text/css"
          : ext === ".png"
            ? "image/png"
            : "application/octet-stream";
  try {
    if (!existsSync(full)) return undefined;
    return { body: readFileSync(full), type };
  } catch {
    return undefined;
  }
}

describe.skipIf(process.env.OVERLAY_BROWSER_TESTS !== "true" || !process.env.DATABASE_URL)(
  OVERLAY_BROWSER_SUITE,
  () => {
    let fixture: MemberDataFixture;
    let db: Db;
    let sessions: SessionStore;
    let browser: Browser | undefined;
    let overlayHtml: string;
    let unknownHtml: string;
    let rotatedHtml: string;
    const contexts: BrowserContext[] = [];
    const servers: Server[] = [];
    const bindings = () => ({
      ...env,
      ADMIN_DB: db,
      SESSION_STORE: sessions,
      THROTTLE_STORE: async () => fixture.client as unknown as Sql,
      DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
    });

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      db = fixture.db;
      await fixture.reset();
      await seed(db);
      sessions = createMemorySessionStore();
      const live = mintOverlayToken();
      const rotated = mintOverlayToken();
      const unknown = mintOverlayToken();
      await insertOverlayConfig(fixture, MEMBER.userId);
      await insertOverlayToken(fixture, { token: live, memberId: MEMBER.userId });
      await insertOverlayToken(fixture, {
        token: rotated,
        memberId: MEMBER.userId,
        status: "rotated",
        rotatedAt: new Date(Date.now() - 60_000),
      });
      const load = async (token: string, ip: string) => {
        const res = await app.request(
          `/o/${token}`,
          { headers: { "cf-connecting-ip": ip } },
          bindings(),
        );
        return { status: res.status, html: await res.text() };
      };
      const livePage = await load(live, "198.51.100.11");
      expect(livePage.status).toBe(200);
      overlayHtml = livePage.html;
      const unknownPage = await load(unknown, "198.51.100.12");
      expect(unknownPage.status).toBe(404);
      unknownHtml = unknownPage.html;
      const rotatedPage = await load(rotated, "198.51.100.13");
      expect(rotatedPage.status).toBe(404);
      rotatedHtml = rotatedPage.html;
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
    });

    afterAll(async () => {
      await Promise.all(contexts.map((context) => context.close()));
      await browser?.close();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.closeAllConnections();
              server.close((error) => (error ? reject(error) : resolve()));
            }),
        ),
      );
      await fixture?.dispose();
    });

    async function openDocument(
      html: string,
      status: number,
      viewport: { width: number; height: number },
    ): Promise<{ page: Page; responseStatus: number | null; errors: Error[] }> {
      const server = createServer((req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          if (url.pathname === "/") {
            res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
            res.end(html);
            return;
          }
          const asset = publicAsset(url.pathname);
          if (asset) {
            res.writeHead(200, { "content-type": asset.type });
            res.end(asset.body);
            return;
          }
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("missing fixture asset");
        } catch {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end("loopback error");
        }
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      servers.push(server);
      const address = server.address() as AddressInfo;
      const context = await browser!.newContext({ viewport });
      contexts.push(context);
      const page = await context.newPage();
      const errors: Error[] = [];
      page.on("pageerror", (error) => {
        errors.push(error);
      });
      const response = await page.goto(`http://127.0.0.1:${address.port}/`);
      return { page, responseStatus: response?.status() ?? null, errors };
    }

    async function expectWatermarkCanvas(page: Page, errors: Error[], shot: string): Promise<void> {
      const watermark = page.getByText("Together We Own").first();
      expect(await watermark.count()).toBeGreaterThan(0);
      expect(await watermark.boundingBox()).not.toBeNull();
      const logo = page.locator('img[src*="logo.svg"]').first();
      expect(await logo.count()).toBe(1);
      expect(
        await logo.evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth),
      ).toBeGreaterThan(0);
      const background = await page.evaluate<string>(
        "getComputedStyle(document.body).backgroundColor",
      );
      expect(background).toBe("rgba(0, 0, 0, 0)");
      expect(await page.locator("header").count()).toBe(0);
      expect(await page.locator("footer").count()).toBe(0);
      expect(errors).toHaveLength(0);
      await page.screenshot({ path: join(repoRoot, "test-results", shot) });
    }

    it("1920x1080 canvas shows the watermark over a transparent page", async () => {
      const { page, responseStatus, errors } = await openDocument(overlayHtml, 200, {
        width: 1920,
        height: 1080,
      });
      expect(responseStatus).toBe(200);
      await expectWatermarkCanvas(page, errors, "overlay-1920x1080.png");
    });

    it("1280x720 canvas shows the watermark over a transparent page", async () => {
      const { page, responseStatus, errors } = await openDocument(overlayHtml, 200, {
        width: 1280,
        height: 720,
      });
      expect(responseStatus).toBe(200);
      await expectWatermarkCanvas(page, errors, "overlay-1280x720.png");
    });

    it("unknown token serves the 404 without overlay content", async () => {
      const { page, responseStatus, errors } = await openDocument(unknownHtml, 404, {
        width: 1280,
        height: 720,
      });
      expect(responseStatus).toBe(404);
      expect(await page.getByText("We cannot find that page").count()).toBeGreaterThan(0);
      expect(await page.getByText(MEMBER.username).count()).toBe(0);
      expect(errors).toHaveLength(0);
    });

    it("rotated token 404s in a second context", async () => {
      const first = await openDocument(overlayHtml, 200, { width: 1280, height: 720 });
      expect(first.responseStatus).toBe(200);
      const second = await openDocument(rotatedHtml, 404, { width: 1280, height: 720 });
      expect(second.responseStatus).toBe(404);
      expect(await second.page.getByText("We cannot find that page").count()).toBeGreaterThan(0);
      expect(await second.page.getByText(MEMBER.username).count()).toBe(0);
      expect(second.errors).toHaveLength(0);
    });

    it("overlay document carries lang, title and logo alt text", async () => {
      const { page, errors } = await openDocument(overlayHtml, 200, { width: 1280, height: 720 });
      const lang = await page.evaluate<string>("document.documentElement.lang");
      expect(lang.trim()).not.toBe("");
      expect((await page.title()).trim()).not.toBe("");
      const alt = await page.locator('img[src*="logo.svg"]').first().getAttribute("alt");
      expect((alt ?? "").trim()).not.toBe("");
      expect(errors).toHaveLength(0);
    });
  },
);
