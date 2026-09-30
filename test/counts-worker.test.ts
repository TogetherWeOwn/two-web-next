import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

// Actual reader in workerd; only postgres is replaced. Driver delays and read
// deadlines are owned by Worker invocations, not Node timers or another request.
// No database, Hyperdrive binding, deployment secrets or outbound network.
describe("counts cache invocation lifetime in workerd", () => {
  let mf: Miniflare;

  beforeAll(async () => {
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(), sourcefile: "counts-lifetime-worker.ts", contents: `
          import { readCounts } from "./src/counts";
          import { stats } from "postgres";
          export default {
            async fetch(request) {
              const url = new URL(request.url);
              const env = { DATABASE_URL: "postgres://fixture.test/" + (url.searchParams.get("mode") || "counts") };
              if (url.pathname === "/abandon") {
                void readCounts(env);
                await new Promise(resolve => setTimeout(resolve, 300));
                // Deliberately terminate the owning invocation while its fill is
                // pending. No waitUntil: it would mask the cancellation hazard.
                return Response.json({ ...stats });
              }
              let timer;
              try {
                const counts = await Promise.race([
                  readCounts(env),
                  new Promise(resolve => { timer = setTimeout(() => resolve(null), 2500); }),
                ]);
                return Response.json({ counts, ...stats }, { status: counts ? 200 : 504 });
              } finally { clearTimeout(timer); }
            }
          };
        `,
      },
      bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
      conditions: ["workerd", "worker", "browser"], external: ["node:*", "cloudflare:*"],
      plugins: [{
        name: "fixture-postgres",
        setup(plugin) {
          plugin.onResolve({ filter: /^postgres$/ }, () => ({ path: "postgres", namespace: "fixture" }));
          plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
            export const stats = { queries: 0, ends: 0 };
            export default function postgres(url) {
              const sql = (parts) => {
                stats.queries++;
                if (url.endsWith("hung")) return new Promise(() => {});
                const live = parts.join("").includes("web_v1.live_counts");
                return new Promise(resolve => setTimeout(() => resolve(live
                  ? [{ human_member_count: "84", online_count: "12", counts_updated_at: new Date().toISOString() }]
                  : [{ rank_key: "member", rank_label: "Member", member_count: "40" }]
                ), 1000));
              };
              sql.end = async () => { stats.ends++; };
              return sql;
            }
          ` }));
        },
      }],
    });
    mf = new Miniflare(convertV4MiniflareOptions({
      modules: true, script: bundle.outputFiles![0]!.text,
      compatibilityDate: "2026-09-29", compatibilityFlags: ["nodejs_compat"],
      outboundService: () => { throw new Error("Network forbidden in counts lifetime fixture"); },
    }));
    await mf.ready;
  }, 30_000);
  afterAll(async () => { await mf?.dispose(); });

  const request = (path: string) => mf.dispatchFetch(`https://counts.example.test${path}`);
  const fresh = {
    memberCount: 84, onlineCount: 12,
    ranks: [{ key: "member", label: "Member", memberCount: 40 }],
  };

  it("does not reuse an abandoned pending fill; following calls reuse only settled values", async () => {
    const owner = await request("/abandon");
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual({ queries: 2, ends: 0 });

    const following = await request("/counts");
    expect(following.status).toBe(200);
    expect(await following.json()).toEqual({ counts: fresh, queries: 4, ends: 2 });

    const cached = await request("/counts");
    expect(cached.status).toBe(200);
    expect(await cached.json()).toEqual({ counts: fresh, queries: 4, ends: 2 });
  }, 10_000);

  it("gives a later hung fill its own bounded deadline and caches its degraded result", async () => {
    const owner = await request("/abandon?mode=hung");
    expect(owner.status).toBe(200);
    const before = await owner.json() as { queries: number; ends: number };

    const following = await request("/counts?mode=hung");
    expect(following.status).toBe(200); // Reader's 2 s deadline, before the 2.5 s diagnostic guard.
    const degraded = { memberCount: null, onlineCount: null, ranks: [] };
    expect(await following.json()).toEqual({ counts: degraded, queries: before.queries + 2, ends: before.ends + 2 });

    const cached = await request("/counts?mode=hung");
    expect(cached.status).toBe(200);
    expect(await cached.json()).toEqual({ counts: degraded, queries: before.queries + 2, ends: before.ends + 2 });
  }, 10_000);
});
