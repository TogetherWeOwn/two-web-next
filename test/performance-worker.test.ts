import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { drizzle } from "drizzle-orm/pg-proxy";
import { convertV4MiniflareOptions, Miniflare, type Request as WorkerRequest } from "miniflare";
import { fixtureEnvForRequest } from "../ci/lighthouse-worker";
import { auditPaths, fixtureKey } from "../ci/lighthouse-paths";
import type { Db } from "../src/db/index";
import { getEventNeighbors } from "../src/events/reads";

const require = createRequire(import.meta.url);
const { probeFixture } = require("../ci/lighthouse-admission.cjs");
const collect = require("../ci/lighthouserc.cjs").ci.collect;

// Node does not reproduce workerd's epoch clock during module evaluation.
// Bundle the actual Lighthouse wrapper and exercise it in the Workers runtime.
describe("Lighthouse fixture in Miniflare", () => {
  let mf: Miniflare;
  const outbound: string[] = [];

  beforeAll(async () => {
    const bundle = await build({
      entryPoints: ["ci/lighthouse-worker.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      conditions: ["workerd", "worker", "browser"],
      external: ["node:*", "cloudflare:*"],
    });
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: bundle.outputFiles![0]!.text,
        compatibilityDate: "2026-09-29",
        compatibilityFlags: ["nodejs_compat"],
        outboundService: async (request: WorkerRequest) => {
          outbound.push(request.url);
          throw new Error("Outbound network forbidden by Lighthouse fixture");
        },
        bindings: {
          DATABASE_URL: "postgres://must-not-connect.invalid/forbidden",
          DISCORD_BOT_TOKEN: "must-not-use",
        },
      }),
    );
    await mf.ready;
  }, 30_000);
  afterAll(async () => {
    await mf?.dispose();
  });

  it("renders populated homepage teaser and event pages with future dates and no outbound access", async () => {
    for (const path of ["/", "/events", `/e/${fixtureKey}`]) {
      const before = Date.now();
      const response = await mf.dispatchFetch(`http://127.0.0.1:8787${path}`);
      const html = await response.text();
      const after = Date.now();
      expect(response.status, path).toBe(200);
      expect(html).toContain("Lighthouse fixture game night");
      expect(html).toContain(path === "/" ? "3 going" : "3 of 20 going");
      expect(html).toContain("Community voice channel");
      if (path === "/") {
        expect(html).toContain('data-testid="home-events-list"');
        expect(html).toContain(`href="/e/${fixtureKey}"`);
        expect(html).toContain('data-testid="featured-content"');
        expect(html).toContain("Lighthouse fixture community news");
        expect(html).not.toContain('data-testid="home-events-empty"');
        expect(html).not.toContain('data-state="unavailable"');
      } else if (path === "/events") {
        expect(html).toContain('data-testid="event-card"');
        expect(html).not.toMatch(/data-testid="events-empty-(never|gap|error|search)"/);
      } else {
        expect(html).toContain(
          "A local-only community game night used to measure the real event page.",
        );
        expect(html).toContain('data-testid="event-join-pitch"');
        expect(html).toContain('<h1 data-waitlist-position="">Lighthouse fixture game night</h1>');
      }
      const times = [...html.matchAll(/<time\b[^>]*datetime="([^"]+)"/g)];
      expect(times.length, path).toBeGreaterThan(0);
      for (const [, instant] of times) {
        const startsAt = Date.parse(instant!);
        expect(startsAt, `${path}: ${instant}`).toBeGreaterThanOrEqual(before + 7 * 86400_000);
        expect(startsAt, `${path}: ${instant}`).toBeLessThanOrEqual(after + 7 * 86400_000);
      }
    }
    expect(outbound).toEqual([]);
  });

  it("passes the exact precollection content admission against real workerd responses", async () => {
    await probeFixture(collect.url, (url: string) => mf.dispatchFetch(url));
    expect(outbound).toEqual([]);
  });

  it("serves every audit page and refuses nonfixture routes in workerd", async () => {
    for (const path of auditPaths) {
      expect((await mf.dispatchFetch(`http://127.0.0.1:8787${path}`)).status, path).toBe(200);
    }
    expect((await mf.dispatchFetch("http://127.0.0.1:8787/auth/discord")).status).toBe(404);
    expect((await mf.dispatchFetch("http://127.0.0.1:8787/join", { method: "POST" })).status).toBe(
      404,
    );
    expect(outbound).toEqual([]);
  });

  it("pins the fixture neighbor SQL to getEventNeighbors in both directions", async () => {
    // Capture the src shape DB-free: both neighbor comparisons, their bound,
    // and their 7-param contract. The worker copy must accept exactly this.
    const now = new Date("2030-01-10T20:00:00.000Z");
    const seen: { sql: string; params: unknown[] }[] = [];
    const captureDb = drizzle(async (sql, params) => {
      seen.push({ sql, params: params as unknown[] });
      return { rows: [] };
    }) as unknown as Db;
    await getEventNeighbors(captureDb, { id: 2 }, now);
    expect(seen).toHaveLength(2);
    for (const query of seen) {
      expect(query.sql).toContain('"events"."ends_at" >= $3');
      expect(query.sql).toContain('"events"."status" = $1');
      expect(query.sql).toContain('"events"."id" <> $2');
      expect(query.sql).toContain('isfinite("events"."starts_at")');
      expect(query.params).toHaveLength(7);
      expect(query.params[0]).toBe("published");
      expect(query.params[1]).toBe(2);
      expect(query.params[2]).toBe(now.toISOString());
      expect(query.params[3]).toBe(2);
      expect(query.params[4]).toBe(2);
      expect(query.params[5]).toBe(2);
      expect(query.params[6]).toBe(1);
    }
    const previous = seen.find((query) => query.sql.includes('"starts_at" desc'));
    const next = seen.find((query) => query.sql.includes('"starts_at" asc'));
    expect(previous?.sql).toMatch(/"starts_at" < .*"starts_at" = .*"id" </);
    expect(next?.sql).toMatch(/"starts_at" > .*"starts_at" = .*"id" >/);

    // Drive both comparisons through the worker fixture: a skewed worker copy
    // (for example without the ends_at bound) throws here instead of returning.
    const env = fixtureEnvForRequest(Date.now());
    await expect(getEventNeighbors(env.ADMIN_DB as unknown as Db, { id: 1 })).resolves.toEqual({
      previous: null,
      next: null,
    });

    // Drive both comparisons through the bundled worker: the lone fixture has
    // no neighbours, so the event page renders without pagination links.
    const response = await mf.dispatchFetch(`http://127.0.0.1:8787/e/${fixtureKey}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain('data-testid="event-previous"');
    expect(html).not.toContain('data-testid="event-next"');
    expect(outbound).toEqual([]);
  });
});
